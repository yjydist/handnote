import { constants, readFileSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { revisionDraftSchema } from "./document.ts";
import { HandnoteError } from "./errors.ts";
import {
  type Artifact,
  type RunManifest,
  runManifestSchema,
  type StoredRevision,
  summarizeUsage,
} from "./manifest.ts";
import { compileNoteMarkdown } from "./markdown.ts";
import {
  accountModelAttempt,
  accountModelStep,
  createModelAccounting,
} from "./model-accounting.ts";
import type { RedactionOptions } from "./redact.ts";
import { renderDocument } from "./renderer.ts";
import { checkedRunPath } from "./run-path.ts";
import { readSession, type SessionEvent, SessionRecorder } from "./session.ts";
import { atomicWrite, isoWithOffset, sha256 } from "./utils.ts";

export class NoteStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RevisionSnapshot extends StoredRevision {
  text: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class RunStore {
  readonly directory: string;
  #tail: Promise<void> = Promise.resolve();
  private constructor(
    directory: string,
    private readonly writer?: SessionRecorder,
  ) {
    this.directory = resolve(directory);
  }

  static async create(
    directory: string,
    options: {
      inputExtension: string;
      startedAt?: string;
      runId?: string;
    } & RedactionOptions,
  ): Promise<RunStore> {
    if (await exists(`${directory}/run.json`))
      throw new HandnoteError("Run manifest already exists", "filesystem");
    await mkdir(directory, { recursive: true });
    new RunStore(directory).validatePaths();
    const recorder = SessionRecorder.create(resolve(directory), options);
    const store = new RunStore(directory, recorder);
    const startedAt = options.startedAt ?? isoWithOffset();
    recorder.record("run.created", { formatVersion: 1 });
    await store.persist({
      formatVersion: 1,
      runId: options.runId ?? basename(directory),
      status: "running",
      startedAt,
      durationMs: 0,
      input: { path: `input/original${options.inputExtension}` },
      session: "session/events.jsonl",
      revisions: [],
      model: createModelAccounting(),
    });
    return store;
  }

  static async open(
    directory: string,
    options: { mode?: "read" | "recover" } & RedactionOptions = {},
  ): Promise<RunStore> {
    const reader = new RunStore(directory);
    reader.validatePaths();
    const manifest = reader.manifest;
    const session = readSession(reader.path(manifest.session));
    await reader.verify(manifest, session.events);
    if (options.mode !== "recover") return reader;
    const model = reconcileModelAccounting(manifest.model, session.events);
    const uncommitted = await reader.uncommittedPaths(manifest);
    const recorder = SessionRecorder.open(reader.directory, options);
    const store = new RunStore(directory, recorder);
    for (const path of uncommitted)
      await rm(store.path(path), { recursive: true, force: true });
    await store.updateModel(model);
    if (manifest.status === "running") await store.finish("interrupted");
    recorder.record("run.recovered", { status: store.manifest.status });
    return store;
  }

  get recorder(): SessionRecorder {
    if (!this.writer) throw new Error("RunStore was opened read-only");
    return this.writer;
  }

  get manifest(): RunManifest {
    try {
      return runManifestSchema.parse(
        JSON.parse(readFileSync(this.path("run.json"), "utf8")),
      );
    } catch (error) {
      throw new HandnoteError(
        "Cannot read a valid version 1 run manifest",
        "filesystem",
        false,
        { cause: error },
      );
    }
  }

  path(relativePath: string): string {
    return checkedRunPath(this.directory, relativePath);
  }

  private validatePaths(): void {
    for (const path of [
      "input",
      "session",
      "assets/figures",
      "intermediate/revisions",
      "intermediate/inspections",
      "output",
      "output.tmp",
    ])
      checkedRunPath(this.directory, path, { kind: "directory" });
    for (const path of ["run.json", "session/events.jsonl"])
      checkedRunPath(this.directory, path, { kind: "file" });
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.recorder;
    let release = () => {};
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        !(error instanceof HandnoteError) &&
        typeof code === "string" &&
        /^E[A-Z]+$/.test(code)
      )
        throw new HandnoteError(
          "Run artifact filesystem operation failed",
          "filesystem",
          false,
          { cause: error },
        );
      throw error;
    } finally {
      release();
    }
  }

  private async persist(manifest: RunManifest): Promise<void> {
    const parsed = runManifestSchema.safeParse(manifest);
    if (!parsed.success)
      throw new HandnoteError(
        "Cannot serialize a valid run manifest",
        "internal",
        false,
        { cause: parsed.error },
      );
    const safe = parsed.data;
    safe.runId = this.recorder.sanitize(safe.runId);
    if (safe.error)
      safe.error.message = this.recorder.sanitize(safe.error.message);
    for (const revision of safe.revisions)
      for (const warning of revision.warnings)
        warning.message = this.recorder.sanitize(warning.message);
    await atomicWrite(
      this.path("run.json"),
      `${JSON.stringify(safe, null, 2)}\n`,
    );
  }

  private async bytes(artifact: Artifact): Promise<Buffer> {
    try {
      const path = checkedRunPath(this.directory, artifact.path, {
        kind: "file",
        allowMissing: false,
      });
      const bytes = await readFile(path);
      if (sha256(bytes) !== artifact.sha256) throw new Error("hash mismatch");
      return bytes;
    } catch (error) {
      throw new HandnoteError(
        `Cannot read verified artifact (missing file or hash mismatch): ${artifact.path}`,
        "filesystem",
        false,
        { cause: error },
      );
    }
  }

  async readRevision(
    number = this.manifest.currentRevision,
  ): Promise<RevisionSnapshot | undefined> {
    const revision = this.manifest.revisions.find(
      (entry) => entry.number === number,
    );
    if (!revision) return undefined;
    const markdown = await this.bytes(revision.markdown);
    for (const artifact of [revision.html, revision.image, ...revision.assets])
      await this.bytes(artifact);
    const text = markdown.toString("utf8");
    try {
      const note = await compileNoteMarkdown(text, {
        runDirectory: this.directory,
      });
      const assets = new Map(
        revision.assets.map((asset) => [asset.path, asset.sha256]),
      );
      if (
        assets.size !== revision.assets.length ||
        assets.size !== note.assets.length ||
        note.assets.some((asset) => assets.get(asset.path) !== asset.sha256)
      )
        throw new Error("Referenced resources do not match the revision index");
    } catch (error) {
      throw new HandnoteError(
        "Committed revision resources cannot be verified",
        "filesystem",
        false,
        { cause: error },
      );
    }
    return { ...revision, text };
  }

  private async verify(
    manifest: RunManifest,
    events: SessionEvent[],
  ): Promise<void> {
    const creation = events[0];
    if (
      creation?.type !== "run.created" ||
      (creation.data as { formatVersion?: number } | null)?.formatVersion !== 1
    )
      throw new HandnoteError(
        "Run session is missing its creation event",
        "filesystem",
      );
    if (manifest.input.sha256)
      await this.bytes({
        path: manifest.input.path,
        sha256: manifest.input.sha256,
      });
    const eventFor = (seq: number, type: string, revision: number) => {
      const event = events[seq - 1];
      const data = event?.data as
        | {
            revision?: number;
            markdownSha256?: string;
            imageSha256?: string;
            step?: number;
          }
        | undefined;
      if (event?.type !== type || data?.revision !== revision)
        throw new HandnoteError(`Missing matching ${type} event`, "filesystem");
      return data;
    };
    for (const revision of manifest.revisions) {
      await this.readRevision(revision.number);
      const event = eventFor(
        revision.commitEventSeq,
        "document.revision.committed",
        revision.number,
      );
      if (
        event.markdownSha256 !== revision.markdown.sha256 ||
        event.imageSha256 !== revision.image.sha256
      )
        throw new HandnoteError("Revision event hash mismatch", "filesystem");
    }
    if (manifest.reviewedRevision) {
      const review = manifest.reviewedRevision;
      const event = eventFor(review.eventSeq, "render.reviewed", review.number);
      if (
        event.markdownSha256 !== review.markdownSha256 ||
        event.imageSha256 !== review.imageSha256 ||
        event.step !== review.reviewedAtStep
      )
        throw new HandnoteError("Review event mismatch", "filesystem");
    }
    if (manifest.final) {
      const final = manifest.final;
      const event = eventFor(final.eventSeq, "note.finalized", final.revision);
      if (
        event.markdownSha256 !== final.markdown.sha256 ||
        event.imageSha256 !== final.image.sha256 ||
        (event.step ?? 0) <= (manifest.reviewedRevision?.reviewedAtStep ?? 0)
      )
        throw new HandnoteError("Finalize event mismatch", "filesystem");
      await this.bytes(final.markdown);
      await this.bytes(final.image);
    }
  }

  async copyInput(source: string): Promise<void> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      if (manifest.input.sha256)
        throw new HandnoteError("Original input is immutable", "filesystem");
      const bytes = await readFile(source);
      await atomicWrite(this.path(manifest.input.path), bytes);
      manifest.input.sha256 = sha256(bytes);
      this.recorder.record("input.copied", manifest.input);
      await this.persist(manifest);
    });
  }

  async commit(
    draft: unknown,
    options: { kind: "write" | "revise"; step: number; width: number },
  ): Promise<StoredRevision> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      if (manifest.status === "complete")
        throw new NoteStateError(
          "already_finalized",
          "The note is already finalized and cannot be changed",
        );
      if (options.kind === "write" && manifest.currentRevision)
        throw new NoteStateError(
          "revision_exists",
          "A revision already exists; use revise_note",
        );
      if (options.kind === "revise" && !manifest.currentRevision)
        throw new NoteStateError(
          "no_revision",
          "No revision exists; use write_note",
        );
      await this.readRevision();
      const parsed = revisionDraftSchema.parse(draft);
      const note = await compileNoteMarkdown(parsed.markdown, {
        runDirectory: this.directory,
      });
      const number = manifest.revisions.length + 1;
      const parent = "intermediate/revisions";
      const name = String(number).padStart(4, "0");
      const directory = `${parent}/${name}`;
      const temporary = `${parent}/.${name}.tmp`;
      await mkdir(this.path(parent), { recursive: true });
      if (await exists(this.path(directory)))
        throw new HandnoteError(
          "Revision destination already exists; recover the run first",
          "filesystem",
        );
      await mkdir(this.path(temporary));
      let promoted = false;
      try {
        await atomicWrite(this.path(`${temporary}/note.md`), parsed.markdown);
        const render = await renderDocument(
          note,
          this.path(temporary),
          options.width,
        );
        await flushFile(this.path(`${temporary}/note.png`));
        const artifact = async (name: string): Promise<Artifact> => ({
          path: `${directory}/${name}`,
          sha256: sha256(await readFile(this.path(`${temporary}/${name}`))),
        });
        const markdown = await artifact("note.md"),
          html = await artifact("note.html"),
          image = await artifact("note.png");
        for (const asset of note.assets) await this.bytes(asset);
        await rename(this.path(temporary), this.path(directory));
        promoted = true;
        const event = this.recorder.recordRevision({
          type: "document.revision.committed",
          revision: number,
          markdownSha256: markdown.sha256,
          imageSha256: image.sha256,
          audit: parsed.audit,
        });
        const revision: StoredRevision = {
          number,
          markdown,
          html,
          image,
          assets: note.assets,
          width: render.width,
          height: render.height,
          warnings: render.warnings,
          structure: render.structure,
          renderedAtStep: options.step,
          commitEventSeq: event.seq,
        };
        manifest.revisions.push(revision);
        manifest.currentRevision = number;
        delete manifest.reviewedRevision;
        await this.persist(manifest);
        return revision;
      } catch (error) {
        await rm(this.path(promoted ? directory : temporary), {
          recursive: true,
          force: true,
        });
        this.recorder.record("document.revision.failed", {
          revision: number,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async review(
    step: number,
    prepare: (revision: StoredRevision) => Promise<void>,
  ): Promise<StoredRevision> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      if (manifest.status === "complete")
        throw new NoteStateError(
          "already_finalized",
          "The note is already finalized",
        );
      const revision = await this.readRevision();
      if (!revision)
        throw new NoteStateError("no_revision", "No revision exists to review");
      if (step <= revision.renderedAtStep)
        throw new NoteStateError(
          "not_ready",
          "Review must occur in a later model step than rendering",
        );
      await prepare(revision);
      await this.readRevision(revision.number);
      const event = this.recorder.recordRevision({
        type: "render.reviewed",
        revision: revision.number,
        markdownSha256: revision.markdown.sha256,
        imageSha256: revision.image.sha256,
        step,
      });
      manifest.reviewedRevision = {
        number: revision.number,
        markdownSha256: revision.markdown.sha256,
        imageSha256: revision.image.sha256,
        reviewedAtStep: step,
        eventSeq: event.seq,
      };
      await this.persist(manifest);
      return revision;
    });
  }

  async finalize(step: number): Promise<StoredRevision> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      const review = manifest.reviewedRevision;
      if (
        manifest.status === "complete" ||
        !review ||
        step <= review.reviewedAtStep
      )
        throw new NoteStateError(
          "not_ready",
          "Finalize requires an unchanged revision reviewed in an earlier model step",
        );
      if (!manifest.input.sha256)
        throw new NoteStateError(
          "not_ready",
          "Original input has not been copied",
        );
      await this.bytes({
        path: manifest.input.path,
        sha256: manifest.input.sha256,
      });
      const revision = await this.readRevision();
      if (!revision || revision.warnings.some((warning) => warning.blocking))
        throw new NoteStateError(
          "not_ready",
          "Review contains blocking layout warnings",
        );
      if (await exists(this.path("output")))
        throw new HandnoteError(
          "Output destination already exists; recover the run first",
          "filesystem",
        );
      await mkdir(this.path("output.tmp"));
      let promoted = false;
      try {
        await copyFile(
          this.path(revision.markdown.path),
          this.path("output.tmp/note.md"),
          constants.COPYFILE_EXCL,
        );
        await copyFile(
          this.path(revision.image.path),
          this.path("output.tmp/note.png"),
          constants.COPYFILE_EXCL,
        );
        await flushFile(this.path("output.tmp/note.md"));
        await flushFile(this.path("output.tmp/note.png"));
        await this.bytes({
          path: "output.tmp/note.md",
          sha256: review.markdownSha256,
        });
        await this.bytes({
          path: "output.tmp/note.png",
          sha256: review.imageSha256,
        });
        await this.readRevision(revision.number);
        await rename(this.path("output.tmp"), this.path("output"));
        promoted = true;
        const event = this.recorder.recordRevision({
          type: "note.finalized",
          revision: revision.number,
          markdownSha256: review.markdownSha256,
          imageSha256: review.imageSha256,
          step,
        });
        manifest.final = {
          revision: revision.number,
          markdown: { path: "output/note.md", sha256: review.markdownSha256 },
          image: { path: "output/note.png", sha256: review.imageSha256 },
          eventSeq: event.seq,
        };
        manifest.status = "complete";
        manifest.stopReason = "finalized";
        manifest.finishedAt = isoWithOffset();
        manifest.durationMs = Date.now() - Date.parse(manifest.startedAt);
        await this.persist(manifest);
        return revision;
      } catch (error) {
        await rm(this.path(promoted ? "output" : "output.tmp"), {
          recursive: true,
          force: true,
        });
        this.recorder.record("note.finalize.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  async updateModel(update: Partial<RunManifest["model"]>): Promise<void> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      manifest.model = { ...manifest.model, ...update };
      manifest.model.usage = summarizeUsage(manifest.model.usage);
      await this.persist(manifest);
    });
  }

  async finish(
    stopReason: string,
    error?: { kind: string; message: string },
  ): Promise<RunManifest> {
    return this.transaction(async () => {
      const manifest = this.manifest;
      if (manifest.status !== "complete") {
        try {
          manifest.status = (await this.readRevision()) ? "partial" : "failed";
        } catch (corruption) {
          manifest.status = "failed";
          error = {
            kind: "filesystem",
            message:
              corruption instanceof Error
                ? corruption.message
                : String(corruption),
          };
          stopReason = "filesystem";
        }
        manifest.stopReason = stopReason;
        if (error) manifest.error = error;
      }
      manifest.finishedAt = isoWithOffset();
      manifest.durationMs = Date.now() - Date.parse(manifest.startedAt);
      this.recorder.record("run.finished", {
        status: manifest.status,
        stopReason: manifest.stopReason,
      });
      await this.persist(manifest);
      return this.manifest;
    });
  }

  private async uncommittedPaths(manifest: RunManifest): Promise<string[]> {
    const paths: string[] = [];
    const known = new Set(
      manifest.revisions.map((revision) =>
        String(revision.number).padStart(4, "0"),
      ),
    );
    const parent = this.path("intermediate/revisions");
    for (const name of await readdir(parent).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (/^\.\d+\.tmp$/.test(name) || (/^\d+$/.test(name) && !known.has(name)))
        paths.push(`intermediate/revisions/${name}`);
    }
    paths.push("output.tmp");
    if (!manifest.final) paths.push("output");
    for (const name of await readdir(this.path("input")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      if (name.startsWith(`${basename(manifest.input.path)}.tmp-`))
        paths.push(`input/${name}`);
    }
    for (const name of await readdir(this.directory))
      if (/^run\.json\.tmp-[a-f0-9]+$/.test(name)) paths.push(name);
    for (const path of paths) this.path(path);
    return paths;
  }
}

function reconcileModelAccounting(
  confirmed: RunManifest["model"],
  events: SessionEvent[],
): RunManifest["model"] {
  let model = createModelAccounting();
  const matchesConfirmed = () =>
    isDeepStrictEqual(
      { ...model, usage: summarizeUsage(model.usage) },
      confirmed,
    );
  let matched = matchesConfirmed();
  for (const event of events) {
    const data = event.data as {
      step?: number;
      attempt?: number;
      usage?: Record<string, unknown>;
    } | null;
    if (event.type === "model.attempt.started") {
      model = accountModelAttempt(model, {
        step: data?.step ?? 0,
        attempt: data?.attempt ?? 0,
      });
    }
    if (event.type === "model.step.completed") {
      model = accountModelStep(model, {
        step: data?.step ?? 0,
        usage: data?.usage ?? {},
      });
    }
    matched ||= matchesConfirmed();
  }
  if (!matched)
    throw new HandnoteError(
      "Recorded model accounting does not match any session event prefix",
      "filesystem",
    );
  model.usage = summarizeUsage(model.usage);
  return model;
}

async function flushFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

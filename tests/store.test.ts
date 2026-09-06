import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { compileNoteMarkdown } from "../src/markdown.ts";
import * as renderer from "../src/renderer.ts";
import { readSession, SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { RunStore } from "../src/store.ts";
import type { TokenUsage } from "../src/usage.ts";
import { sha256File } from "../src/utils.ts";
import { createStoreFixture, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
async function setup() {
  const directory = await fs.mkdtemp(`${tmpdir()}/handnote-store-`);
  directories.push(directory);
  return createStoreFixture(directory, {
    secrets: ["sk-store-secret"],
  });
}
async function reviewed() {
  const store = await setup();
  await store.commit(simpleDraft(), { kind: "write", step: 1, width: 700 });
  await store.review(2, async () => {});
  return store;
}
const diskFull = () =>
  Object.assign(new Error("injected disk full"), { code: "ENOSPC" });

function failSessionAppendOnce(
  path: string,
  eventType: string,
  stage: "before" | "partial" | "flushed",
) {
  const append = fsSync.appendFileSync;
  const error = Object.assign(new Error(`injected ${stage} append failure`), {
    code: stage === "flushed" ? "EIO" : "ENOSPC",
  });
  let injected = false;
  const failure = spyOn(fsSync, "appendFileSync").mockImplementation(
    (file, data, options) => {
      if (
        injected ||
        String(file) !== path ||
        !String(data).includes(`"type":"${eventType}"`)
      )
        return append(file, data, options);
      injected = true;
      if (stage === "partial")
        append(
          file,
          String(data).slice(0, Math.floor(String(data).length / 2)),
          options,
        );
      if (stage === "flushed") append(file, data, options);
      throw error;
    },
  );
  return { failure, error };
}
afterEach(async () => {
  mock.restore();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("disk revision contract", () => {
  test("initializes before any revision, restores reviewed state, and keeps old revisions byte-identical", async () => {
    const store = await setup();
    expect(store.manifest).toMatchObject({
      formatVersion: 1,
      status: "running",
      revisions: [],
    });
    expect(existsSync(store.path("output"))).toBe(false);
    await store.commit(simpleDraft(), { kind: "write", step: 1, width: 700 });
    await store.review(2, async () => {});
    const before = store.manifest;
    const first = before.revisions[0];
    if (!first) throw new Error("Missing revision");
    const paths = [first.markdown, first.html, first.image];
    const bytes = await Promise.all(
      paths.map((artifact) => fs.readFile(store.path(artifact.path))),
    );
    const readonly = await RunStore.open(store.directory);
    expect(readonly.manifest).toEqual(before);
    expect(await fs.readFile(store.path("run.json"), "utf8")).not.toContain(
      store.directory,
    );
    const recovered = await RunStore.open(store.directory, { mode: "recover" });
    expect(recovered.manifest).toMatchObject({
      status: "partial",
      stopReason: "interrupted",
      currentRevision: 1,
      reviewedRevision: before.reviewedRevision,
    });
    await recovered.commit(
      { ...simpleDraft(), markdown: "# Second\n" },
      { kind: "revise", step: 3, width: 700 },
    );
    expect(recovered.manifest.currentRevision).toBe(2);
    expect(recovered.manifest.reviewedRevision).toBeUndefined();
    for (const [index, artifact] of paths.entries()) {
      const expected = bytes[index];
      if (!expected) throw new Error("Missing artifact");
      expect(await fs.readFile(store.path(artifact.path))).toEqual(expected);
    }
    expect(
      (await RunStore.open(store.directory)).manifest.revisions,
    ).toHaveLength(2);
    expect((await recovered.readRevision(1))?.text).toBe(
      simpleDraft().markdown,
    );
  });

  test("requires later review and finalize steps and persists complete output only from that revision", async () => {
    const store = await setup();
    await expect(store.finalize(1)).rejects.toMatchObject({
      code: "not_ready",
    });
    await store.commit(simpleDraft(), { kind: "write", step: 1, width: 700 });
    await expect(store.review(1, async () => {})).rejects.toMatchObject({
      code: "not_ready",
    });
    await expect(
      store.review(2, async () => {
        throw new Error("preview failed");
      }),
    ).rejects.toThrow("preview failed");
    expect(store.manifest.reviewedRevision).toBeUndefined();
    await store.review(2, async () => {});
    await expect(store.finalize(2)).rejects.toMatchObject({
      code: "not_ready",
    });
    await store.finalize(3);
    expect((await fs.readdir(store.path("output"))).sort()).toEqual([
      "note.md",
      "note.png",
    ]);
    const manifest = store.manifest;
    expect(manifest.status).toBe("complete");
    if (!manifest.final || !manifest.revisions[0])
      throw new Error("Missing final output");
    expect(manifest.final?.markdown.sha256).toBe(
      manifest.revisions[0]?.markdown.sha256,
    );
    expect(manifest.final?.image.sha256).toBe(
      manifest.revisions[0]?.image.sha256,
    );
    await store.finish("filesystem", {
      kind: "filesystem",
      message: "later cleanup failed",
    });
    expect(store.manifest.status).toBe("complete");
    expect(store.manifest.error).toBeUndefined();
    expect((await RunStore.open(store.directory)).manifest.final).toEqual(
      manifest.final,
    );
    await expect(
      store.commit(simpleDraft(), { kind: "revise", step: 4, width: 700 }),
    ).rejects.toMatchObject({ code: "already_finalized" });
  });

  test("blocking layout warnings prevent finalization", async () => {
    const store = await setup();
    const revision = await store.commit(
      { ...simpleDraft(), markdown: "```mermaid\nnot a diagram\n```" },
      { kind: "write", step: 1, width: 700 },
    );
    expect(revision.warnings.some((warning) => warning.blocking)).toBe(true);
    await store.review(2, async () => {});
    await expect(store.finalize(3)).rejects.toMatchObject({
      code: "not_ready",
    });
    expect(existsSync(store.path("output"))).toBe(false);
  });

  test.each(["markdown", "html", "image"] as const)(
    "rejects a changed %s after review and on read-only open",
    async (key) => {
      const store = await reviewed();
      const revision = store.manifest.revisions[0];
      if (!revision) throw new Error("Missing revision");
      await fs.appendFile(store.path(revision[key].path), "tampered");
      await expect(store.finalize(3)).rejects.toMatchObject({
        kind: "filesystem",
      });
      await expect(RunStore.open(store.directory)).rejects.toMatchObject({
        kind: "filesystem",
      });
      expect(existsSync(store.path("output"))).toBe(false);
      expect(store.manifest.status).toBe("running");
    },
  );

  test.each(["missing", "changed"])(
    "rejects a %s original input before finalize",
    async (kind) => {
      const store = await reviewed();
      const original = store.path(store.manifest.input.path);
      if (kind === "missing") await fs.rm(original);
      else await fs.appendFile(original, "changed");
      await expect(store.finalize(3)).rejects.toMatchObject({
        kind: "filesystem",
      });
      expect(existsSync(store.path("output"))).toBe(false);
    },
  );

  test("uses output-relative figure paths and binds resource hashes to historical revisions", async () => {
    const store = await setup();
    await fs.mkdir(store.path("assets/figures"), { recursive: true });
    const figure = store.path("assets/figures/figure-001.png");
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: "white" },
    })
      .png()
      .toFile(figure);
    const draft = {
      ...simpleDraft(),
      markdown: "![Figure](../assets/figures/figure-001.png)",
    };
    const revision = await store.commit(draft, {
      kind: "write",
      step: 1,
      width: 700,
    });
    expect(revision.assets).toEqual([
      {
        path: "assets/figures/figure-001.png",
        sha256: await sha256File(figure),
      },
    ]);
    await store.review(2, async () => {});
    await store.finalize(3);
    const destination = resolve(
      store.path("output"),
      "../assets/figures/figure-001.png",
    );
    expect(destination).toBe(figure);
    const snapshot = await (
      await RunStore.open(store.directory)
    ).readRevision();
    if (!snapshot) throw new Error("Missing revision");
    const text = snapshot.text;
    expect(text).toBe(await fs.readFile(store.path("output/note.md"), "utf8"));
    expect(
      (await compileNoteMarkdown(text, { runDirectory: store.directory }))
        .assets,
    ).toEqual(revision.assets);
    await fs.appendFile(figure, "changed");
    await expect(RunStore.open(store.directory)).rejects.toMatchObject({
      kind: "filesystem",
    });
  });

  test("rejects a changed figure before finalize", async () => {
    const store = await setup();
    await fs.mkdir(store.path("assets/figures"), { recursive: true });
    const figure = store.path("assets/figures/a.png");
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toFile(figure);
    await store.commit(
      { ...simpleDraft(), markdown: "![](../assets/figures/a.png)" },
      { kind: "write", step: 1, width: 700 },
    );
    await store.review(2, async () => {});
    await fs.appendFile(figure, "changed");
    await expect(store.finalize(3)).rejects.toMatchObject({
      kind: "filesystem",
    });
    expect(existsSync(store.path("output"))).toBe(false);
  });

  test("a concurrent revision waits for review preparation and then invalidates that review", async () => {
    const store = await setup();
    await store.commit(simpleDraft(), { kind: "write", step: 1, width: 700 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let prepared = () => {};
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const review = store.review(2, async () => {
      prepared();
      await gate;
    });
    await entered;
    const revise = store.commit(simpleDraft(), {
      kind: "revise",
      step: 3,
      width: 700,
    });
    expect(store.manifest.currentRevision).toBe(1);
    release();
    await Promise.all([review, revise]);
    expect(store.manifest.currentRevision).toBe(2);
    expect(store.manifest.reviewedRevision).toBeUndefined();
    await expect(store.finalize(4)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("serializes revision and finalize transactions in either order", async () => {
    const reviseFirst = await reviewed();
    const results = await Promise.allSettled([
      reviseFirst.commit(
        { ...simpleDraft(), markdown: "New" },
        { kind: "revise", step: 3, width: 700 },
      ),
      reviseFirst.finalize(3),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(reviseFirst.manifest.currentRevision).toBe(2);
    expect(reviseFirst.manifest.final).toBeUndefined();
    const finalizeFirst = await reviewed();
    const reverse = await Promise.allSettled([
      finalizeFirst.finalize(3),
      finalizeFirst.commit(simpleDraft(), {
        kind: "revise",
        step: 3,
        width: 700,
      }),
    ]);
    expect(reverse.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(finalizeFirst.manifest.final?.revision).toBe(1);
  });
});

describe("artifact transaction failures", () => {
  test.each(["note.md", "note.html"])(
    "rolls back a revision when %s writing fails",
    async (name) => {
      const store = await reviewed();
      const before = await fs.readFile(store.path("run.json"), "utf8");
      const open = fs.open;
      spyOn(fs, "open").mockImplementation(async (path, ...args) => {
        if (String(path).includes(`.0002.tmp/${name}.tmp-`)) throw diskFull();
        return open(path, ...args);
      });
      await expect(
        store.commit(simpleDraft(), { kind: "revise", step: 3, width: 700 }),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await fs.readFile(store.path("run.json"), "utf8")).toBe(before);
      expect(await fs.readdir(store.path("intermediate/revisions"))).toEqual([
        "0001",
      ]);
    },
  );

  test("rolls back when screenshot production fails after writing HTML", async () => {
    const store = await reviewed();
    const before = store.manifest;
    spyOn(renderer, "renderDocument").mockImplementation(
      async (_note, directory) => {
        await fs.writeFile(`${directory}/note.html`, "partial rendering");
        throw diskFull();
      },
    );
    await expect(
      store.commit(simpleDraft(), { kind: "revise", step: 3, width: 700 }),
    ).rejects.toMatchObject({ kind: "filesystem" });
    expect(store.manifest).toEqual(before);
    expect(await fs.readdir(store.path("intermediate/revisions"))).toEqual([
      "0001",
    ]);
  });

  test.each(["revision", "manifest"])(
    "rolls back a revision on %s rename failure",
    async (stage) => {
      const store = await reviewed();
      const before = store.manifest;
      const rename = fs.rename;
      const previous = before.revisions[0];
      if (!previous) throw new Error("Missing revision");
      spyOn(renderer, "renderDocument").mockImplementation(
        async (note, directory, width) => {
          const htmlPath = `${directory}/note.html`,
            imagePath = `${directory}/note.png`;
          await fs.copyFile(store.path(previous.html.path), htmlPath);
          await fs.copyFile(store.path(previous.image.path), imagePath);
          return {
            htmlPath,
            imagePath,
            width,
            height: previous.height,
            warnings: note.warnings,
            structure: note.structure,
          };
        },
      );
      spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (
          stage === "manifest"
            ? String(to) === store.path("run.json")
            : String(to).endsWith("/0002")
        )
          throw diskFull();
        return rename(from, to);
      });
      await expect(
        store.commit(simpleDraft(), { kind: "revise", step: 3, width: 700 }),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(store.manifest).toEqual(before);
      expect(await fs.readdir(store.path("intermediate/revisions"))).toEqual([
        "0001",
      ]);
      expect(
        (await RunStore.open(store.directory)).manifest.currentRevision,
      ).toBe(1);
    },
  );

  test.each(["note.md", "note.png", "output", "manifest"])(
    "leaves no output after finalize %s failure",
    async (stage) => {
      const store = await reviewed();
      const before = store.manifest;
      const copyFile = fs.copyFile,
        rename = fs.rename;
      spyOn(fs, "copyFile").mockImplementation(async (from, to, flags) => {
        if (String(to).endsWith(`/output.tmp/${stage}`)) throw diskFull();
        return copyFile(from, to, flags);
      });
      spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (
          (stage === "output" && String(to) === store.path("output")) ||
          (stage === "manifest" && String(to) === store.path("run.json"))
        )
          throw diskFull();
        return rename(from, to);
      });
      await expect(store.finalize(3)).rejects.toMatchObject({
        kind: "filesystem",
      });
      expect(store.manifest).toEqual(before);
      expect(existsSync(store.path("output"))).toBe(false);
      expect(existsSync(store.path("output.tmp"))).toBe(false);
      expect(
        (await RunStore.open(store.directory)).manifest.final,
      ).toBeUndefined();
    },
  );

  test.each(["revision", "output"])(
    "recovers a process interrupted after %s promotion but before manifest commit",
    async (stage) => {
      const store = await reviewed();
      const code = `import {RunStore} from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const store=await RunStore.open(process.env.HANDNOTE_TEST_RUN,{mode:"recover"});
      const record=store.recorder.recordRevision.bind(store.recorder);
      store.recorder.recordRevision=(input)=>{const event=record(input);if(input.type===${JSON.stringify(stage === "revision" ? "document.revision.committed" : "note.finalized")}) process.exit(23);return event;};
      ${stage === "revision" ? 'await store.commit({markdown:"Second",audit:{}},{kind:"revise",step:3,width:700});' : "await store.finalize(3);"}`;
      const child = Bun.spawn([process.execPath, "-e", code], {
        env: { ...process.env, HANDNOTE_TEST_RUN: store.directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(23);
      const orphan =
        stage === "revision" ? "intermediate/revisions/0002" : "output";
      expect(existsSync(store.path(orphan))).toBe(true);
      const before = await fs.readFile(store.path("run.json"), "utf8");
      const readonly = await RunStore.open(store.directory);
      expect(readonly.manifest.currentRevision).toBe(1);
      expect(existsSync(store.path(orphan))).toBe(true);
      expect(await fs.readFile(store.path("run.json"), "utf8")).toBe(before);
      const recovered = await RunStore.open(store.directory, {
        mode: "recover",
      });
      expect(recovered.manifest.status).toBe("partial");
      expect(recovered.manifest.final).toBeUndefined();
      expect(existsSync(store.path(orphan))).toBe(false);
      await recovered.finalize(3);
      expect((await RunStore.open(store.directory)).manifest.status).toBe(
        "complete",
      );
    },
    15000,
  );
});

describe("session and recovery", () => {
  test.each([
    {
      name: "partially missing reasoning",
      steps: [{ outputTokens: 10, reasoningTokens: 4 }, { outputTokens: 8 }],
      expected: { outputTokens: 18, reasoningTokens: 4, textOutputTokens: 6 },
    },
    {
      name: "entirely missing reasoning",
      steps: [{ outputTokens: 10 }, { outputTokens: 8 }],
      expected: { outputTokens: 18 },
    },
    {
      name: "fields from different steps",
      steps: [{ outputTokens: 10 }, { reasoningTokens: 4 }],
      expected: { outputTokens: 10, reasoningTokens: 4 },
    },
    {
      name: "explicit zero reasoning",
      steps: [{ outputTokens: 10, reasoningTokens: 0 }, { outputTokens: 8 }],
      expected: { outputTokens: 18, reasoningTokens: 0, textOutputTokens: 10 },
    },
    {
      name: "explicit zero text output",
      steps: [{ outputTokens: 0, reasoningTokens: 0 }, { outputTokens: 8 }],
      expected: { outputTokens: 8, reasoningTokens: 0, textOutputTokens: 0 },
    },
    { name: "entirely missing usage", steps: [{}, {}], expected: {} },
  ] satisfies Array<{
    name: string;
    steps: TokenUsage[];
    expected: TokenUsage;
  }>)(
    "preserves per-step usage through persistence and recovery: $name",
    async ({ steps, expected }) => {
      const store = await setup();
      const state = new RunState();
      for (const usage of steps) {
        const step = state.beginModelStep();
        state.beginModelAttempt({ step, attempt: 1 });
        store.recorder.record("model.attempt.started", { step, attempt: 1 });
        state.completeModelStep(usage);
        store.recorder.record("model.step.completed", { step, usage });
        await store.updateModel(state.modelAccounting);
        expect(store.manifest.model.usage).toEqual(state.modelAccounting.usage);
      }
      expect(store.manifest.model.usage).toEqual(expected);
      await store.finish("model_stopped_no_revision");
      expect(
        (await RunStore.open(store.directory)).manifest.model.usage,
      ).toEqual(expected);
      const recovered = await RunStore.open(store.directory, {
        mode: "recover",
      });
      expect(recovered.manifest.model.usage).toEqual(expected);
      const nextStep = steps.length + 1;
      recovered.recorder.record("model.attempt.started", {
        step: nextStep,
        attempt: 1,
      });
      recovered.recorder.record("model.step.completed", {
        step: nextStep,
        usage: { outputTokens: 3, reasoningTokens: 1 },
      });
      const replayed = await RunStore.open(store.directory, {
        mode: "recover",
      });
      expect(replayed.manifest.model).toEqual({
        steps: nextStep,
        attempts: nextStep,
        retries: 0,
        usage: {
          outputTokens: (expected.outputTokens ?? 0) + 3,
          reasoningTokens: (expected.reasoningTokens ?? 0) + 1,
          textOutputTokens: (expected.textOutputTokens ?? 0) + 2,
        },
      });
      expect(
        (await RunStore.open(store.directory, { mode: "recover" })).manifest,
      ).toEqual(replayed.manifest);
    },
  );

  test("rejects legacy aggregate text totals before changing recovery evidence", async () => {
    const store = await setup();
    for (const [index, usage] of [
      { outputTokens: 10, reasoningTokens: 4 },
      { outputTokens: 8 },
    ].entries()) {
      const step = index + 1;
      store.recorder.record("model.attempt.started", { step, attempt: 1 });
      store.recorder.record("model.step.completed", { step, usage });
    }
    await store.updateModel({
      steps: 2,
      attempts: 2,
      usage: { outputTokens: 18, reasoningTokens: 4, textOutputTokens: 14 },
    });
    const orphan = store.path("intermediate/revisions/.0001.tmp/note.md");
    await fs.mkdir(store.path("intermediate/revisions/.0001.tmp"), {
      recursive: true,
    });
    await fs.writeFile(orphan, "uncommitted");
    await fs.appendFile(store.recorder.path, '{"seq":');
    const paths = [store.path("run.json"), store.recorder.path, orphan];
    const before = await Promise.all(paths.map((path) => fs.readFile(path)));
    expect((await RunStore.open(store.directory)).manifest).toEqual(
      store.manifest,
    );
    await expect(
      RunStore.open(store.directory, { mode: "recover" }),
    ).rejects.toMatchObject({
      kind: "filesystem",
      message:
        "Recorded model accounting does not match any session event prefix",
    });
    expect(await Promise.all(paths.map((path) => fs.readFile(path)))).toEqual(
      before,
    );
  });

  test.each(["before", "partial", "flushed"] as const)(
    "stops a recorder after an append failure until it is reopened: %s",
    async (stage) => {
      const store = await setup();
      const recorder = store.recorder;
      const fault = failSessionAppendOnce(recorder.path, "test.failure", stage);
      let firstError: unknown;
      try {
        recorder.record("test.failure", { message: "diagnostic" });
      } catch (error) {
        firstError = error;
      }
      fault.failure.mockRestore();
      const before = await fs.readFile(recorder.path);
      expect(() => recorder.record("test.after_failure")).toThrow();
      expect(() =>
        recorder.recordRevision({
          type: "render.reviewed",
          revision: 1,
          step: 2,
          markdownSha256: "a".repeat(64),
          imageSha256: "b".repeat(64),
        }),
      ).toThrow();
      expect(await fs.readFile(recorder.path)).toEqual(before);
      expect(firstError).toMatchObject({
        kind: "filesystem",
        cause: fault.error,
      });
      const session = readSession(recorder.path);
      const reopened = SessionRecorder.open(store.directory);
      expect(reopened.record("test.after_reopen").seq).toBe(
        session.events.length + (session.trailingBytes ? 2 : 1),
      );
      const after = readSession(recorder.path);
      expect(after.trailingBytes).toBe(0);
      expect(after.events.map((event) => event.seq)).toEqual(
        after.events.map((_, index) => index + 1),
      );
    },
  );

  test.each(["revision", "review", "finalize"] as const)(
    "preserves the confirmed revision when its %s event fails after append",
    async (operation) => {
      const store = await reviewed();
      const before = await fs.readFile(store.path("run.json"));
      if (operation === "revision") {
        const previous = store.manifest.revisions[0];
        if (!previous) throw new Error("Missing revision");
        spyOn(renderer, "renderDocument").mockImplementation(
          async (note, directory, width) => {
            const htmlPath = `${directory}/note.html`;
            const imagePath = `${directory}/note.png`;
            await fs.copyFile(store.path(previous.html.path), htmlPath);
            await fs.copyFile(store.path(previous.image.path), imagePath);
            return {
              htmlPath,
              imagePath,
              width,
              height: previous.height,
              warnings: note.warnings,
              structure: note.structure,
            };
          },
        );
      }
      const eventType =
        operation === "revision"
          ? "document.revision.committed"
          : operation === "review"
            ? "render.reviewed"
            : "note.finalized";
      const fault = failSessionAppendOnce(
        store.recorder.path,
        eventType,
        "flushed",
      );
      await expect(
        operation === "revision"
          ? store.commit(
              { ...simpleDraft(), markdown: "# 未提交的修订\n\n这是正文。" },
              { kind: "revise", step: 3, width: 700 },
            )
          : operation === "review"
            ? store.review(3, async () => {})
            : store.finalize(3),
      ).rejects.toMatchObject({ kind: "filesystem", cause: fault.error });
      fault.failure.mockRestore();
      expect(await fs.readFile(store.path("run.json"))).toEqual(before);
      expect(await fs.readdir(store.path("intermediate/revisions"))).toEqual([
        "0001",
      ]);
      expect(existsSync(store.path("output"))).toBe(false);
      expect(existsSync(store.path("output.tmp"))).toBe(false);
      expect((await RunStore.open(store.directory)).manifest).toEqual(
        JSON.parse(before.toString()),
      );
      const recovered = await RunStore.open(store.directory, {
        mode: "recover",
      });
      expect(recovered.manifest.status).toBe("partial");
      expect(recovered.manifest.final).toBeUndefined();
      expect(recovered.manifest.reviewedRevision).toEqual(
        JSON.parse(before.toString()).reviewedRevision,
      );
      expect((await recovered.readRevision())?.text).toBe(
        simpleDraft().markdown,
      );
      await recovered.finalize(4);
      expect((await RunStore.open(store.directory)).manifest.status).toBe(
        "complete",
      );
    },
    15000,
  );

  test.each(["before", "partial", "flushed"] as const)(
    "can reopen after writing a tail recovery event fails: %s",
    async (stage) => {
      const store = await setup();
      await fs.appendFile(store.recorder.path, '{"seq":');
      const before = await fs.readFile(store.path("run.json"));
      const orphan = store.path("intermediate/revisions/.0001.tmp/note.md");
      await fs.mkdir(store.path("intermediate/revisions/.0001.tmp"), {
        recursive: true,
      });
      await fs.writeFile(orphan, "uncommitted");
      const fault = failSessionAppendOnce(
        store.recorder.path,
        "session.tail.recovered",
        stage,
      );
      await expect(
        RunStore.open(store.directory, { mode: "recover" }),
      ).rejects.toMatchObject({ kind: "filesystem", cause: fault.error });
      fault.failure.mockRestore();
      expect(await fs.readFile(store.path("run.json"))).toEqual(before);
      expect(await fs.readFile(orphan, "utf8")).toBe("uncommitted");
      await RunStore.open(store.directory);
      const recovered = await RunStore.open(store.directory, {
        mode: "recover",
      });
      expect(recovered.manifest).toMatchObject({
        status: "failed",
        stopReason: "interrupted",
      });
      expect(existsSync(orphan)).toBe(false);
      const session = readSession(store.recorder.path);
      expect(session.trailingBytes).toBe(0);
      expect(session.events.map((event) => event.seq)).toEqual(
        session.events.map((_, index) => index + 1),
      );
    },
  );

  test("recovers an empty interrupted run and discards only uncommitted artifacts", async () => {
    const store = await setup();
    await fs.mkdir(store.path("intermediate/revisions/.0001.tmp"), {
      recursive: true,
    });
    await fs.writeFile(
      store.path("intermediate/revisions/.0001.tmp/note.md"),
      "half",
    );
    await fs.writeFile(
      store.path("input/original.png.tmp-deadbeef"),
      "partial input",
    );
    await fs.writeFile(store.path("run.json.tmp-deadbeef"), "partial manifest");
    const recovered = await RunStore.open(store.directory, { mode: "recover" });
    expect(existsSync(store.path("input/original.png.tmp-deadbeef"))).toBe(
      false,
    );
    expect(existsSync(store.path("run.json.tmp-deadbeef"))).toBe(false);
    expect(recovered.manifest).toMatchObject({
      status: "failed",
      stopReason: "interrupted",
      revisions: [],
    });
    expect(await fs.readdir(store.path("intermediate/revisions"))).toEqual([]);
  });

  test("recovers known model usage from durable events and redacts manifest errors", async () => {
    const store = await setup();
    store.recorder.record("model.attempt.started", { step: 1, attempt: 1 });
    store.recorder.record("model.attempt.started", { step: 1, attempt: 2 });
    store.recorder.record("model.step.completed", {
      step: 1,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 6,
        reasoningTokens: 2,
        totalTokens: 16,
      },
    });
    const recovered = await RunStore.open(store.directory, {
      mode: "recover",
      secrets: ["sk-store-secret"],
    });
    expect(recovered.manifest.model).toMatchObject({
      steps: 1,
      attempts: 2,
      retries: 1,
      usage: {
        inputTokens: 10,
        uncachedInputTokens: 6,
        cacheHitRate: 0.4,
        outputTokens: 6,
        textOutputTokens: 4,
      },
    });
    await recovered.finish("authentication", {
      kind: "authentication",
      message: "Bearer sk-store-secret data",
    });
    expect(await fs.readFile(store.path("run.json"), "utf8")).not.toContain(
      "sk-store-secret",
    );
    expect(await fs.readFile(store.recorder.path, "utf8")).not.toContain(
      "sk-store-secret",
    );
  });

  test.each([
    "missing-step",
    "non-prefix",
    "steps",
    "attempts",
    "retries",
    "unknown-is-not-zero",
  ])(
    "rejects inconsistent accounting before repairing or cleaning the run: %s",
    async (scenario) => {
      const store = await setup();
      store.recorder.record("model.attempt.started", { step: 1, attempt: 1 });
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      if (scenario !== "missing-step" && scenario !== "unknown-is-not-zero")
        store.recorder.record("model.step.completed", {
          step: 1,
          usage:
            scenario === "non-prefix"
              ? { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
              : usage,
        });
      await store.updateModel({
        steps: scenario === "steps" ? 2 : 1,
        attempts: scenario === "attempts" ? 2 : 1,
        retries: scenario === "retries" ? 1 : 0,
        usage: scenario === "unknown-is-not-zero" ? { inputTokens: 0 } : usage,
      });
      if (scenario === "non-prefix") {
        store.recorder.record("model.attempt.started", { step: 2, attempt: 1 });
        store.recorder.record("model.step.completed", {
          step: 2,
          usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
        });
      }
      const orphan = store.path("intermediate/revisions/.0001.tmp/note.md");
      await fs.mkdir(store.path("intermediate/revisions/.0001.tmp"), {
        recursive: true,
      });
      await fs.writeFile(orphan, "uncommitted revision");
      await fs.appendFile(store.recorder.path, '{"seq":');
      const paths = [store.path("run.json"), store.recorder.path, orphan];
      const before = await Promise.all(paths.map((path) => fs.readFile(path)));
      expect((await RunStore.open(store.directory)).manifest).toEqual(
        store.manifest,
      );
      await expect(
        RunStore.open(store.directory, { mode: "recover" }),
      ).rejects.toMatchObject({
        kind: "filesystem",
        message:
          "Recorded model accounting does not match any session event prefix",
      });
      expect(await Promise.all(paths.map((path) => fs.readFile(path)))).toEqual(
        before,
      );
    },
  );

  for (const confirmedPrefix of [false, true])
    test.each([
      {
        name: "malformed attempt step",
        events: [
          { type: "model.attempt.started", data: { step: "bad", attempt: 1 } },
        ],
      },
      {
        name: "malformed completed step",
        events: [
          {
            type: "model.step.completed",
            data: { step: "bad", usage: { outputTokens: 3 } },
          },
        ],
      },
      {
        name: "overflowing accumulated usage",
        events: [2, 3].map((step) => ({
          type: "model.step.completed",
          data: { step, usage: { outputTokens: 1e308 } },
        })),
      },
      {
        name: "step that cannot be converted to a number",
        events: [
          {
            type: "model.attempt.started",
            data: { step: { toString: null }, attempt: 1 },
          },
        ],
      },
    ])(
      `preserves recovery evidence for $name after a ${confirmedPrefix ? "nonempty" : "empty"} confirmed prefix`,
      async ({ events }) => {
        const store = await setup();
        if (confirmedPrefix) {
          store.recorder.record("model.attempt.started", {
            step: 1,
            attempt: 1,
          });
          await store.updateModel({ steps: 1, attempts: 1 });
        }
        for (const event of events)
          store.recorder.record(event.type, event.data);
        const orphan = store.path("intermediate/revisions/.0001.tmp/note.md");
        await fs.mkdir(store.path("intermediate/revisions/.0001.tmp"), {
          recursive: true,
        });
        await fs.writeFile(orphan, "uncommitted revision");
        await fs.appendFile(store.recorder.path, '{"seq":');
        const paths = [store.path("run.json"), store.recorder.path, orphan];
        const before = await Promise.all(
          paths.map((path) => fs.readFile(path)),
        );
        expect((await RunStore.open(store.directory)).manifest).toEqual(
          store.manifest,
        );
        await expect(
          RunStore.open(store.directory, { mode: "recover" }),
        ).rejects.toMatchObject({
          kind: "filesystem",
          message: "Session model events cannot produce valid model accounting",
        });
        expect(
          await Promise.all(paths.map((path) => fs.readFile(path))),
        ).toEqual(before);
      },
    );

  test("preserves tolerated historical model fields and unrelated diagnostics during recovery", async () => {
    const store = await setup();
    store.recorder.record("model.attempt.started");
    store.recorder.record("model.step.completed", {
      step: "2",
      usage: { outputTokens: "unknown", reasoningTokens: 0 },
    });
    store.recorder.record("model.diagnostic", { step: "bad", usage: null });
    const recovered = await RunStore.open(store.directory, { mode: "recover" });
    expect(recovered.manifest.model).toEqual({
      steps: 2,
      attempts: 1,
      retries: 0,
      usage: { reasoningTokens: 0 },
    });
    expect(
      (await RunStore.open(store.directory, { mode: "recover" })).manifest,
    ).toEqual(recovered.manifest);
  });

  test("replays events after a confirmed accounting prefix without counting them twice", async () => {
    const store = await setup();
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 6,
      reasoningTokens: 2,
      totalTokens: 16,
    };
    store.recorder.record("model.attempt.started", { step: 1, attempt: 1 });
    store.recorder.record("model.step.completed", { step: 1, usage });
    await store.updateModel({
      steps: 1,
      attempts: 1,
      usage: { ...usage, textOutputTokens: 4 },
    });
    store.recorder.record("model.attempt.started", { step: 2, attempt: 1 });
    store.recorder.record("model.attempt.started", { step: 2, attempt: 2 });
    store.recorder.record("model.step.completed", { step: 2, usage });
    const recovered = await RunStore.open(store.directory, { mode: "recover" });
    expect(recovered.manifest).toMatchObject({
      status: "failed",
      stopReason: "interrupted",
      model: {
        steps: 2,
        attempts: 3,
        retries: 1,
        usage: {
          inputTokens: 20,
          cachedInputTokens: 8,
          uncachedInputTokens: 12,
          cacheHitRate: 0.4,
          outputTokens: 12,
          reasoningTokens: 4,
          textOutputTokens: 8,
          totalTokens: 32,
        },
      },
    });
    const before = recovered.manifest;
    expect(
      (await RunStore.open(store.directory, { mode: "recover" })).manifest,
    ).toEqual(before);
  });

  test("continues session sequence and repairs only an incomplete last line", async () => {
    const store = await setup();
    store.recorder.record("test", {
      token: "secret",
      media: "data:image/png;base64,AAAA",
    });
    const count = readSession(store.recorder.path).events.length;
    await fs.appendFile(store.recorder.path, '{"seq":');
    const before = await fs.readFile(store.recorder.path);
    await RunStore.open(store.directory);
    expect(await fs.readFile(store.recorder.path)).toEqual(before);
    const recorder = SessionRecorder.open(store.directory);
    expect(recorder.record("after").seq).toBe(count + 2);
    const events = readSession(recorder.path);
    expect(events.trailingBytes).toBe(0);
    expect(events.events.at(-2)?.type).toBe("session.tail.recovered");
    await fs.appendFile(
      recorder.path,
      '{"seq":1,"time":"x","type":"duplicate"}\n',
    );
    await expect(
      RunStore.open(store.directory, { mode: "recover" }),
    ).rejects.toMatchObject({ kind: "filesystem" });
  });

  test.each(["formatVersion", "absolutePath"])(
    "rejects an invalid %s manifest without modifying it",
    async (kind) => {
      const store = await setup();
      const manifest = store.manifest;
      const invalid =
        kind === "formatVersion"
          ? { ...manifest, formatVersion: 2 }
          : { ...manifest, input: { path: "/outside.png" } };
      await fs.writeFile(store.path("run.json"), JSON.stringify(invalid));
      const before = await fs.readFile(store.path("run.json"));
      await expect(
        RunStore.open(store.directory, { mode: "recover" }),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await fs.readFile(store.path("run.json"))).toEqual(before);
    },
  );
});

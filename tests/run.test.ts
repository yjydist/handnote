import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsSync from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { HandnoteError } from "../src/errors.ts";
import { createModelPreviews, displayMetadata } from "../src/image.ts";
import { executeRun, validateInput } from "../src/run.ts";
import { readSession, SessionRecorder } from "../src/session.ts";
import { RunStore } from "../src/store.ts";
import { sha256File } from "../src/utils.ts";
import { fullRegion, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-run-`);
  directories.push(path);
  return path;
}

function completion(name: string, args: unknown, sequence: number): Response {
  const cacheHit = sequence === 1 ? 0 : 8;
  return Response.json({
    id: `offline-${sequence}`,
    object: "chat.completion",
    created: 1,
    model: "offline",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${sequence}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_hit_tokens: cacheHit,
      prompt_cache_miss_tokens: 10 - cacheHit,
    },
  });
}

function completionMany(
  calls: Array<[name: string, args: unknown]>,
  sequence: number,
): Response {
  return Response.json({
    id: `offline-${sequence}`,
    object: "chat.completion",
    created: 1,
    model: "offline",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map(([name, args], index) => ({
            id: `call-${sequence}-${index}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function textCompletion(
  sequence: number,
  usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
): Response {
  return Response.json({
    id: `offline-${sequence}`,
    object: "chat.completion",
    created: 1,
    model: "offline",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "done" },
        finish_reason: "stop",
      },
    ],
    usage,
  });
}

async function writeRunInputs(
  directory: string,
  baseUrl: string,
  apiKey: string,
): Promise<string> {
  const inputPath = `${directory}/input.png`;
  await sharp({
    create: { width: 100, height: 60, channels: 3, background: "white" },
  })
    .png()
    .toFile(inputPath);
  await writeFile(`${directory}/prompt.md`, "Use tools.");
  await writeFile(
    `${directory}/config.yaml`,
    `model:\n  baseUrl: ${baseUrl}\n  apiKey: ${JSON.stringify(apiKey)}\n  name: offline\n  timeoutMs: 5000\n  maxRetries: 0\nprompt:\n  file: prompt.md\nmaxSteps: 8\nwidth: 700\n`,
  );
  return inputPath;
}

describe("run controller", () => {
  test("inspection cleanup never follows a linked intermediate directory", async () => {
    const directory = await temporary();
    const outside = `${directory}/outside`;
    const marker = `${outside}/inspections/keep.png`;
    await mkdir(`${outside}/inspections`, { recursive: true });
    await writeFile(marker, "unrelated inspection");
    const runs = `${directory}/runs`;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        const [runName] = await readdir(runs);
        if (!runName) throw new Error("Missing run");
        await symlink(outside, `${runs}/${runName}/intermediate`);
        return textCompletion(1);
      },
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const config = `${directory}/config.yaml`;
      await writeFile(
        config,
        `${await readFile(config, "utf8")}saveIntermediateImages: false\n`,
      );
      const result = await executeRun(input, config, runs);
      expect(result.exitCode).toBe(1);
      expect(await readFile(marker, "utf8")).toBe("unrelated inspection");
      expect(
        readSession(`${result.runDirectory}/session/events.jsonl`).events.some(
          (event) => event.type === "cleanup.failed",
        ),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test.each(["a", "1"])(
    "completes and reopens with short API key %s while redacting free text",
    async (apiKey) => {
      const directory = await temporary();
      const draft = simpleDraft();
      draft.audit.uncertainties.push({
        id: "uncertainText",
        target: { quote: "这是正文。" },
        bestGuess: "这是正文。",
        candidates: ["这是正文。", "这是证文。"],
        basis: `credential=${apiKey}`,
        region: fullRegion,
        confidence: 0.7,
      });
      const script: Array<[string, unknown]> = [
        ["write_note", draft],
        ["review_render", {}],
        ["finalize_note", {}],
      ];
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          expect(request.headers.get("authorization")).toBe(`Bearer ${apiKey}`);
          const item = script[requests++];
          return item
            ? completion(item[0], item[1], requests)
            : textCompletion(requests);
        },
      });
      try {
        const input = await writeRunInputs(
          directory,
          `${server.url}v1`,
          apiKey,
        );
        const result = await executeRun(
          input,
          `${directory}/config.yaml`,
          `${directory}/runs`,
        );
        expect(result.exitCode).toBe(0);
        expect(result.manifest.status).toBe("complete");
        if (!result.manifest.final) throw new Error("Missing final output");
        for (const mode of ["read", "recover"] as const) {
          const reopened = await RunStore.open(result.runDirectory, {
            mode,
            secrets: [apiKey],
          });
          expect(reopened.manifest.final).toEqual(result.manifest.final);
          expect(reopened.manifest.model).toEqual(result.manifest.model);
        }
        const events = readSession(
          `${result.runDirectory}/session/events.jsonl`,
        ).events;
        const revision = result.manifest.revisions[0];
        if (!revision) throw new Error("Missing revision");
        for (const seq of [
          revision.commitEventSeq,
          result.manifest.reviewedRevision?.eventSeq,
          result.manifest.final?.eventSeq,
        ]) {
          if (!seq) throw new Error("Missing confirmed event");
          expect(events[seq - 1]?.data).toMatchObject({
            markdownSha256: revision.markdown.sha256,
            imageSha256: revision.image.sha256,
          });
        }
        const commit = events[revision.commitEventSeq - 1]?.data as {
          audit: typeof draft.audit;
        };
        expect(commit.audit.uncertainties[0]?.basis).not.toBe(
          `credential=${apiKey}`,
        );
        expect(commit.audit.uncertainties[0]?.basis).toContain("[REDACTED]");
        expect(await sha256File(`${result.runDirectory}/output/note.md`)).toBe(
          revision.markdown.sha256,
        );
        expect(await sha256File(`${result.runDirectory}/output/note.png`)).toBe(
          revision.image.sha256,
        );
      } finally {
        server.stop(true);
      }
    },
  );

  test.each(["complete", "partial"] as const)(
    "retains complete revisions while cleaning inspections for a %s run",
    async (expected) => {
      const directory = await temporary();
      const runs = `${directory}/runs`;
      const script: Array<[string, unknown]> = [
        [
          "inspect_source",
          { regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] },
        ],
        ["write_note", simpleDraft()],
        ...(expected === "complete"
          ? ([
              ["review_render", {}],
              ["finalize_note", {}],
            ] as Array<[string, unknown]>)
          : []),
      ];
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        fetch: async () => {
          if (requests === 0) {
            const name = (await readdir(runs))[0];
            const manifest = JSON.parse(
              await readFile(`${runs}/${name}/run.json`, "utf8"),
            );
            expect(manifest).toMatchObject({
              status: "running",
              formatVersion: 1,
              input: { path: "input/original.png" },
            });
            expect(manifest.input.sha256).toHaveLength(64);
          }
          const item = script[requests++];
          return item
            ? completion(item[0], item[1], requests)
            : textCompletion(requests);
        },
      });
      try {
        const input = await writeRunInputs(
          directory,
          `${server.url}v1`,
          "offline",
        );
        const config = await readFile(`${directory}/config.yaml`, "utf8");
        await writeFile(
          `${directory}/config.yaml`,
          `${config}saveIntermediateImages: false\n`,
        );
        const result = await executeRun(
          input,
          `${directory}/config.yaml`,
          runs,
        );
        expect(result.manifest.status).toBe(expected);
        const store = await RunStore.open(result.runDirectory);
        for (const file of ["note.md", "note.html", "note.png"])
          expect(
            await Bun.file(
              store.path(`intermediate/revisions/0001/${file}`),
            ).exists(),
          ).toBe(true);
        expect(fsSync.existsSync(store.path("intermediate/inspections"))).toBe(
          false,
        );
        expect(await Bun.file(store.path("output/note.md")).exists()).toBe(
          expected === "complete",
        );
        const events = await readFile(
          store.path("session/events.jsonl"),
          "utf8",
        );
        expect(events).toContain('"type":"media.removed"');
      } finally {
        server.stop(true);
      }
    },
    30000,
  );

  test("keeps committed completion when final accounting cannot be written", async () => {
    const directory = await temporary();
    let requests = 0;
    const script: Array<[string, unknown]> = [
      ["write_note", simpleDraft()],
      ["review_render", {}],
      ["finalize_note", {}],
    ];
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        const item = script[requests++];
        return item
          ? completion(item[0], item[1], requests)
          : textCompletion(requests);
      },
    });
    const update = RunStore.prototype.updateModel;
    const failure = spyOn(RunStore.prototype, "updateModel").mockImplementation(
      async function (this: RunStore, model) {
        if (this.manifest.status === "complete")
          throw new HandnoteError("Final accounting unavailable", "filesystem");
        return update.call(this, model);
      },
    );
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const result = await executeRun(
        input,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.manifest.status).toBe("complete");
      expect((await RunStore.open(result.runDirectory)).manifest.status).toBe(
        "complete",
      );
    } finally {
      failure.mockRestore();
      server.stop(true);
    }
  }, 30000);

  test.each(["after-complete", "cleanup", "before-finalize"])(
    "CLI preserves the committed outcome when session writes fail: %s",
    async (failureMode) => {
      const directory = await temporary();
      const runs = `${directory}/runs`;
      const script: Array<[string, unknown]> = [
        ["write_note", simpleDraft()],
        ["review_render", {}],
        ["finalize_note", {}],
      ];
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        async fetch() {
          const item = script[requests++];
          if (failureMode === "cleanup" && requests === 1) {
            const [runName] = await readdir(runs);
            const inspections = `${runs}/${runName}/intermediate/inspections`;
            await mkdir(inspections, { recursive: true });
            await writeFile(`${inspections}/evidence.png`, "inspection bytes");
          }
          return item
            ? completion(item[0], item[1], requests)
            : textCompletion(requests);
        },
      });
      try {
        const input = await writeRunInputs(
          directory,
          `${server.url}v1`,
          "offline",
        );
        const config = `${directory}/config.yaml`;
        await writeFile(
          config,
          `${await readFile(config, "utf8")}saveIntermediateImages: false\n`,
        );
        const faultPath = `${directory}/session-failure.ts`;
        const snapshotPath = `${directory}/before-failure.json`;
        await writeFile(
          faultPath,
          `
          import { existsSync, readFileSync, writeFileSync } from "node:fs";
          import { SessionRecorder } from ${JSON.stringify(`${import.meta.dir}/../src/session.ts`)};
          const record = SessionRecorder.prototype.record;
          const mode = ${JSON.stringify(failureMode)};
          let failed = false;
          SessionRecorder.prototype.record = function(type, data) {
            const path = this.runDirectory + "/run.json";
            const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
            const shouldFail = mode === "cleanup"
              ? type === "media.removed" || type === "cleanup.failed"
              : mode === "after-complete"
                ? manifest?.status === "complete"
                : Boolean(manifest?.currentRevision);
            if (shouldFail) {
              if (!failed) writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({
                manifest: readFileSync(path, "utf8"),
                session: readFileSync(this.path, "utf8"),
              }));
              failed = true;
              throw Object.assign(new Error("injected session disk full"), { code: "ENOSPC" });
            }
            return record.call(this, type, data);
          };
        `,
        );
        const child = Bun.spawn(
          [
            "bun",
            "--preload",
            faultPath,
            "src/cli.ts",
            "run",
            input,
            "--config",
            config,
            "--output",
            runs,
            "--json",
          ],
          { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stdout.trim().split("\n")).toHaveLength(1);
        const result = JSON.parse(stdout);
        const [runName] = await readdir(runs);
        const store = await RunStore.open(`${runs}/${runName}`);
        const before = JSON.parse(await readFile(snapshotPath, "utf8"));
        expect(await readFile(store.path("run.json"), "utf8")).toBe(
          before.manifest,
        );
        expect(await readFile(store.path("session/events.jsonl"), "utf8")).toBe(
          before.session,
        );
        if (failureMode === "before-finalize") {
          expect(code).toBe(1);
          expect(result).toMatchObject({
            status: "failed",
            stopReason: "filesystem",
          });
          expect(store.manifest.status).toBe("running");
          expect(store.manifest.currentRevision).toBe(1);
          expect(await Bun.file(store.path("output/note.md")).exists()).toBe(
            false,
          );
          expect(await Bun.file(store.path("output/note.png")).exists()).toBe(
            false,
          );
        } else {
          expect(code).toBe(0);
          expect(result).toMatchObject({
            status: "complete",
            exitCode: 0,
            runDirectory: store.directory,
          });
          expect(stderr).toContain("Final output is complete");
          const final = store.manifest.final;
          if (!final) throw new Error("Missing final output");
          for (const artifact of [final.markdown, final.image])
            expect(await sha256File(store.path(artifact.path))).toBe(
              artifact.sha256,
            );
          if (failureMode === "cleanup")
            expect(
              await readFile(
                store.path("intermediate/inspections/evidence.png"),
                "utf8",
              ),
            ).toBe("inspection bytes");
        }
      } finally {
        server.stop(true);
      }
    },
    30000,
  );

  test.each(["partial", "flushed"] as const)(
    "keeps complete output after an actual session append failure: %s",
    async (stage) => {
      const directory = await temporary();
      const script: Array<[string, unknown]> = [
        ["write_note", simpleDraft()],
        ["review_render", {}],
        ["finalize_note", {}],
      ];
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        fetch() {
          const item = script[requests++];
          return item
            ? completion(item[0], item[1], requests)
            : textCompletion(requests);
        },
      });
      const append = fsSync.appendFileSync;
      let snapshot:
        | {
            manifest: Buffer<ArrayBuffer>;
            session: Buffer<ArrayBuffer>;
          }
        | undefined;
      const failure = spyOn(fsSync, "appendFileSync").mockImplementation(
        (path, data, options) => {
          const manifestPath = String(path).replace(
            /\/session\/events\.jsonl$/,
            "/run.json",
          );
          if (
            !snapshot &&
            fsSync.existsSync(manifestPath) &&
            JSON.parse(fsSync.readFileSync(manifestPath, "utf8")).status ===
              "complete"
          ) {
            append(
              path,
              stage === "partial"
                ? String(data).slice(0, Math.floor(String(data).length / 2))
                : data,
              options,
            );
            snapshot = {
              manifest: fsSync.readFileSync(manifestPath),
              session: fsSync.readFileSync(path),
            };
            throw Object.assign(
              new Error("injected append failure after completion"),
              { code: "EIO" },
            );
          }
          return append(path, data, options);
        },
      );
      try {
        const input = await writeRunInputs(
          directory,
          `${server.url}v1`,
          "offline",
        );
        const result = await executeRun(
          input,
          `${directory}/config.yaml`,
          `${directory}/runs`,
        );
        failure.mockRestore();
        if (!snapshot) throw new Error("Append failure was not injected");
        expect(result.exitCode).toBe(0);
        expect(result.manifest.status).toBe("complete");
        const committedFinal = result.manifest.final;
        if (!committedFinal) throw new Error("Missing committed final output");
        const store = await RunStore.open(result.runDirectory);
        expect(await readFile(store.path("run.json"))).toEqual(
          snapshot.manifest,
        );
        expect(await readFile(store.path("session/events.jsonl"))).toEqual(
          snapshot.session,
        );
        expect(
          readSession(store.path("session/events.jsonl")).trailingBytes > 0,
        ).toBe(stage === "partial");
        const recovered = await RunStore.open(store.directory, {
          mode: "recover",
        });
        expect(recovered.manifest.status).toBe("complete");
        expect(recovered.manifest.final).toEqual(committedFinal);
        const final = recovered.manifest.final;
        if (!final) throw new Error("Missing final output");
        for (const artifact of [final.markdown, final.image])
          expect(await sha256File(store.path(artifact.path))).toBe(
            artifact.sha256,
          );
      } finally {
        failure.mockRestore();
        server.stop(true);
      }
    },
    30000,
  );

  test("preserves saved usage when a completed-step event could not be written", async () => {
    const directory = await temporary();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        textCompletion(1, {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
    });
    const record = SessionRecorder.prototype.record;
    let failed = false;
    const failure = spyOn(
      SessionRecorder.prototype,
      "record",
    ).mockImplementation(function (this: SessionRecorder, type, data) {
      if (type === "model.step.completed" && !failed) {
        failed = true;
        throw Object.assign(new Error("injected session disk full"), {
          code: "ENOSPC",
        });
      }
      return record.call(this, type, data);
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const result = await executeRun(
        input,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(failed).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.manifest).toMatchObject({
        status: "failed",
        model: {
          steps: 1,
          attempts: 1,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      });
      const store = await RunStore.open(result.runDirectory);
      expect(store.manifest.model).toEqual(result.manifest.model);
      const paths = [
        store.path("run.json"),
        store.path("session/events.jsonl"),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      expect(
        readSession(store.path("session/events.jsonl")).events.some(
          (event) => event.type === "model.step.completed",
        ),
      ).toBe(false);
      await expect(
        RunStore.open(store.directory, { mode: "recover" }),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
        before,
      );
    } finally {
      failure.mockRestore();
      server.stop(true);
    }
  }, 30000);

  test("recognizes PNG, JPEG, and WebP display input", async () => {
    const directory = await temporary();
    for (const [format, extension] of [
      ["png", "png"],
      ["jpeg", "jpg"],
      ["jpeg", "jpeg"],
      ["webp", "webp"],
    ] as const) {
      const path = `${directory}/image.${extension}`;
      await sharp({
        create: { width: 20, height: 10, channels: 3, background: "white" },
      })
        [format]()
        .toFile(path);
      expect((await validateInput(path)).mimeType).toBe(`image/${format}`);
    }
  });

  test("preserves EXIF display orientation and original input bytes during validation", async () => {
    const directory = await temporary();
    const path = `${directory}/rotated.jpg`;
    const original = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    await writeFile(path, original);

    expect(await validateInput(path)).toMatchObject({ mimeType: "image/jpeg" });
    expect((await readFile(path)).equals(original)).toBe(true);
    expect(await displayMetadata(path)).toEqual({
      width: 10,
      height: 20,
      mimeType: "image/jpeg",
    });
    expect(
      await createModelPreviews(path, { maxEdge: 2048, jpegQuality: 85 }),
    ).toMatchObject([{ width: 10, height: 20 }]);
  });

  test("rejects truncated image pixels even when the PNG header is readable", async () => {
    const directory = await temporary();
    const path = `${directory}/truncated.png`;
    const original = await sharp({
      create: { width: 100, height: 60, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await writeFile(
      path,
      original.subarray(0, Math.floor(original.length / 2)),
    );

    expect(await displayMetadata(path)).toEqual({
      width: 100,
      height: 60,
      mimeType: "image/png",
    });
    await expect(validateInput(path)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("Input is not a readable image"),
    });
  });

  test("rejects unsupported decoded formats and extension mismatches", async () => {
    const directory = await temporary();
    const mismatch = `${directory}/jpeg-named-png.png`;
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .jpeg()
      .toFile(mismatch);
    await expect(validateInput(mismatch)).rejects.toThrow(
      "does not match decoded image/jpeg content",
    );

    const unsupported = `${directory}/gif-named-png.png`;
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .gif()
      .toFile(unsupported);
    await expect(validateInput(unsupported)).rejects.toThrow(
      "Unsupported decoded image format: gif",
    );
  });

  test("creates a complete run through a local scripted Provider and leaves no secrets or Base64 in the session", async () => {
    const directory = await temporary();
    const inputPath = `${directory}/手 写.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(inputPath);
    const inputHash = await sha256File(inputPath);
    await writeFile(
      `${directory}/prompt.md`,
      "Use the required tools in order.",
    );
    let requests = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const draft = simpleDraft();
    draft.audit.uncertainties.push({
      id: "uncertainText",
      target: { quote: "这是正文。" },
      bestGuess: "这是正文。",
      candidates: ["这是正文。", "这是证文。"],
      basis: "session-only-basis",
      region: fullRegion,
      confidence: 0.7,
    });
    draft.audit.corrections.push({
      id: "correctedText",
      target: { quote: "这是正文。" },
      original: "这是证文。",
      corrected: "这是正文。",
      basis: "session-only-correction-basis",
      region: fullRegion,
      confidence: 0.99,
    });
    const revised: typeof draft = {
      markdown: `${draft.markdown}\n补充一段。\n`,
      audit: draft.audit,
    };
    const script = [
      ["write_note", draft],
      ["revise_note", revised],
      ["review_render", {}],
      ["finalize_note", {}],
    ] as const;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        expect(request.method).toBe("POST");
        requestBodies.push((await request.json()) as Record<string, unknown>);
        const current = script[requests++];
        if (!current)
          return new Response("unexpected request", { status: 500 });
        return completion(current[0], current[1], requests);
      },
    });
    try {
      await writeFile(
        `${directory}/config.yaml`,
        `model:\n  baseUrl: ${server.url}v1\n  apiKey: super-secret-offline-key\n  name: offline\n  timeoutMs: 5000\n  maxRetries: 0\nprompt:\n  file: prompt.md\nmaxSteps: 8\nwidth: 700\nsaveIntermediateImages: false\n`,
      );
      const result = await executeRun(
        inputPath,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(result.manifest.status).toBe("complete");
      expect(result.exitCode).toBe(0);
      expect(requests).toBe(4);
      expect(result.manifest.final?.revision).toBe(2);
      expect(result.manifest.model.usage.totalTokens).toBe(60);
      expect(result.manifest.model.usage).toMatchObject({
        inputTokens: 40,
        cachedInputTokens: 24,
        uncachedInputTokens: 16,
        cacheHitRate: 0.6,
      });
      const fourthMessages = requestBodies[3]?.messages as Array<
        Record<string, unknown>
      >;
      const toolMessages = fourthMessages.filter(
        (message) => message.role === "tool",
      );
      expect(JSON.stringify(toolMessages)).not.toMatch(
        /[A-Za-z0-9+/]{512,}={0,2}/,
      );
      const visualMessage = [...fourthMessages]
        .reverse()
        .find(
          (message) =>
            message.role === "user" && Array.isArray(message.content),
        );
      expect(JSON.stringify(visualMessage)).toContain(
        "data:image/jpeg;base64,",
      );
      const runDirectory = result.runDirectory;
      if (!runDirectory) throw new Error("missing run directory");
      expect(await sha256File(`${runDirectory}/input/original.png`)).toBe(
        inputHash,
      );
      expect(await Bun.file(`${runDirectory}/output/note.md`).exists()).toBe(
        true,
      );
      expect(await Bun.file(`${runDirectory}/output/note.png`).exists()).toBe(
        true,
      );
      const noteMarkdown = await readFile(
        `${runDirectory}/output/note.md`,
        "utf8",
      );
      expect(noteMarkdown).toBe(revised.markdown);
      expect(noteMarkdown).not.toContain("audit");
      expect(noteMarkdown).not.toContain("session-only");
      expect(
        await Bun.file(
          `${runDirectory}/intermediate/revisions/0001/note.md`,
        ).exists(),
      ).toBe(true);
      expect(
        (await readFile(
          `${runDirectory}/intermediate/revisions/0001/note.md`,
          "utf8",
        )) === draft.markdown,
      ).toBe(true);
      const finalSha = result.manifest.final?.markdown.sha256;
      if (!finalSha) throw new Error("missing final markdown sha");
      expect(
        await sha256File(`${runDirectory}/intermediate/revisions/0002/note.md`),
      ).toBe(finalSha);
      expect(await sha256File(`${runDirectory}/output/note.md`)).toBe(finalSha);
      expect(
        fsSync.existsSync(`${runDirectory}/intermediate/inspections`),
      ).toBe(false);
      expect(
        (await stat(`${runDirectory}/intermediate/revisions`)).isDirectory(),
      ).toBe(true);
      const session = await readFile(
        `${runDirectory}/session/events.jsonl`,
        "utf8",
      );
      expect(session).not.toContain("super-secret-offline-key");
      expect(session).not.toContain("Bearer ");
      expect(session).not.toMatch(/[A-Za-z0-9+/]{512,}={0,2}/);
      const events = session
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const attemptEvents = events.filter(
        (event) => event.type === "model.attempt.started",
      );
      expect(attemptEvents).toHaveLength(4);
      expect(attemptEvents[3].data.request).toMatchObject({
        imageCount: 2,
      });
      const committed = events.find(
        (event) => event.type === "document.revision.committed",
      );
      expect(committed.data.audit.uncertainties[0]).toMatchObject({
        id: "uncertainText",
        bestGuess: "这是正文。",
        basis: "session-only-basis",
      });
      expect(committed.data.audit.corrections[0]).toMatchObject({
        id: "correctedText",
        original: "这是证文。",
        corrected: "这是正文。",
        basis: "session-only-correction-basis",
        confidence: 0.99,
      });
      const eventSequences = events.map((event) => event.seq);
      expect(eventSequences).toEqual(
        eventSequences.map((_: number, index: number) => index + 1),
      );
      expect((await readdir(runDirectory)).sort()).toEqual(
        expect.arrayContaining([
          "input",
          "output",
          "intermediate",
          "run.json",
          "session",
        ]),
      );
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("keeps a successful same-step finalize complete despite a concurrent fatal tool error", async () => {
    const directory = await temporary();
    let requests = 0;
    const runs = `${directory}/runs`;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        requests++;
        if (requests === 1)
          return completion("write_note", simpleDraft(), requests);
        if (requests === 2) return completion("review_render", {}, requests);
        if (requests === 3) {
          const [runName] = await readdir(runs);
          if (!runName) throw new Error("missing allocated run");
          await writeFile(
            `${runs}/${runName}/assets`,
            "blocks directory creation",
          );
          return completionMany(
            [
              ["finalize_note", {}],
              [
                "capture_figure",
                { region: { x: 0, y: 0, width: 1, height: 1 } },
              ],
            ],
            requests,
          );
        }
        return new Response("unexpected request", { status: 500 });
      },
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const result = await executeRun(input, `${directory}/config.yaml`, runs);
      expect(result).toMatchObject({
        exitCode: 0,
        manifest: {
          status: "complete",
          stopReason: "finalized",
          final: { revision: 1 },
        },
      });
      expect(result.manifest.error).toBeUndefined();
      const session = await readFile(
        `${result.runDirectory}/session/events.jsonl`,
        "utf8",
      );
      expect(session).toContain('"type":"run.error"');
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("emits a usable partial when the model stops after a valid revision", async () => {
    const directory = await temporary();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        return requests === 1
          ? completion("write_note", simpleDraft(), requests)
          : textCompletion(requests);
      },
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const result = await executeRun(
        input,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(result.manifest.status).toBe("partial");
      expect(result.exitCode).toBe(2);
      expect(result.manifest.stopReason).toBe("model_stopped");
      expect(
        await Bun.file(`${result.runDirectory}/output/note.png`).exists(),
      ).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test.each([false, true])(
    "keeps authentication diagnostics safe with JSON mode %s",
    async (json) => {
      const directory = await temporary();
      const apiKey = "sk-authentication-secret";
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          Response.json(
            {
              error: {
                message: `invalid API key ${apiKey}`,
                type: "authentication",
              },
            },
            { status: 401 },
          ),
      });
      try {
        const input = await writeRunInputs(
          directory,
          `${server.url}v1`,
          apiKey,
        );
        const child = Bun.spawn(
          [
            process.execPath,
            "run",
            "src/cli.ts",
            "run",
            input,
            "--config",
            `${directory}/config.yaml`,
            "--output",
            `${directory}/runs`,
            ...(json ? ["--json"] : []),
          ],
          { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code).toBe(1);
        expect(stdout).not.toContain(apiKey);
        expect(stderr).not.toContain(apiKey);
        expect(stderr).not.toContain("responseBody");
        expect(stderr).not.toContain("requestBodyValues");
        expect(stderr).toContain("authentication");
        expect(stderr).toContain("401");
        expect(stdout.trim().split("\n")).toHaveLength(1);
        const [runName] = await readdir(`${directory}/runs`);
        const runDirectory = `${directory}/runs/${runName}`;
        const manifestText = await readFile(`${runDirectory}/run.json`, "utf8");
        expect(manifestText).not.toContain(apiKey);
        expect(JSON.parse(manifestText)).toMatchObject({
          status: "failed",
          stopReason: "authentication",
          error: { kind: "authentication" },
        });
        if (json)
          expect(JSON.parse(stdout)).toMatchObject({
            status: "failed",
            exitCode: 1,
            runDirectory,
            error: { kind: "authentication" },
          });
        else expect(stdout.trim()).toBe(`failed: ${runDirectory}`);
        expect(await Bun.file(`${runDirectory}/output/note.md`).exists()).toBe(
          false,
        );
        const session = await readFile(
          `${runDirectory}/session/events.jsonl`,
          "utf8",
        );
        expect(session).not.toContain(apiKey);
        expect(session).not.toContain("responseBody");
        expect(session).not.toContain("requestBodyValues");
        expect(session).toContain('"statusCode":401');
      } finally {
        server.stop(true);
      }
    },
  );

  test("retains a valid revision as partial after a later authentication failure", async () => {
    const directory = await temporary();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        if (requests === 1)
          return completion("write_note", simpleDraft(), requests);
        if (requests === 2) return completion("review_render", {}, requests);
        return Response.json(
          { error: { message: "invalid API key", type: "authentication" } },
          { status: 401 },
        );
      },
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const result = await executeRun(
        input,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(result.manifest.status).toBe("partial");
      expect(result.exitCode).toBe(2);
      expect(result.manifest.stopReason).toBe("authentication");
      expect(result.manifest.error?.kind).toBe("authentication");
      expect(result.manifest.currentRevision).toBe(1);
      expect(result.manifest.final).toBeUndefined();
      expect(result.manifest.model.usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: 8,
        uncachedInputTokens: 12,
      });
      expect(
        await Bun.file(`${result.runDirectory}/output/note.md`).exists(),
      ).toBe(false);
      expect(
        await Bun.file(`${result.runDirectory}/output/note.png`).exists(),
      ).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("invalid CLI preflight does not create the output root", async () => {
    const directory = await temporary();
    const output = `${directory}/runs`;
    const processResult = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli.ts",
        "run",
        `${directory}/missing.png`,
        "--config",
        `${directory}/missing.yaml`,
        "--output",
        output,
        "--json",
      ],
      { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      processResult.exited,
    ]);
    const parsed = JSON.parse(stdout.trim());
    expect(code).toBe(1);
    expect(parsed.status).toBe("failed");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(fsSync.existsSync(output)).toBe(false);
  });

  test("truncated image CLI preflight creates no output and sends no Provider request", async () => {
    const directory = await temporary();
    const output = `${directory}/runs`;
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        return Response.json(
          { error: { message: "invalid image content" } },
          { status: 400 },
        );
      },
    });
    try {
      const input = await writeRunInputs(
        directory,
        `${server.url}v1`,
        "offline",
      );
      const original = await readFile(input);
      await writeFile(
        input,
        original.subarray(0, Math.floor(original.length / 2)),
      );
      const child = Bun.spawn(
        [
          "bun",
          "run",
          "src/cli.ts",
          "run",
          input,
          "--config",
          `${directory}/config.yaml`,
          "--output",
          output,
          "--json",
        ],
        { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect({
        result: JSON.parse(stdout),
        requests,
        outputExists: fsSync.existsSync(output),
      }).toEqual({
        result: {
          status: "failed",
          exitCode: 1,
          stopReason: "validation",
          error: {
            kind: "validation",
            message: expect.stringContaining("Input is not a readable image"),
          },
        },
        requests: 0,
        outputExists: false,
      });
      expect(stderr).toBe("");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("reports output initialization failures as filesystem errors", async () => {
    const directory = await temporary();
    const input = await writeRunInputs(
      directory,
      "https://offline.invalid/v1",
      "offline",
    );
    const outputFile = `${directory}/occupied`;
    await writeFile(outputFile, "not a directory");
    const processResult = Bun.spawn(
      [
        "bun",
        "run",
        "src/cli.ts",
        "run",
        input,
        "--config",
        `${directory}/config.yaml`,
        "--output",
        outputFile,
        "--json",
      ],
      { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      processResult.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      status: "failed",
      stopReason: "filesystem",
      error: { kind: "filesystem" },
    });
  });

  test("top-level and run help exit successfully", async () => {
    for (const args of [["--help"], ["run", "--help"]]) {
      const processResult = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
        cwd: `${import.meta.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(processResult.stdout).text(),
        new Response(processResult.stderr).text(),
        processResult.exited,
      ]);
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("Usage: handnote");
    }
  });
});

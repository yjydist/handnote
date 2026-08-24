import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { executeRun, validateInput } from "../src/run.ts";
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

function textCompletion(sequence: number): Response {
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
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
    `model:\n  baseUrl: ${baseUrl}\n  apiKey: ${apiKey}\n  name: offline\n  timeoutMs: 5000\n  maxRetries: 0\nprompt:\n  file: prompt.md\nmaxSteps: 8\nwidth: 700\n`,
  );
  return inputPath;
}

describe("run controller", () => {
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
      target: { kind: "block", blockId: "paragraph-1" },
      bestGuess: "这是正文。",
      candidates: ["这是正文。", "这是证文。"],
      basis: "session-only-basis",
      region: fullRegion,
      confidence: 0.7,
    });
    draft.audit.corrections.push({
      id: "correctedText",
      target: { kind: "block", blockId: "paragraph-1" },
      original: "这是证文。",
      corrected: "这是正文。",
      basis: "session-only-correction-basis",
      region: fullRegion,
      confidence: 0.99,
    });
    const script = [
      ["write_document", draft],
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
      expect(result.status).toBe("complete");
      expect(result.exitCode).toBe(0);
      expect(requests).toBe(3);
      expect(result.final?.revision).toBe(1);
      expect(result.model.usage.totalTokens).toBe(45);
      expect(result.model.usage).toMatchObject({
        inputTokens: 30,
        cachedInputTokens: 16,
        uncachedInputTokens: 14,
        cacheHitRate: 0.533333,
      });
      const thirdMessages = requestBodies[2]?.messages as Array<
        Record<string, unknown>
      >;
      const toolMessages = thirdMessages.filter(
        (message) => message.role === "tool",
      );
      expect(JSON.stringify(toolMessages)).not.toMatch(
        /[A-Za-z0-9+/]{512,}={0,2}/,
      );
      const visualMessage = [...thirdMessages]
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
      expect(await sha256File(`${runDirectory}/original.png`)).toBe(inputHash);
      expect(await Bun.file(`${runDirectory}/note.json`).exists()).toBe(true);
      expect(await Bun.file(`${runDirectory}/note.png`).exists()).toBe(true);
      const note = JSON.parse(
        await readFile(`${runDirectory}/note.json`, "utf8"),
      );
      expect(note).toEqual(draft.document);
      expect(note).not.toHaveProperty("audit");
      expect(note).not.toHaveProperty("summary");
      expect(note).not.toHaveProperty("corrections");
      expect(note).not.toHaveProperty("uncertainties");
      expect(await Bun.file(`${runDirectory}/intermediate`).exists()).toBe(
        false,
      );
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
      expect(attemptEvents).toHaveLength(3);
      expect(attemptEvents[2].data.request).toMatchObject({
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
          "note.json",
          "note.png",
          "original.png",
          "run.json",
          "session",
        ]),
      );
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
          ? completion("write_document", simpleDraft(), requests)
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
      expect(result.status).toBe("partial");
      expect(result.exitCode).toBe(2);
      expect(result.stopReason).toBe("model_stopped");
      expect(await Bun.file(`${result.runDirectory}/note.png`).exists()).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("writes a failed manifest and no note after authentication rejection", async () => {
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
      const input = await writeRunInputs(directory, `${server.url}v1`, apiKey);
      const result = await executeRun(
        input,
        `${directory}/config.yaml`,
        `${directory}/runs`,
      );
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.error?.kind).toBe("authentication");
      expect(await Bun.file(`${result.runDirectory}/run.json`).exists()).toBe(
        true,
      );
      expect(await Bun.file(`${result.runDirectory}/note.json`).exists()).toBe(
        false,
      );
      const session = await readFile(
        `${result.runDirectory}/session/events.jsonl`,
        "utf8",
      );
      expect(session).not.toContain(apiKey);
      expect(session).not.toContain("responseBody");
      expect(session).not.toContain("requestBodyValues");
      expect(session).toContain('"statusCode":401');
    } finally {
      server.stop(true);
    }
  });

  test("retains a valid revision as partial after a later authentication failure", async () => {
    const directory = await temporary();
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++;
        if (requests === 1)
          return completion("write_document", simpleDraft(), requests);
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
      expect(result.status).toBe("partial");
      expect(result.exitCode).toBe(2);
      expect(result.stopReason).toBe("authentication");
      expect(result.error?.kind).toBe("authentication");
      expect(result.final?.revision).toBe(1);
      expect(result.model.usage).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: 8,
        uncachedInputTokens: 12,
      });
      expect(await Bun.file(`${result.runDirectory}/note.json`).exists()).toBe(
        true,
      );
      expect(await Bun.file(`${result.runDirectory}/note.png`).exists()).toBe(
        true,
      );
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
    expect(await Bun.file(output).exists()).toBe(false);
  });

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

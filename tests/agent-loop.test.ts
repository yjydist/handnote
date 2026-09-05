import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";
import {
  accumulateAgentUsage,
  createAgentRunStats,
  runAgent,
} from "../src/agent.ts";
import type { HandnoteConfig } from "../src/config.ts";
import type { createModel } from "../src/provider/index.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { createStoreFixture, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

test("accumulates completed-step usage including reasoning", () => {
  const stats = createAgentRunStats();
  accumulateAgentUsage(stats, {
    inputTokens: 10,
    outputTokens: 7,
    totalTokens: 17,
    cachedInputTokens: 6,
    reasoningTokens: 5,
  });
  accumulateAgentUsage(stats, {
    inputTokens: 20,
    outputTokens: 4,
    totalTokens: 24,
    cachedInputTokens: 12,
    reasoningTokens: 1,
  });
  expect(stats).toEqual({
    completedSteps: 2,
    usage: {
      inputTokens: 30,
      outputTokens: 11,
      totalTokens: 41,
      cachedInputTokens: 18,
      reasoningTokens: 6,
      textOutputTokens: 5,
    },
  });
});

test("runs an offline Mastra media tool loop and stops immediately after valid finalize", async () => {
  const directory = await mkdtemp(`${tmpdir()}/handnote-agent-`);
  directories.push(directory);
  const sourcePath = `${directory}/original.png`;
  await sharp({
    create: { width: 160, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toFile(sourcePath);
  const state = new RunState();
  const store = await createStoreFixture(directory);
  const recorder = store.recorder;
  const tools = createHandnoteTools({
    store,
    sourcePath,
    runDirectory: directory,
    width: 700,
    maxSteps: 18,
    maxInspectCalls: 3,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
    state,
    recorder,
  });
  const script = [
    { name: "write_note", input: JSON.stringify(simpleDraft()) },
    { name: "review_render", input: "{}" },
    { name: "finalize_note", input: "{}" },
  ];
  let call = 0;
  const generateForCall = async (): Promise<LanguageModelV3GenerateResult> => {
    const current = script[call++];
    state.beginModelStep();
    if (!current) throw new Error("unexpected extra model call");
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${call}`,
          toolName: current.name,
          input: current.input,
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
      warnings: [],
    };
  };
  const model = new MockLanguageModelV3({
    modelId: "offline",
    doGenerate: generateForCall,
  });
  const config: HandnoteConfig = {
    model: {
      provider: "openai-compatible",
      baseUrl: "https://offline.invalid/v1",
      apiKey: "offline",
      name: "offline",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    prompt: { file: "prompt.md" },
    maxSteps: 10,
    maxInspectCalls: 3,
    width: 700,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
    theme: "clean",
    fontFamily: "sans-serif",
    saveIntermediateImages: true,
    configPath: `${directory}/config.yaml`,
    promptPath: `${directory}/prompt.md`,
    promptText: "Use the tools.",
  };
  const result = await runAgent({
    config,
    model: model as unknown as ReturnType<typeof createModel>,
    tools,
    sourcePath,
    sourceMimeType: "image/png",
    recorder,
    state,
    stats: createAgentRunStats(),
  });
  expect(result.steps).toBe(3);
  expect(call).toBe(3);
  expect(state.finalized).toBe(true);
  expect(model.doGenerateCalls[2]?.prompt).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "tool" })]),
  );
  const toolMessages = model.doGenerateCalls[2]?.prompt.filter(
    (message) => message.role === "tool",
  );
  expect(JSON.stringify(toolMessages?.[1])).toContain(
    '"mediaType":"image/jpeg"',
  );
  expect(JSON.stringify(toolMessages?.[1])).toContain('"type":"content"');
  expect(JSON.stringify(toolMessages?.[1])).toContain('"type":"image-data"');
}, 30_000);

test("records safe stream diagnostics and their model step", async () => {
  const directory = await mkdtemp(`${tmpdir()}/handnote-agent-error-`);
  directories.push(directory);
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "tests/fixtures/agent-stream-error.ts",
      directory,
    ],
    { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout).not.toContain("sk-stream-error-secret");
  expect(stderr).not.toContain("sk-stream-error-secret");
  expect(stderr).toContain("provider_transient");
  expect(stderr).toContain("TimeoutError");
  expect(JSON.parse(stdout)).toEqual({
    kind: "provider_transient",
    message: "Provider request timed out",
  });
  const session = await readFile(`${directory}/session/events.jsonl`, "utf8");
  expect(session).not.toContain("sk-stream-error-secret");
  const events = session
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "model.stream.error")?.data,
  ).toEqual({
    step: 1,
    kind: "provider_transient",
    message: "Provider request timed out",
  });
});

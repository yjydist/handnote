import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";
import { createAgentRunStats, runAgent } from "../../src/agent.ts";
import type { HandnoteConfig } from "../../src/config.ts";
import { HandnoteError } from "../../src/errors.ts";
import type { createModel } from "../../src/provider/index.ts";
import { RunState } from "../../src/state.ts";
import { createHandnoteTools } from "../../src/tools/index.ts";
import { createStoreFixture } from "../helpers.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Missing fixture directory");
const apiKey = "sk-stream-error-secret";
const sourcePath = `${directory}/original.png`;
await sharp({
  create: { width: 80, height: 50, channels: 3, background: "white" },
})
  .png()
  .toFile(sourcePath);
const state = new RunState();
const store = await createStoreFixture(directory, { secrets: [apiKey] });
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
const model = new MockLanguageModelV3({
  modelId: "offline-timeout",
  doGenerate: async () => {
    state.beginModelStep();
    throw new DOMException(`request ${apiKey} timed out`, "TimeoutError");
  },
});
const config: HandnoteConfig = {
  model: {
    provider: "openai-compatible",
    baseUrl: "https://offline.invalid/v1",
    apiKey,
    name: "offline",
    timeoutMs: 1_000,
    maxRetries: 0,
  },
  prompt: { file: "prompt.md" },
  maxSteps: 3,
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
try {
  await runAgent({
    config,
    model: model as unknown as ReturnType<typeof createModel>,
    tools,
    sourcePath,
    sourceMimeType: "image/png",
    recorder,
    state,
    stats: createAgentRunStats(),
  });
  throw new Error("Expected model failure");
} catch (error) {
  if (!(error instanceof HandnoteError)) throw error;
  process.stdout.write(
    `${JSON.stringify({ kind: error.kind, message: error.message })}\n`,
  );
}

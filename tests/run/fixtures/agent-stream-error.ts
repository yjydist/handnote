import { readFile } from "node:fs/promises";
import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";
import { AgentError, runAgent } from "../../../src/agent/index.ts";
import type { HandnoteConfig } from "../../../src/config.ts";
import { createHandnoteHandlers } from "../../../src/tools/index.ts";
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
const store = await createStoreFixture(directory, { secrets: [apiKey] });
const recorder = store.recorder;
const handlers = createHandnoteHandlers({
  store,
  sourcePath,
  width: 700,
  maxInspectCalls: 3,
  toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  recorder,
});
const model = new MockLanguageModelV3({
  modelId: "offline-timeout",
  doGenerate: async () => {
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
  maxSteps: 3,
  maxInspectCalls: 3,
  width: 700,
  toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  saveIntermediateImages: true,
  configPath: `${directory}/config.yaml`,
};
try {
  await runAgent({
    config,
    model: model as unknown as NonNullable<
      Parameters<typeof runAgent>[0]["model"]
    >,
    handlers,
    source: { data: await readFile(sourcePath), mimeType: "image/png" },
    onModelEvent: async (event) => {
      recorder.record(event.type, event.data);
    },
    onDiagnostic: (diagnostic) => {
      process.stderr.write(
        `${JSON.stringify(recorder.sanitize(diagnostic))}\n`,
      );
      return undefined;
    },
  });
  throw new Error("Expected model failure");
} catch (error) {
  if (!(error instanceof AgentError)) throw error;
  process.stdout.write(
    `${JSON.stringify({ kind: error.kind, message: error.message })}\n`,
  );
}

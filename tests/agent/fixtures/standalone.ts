import { MockLanguageModelV3 } from "ai/test";
import {
  type HandnoteToolHandlers,
  type ModelEvent,
  runAgent,
  toolError,
} from "../../../src/agent/index.ts";

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected operation");
};
const steps: number[] = [];
let markdown = "";
const handlers: HandnoteToolHandlers = {
  inspect_source: unexpected,
  capture_figure: unexpected,
  read_note: unexpected,
  write_note: async (input, execution) => {
    markdown = input.markdown;
    steps.push(execution.step);
    return {
      ok: true,
      revision: 1,
      markdownSha256: "a".repeat(64),
      warnings: [],
      summary: "Written",
    };
  },
  revise_note: unexpected,
  review_render: async (_input, execution) => {
    steps.push(execution.step);
    return {
      ok: true,
      revision: 1,
      markdownSha256: "a".repeat(64),
      path: "memory:preview",
      mimeType: "image/png",
      warnings: [],
      structure: {},
      summary: "Review the note",
    };
  },
  finalize_note: async (_input, execution) => {
    steps.push(execution.step);
    return steps.at(-2) === execution.step - 1
      ? {
          ok: true,
          revision: 1,
          markdownSha256: "a".repeat(64),
          summary: "Finalized",
        }
      : toolError("not_ready", "Review first");
  },
  prepareModelMedia: async () => ({
    kind: "previews",
    summary: "Note preview",
    previews: [
      { data: "aW1hZ2U=", mediaType: "image/jpeg", width: 80, height: 40 },
    ],
  }),
};
const calls = [
  { name: "write_note", input: JSON.stringify({ markdown: "# Memory note" }) },
  { name: "review_render", input: "{}" },
  { name: "finalize_note", input: "{}" },
];
let requests = 0;
const model = new MockLanguageModelV3({
  doGenerate: async () => {
    const call = calls[requests++];
    if (!call) throw new Error("An extra model request escaped finalization");
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: String(requests),
          toolName: call.name,
          input: call.input,
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 3, reasoning: 2 },
      },
      warnings: [],
    };
  },
});
const events: ModelEvent[] = [];
const result = await runAgent({
  config: {
    model: {
      provider: "openai-compatible",
      baseUrl: "https://offline.invalid/v1",
      apiKey: "offline",
      name: "offline",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    promptText: "Use the tools.",
    maxSteps: 8,
    maxInspectCalls: 1,
  },
  source: { data: Uint8Array.of(1, 2, 3), mimeType: "image/png" },
  handlers,
  model: model as unknown as NonNullable<
    Parameters<typeof runAgent>[0]["model"]
  >,
  onModelEvent: async (event) => {
    events.push(event);
  },
  onDiagnostic: () => undefined,
});
process.stdout.write(
  JSON.stringify({
    result,
    requests,
    steps,
    markdown,
    events: events.map((event) => event.type),
    reviewMedia: JSON.stringify(model.doGenerateCalls[2]?.prompt).includes(
      '"type":"image-data"',
    ),
  }),
);

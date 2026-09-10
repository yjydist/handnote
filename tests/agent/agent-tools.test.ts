import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import {
  type HandnoteToolHandlers,
  type ToolExecutionContext,
  toolError,
} from "../../src/agent/agent-protocol.ts";
import { createAgentTools } from "../../src/agent/agent-tools.ts";
import { runAgent } from "../../src/agent/index.ts";
import { loadPrompt } from "../../src/prompt/index.ts";

function setup(overrides: Partial<HandnoteToolHandlers>) {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected business operation");
  };
  const state = { step: 2, finalized: false, failures: [] as unknown[] };
  const tools = createAgentTools({
    handlers: {
      inspect_source: unexpected,
      capture_figure: unexpected,
      read_note: unexpected,
      write_note: unexpected,
      revise_note: unexpected,
      review_render: unexpected,
      finalize_note: unexpected,
      prepareModelMedia: unexpected,
      ...overrides,
    },
    maxSteps: 8,
    maxInspectCalls: 3,
    currentStep: () => state.step,
    onFatal: (error) => {
      state.failures.push(error);
      throw error;
    },
    onFinalized: () => {
      state.finalized = true;
    },
  });
  return { tools, state };
}

test("business handlers receive a stable execution step without application state", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: ToolExecutionContext[] = [];
  const { tools, state } = setup({
    write_note: async (input, execution) => {
      seen.push(execution);
      await pending;
      expect(input).toEqual({
        markdown: "A note",
        audit: { corrections: [], uncertainties: [] },
      });
      return {
        ok: true,
        revision: 1,
        markdownSha256: "a".repeat(64),
        warnings: [],
        summary: "Revision rendered",
      };
    },
    read_note: async (_input, execution) => {
      seen.push(execution);
      return toolError("no_revision", "Write is still pending");
    },
  });
  const write = tools.write_note.execute;
  const read = tools.read_note.execute;
  if (!write || !read) throw new Error("Missing protocol operation");
  const committed = write(
    { markdown: "A note" },
    {} as Parameters<typeof write>[1],
  );
  state.step = 3;
  expect(await read({}, {} as Parameters<typeof read>[1])).toMatchObject({
    ok: false,
    error: { code: "no_revision" },
  });
  release();
  expect(await committed).toMatchObject({ ok: true, revision: 1 });
  expect(seen).toEqual([
    { step: 2, remainingSteps: 6 },
    { step: 3, remainingSteps: 5 },
  ]);
  expect(state.failures).toEqual([]);
});

test("only a successful business finalization stops the agent", async () => {
  let ready = false;
  const { tools, state } = setup({
    finalize_note: async () =>
      ready
        ? {
            ok: true,
            revision: 1,
            markdownSha256: "a".repeat(64),
            summary: "Note finalized",
          }
        : toolError("not_ready", "A later review step is required"),
  });
  const finalize = tools.finalize_note.execute;
  if (!finalize) throw new Error("Missing finalization operation");
  expect(
    await finalize({}, {} as Parameters<typeof finalize>[1]),
  ).toMatchObject({ ok: false });
  expect(state.finalized).toBe(false);
  ready = true;
  expect(
    await finalize({}, {} as Parameters<typeof finalize>[1]),
  ).toMatchObject({ ok: true });
  expect(state.finalized).toBe(true);
  expect(state.failures).toEqual([]);
});

test("media preparation errors preserve their identity and mark the loop fatal", async () => {
  const failure = new Error("The reviewed artifact changed");
  const { tools, state } = setup({
    prepareModelMedia: async (purpose, output) => {
      expect(purpose).toBe("review_render");
      expect(output.path).toBe("rendered-note.png");
      throw failure;
    },
  });
  const output = tools.review_render.toModelOutput;
  if (!output) throw new Error("Missing media operation");
  await expect(
    output({
      ok: true,
      revision: 1,
      markdownSha256: "a".repeat(64),
      path: "rendered-note.png",
      mimeType: "image/png",
      warnings: [],
      structure: {},
      summary: "Review the note",
    }),
  ).rejects.toBe(failure);
  expect(state.failures).toEqual([failure]);
});

test("the agent formats prepared previews and failure text for the model", async () => {
  const { tools } = setup({
    prepareModelMedia: async (_purpose, output) =>
      output.ok
        ? {
            kind: "previews",
            summary: "Compare both tiles",
            previews: [
              {
                data: "first",
                mediaType: "image/jpeg",
                width: 100,
                height: 80,
              },
              {
                data: "second",
                mediaType: "image/jpeg",
                width: 100,
                height: 60,
              },
            ],
          }
        : { kind: "text", text: "The note is not ready" },
  });
  const output = tools.review_render.toModelOutput;
  if (!output) throw new Error("Missing media operation");
  expect(
    await output({
      ok: true,
      revision: 1,
      markdownSha256: "a".repeat(64),
      path: "rendered-note.png",
      mimeType: "image/png",
      warnings: [],
      structure: {},
      summary: "Review the note",
    }),
  ).toEqual({
    type: "content",
    value: [
      { type: "text", text: "Compare both tiles" },
      { type: "text", text: "Preview 1/2 100×80" },
      { type: "image-data", data: "first", mediaType: "image/jpeg" },
      { type: "text", text: "Preview 2/2 100×60" },
      { type: "image-data", data: "second", mediaType: "image/jpeg" },
    ],
  });
  expect(await output(toolError("not_ready", "Review later"))).toEqual({
    type: "text",
    value: "The note is not ready",
  });
});

test("tool schemas reject out-of-bounds crops and unknown draft fields", async () => {
  const { tools } = setup({});
  expect("inspect_ink" in tools).toBe(false);
  expect("select_ink" in tools).toBe(false);
  expect("compose_ink" in tools).toBe(false);
  expect(tools.inspect_source.description).toContain(
    "a region may override either",
  );
  const execute = tools.capture_figure.execute;
  if (!execute) throw new Error("Missing capture operation");
  const rejected = await execute(
    { region: { x: 0.5, y: 0, width: 0.6, height: 1 } },
    {} as Parameters<typeof execute>[1],
  );
  expect(JSON.stringify(rejected)).toContain(
    "Region exceeds normalized image bounds",
  );
  const schema = tools.write_note.inputSchema;
  if (!schema) throw new Error("Missing draft schema");
  expect(schema.safeParse({ markdown: "A note", extra: 1 }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({
      markdown: "A note",
      audit: { corrections: [], uncertainties: [], extra: 1 },
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ markdown: "A note", audit: {} }).success).toBe(
    true,
  );
});

test("ink tool descriptions preserve Markdown positions and genuine stroke constraints", () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("Description inspection does not execute tools");
  };
  const { tools } = setup({
    ink: {
      inspect_ink: unexpected,
      select_ink: unexpected,
      compose_ink: unexpected,
    },
  });
  expect(tools.inspect_ink?.description).toContain(
    "ordered/unordered/nested list items and table cells",
  );
  expect(tools.select_ink?.description).toContain(
    "individual Markdown positions",
  );
  expect(tools.select_ink?.description).toContain("smallest inseparable group");
  expect(tools.select_ink?.description).toContain(
    "omit and audit their strokes instead of duplicating markers",
  );
  expect(tools.select_ink?.description).toContain(
    "relationship explained in description",
  );
  expect(tools.compose_ink?.description).toContain(
    "never recombine them into one wrapper image",
  );
  expect(tools.compose_ink?.description).toContain("presentation.description");
  expect(tools.compose_ink?.description).toContain(
    "whole characters and annotation-to-target relationships",
  );
});

test.each([
  "inspect_source",
  "capture_figure",
  "inspect_ink",
  "select_ink",
  "compose_ink",
] as const)(
  "%s preserves runtime schema errors for the model",
  async (name) => {
    const unexpected = async (): Promise<never> => {
      throw new Error("Invalid input reached a business handler");
    };
    let prepared = false;
    const { tools, state } = setup({
      ink: {
        inspect_ink: unexpected,
        select_ink: unexpected,
        compose_ink: unexpected,
      },
      prepareModelMedia: async () => {
        prepared = true;
        return { kind: "text", text: "Tool failed" };
      },
    });
    const tool = tools[name];
    if (!tool?.execute || !tool.toModelOutput)
      throw new Error("Missing media tool");
    for (const step of [2, 8]) {
      state.step = step;
      const rejected = await tool.execute(
        {} as Parameters<typeof tool.execute>[0],
        {} as Parameters<typeof tool.execute>[1],
      );
      expect(rejected).toMatchObject({ error: true });
      const message = (rejected as { message: string }).message;
      expect(message).toContain(`Tool input validation failed for ${name}`);
      const output = await tool.toModelOutput(
        rejected as Parameters<typeof tool.toModelOutput>[0],
      );
      expect(output).toMatchObject({ type: "text" });
      const text = (output as { value: string }).value;
      expect(text).toContain(message);
      if (name.endsWith("_ink")) {
        expect(text).toContain("Use a smaller batch and valid JSON");
        expect(text).toContain(
          `${8 - step} model step(s) remain after this one`,
        );
        expect(text).toContain("write → review → revise → review → finalize");
      }
      expect(prepared).toBe(false);
      expect(state.failures).toEqual([]);
    }
  },
);

test("an offline model sees the malformed ink call error and retries valid JSON", async () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected business operation");
  };
  const selection = {
    strokeIndices: [0],
    presentation: { kind: "text" as const, referenceHeight: 10 },
  };
  let selections = 0;
  const handlers: HandnoteToolHandlers = {
    inspect_source: unexpected,
    capture_figure: unexpected,
    read_note: unexpected,
    write_note: unexpected,
    revise_note: unexpected,
    review_render: unexpected,
    finalize_note: async () => ({
      ok: true,
      revision: 1,
      markdownSha256: "a".repeat(64),
      summary: "Finalized",
    }),
    ink: {
      inspect_ink: unexpected,
      compose_ink: unexpected,
      select_ink: async (input) => {
        expect(input).toEqual({ selections: [selection] });
        selections++;
        return {
          ok: true,
          paths: ["memory:ink.png"],
          mimeType: "image/png",
          items: [selection],
          summary: "Selected complete stroke 0",
          status: "pending-human-review",
        };
      },
    },
    prepareModelMedia: async (_purpose, output) => ({
      kind: "text",
      text: output.summary ?? "Tool failed",
    }),
  };
  let calls = 0;
  const inkPrompt = await loadPrompt("ink");
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      expect(prompt.find((message) => message.role === "system")?.content).toBe(
        inkPrompt.text,
      );
      calls++;
      if (calls > 3) throw new Error("Unexpected model continuation");
      if (calls === 2) {
        const feedback = JSON.stringify(prompt);
        expect(feedback).toContain(
          "Tool input validation failed for select_ink",
        );
        expect(feedback).toContain("selections: Invalid input: expected array");
        expect(feedback).toContain("Use a smaller batch and valid JSON");
        expect(feedback).toContain("3 model step(s) remain after this one");
      }
      if (calls === 3) {
        expect(JSON.stringify(prompt)).toContain("Selected complete stroke 0");
        expect(JSON.stringify(prompt)).toContain(
          "3 model step(s) remain after this one",
        );
      }
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `repair-${calls}`,
            toolName: calls === 3 ? "finalize_note" : "select_ink",
            input:
              calls === 1
                ? '{"selections":[{"strokeIndices":[0],"presentation":{"kind":"text","referenceHeight":10'
                : calls === 2
                  ? JSON.stringify({ selections: [selection] })
                  : "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const result = await runAgent({
    config: {
      model: {
        provider: "openai-compatible",
        baseUrl: "https://offline.invalid",
        apiKey: "offline",
        name: "offline",
        timeoutMs: 1000,
        maxRetries: 0,
      },
      maxSteps: 4,
      maxInspectCalls: 1,
    },
    handlers,
    source: { data: Uint8Array.of(1, 2, 3), mimeType: "image/png" },
    model: model as unknown as NonNullable<
      Parameters<typeof runAgent>[0]["model"]
    >,
    onModelEvent: async (event) => {
      if (event.type === "model.run.started")
        expect(event.data.promptSha256).toBe(inkPrompt.sha256);
    },
    onDiagnostic: () => undefined,
  });
  expect(result.steps).toBe(3);
  expect(calls).toBe(3);
  expect(selections).toBe(1);
});

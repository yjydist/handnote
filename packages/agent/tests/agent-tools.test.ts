import { expect, test } from "bun:test";
import {
  type HandnoteToolHandlers,
  type ToolExecutionContext,
  toolError,
} from "../src/agent-protocol.ts";
import { createAgentTools } from "../src/agent-tools.ts";

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

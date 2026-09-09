import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runAgent } from "../src/agent.ts";
import type { ModelEvent } from "../src/agent-events.ts";
import { AgentErrorLogger } from "../src/agent-logger.ts";
import { type HandnoteToolHandlers, toolError } from "../src/agent-protocol.ts";
import {
  createRetryingFetch,
  repairToolArgumentResponse,
} from "../src/provider/index.ts";
import { RunState } from "../src/state.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function scriptedAgent() {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected business handler");
  };
  const handlers: HandnoteToolHandlers = {
    inspect_source: unexpected,
    capture_figure: unexpected,
    read_note: async () => toolError("no_revision", "No note yet"),
    write_note: unexpected,
    revise_note: unexpected,
    review_render: unexpected,
    finalize_note: unexpected,
    prepareModelMedia: unexpected,
  };
  let requests = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      requests++;
      return {
        content:
          requests === 1
            ? [
                {
                  type: "tool-call",
                  toolCallId: "read",
                  toolName: "read_note",
                  input: "{}",
                },
              ]
            : [{ type: "text", text: "Stopped" }],
        finishReason: {
          unified: requests === 1 ? "tool-calls" : "stop",
          raw: "stop",
        },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 3, reasoning: 2 },
        },
        warnings: [],
      };
    },
  });
  return {
    requests: () => requests,
    options: {
      config: {
        model: {
          provider: "openai-compatible" as const,
          baseUrl: "https://offline.invalid",
          apiKey: "offline",
          name: "offline",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
        promptText: "Use the tools.",
        maxSteps: 3,
        maxInspectCalls: 1,
      },
      source: { data: Uint8Array.of(1, 2, 3), mimeType: "image/png" },
      handlers,
      model: model as unknown as NonNullable<
        Parameters<typeof runAgent>[0]["model"]
      >,
      onDiagnostic: () => undefined,
    },
  };
}

test("transport waits for the attempt accounting event before contacting the provider", async () => {
  const entered = deferred();
  const persisted = deferred();
  let calls = 0;
  const state = new RunState(async (event) => {
    if (event.type !== "model.attempt.started") return;
    expect(event.accounting).toEqual({
      steps: 1,
      attempts: 1,
      retries: 0,
      usage: {},
    });
    entered.resolve();
    await persisted.promise;
  });
  const transport = createRetryingFetch(
    { maxRetries: 0, timeoutMs: 1_000 },
    state,
    (async () => {
      calls++;
      return new Response("ok");
    }) as unknown as typeof fetch,
  );
  const response = transport("https://offline.invalid");
  await entered.promise;
  expect(calls).toBe(0);
  persisted.resolve();
  expect((await response).status).toBe(200);
  expect(calls).toBe(1);
});

test.each([
  "model.attempt.started",
  "model.attempt.completed",
  "model.tool_arguments.repaired",
] as const)(
  "%s persistence failure is propagated without a transport retry",
  async (failingEvent) => {
    const failure = new Error("Cannot persist model evidence");
    let calls = 0;
    const state = new RunState(async (event) => {
      if (event.type === failingEvent) throw failure;
    });
    const transport = createRetryingFetch(
      { maxRetries: 2, timeoutMs: 1_000 },
      state,
      (async () => {
        calls++;
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "read_note", arguments: "{}}" } },
                ],
              },
            },
          ],
        });
      }) as unknown as typeof fetch,
      repairToolArgumentResponse(state),
    );
    await expect(transport("https://offline.invalid")).rejects.toBe(failure);
    expect(calls).toBe(failingEvent === "model.attempt.started" ? 0 : 1);
    expect(state.modelAccounting.attempts).toBe(1);
  },
);

test("the agent waits for step persistence before requesting another model step", async () => {
  const script = scriptedAgent();
  const entered = deferred();
  const persisted = deferred();
  const pending = runAgent({
    ...script.options,
    onModelEvent: async (event) => {
      if (event.type !== "model.step.completed" || event.data.step !== 1)
        return;
      expect(event.accounting.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        textOutputTokens: 3,
      });
      entered.resolve();
      await persisted.promise;
    },
  });
  await entered.promise;
  expect(script.requests()).toBe(1);
  persisted.resolve();
  expect(await pending).toMatchObject({
    steps: 2,
    usage: { inputTokens: 20, textOutputTokens: 6 },
  });
  expect(script.requests()).toBe(2);
});

test("failed step persistence keeps known usage and the original callback error", async () => {
  const script = scriptedAgent();
  const failure = new Error("The step event could not be written");
  const events: ModelEvent[] = [];
  await expect(
    runAgent({
      ...script.options,
      onModelEvent: async (event) => {
        events.push(event);
        if (event.type === "model.step.completed") throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(script.requests()).toBe(1);
  expect(events.some((event) => event.type === "model.stream.error")).toBe(
    false,
  );
  expect(events.at(-1)).toMatchObject({
    type: "model.run.failed",
    accounting: {
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 5, textOutputTokens: 3 },
    },
  });
});

test("synchronous diagnostics omit raw SDK payloads and propagate sink failures", () => {
  const failure = new Error("Diagnostic sink failed");
  const logger = new AgentErrorLogger((diagnostic) => {
    expect(diagnostic).toMatchObject({
      message: "Model failed",
      context: [{ error: { kind: "authentication", statusCode: 401 } }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("raw-secret");
    throw failure;
  });
  expect(() =>
    logger.error("Model failed", {
      error: Object.assign(new Error("raw-secret"), {
        statusCode: 401,
        responseBody: "raw-secret",
      }),
      request: "raw-secret",
    }),
  ).toThrow(failure);
});

test("the agent awaits stream error persistence before rejecting", async () => {
  const script = scriptedAgent();
  const entered = deferred();
  const persisted = deferred();
  let settled = false;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new DOMException("Timed out", "TimeoutError");
    },
  });
  const pending = runAgent({
    ...script.options,
    model: model as unknown as NonNullable<
      Parameters<typeof runAgent>[0]["model"]
    >,
    onModelEvent: async (event) => {
      if (event.type !== "model.stream.error") return;
      entered.resolve();
      await persisted.promise;
    },
  });
  const outcome = pending.catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  expect(settled).toBe(false);
  persisted.resolve();
  expect(await outcome).toMatchObject({
    kind: "provider_transient",
    message: "Provider request timed out",
  });
});

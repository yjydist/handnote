import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  classifyProviderError,
  convertDeepSeekUsage,
  createRetryingFetch,
  promoteToolMedia,
  repairOpenAiToolArguments,
  repairToolArgumentResponse,
  requestFingerprint,
} from "../src/provider/index.ts";
import { SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-provider-`);
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("provider transport", () => {
  test("repairs only excess trailing tool-argument closers", async () => {
    const payload = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "write_document",
                  arguments: '{"document":{"sections":[]},"audit":{}}}',
                },
              },
              {
                function: {
                  name: "patch_document",
                  arguments: '{"operations":[]',
                },
              },
            ],
          },
        },
      ],
    };
    const result = repairOpenAiToolArguments(payload);
    expect(result.repairs).toEqual([
      { toolName: "write_document", removedTrailingClosers: 1 },
    ]);
    const calls = payload.choices[0]?.message.tool_calls;
    if (!calls?.[0] || !calls[1]) throw new Error("missing tool calls");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      document: { sections: [] },
      audit: {},
    });
    expect(calls[1].function.arguments).toBe('{"operations":[]');
  });

  test("repairs Provider tool arguments before SDK validation and records metadata", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const retrying = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 0 },
      recorder,
      new RunState(),
      (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: "write_document",
                        arguments: '{"document":{},"audit":{}}}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      repairToolArgumentResponse(recorder),
    );
    const response = await retrying("https://example.test");
    const payload = (await response.json()) as {
      choices: Array<{
        message: {
          tool_calls: Array<{ function: { arguments: string } }>;
        };
      }>;
    };
    expect(
      JSON.parse(
        payload.choices[0]?.message.tool_calls[0]?.function.arguments ?? "",
      ),
    ).toEqual({ document: {}, audit: {} });
    const session = await readFile(recorder.path, "utf8");
    expect(session).toContain('"type":"model.tool_arguments.repaired"');
    expect(session).toContain('"removedTrailingClosers":1');
    expect(session).not.toContain('"document"');
  });

  test("retries 429 and all 5xx responses but does not retry 401", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const state = new RunState();
    let calls = 0;
    const retrying = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 1 },
      recorder,
      state,
      (async () => {
        calls++;
        return new Response("", {
          status: calls === 1 ? 429 : 200,
          headers: { "retry-after": "0" },
        });
      }) as unknown as typeof fetch,
    );
    expect((await retrying("https://example.test")).status).toBe(200);
    expect(calls).toBe(2);
    expect(state.modelAccounting).toEqual({
      steps: 1,
      retries: 1,
      attempts: 2,
      usage: {},
    });
    calls = 0;
    const serverError = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 1 },
      recorder,
      state,
      (async () => {
        calls++;
        return new Response("", { status: calls === 1 ? 507 : 200 });
      }) as unknown as typeof fetch,
    );
    expect((await serverError("https://example.test")).status).toBe(200);
    expect(calls).toBe(2);
    calls = 0;
    const auth = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 2 },
      recorder,
      state,
      (async () => {
        calls++;
        return new Response("", { status: 401 });
      }) as unknown as typeof fetch,
    );
    expect((await auth("https://example.test")).status).toBe(401);
    expect(calls).toBe(1);
    expect(state.modelAccounting).toEqual({
      steps: 3,
      retries: 2,
      attempts: 5,
      usage: {},
    });
  });

  test("gives each timed-out attempt its own deadline", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const state = new RunState();
    let calls = 0;
    const timingOut = createRetryingFetch(
      { timeoutMs: 10, maxRetries: 1 },
      recorder,
      state,
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        });
      }) as unknown as typeof fetch,
    );
    expect(timingOut("https://example.test")).rejects.toMatchObject({
      kind: "provider_transient",
    });
    expect(calls).toBe(2);
    expect(state.modelAccounting).toEqual({
      steps: 1,
      retries: 1,
      attempts: 2,
      usage: {},
    });
  });

  test("does not transport-retry a body stream after response start", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const state = new RunState();
    let calls = 0;
    const retrying = createRetryingFetch(
      { timeoutMs: 10, maxRetries: 2 },
      recorder,
      state,
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        });
        return new Response(stream);
      }) as unknown as typeof fetch,
    );
    const response = await retrying("https://example.test");
    await expect(response.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(calls).toBe(1);
    expect(state.modelAccounting).toEqual({
      steps: 1,
      retries: 0,
      attempts: 1,
      usage: {},
    });
  });

  test("classifies explicit capability failures", () => {
    expect(
      classifyProviderError(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    ).toMatchObject({
      kind: "provider_transient",
      message: "Provider request timed out",
    });
    expect(
      classifyProviderError(new Error("image input unsupported")).kind,
    ).toBe("provider_image_incompatible");
    expect(
      classifyProviderError(new Error("tool result image_url not supported"))
        .kind,
    ).toBe("provider_tool_media_incompatible");
    expect(
      classifyProviderError(new Error("unsupported image in tool message"))
        .kind,
    ).toBe("provider_tool_media_incompatible");
    expect(
      classifyProviderError(new Error("tool result file-data unsupported"))
        .kind,
    ).toBe("provider_tool_media_incompatible");
    expect(
      classifyProviderError(new Error("function calling not supported")).kind,
    ).toBe("provider_tools_incompatible");
    expect(classifyProviderError(new Error("tool message invalid")).kind).toBe(
      "provider_tools_incompatible",
    );
    expect(
      classifyProviderError(
        Object.assign(new Error("maximum context length exceeded"), {
          requestBodyValues: {
            messages: [
              {
                role: "tool",
                content:
                  '[{"type":"file","data":{"type":"data","data":"AAAA"},"mediaType":"image/png"}]',
              },
            ],
          },
        }),
      ).kind,
    ).toBe("provider_tool_media_incompatible");

    for (const statusCode of [400, 404, 422]) {
      expect(
        classifyProviderError(
          Object.assign(new Error("request rejected"), {
            statusCode,
            isRetryable: false,
          }),
        ),
      ).toMatchObject({
        kind: "provider_rejected",
        recoverable: false,
        message: `Provider rejected the request (HTTP ${statusCode})`,
      });
    }
    for (const statusCode of [401, 403]) {
      expect(
        classifyProviderError(
          Object.assign(new Error("request rejected"), { statusCode }),
        ).kind,
      ).toBe("authentication");
    }
    for (const statusCode of [408, 409, 429, 500, 503, 599]) {
      expect(
        classifyProviderError(
          Object.assign(new Error("request failed"), {
            statusCode,
            isRetryable: true,
          }),
        ),
      ).toMatchObject({ kind: "provider_transient", recoverable: true });
    }
    expect(
      classifyProviderError(
        Object.assign(new Error("API key rate limit reached"), {
          statusCode: 429,
          isRetryable: true,
        }),
      ).kind,
    ).toBe("provider_transient");
    expect(
      classifyProviderError(
        Object.assign(new Error("request rejected"), {
          statusCode: 422,
          isRetryable: true,
        }),
      ).kind,
    ).toBe("provider_rejected");
    expect(
      classifyProviderError(
        Object.assign(new Error("image input unsupported"), {
          statusCode: 400,
          isRetryable: false,
        }),
      ).kind,
    ).toBe("provider_image_incompatible");
  });

  test("promotes consecutive media tool results after the full tool block", () => {
    const media = (text: string) =>
      JSON.stringify([
        { type: "text", text },
        {
          type: "file",
          data: { type: "data", data: "QUJD" },
          mediaType: "image/jpeg",
        },
      ]);
    const promoted = promoteToolMedia({
      model: "vision",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "call-1", function: { name: "inspect_source" } },
            { id: "call-2", function: { name: "review_render" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: media("one") },
        { role: "tool", tool_call_id: "call-2", content: media("two") },
      ],
    });
    const messages = promoted.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(messages[1]?.content).toBe("one");
    expect(messages[2]?.content).toBe("two");
    expect(JSON.stringify(messages.slice(1, 3))).not.toContain("QUJD");
    expect(JSON.stringify(messages[3])).toContain(
      "data:image/jpeg;base64,QUJD",
    );
  });

  test("maps DeepSeek prompt cache usage and fingerprints image requests", () => {
    expect(
      convertDeepSeekUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 75,
        prompt_cache_miss_tokens: 25,
        completion_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toMatchObject({
      inputTokens: { total: 100, noCache: 25, cacheRead: 75 },
      outputTokens: { total: 20, text: 15, reasoning: 5 },
    });
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "x" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,AA==" },
            },
          ],
        },
      ],
    });
    const fingerprint = requestFingerprint(body);
    if (!fingerprint) throw new Error("missing request fingerprint");
    expect(fingerprint).toEqual({
      sha256: fingerprint.sha256,
      bytes: Buffer.byteLength(body),
      imageCount: 1,
    });
    expect(fingerprint.sha256).toHaveLength(64);
  });
});

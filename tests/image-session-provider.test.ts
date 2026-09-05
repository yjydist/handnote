import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { safeErrorMetadata } from "../src/errors.ts";
import {
  createModelPreviews,
  inspectSource,
  normalizeInspectInput,
  regionPixels,
} from "../src/image.ts";
import {
  classifyProviderError,
  convertDeepSeekUsage,
  createRetryingFetch,
  promoteToolMedia,
  repairOpenAiToolArguments,
  repairToolArgumentResponse,
  requestFingerprint,
} from "../src/provider/index.ts";
import { redact } from "../src/redact.ts";
import { SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { createStoreFixture } from "./helpers.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-media-`);
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

describe("image inspection", () => {
  test("normalizes repeated region options and clips edge-crossing crops", () => {
    const normalized = normalizeInspectInput({
      regions: [
        {
          x: 0.9,
          y: 0.95,
          width: 0.2,
          height: 0.1,
          scale: 3,
          enhancement: "contrast",
        },
      ],
    });
    expect(normalized).toMatchObject({
      regions: [
        {
          x: 0.9,
          y: 0.95,
          scale: 3,
          enhancement: "contrast",
        },
      ],
    });
    expect(normalized.regions[0]?.width).toBeCloseTo(0.1);
    expect(normalized.regions[0]?.height).toBeCloseTo(0.05);
    const perRegion = normalizeInspectInput({
      scale: 2,
      enhancement: "original",
      regions: [
        { x: 0, y: 0, width: 0.5, height: 0.5, enhancement: "contrast" },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5, scale: 3 },
      ],
    });
    expect(perRegion.regions).toMatchObject([
      { scale: 2, enhancement: "contrast" },
      { scale: 3, enhancement: "original" },
    ]);
  });

  test("rounds normalized crop outward and produces all enhancement modes", async () => {
    expect(
      regionPixels(
        { x: 0.101, y: 0.201, width: 0.302, height: 0.304 },
        100,
        100,
      ),
    ).toEqual({ left: 10, top: 20, width: 31, height: 31 });
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 100, height: 80, channels: 3, background: "#77aacc" },
    })
      .png()
      .toFile(source);
    for (const [index, enhancement] of [
      "original",
      "grayscale",
      "contrast",
      "sharpen",
      "binarize",
    ].entries()) {
      const output = await inspectSource(
        source,
        `${directory}/out`,
        {
          regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
          scale: 2,
          enhancement: enhancement as "original",
        },
        index,
        2048,
      );
      expect(await Bun.file(output.path).exists()).toBe(true);
      expect(output.width).toBe(100);
    }
  });

  test("creates a numbered contact sheet", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 60, height: 60, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const output = await inspectSource(
      source,
      `${directory}/out`,
      {
        regions: [
          { x: 0, y: 0, width: 0.5, height: 0.5 },
          { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        ],
        scale: 1,
        enhancement: "original",
      },
      1,
      2048,
    );
    expect(output.kind).toBe("contact_sheet");
    expect(output.width).toBeGreaterThan(60);
  });

  test("bounds enlarged crops and contact sheets without changing aspect ratio", async () => {
    const directory = await temporary();
    const source = `${directory}/bounded.png`;
    await sharp({
      create: { width: 500, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const input = {
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      scale: 4,
      enhancement: "original" as const,
    };
    const crop = await inspectSource(
      source,
      `${directory}/single`,
      input,
      1,
      640,
    );
    expect(crop).toMatchObject({ width: 640, height: 512, kind: "crop" });
    expect(await sharp(crop.path).metadata()).toMatchObject({
      width: crop.width,
      height: crop.height,
    });

    const contact = await inspectSource(
      source,
      `${directory}/contact`,
      {
        ...input,
        regions: Array.from({ length: 8 }, () => ({
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })),
      },
      2,
      4096,
    );
    expect(contact.kind).toBe("contact_sheet");
    expect(contact.width).toBeLessThanOrEqual(4096);
    expect(contact.width * contact.height).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    const cellWidth = contact.width / 2;
    const cellHeight = contact.height / 4;
    expect((cellWidth - 32) / (cellHeight - 56)).toBeCloseTo(1.25, 2);
  });

  test("creates deterministic bounded JPEG previews and tiles tall images", async () => {
    const directory = await temporary();
    const source = `${directory}/tall.png`;
    await sharp({
      create: { width: 900, height: 5000, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const options = { maxEdge: 2048, jpegQuality: 85 };
    const first = await createModelPreviews(source, options);
    const second = await createModelPreviews(source, options);
    expect(first).toHaveLength(3);
    expect(first.map(({ data: _data, ...item }) => item)).toEqual(
      second.map(({ data: _data, ...item }) => item),
    );
    expect(first.every((item) => item.mediaType === "image/jpeg")).toBe(true);
    expect(
      first.every(
        (item) =>
          item.width <= options.maxEdge && item.height <= options.maxEdge,
      ),
    ).toBe(true);
    expect(first.reduce((total, item) => total + item.bytes, 0)).toBeLessThan(
      Bun.file(source).size,
    );
  });

  test("reuses an identical inspection within one run", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      runDirectory: directory,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state: new RunState(),
      recorder,
    });
    expect(tools.inspect_source.description).toContain(
      "a region may override either",
    );
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const input = {
      regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      scale: 2,
      enhancement: "original" as const,
    };
    const executionContext = {} as Parameters<typeof execute>[1];
    const first = await execute(
      {
        regions: [
          {
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
            scale: 2,
            enhancement: "original" as const,
          },
        ],
      },
      executionContext,
    );
    const second = await execute(input, executionContext);
    expect(first).toEqual(second);
    for (const x of [0.1, 0.2]) {
      await execute(
        {
          ...input,
          regions: [{ x, y: 0, width: 0.5, height: 0.5 }],
        },
        executionContext,
      );
    }
    const rejected = await execute(
      {
        ...input,
        regions: [{ x: 0.3, y: 0, width: 0.5, height: 0.5 }],
      },
      executionContext,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    if (!rejected.ok) expect(rejected.error.message).toContain("write_note");
    expect(await readdir(`${directory}/intermediate/inspections`)).toHaveLength(
      3,
    );
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((event) => event.type === "tool.inspect_source.completed")
        .map((event) => event.data.cacheHit),
    ).toEqual([false, true, false, false]);
    expect(
      events.filter((event) => event.type === "tool.inspect_source.rejected"),
    ).toHaveLength(1);
  });

  test("points the exhausted-budget message at write_note before a revision and revise_note after one", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const state = new RunState();
    const store = await createStoreFixture(directory);
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      runDirectory: directory,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 1,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder: store.recorder,
    });
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const executionContext = {} as Parameters<typeof execute>[1];
    await execute(
      { regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    const before = await execute(
      { regions: [{ x: 0.2, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    expect(before).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    if (!before.ok) expect(before.error.message).toContain("write_note");
    await store.commit(
      { markdown: "正文", audit: {} },
      { kind: "write", step: 1, width: 700 },
    );
    const after = await execute(
      { regions: [{ x: 0.4, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    if (!after.ok) expect(after.error.message).toContain("revise_note");
  });

  test("shares an in-flight inspection without consuming another budget slot", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      runDirectory: directory,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 1,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state: new RunState(),
      recorder,
    });
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const input = {
      regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      scale: 2,
      enhancement: "original" as const,
    };
    const executionContext = {} as Parameters<typeof execute>[1];
    const [first, second] = await Promise.all([
      execute(input, executionContext),
      execute(input, executionContext),
    ]);
    if (!first.ok || !second.ok) throw new Error("inspection was rejected");
    expect(first.path).toBe(second.path);
    expect(await readdir(`${directory}/intermediate/inspections`)).toHaveLength(
      1,
    );
    const rejected = await execute(
      {
        ...input,
        regions: [{ x: 0.25, y: 0, width: 0.5, height: 0.5 }],
      },
      executionContext,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((event) => event.type === "tool.inspect_source.completed")
        .map((event) => event.data.cacheHit)
        .sort(),
    ).toEqual([false, true]);
  });
});

describe("session and provider transport", () => {
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
      { retries: 0, attempts: 0 },
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

  test("redacts secrets, URL credentials, authorization, and Base64", () => {
    const wrappedBase64 = Array.from({ length: 4 }, () => "A".repeat(76)).join(
      "\n",
    );
    const plainUrl = "https://example.test/a?keep=1&keep=2#section";
    const value = redact({
      apiKey: "abc",
      nested: {
        Authorization: "Bearer xyz",
        url: "https://user:pass@example.test/a",
        credentialUrl:
          "https://example.test/v1?api_key=query-secret&keep=1&keep=2&access_token=access-secret#id_token=fragment-secret&section=2",
        plainUrl,
        data: "A".repeat(300),
        wrappedBase64,
        urlSafeBase64: "_".repeat(300),
        cachedInputTokens: 123,
        prompt_cache_hit_tokens: 100,
        encoded: JSON.stringify([
          { type: "file", data: { data: "B".repeat(300) } },
        ]),
      },
    });
    expect(JSON.stringify(value)).not.toContain("abc");
    expect(JSON.stringify(value)).not.toContain("xyz");
    expect(JSON.stringify(value)).not.toContain("pass");
    expect(JSON.stringify(value)).not.toContain("query-secret");
    expect(JSON.stringify(value)).not.toContain("access-secret");
    expect(JSON.stringify(value)).not.toContain("fragment-secret");
    expect(JSON.stringify(value)).not.toContain(wrappedBase64);
    expect(JSON.stringify(value)).not.toContain("_".repeat(100));
    expect(JSON.stringify(value)).toContain("BASE64_REDACTED");
    expect(value).toMatchObject({
      nested: {
        cachedInputTokens: 123,
        prompt_cache_hit_tokens: 100,
        plainUrl,
      },
    });
    const credentialUrl = new URL(
      (value as { nested: { credentialUrl: string } }).nested.credentialUrl,
    );
    expect(credentialUrl.searchParams.get("api_key")).toBe("[REDACTED]");
    expect(credentialUrl.searchParams.get("access_token")).toBe("[REDACTED]");
    expect(credentialUrl.searchParams.getAll("keep")).toEqual(["1", "2"]);
    const fragment = new URLSearchParams(credentialUrl.hash.slice(1));
    expect(fragment.get("id_token")).toBe("[REDACTED]");
    expect(fragment.get("section")).toBe("2");
    expect(JSON.stringify(value)).not.toContain("B".repeat(100));
  });

  test("redacts configured secrets and records only safe error metadata", async () => {
    const directory = await temporary();
    const secret = "sk-test+/sensitive-value";
    const encodedSecret = encodeURIComponent(secret);
    const lowercaseEncodedSecret = encodedSecret.replace(
      /%[0-9A-F]{2}/g,
      (match) => match.toLowerCase(),
    );
    const recorder = SessionRecorder.create(directory, { secrets: [secret] });
    const providerError = Object.assign(
      new Error(`Incorrect API key provided: ${secret}`),
      {
        statusCode: 401,
        isRetryable: false,
        responseBody: JSON.stringify({ error: { message: secret } }),
        requestBodyValues: { authorization: secret },
        data: { error: { message: secret } },
      },
    );
    const error = safeErrorMetadata(providerError);
    expect(error).toEqual({
      name: "Error",
      statusCode: 401,
      isRetryable: false,
    });
    expect(error).not.toHaveProperty("responseBody");
    expect(error).not.toHaveProperty("requestBodyValues");
    expect(error).not.toHaveProperty("data");

    recorder.record("model.run.failed", {
      message: `Rejected ${secret}`,
      encoded: `Rejected ${encodedSecret}`,
      lowercaseEncoded: `Rejected ${lowercaseEncodedSecret}`,
      nested: JSON.stringify({ error: { message: secret } }),
      error,
    });
    const session = await readFile(recorder.path, "utf8");
    expect(session).not.toContain(secret);
    expect(session).not.toContain(encodedSecret);
    expect(session).not.toContain(lowercaseEncodedSecret);
    expect(session).not.toContain("responseBody");
    expect(session).toContain('"statusCode":401');
  });

  test("records monotonic synchronous events", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    recorder.record("one", {});
    recorder.record("two", {});
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  test("retries 429 and all 5xx responses but does not retry 401", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const state = new RunState();
    const stats = { retries: 0, attempts: 0 };
    let calls = 0;
    const retrying = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 1 },
      recorder,
      state,
      stats,
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
    expect(stats.retries).toBe(1);
    calls = 0;
    const serverError = createRetryingFetch(
      { timeoutMs: 1_000, maxRetries: 1 },
      recorder,
      state,
      { retries: 0, attempts: 0 },
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
      { retries: 0, attempts: 0 },
      (async () => {
        calls++;
        return new Response("", { status: 401 });
      }) as unknown as typeof fetch,
    );
    expect((await auth("https://example.test")).status).toBe(401);
    expect(calls).toBe(1);
  });

  test("gives each timed-out attempt its own deadline", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const stats = { retries: 0, attempts: 0 };
    let calls = 0;
    const timingOut = createRetryingFetch(
      { timeoutMs: 10, maxRetries: 1 },
      recorder,
      new RunState(),
      stats,
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
    expect(stats).toEqual({ retries: 1, attempts: 2 });
  });

  test("does not transport-retry a body stream after response start", async () => {
    const directory = await temporary();
    const recorder = SessionRecorder.create(directory);
    const stats = { retries: 0, attempts: 0 };
    let calls = 0;
    const retrying = createRetryingFetch(
      { timeoutMs: 10, maxRetries: 2 },
      recorder,
      new RunState(),
      stats,
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
    expect(stats).toEqual({ retries: 0, attempts: 1 });
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

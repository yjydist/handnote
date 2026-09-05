import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { safeErrorMetadata } from "../src/errors.ts";
import { redact } from "../src/redact.ts";
import { SessionRecorder } from "../src/session.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-session-`);
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

describe("session and redaction", () => {
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
});

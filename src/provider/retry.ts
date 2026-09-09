import { createHash } from "node:crypto";
import { safeErrorMetadata } from "../agent-errors.ts";
import type { RunState } from "../state.ts";
import { classifyProviderError } from "./classify.ts";
import { isRetryableStatus, record, retryAfter } from "./primitives.ts";
import type { RetryConfig } from "./types.ts";

export function requestFingerprint(body: BodyInit | null | undefined):
  | {
      sha256: string;
      bytes: number;
      imageCount: number;
    }
  | undefined {
  if (typeof body !== "string") return undefined;
  let imageCount = 0;
  try {
    const parsed = JSON.parse(body);
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const item = record(value);
      if (!item) return;
      if (item.type === "image_url") imageCount++;
      for (const child of Object.values(item)) visit(child);
    };
    visit(record(parsed)?.messages);
  } catch {}
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body),
    imageCount,
  };
}

export function createRetryingFetch(
  config: RetryConfig,
  state: RunState,
  underlyingFetch: typeof fetch = fetch,
  repairResponse: (
    response: Response,
    step: number,
    attempt: number,
  ) => Promise<Response> = async (response) => response,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const transport = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (state.hasFatalError) throw state.fatalError;
    const step = state.beginModelStep();
    const request = requestFingerprint(init?.body);
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
      state.beginModelAttempt({ step, attempt });
      const started = performance.now();
      await state.emit({
        type: "model.attempt.started",
        data: { step, attempt, ...(request ? { request } : {}) },
      });
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      let response: Response;
      try {
        response = await underlyingFetch(input, { ...init, signal });
      } catch (error) {
        await state.emit({
          type: "model.attempt.failed",
          data: {
            step,
            attempt,
            durationMs: Math.round(performance.now() - started),
            error: safeErrorMetadata(error),
          },
        });
        if (attempt > config.maxRetries) throw classifyProviderError(error);
        await Bun.sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
        continue;
      }
      await state.emit({
        type: "model.attempt.completed",
        data: {
          step,
          attempt,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        },
      });
      if (isRetryableStatus(response.status) && attempt <= config.maxRetries) {
        await Bun.sleep(
          retryAfter(response.headers.get("retry-after")) ??
            Math.min(250 * 2 ** (attempt - 1), 2_000),
        );
        continue;
      }
      return await repairResponse(response, step, attempt);
    }
    throw new Error("Model attempt budget was exhausted");
  };
  return transport;
}

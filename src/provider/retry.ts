import { createHash } from "node:crypto";
import { safeErrorMetadata } from "../errors.ts";
import type { SessionRecorder } from "../session.ts";
import type { RunState } from "../state.ts";
import type { RunStore } from "../store.ts";
import { classifyProviderError } from "./classify.ts";
import { isRetryableStatus, record, retryAfter } from "./primitives.ts";
import type { ProviderStats, RetryConfig } from "./types.ts";

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
  recorder: SessionRecorder,
  state: RunState,
  stats: ProviderStats,
  underlyingFetch: typeof fetch = fetch,
  repairResponse: (
    response: Response,
    step: number,
    attempt: number,
  ) => Promise<Response> = async (response) => response,
  store?: RunStore,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const transport = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const step = state.beginModelStep();
    const request = requestFingerprint(init?.body);
    let lastError: unknown;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      stats.attempts++;
      if (attempt > 0) stats.retries++;
      const started = performance.now();
      recorder.record("model.attempt.started", {
        step,
        attempt: attempt + 1,
        ...(request ? { request } : {}),
      });
      await store?.updateModel({
        steps: step,
        retries: stats.retries,
        attempts: stats.attempts,
      });
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      try {
        const response = await underlyingFetch(input, { ...init, signal });
        recorder.record("model.attempt.completed", {
          step,
          attempt: attempt + 1,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        });
        if (isRetryableStatus(response.status) && attempt < config.maxRetries) {
          await Bun.sleep(
            retryAfter(response.headers.get("retry-after")) ??
              Math.min(250 * 2 ** attempt, 2_000),
          );
          continue;
        }
        return await repairResponse(response, step, attempt + 1);
      } catch (error) {
        lastError = error;
        recorder.record("model.attempt.failed", {
          step,
          attempt: attempt + 1,
          durationMs: Math.round(performance.now() - started),
          error: safeErrorMetadata(error),
        });
        if (attempt >= config.maxRetries) throw classifyProviderError(error);
        await Bun.sleep(Math.min(250 * 2 ** attempt, 2_000));
      }
    }
    throw classifyProviderError(lastError);
  };
  return transport;
}

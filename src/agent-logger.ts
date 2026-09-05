import { MastraLogger } from "@mastra/core/logger";
import { safeErrorMetadata } from "./errors.ts";
import { classifyProviderError } from "./provider/index.ts";
import type { SessionRecorder } from "./session.ts";

function errorDiagnostic(error: unknown): object {
  const classified = classifyProviderError(error);
  return {
    kind: classified.kind,
    message: classified.message,
    ...safeErrorMetadata(error),
  };
}

function logContext(value: unknown): object {
  if (value instanceof Error) return { error: errorDiagnostic(value) };
  if (!value || typeof value !== "object") return {};
  const context = value as Record<string, unknown>;
  // SDK errors and framework metadata can contain entire request/response bodies.
  return {
    ...(context.error !== undefined
      ? { error: errorDiagnostic(context.error) }
      : {}),
    ...(typeof context.runId === "string" ? { runId: context.runId } : {}),
    ...(typeof context.provider === "string"
      ? { provider: context.provider }
      : {}),
    ...(typeof context.modelId === "string"
      ? { modelId: context.modelId }
      : {}),
  };
}

export class AgentErrorLogger extends MastraLogger {
  constructor(private readonly recorder: SessionRecorder) {
    super();
  }

  // Keep Mastra's default error-only threshold.
  debug(): void {}
  info(): void {}
  warn(): void {}

  error(message: string, ...args: unknown[]): void {
    const diagnostic = this.recorder.sanitize({
      message,
      context: args.map(logContext),
    });
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  }
}

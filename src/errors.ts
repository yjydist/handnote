export type ErrorKind =
  | "validation"
  | "authentication"
  | "provider_rejected"
  | "provider_transient"
  | "provider_image_incompatible"
  | "provider_tools_incompatible"
  | "provider_tool_media_incompatible"
  | "rendering"
  | "filesystem"
  | "internal";

export class HandnoteError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly recoverable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HandnoteError";
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface SafeErrorMetadata {
  name?: string;
  code?: string | number;
  statusCode?: number;
  isRetryable?: boolean;
}

export function safeErrorMetadata(value: unknown): SafeErrorMetadata {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  const name =
    value instanceof Error
      ? value.name
      : typeof item.name === "string"
        ? item.name
        : undefined;
  const code =
    typeof item.code === "string" || typeof item.code === "number"
      ? item.code
      : undefined;
  const statusCode =
    typeof item.statusCode === "number" && Number.isFinite(item.statusCode)
      ? item.statusCode
      : undefined;
  const isRetryable =
    typeof item.isRetryable === "boolean" ? item.isRetryable : undefined;
  return {
    ...(name ? { name } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(isRetryable !== undefined ? { isRetryable } : {}),
  };
}

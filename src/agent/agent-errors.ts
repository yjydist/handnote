export type AgentErrorKind =
  | "internal"
  | "validation"
  | "authentication"
  | "provider_rejected"
  | "provider_transient"
  | "provider_image_incompatible"
  | "provider_tools_incompatible"
  | "provider_tool_media_incompatible";

export class AgentError extends Error {
  constructor(
    message: string,
    readonly kind: AgentErrorKind,
    readonly recoverable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
  }
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

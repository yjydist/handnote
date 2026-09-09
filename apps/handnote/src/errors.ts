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

export { type SafeErrorMetadata, safeErrorMetadata } from "@handnote/agent";

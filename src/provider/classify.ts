import { HandnoteError } from "../errors.ts";
import { finiteNumber, isRetryableStatus, record } from "./primitives.ts";

function requestContainsSerializedToolMedia(error: unknown): boolean {
  const request = record(record(error)?.requestBodyValues);
  if (!Array.isArray(request?.messages)) return false;
  return request.messages.some((message) => {
    const value = record(message);
    if (value?.role !== "tool" || typeof value.content !== "string")
      return false;
    return /"type":"(?:file|media|image-data)"/.test(value.content);
  });
}

export function classifyProviderError(error: unknown): HandnoteError {
  if (error instanceof HandnoteError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const name = error instanceof Error ? error.name : undefined;
  const value = record(error);
  const statusCode = finiteNumber(value?.statusCode);
  const isRetryable =
    typeof value?.isRetryable === "boolean" ? value.isRetryable : undefined;
  if (name === "TimeoutError")
    return new HandnoteError(
      "Provider request timed out",
      "provider_transient",
      true,
      { cause: error },
    );
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    ((statusCode === undefined || !isRetryableStatus(statusCode)) &&
      /unauthori[sz]ed|forbidden|api.?key/.test(lower))
  )
    return new HandnoteError(
      "Provider authentication failed",
      "authentication",
      false,
      { cause: error },
    );
  if (
    /maximum context length|context.{0,20}(?:length|window)|too many tokens/.test(
      lower,
    ) &&
    requestContainsSerializedToolMedia(error)
  )
    return new HandnoteError(
      "Provider cannot consume media in tool results",
      "provider_tool_media_incompatible",
      false,
      { cause: error },
    );
  if (
    ((/tool[ ._-]?(?:result|message|output)/.test(lower) &&
      /image|media|file/.test(lower)) ||
      /tool.*(?:media|image|file)|file-data|file.*content/.test(lower)) &&
    /unsupported|not support|invalid|reject/.test(lower)
  )
    return new HandnoteError(
      "Provider does not support media in tool results",
      "provider_tool_media_incompatible",
      false,
      { cause: error },
    );
  if (
    /image|vision|multimodal/.test(lower) &&
    /unsupported|not support|invalid.*content|reject/.test(lower)
  )
    return new HandnoteError(
      "Provider does not support image input",
      "provider_image_incompatible",
      false,
      { cause: error },
    );
  if (
    /tool|function.?call/.test(lower) &&
    /unsupported|not support|invalid|reject/.test(lower)
  )
    return new HandnoteError(
      "Provider does not support tool calling",
      "provider_tools_incompatible",
      false,
      { cause: error },
    );
  if (statusCode !== undefined && isRetryableStatus(statusCode))
    return new HandnoteError(
      statusCode === undefined
        ? "Provider request failed temporarily"
        : `Provider request failed temporarily (HTTP ${statusCode})`,
      "provider_transient",
      true,
      { cause: error },
    );
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
    return new HandnoteError(
      `Provider rejected the request (HTTP ${statusCode})`,
      "provider_rejected",
      false,
      { cause: error },
    );
  if (isRetryable === true)
    return new HandnoteError(
      "Provider request failed temporarily",
      "provider_transient",
      true,
      { cause: error },
    );
  if (/timed?\s*out|timeout/.test(lower))
    return new HandnoteError(
      "Provider request timed out",
      "provider_transient",
      true,
      { cause: error },
    );
  return new HandnoteError(
    "Provider request failed",
    "provider_transient",
    true,
    { cause: error },
  );
}

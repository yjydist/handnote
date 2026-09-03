import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONObject, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { HandnoteConfig } from "../config.ts";
import { HandnoteError } from "../errors.ts";
import type { SessionRecorder } from "../session.ts";
import type { RunState } from "../state.ts";
import { finiteNumber, record } from "./primitives.ts";
import { createRetryingFetch, type ProviderStats } from "./retry.ts";

export interface ToolArgumentRepair {
  toolName: string;
  removedTrailingClosers: number;
}

type JsonRecord = Record<string, unknown>;

function repairExcessTrailingClosers(
  input: string,
): { arguments: string; removed: number } | undefined {
  try {
    JSON.parse(input);
    return undefined;
  } catch {}
  let candidate = input.trimEnd();
  for (let removed = 1; removed <= 4; removed++) {
    const last = candidate.at(-1);
    if (last !== "}" && last !== "]") return undefined;
    candidate = candidate.slice(0, -1).trimEnd();
    try {
      if (record(JSON.parse(candidate)))
        return { arguments: candidate, removed };
    } catch {}
  }
  return undefined;
}

export function repairOpenAiToolArguments(payload: unknown): {
  payload: unknown;
  repairs: ToolArgumentRepair[];
} {
  const repairs: ToolArgumentRepair[] = [];
  const choices = record(payload)?.choices;
  if (!Array.isArray(choices)) return { payload, repairs };
  for (const choice of choices) {
    const toolCalls = record(record(choice)?.message)?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const fn = record(record(call)?.function);
      if (!fn || typeof fn.arguments !== "string") continue;
      const repaired = repairExcessTrailingClosers(fn.arguments);
      if (!repaired) continue;
      fn.arguments = repaired.arguments;
      repairs.push({
        toolName: typeof fn.name === "string" ? fn.name : "unknown",
        removedTrailingClosers: repaired.removed,
      });
    }
  }
  return { payload, repairs };
}

export function repairToolArgumentResponse(
  recorder: SessionRecorder,
): (response: Response, step: number, attempt: number) => Promise<Response> {
  return async (response, step, attempt) => {
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      return response;
    try {
      const payload = await response.clone().json();
      const repaired = repairOpenAiToolArguments(payload);
      if (repaired.repairs.length === 0) return response;
      recorder.record("model.tool_arguments.repaired", {
        step,
        attempt,
        repairs: repaired.repairs,
      });
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return new Response(JSON.stringify(repaired.payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      return response;
    }
  };
}

export function convertDeepSeekUsage(usage: unknown): LanguageModelV4Usage {
  const value = record(usage) ?? {};
  const promptTokens = finiteNumber(value.prompt_tokens);
  const completionTokens = finiteNumber(value.completion_tokens);
  const cacheRead =
    finiteNumber(value.prompt_cache_hit_tokens) ??
    finiteNumber(record(value.prompt_tokens_details)?.cached_tokens) ??
    0;
  const cacheMiss =
    finiteNumber(value.prompt_cache_miss_tokens) ??
    (promptTokens === undefined
      ? undefined
      : Math.max(0, promptTokens - cacheRead));
  const reasoning = finiteNumber(
    record(value.completion_tokens_details)?.reasoning_tokens,
  );
  return {
    inputTokens: {
      total: promptTokens,
      noCache: cacheMiss,
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completionTokens,
      text:
        completionTokens === undefined
          ? undefined
          : Math.max(0, completionTokens - (reasoning ?? 0)),
      reasoning,
    },
    raw: value as JSONObject,
  };
}

interface PromotedImage {
  url: string;
}

function imageFromPart(part: unknown): PromotedImage | undefined {
  const value = record(part);
  if (!value) return undefined;
  const type = value.type;
  if (type !== "file" && type !== "media" && type !== "image-data")
    return undefined;
  const nested = record(value.data);
  const data =
    typeof value.data === "string"
      ? value.data
      : nested?.type === "data" && typeof nested.data === "string"
        ? nested.data
        : undefined;
  const mediaType =
    typeof value.mediaType === "string"
      ? value.mediaType
      : typeof nested?.mediaType === "string"
        ? nested.mediaType
        : undefined;
  if (!data || !mediaType?.startsWith("image/")) return undefined;
  return {
    url: data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`,
  };
}

function toolOutput(
  content: unknown,
): { text: string; images: PromotedImage[] } | undefined {
  if (typeof content !== "string" || !content.trimStart().startsWith("["))
    return undefined;
  let parts: unknown;
  try {
    parts = JSON.parse(content);
  } catch (error) {
    if (!/"type":"(?:file|media|image-data)"/.test(content)) return undefined;
    throw new HandnoteError(
      "Cannot parse a media-bearing tool result",
      "provider_tool_media_incompatible",
      false,
      { cause: error },
    );
  }
  if (!Array.isArray(parts)) return undefined;
  const images: PromotedImage[] = [];
  const text: string[] = [];
  for (const part of parts) {
    const image = imageFromPart(part);
    if (image) {
      images.push(image);
      continue;
    }
    const item = record(part);
    if (
      item &&
      (item.type === "file" ||
        item.type === "media" ||
        item.type === "image-data")
    )
      throw new HandnoteError(
        "Tool result contains unsupported or malformed media",
        "provider_tool_media_incompatible",
      );
    if (item?.type === "text" && typeof item.text === "string") {
      text.push(item.text);
      continue;
    }
    text.push(JSON.stringify(part));
  }
  if (images.length === 0) return undefined;
  return {
    text:
      text.filter(Boolean).join("\n") || "Visual tool result attached below.",
    images,
  };
}

function toolNames(messages: JsonRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls))
      continue;
    for (const call of message.tool_calls) {
      const item = record(call);
      const fn = record(item?.function);
      if (typeof item?.id === "string" && typeof fn?.name === "string")
        names.set(item.id, fn.name);
    }
  }
  return names;
}

export function promoteToolMedia(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const messages = body.messages.map((message) => record(message) ?? {});
  const names = toolNames(messages);
  const output: JsonRecord[] = [];
  for (let index = 0; index < messages.length; ) {
    const message = messages[index];
    if (message?.role !== "tool") {
      if (message) output.push(message);
      index++;
      continue;
    }
    const promoted: Array<{ name: string; image: PromotedImage }> = [];
    while (index < messages.length && messages[index]?.role === "tool") {
      const toolMessage = messages[index];
      if (!toolMessage) break;
      const parsed = toolOutput(toolMessage.content);
      if (!parsed) {
        output.push(toolMessage);
      } else {
        output.push({ ...toolMessage, content: parsed.text });
        const callId = toolMessage.tool_call_id;
        const name =
          typeof callId === "string" ? (names.get(callId) ?? "tool") : "tool";
        for (const image of parsed.images) promoted.push({ name, image });
      }
      index++;
    }
    if (promoted.length > 0) {
      output.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Tool-generated visual evidence follows. Treat it as the result of the preceding tool call(s), not as a new source.",
          },
          ...promoted.flatMap(({ name, image }, imageIndex) => [
            {
              type: "text",
              text: `Visual ${imageIndex + 1}/${promoted.length} from ${name}`,
            },
            { type: "image_url", image_url: { url: image.url } },
          ]),
        ],
      });
    }
  }
  return { ...body, messages: output };
}

export function createModel(
  config: HandnoteConfig,
  recorder: SessionRecorder,
  state: RunState,
  stats: ProviderStats,
) {
  const transport = createRetryingFetch(
    config.model,
    recorder,
    state,
    stats,
    fetch,
    repairToolArgumentResponse(recorder),
  );
  const provider = createOpenAICompatible({
    name: "handnote-provider",
    baseURL: config.model.baseUrl.replace(/\/$/, ""),
    apiKey: config.model.apiKey,
    fetch: transport as unknown as typeof fetch,
    transformRequestBody: promoteToolMedia,
    convertUsage: convertDeepSeekUsage,
  });
  return provider(config.model.name);
}

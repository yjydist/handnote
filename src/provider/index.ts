import { HandnoteError } from "../errors.ts";
import { openAiCompatibleAdapter } from "./openai-compatible.ts";
import type { ProviderAdapter, ProviderModelContext } from "./types.ts";

export { classifyProviderError } from "./classify.ts";
export type { ToolArgumentRepair } from "./openai-compatible.ts";
export {
  convertDeepSeekUsage,
  openAiCompatibleAdapter,
  promoteToolMedia,
  repairOpenAiToolArguments,
  repairToolArgumentResponse,
} from "./openai-compatible.ts";
export { createRetryingFetch, requestFingerprint } from "./retry.ts";
export type {
  ProviderAdapter,
  ProviderModelContext,
  ProviderStats,
  RetryConfig,
} from "./types.ts";

const adapters = new Map<string, ProviderAdapter>([
  [openAiCompatibleAdapter.protocol, openAiCompatibleAdapter],
]);

export function createModel(context: ProviderModelContext) {
  const adapter = adapters.get(context.config.model.provider);
  if (!adapter)
    throw new HandnoteError(
      `Unknown provider: ${context.config.model.provider}`,
      "validation",
      false,
    );
  return adapter.createModel(context);
}

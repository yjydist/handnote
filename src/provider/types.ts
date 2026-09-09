import type { LanguageModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import type { RunState } from "../state.ts";

export const modelConfigSchema = z
  .object({
    provider: z.enum(["openai-compatible"]).default("openai-compatible"),
    baseUrl: z.url(),
    apiKey: z.string().min(1),
    name: z.string().min(1),
    timeoutMs: z.int().min(1_000).max(600_000).default(240_000),
    maxRetries: z.int().min(0).max(5).default(1),
  })
  .strict();
export type ModelConfig = z.output<typeof modelConfigSchema>;
export interface RetryConfig {
  timeoutMs: number;
  maxRetries: number;
}
export interface ProviderModelContext {
  config: ModelConfig;
  state: RunState;
}
export interface ProviderAdapter {
  readonly protocol: string;
  createModel(context: ProviderModelContext): LanguageModelV4;
}

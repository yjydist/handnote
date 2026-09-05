import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { HandnoteConfig } from "../config.ts";
import type { SessionRecorder } from "../session.ts";
import type { RunState } from "../state.ts";
import type { RunStore } from "../store.ts";

export interface ProviderStats {
  retries: number;
  attempts: number;
}

export interface RetryConfig {
  timeoutMs: number;
  maxRetries: number;
}

export interface ProviderModelContext {
  store?: RunStore;
  config: HandnoteConfig;
  recorder: SessionRecorder;
  state: RunState;
  stats: ProviderStats;
}

export interface ProviderAdapter {
  readonly protocol: string;
  createModel(context: ProviderModelContext): LanguageModelV4;
}

import type { SafeErrorMetadata } from "./agent-errors.ts";
import type { ModelAccounting } from "./model-accounting.ts";
import type { StepUsage, TokenUsage } from "./usage.ts";

interface ModelEventData {
  "model.run.started": { maxSteps: number };
  "model.attempt.started": {
    step: number;
    attempt: number;
    request?: { sha256: string; bytes: number; imageCount: number };
  };
  "model.attempt.completed": {
    step: number;
    attempt: number;
    status: number;
    durationMs: number;
  };
  "model.attempt.failed": {
    step: number;
    attempt: number;
    durationMs: number;
    error: SafeErrorMetadata;
  };
  "model.tool_arguments.repaired": {
    step: number;
    attempt: number;
    repairs: Array<{ toolName: string; removedTrailingClosers: number }>;
  };
  "model.step.completed": {
    step: number;
    text: string;
    toolCalls: unknown;
    toolResults: unknown;
    usage: StepUsage;
    finishReason: unknown;
  };
  "model.stream.error": { step: number; kind: string; message: string };
  "model.run.completed": {
    finishReason: string;
    steps: number;
    usage: TokenUsage;
    text: string;
  };
  "model.run.failed": {
    kind: string;
    message: string;
    error: SafeErrorMetadata;
  };
}
export type ModelEventPayload = {
  [Type in keyof ModelEventData]: { type: Type; data: ModelEventData[Type] };
}[keyof ModelEventData];
export type ModelEvent = ModelEventPayload & { accounting: ModelAccounting };
export type ModelEventSink = (event: ModelEvent) => Promise<void>;

export interface AgentDiagnostic {
  message: string;
  context: object[];
}
// The SDK logger is synchronous; diagnostic consumers must not return a promise.
export type AgentDiagnosticSink = (diagnostic: AgentDiagnostic) => undefined;

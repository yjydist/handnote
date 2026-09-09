import type { LanguageModelV4 } from "@ai-sdk/provider";
import { Agent } from "@mastra/core/agent";
import { AgentError, safeErrorMetadata } from "./agent-errors.ts";
import type { AgentDiagnosticSink, ModelEventSink } from "./agent-events.ts";
import { AgentErrorLogger } from "./agent-logger.ts";
import type { HandnoteToolHandlers } from "./agent-protocol.ts";
import { createAgentTools } from "./agent-tools.ts";
import { classifyProviderError, createModel } from "./provider/index.ts";
import type { ModelConfig } from "./provider/types.ts";
import { RunState } from "./state.ts";
import type { TokenUsage } from "./usage.ts";

export interface AgentRunResult {
  finishReason: string;
  steps: number;
  usage: TokenUsage;
  text: string;
}

export async function runAgent(options: {
  config: {
    model: ModelConfig;
    promptText: string;
    maxSteps: number;
    maxInspectCalls: number;
  };
  source: { data: Uint8Array; mimeType: string };
  handlers: HandnoteToolHandlers;
  onModelEvent: ModelEventSink;
  onDiagnostic: AgentDiagnosticSink;
  model?: LanguageModelV4;
}): Promise<AgentRunResult> {
  const state = new RunState(options.onModelEvent);
  let acceptingCallbacks = true;
  const agent = new Agent({
    id: "handnote-agent",
    name: "Handnote Agent",
    instructions: options.config.promptText,
    model:
      options.model ?? createModel({ config: options.config.model, state }),
    tools: createAgentTools({
      handlers: options.handlers,
      maxSteps: options.config.maxSteps,
      maxInspectCalls: options.config.maxInspectCalls,
      currentStep: () => state.modelStep,
      onFatal: (error) => {
        state.fail(error);
        throw error;
      },
      onFinalized: () => {
        state.finalized = true;
      },
    }),
    maxRetries: 0,
  });
  agent.__setLogger(
    new AgentErrorLogger((diagnostic) => {
      if (!acceptingCallbacks || state.hasFatalError) return undefined;
      try {
        return options.onDiagnostic(diagnostic);
      } catch (error) {
        state.fail(error);
        throw error;
      }
    }),
  );
  await state.emit({
    type: "model.run.started",
    data: { maxSteps: options.config.maxSteps },
  });
  try {
    const result = await agent.generate(
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Digitize every meaningful note item from this single source image into a faithful electronic note. Follow the configured tool protocol; do not summarize or describe the page, and finalize only after a later-step source-to-render review.",
            },
            {
              type: "image",
              image: options.source.data,
              mimeType: options.source.mimeType,
            },
          ],
        },
      ],
      {
        maxSteps: options.config.maxSteps,
        stopWhen: () => state.finalized || state.hasFatalError,
        modelSettings: { maxRetries: 0 },
        prepareStep: () => {
          if (state.hasFatalError) throw state.fatalError;
          // Supplied offline models bypass the HTTP transport's step counter.
          if (options.model) state.beginModelStep();
          return {};
        },
        onStepFinish: async (step) => {
          if (!acceptingCallbacks) return;
          state.completeModelStep(step.usage);
          await state.emit({
            type: "model.step.completed",
            data: {
              step: state.modelStep,
              text: step.text,
              toolCalls: step.toolCalls,
              toolResults: step.toolResults,
              usage: step.usage,
              finishReason: step.finishReason,
            },
          });
        },
        onError: async ({ error }) => {
          if (!acceptingCallbacks || state.hasFatalError) return;
          const classified = classifyProviderError(error);
          await state.emit({
            type: "model.stream.error",
            data: {
              step: state.modelStep,
              kind: classified.kind,
              message: classified.message,
            },
          });
        },
      },
    );
    if (state.hasFatalError) throw state.fatalError;
    acceptingCallbacks = false;
    const output = {
      finishReason: String(result.finishReason),
      steps: result.steps.length,
      usage: state.modelAccounting.usage,
      text: result.text,
    };
    await state.emit({ type: "model.run.completed", data: output });
    return output;
  } catch (error) {
    // Mastra can invoke stream callbacks after generate has already rejected.
    acceptingCallbacks = false;
    const failure = state.hasFatalError
      ? state.fatalError
      : classifyProviderError(error);
    const kind =
      failure instanceof AgentError
        ? failure.kind
        : failure &&
            typeof failure === "object" &&
            "kind" in failure &&
            typeof failure.kind === "string"
          ? failure.kind
          : "internal";
    try {
      await state.emit({
        type: "model.run.failed",
        data: {
          kind,
          message: failure instanceof Error ? failure.message : String(failure),
          error: safeErrorMetadata(failure),
        },
      });
    } catch (eventError) {
      throw state.hasFatalError ? state.fatalError : eventError;
    }
    throw failure;
  }
}

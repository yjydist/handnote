import { readFile } from "node:fs/promises";
import { Agent } from "@mastra/core/agent";
import { AgentErrorLogger } from "./agent-logger.ts";
import type { HandnoteConfig } from "./config.ts";
import { safeErrorMetadata } from "./errors.ts";
import { classifyProviderError, type createModel } from "./provider/index.ts";
import type { SessionRecorder } from "./session.ts";
import type { RunState } from "./state.ts";
import type { RunStore } from "./store.ts";
import type { createHandnoteTools } from "./tools/index.ts";
import { accumulateStepUsage, type TokenUsage } from "./usage.ts";

export interface AgentRunResult {
  finishReason: string;
  steps: number;
  usage: AgentUsage;
  text: string;
}

export type AgentUsage = TokenUsage;

export interface AgentRunStats {
  completedSteps: number;
  usage: AgentUsage;
}

export function createAgentRunStats(): AgentRunStats {
  return { completedSteps: 0, usage: {} };
}

export function accumulateAgentUsage(
  stats: AgentRunStats,
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
    cachedInputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
  },
): void {
  stats.completedSteps++;
  stats.usage = accumulateStepUsage(stats.usage, usage);
}

export async function runAgent(options: {
  store?: RunStore;
  config: HandnoteConfig;
  model: ReturnType<typeof createModel>;
  tools: ReturnType<typeof createHandnoteTools>;
  sourcePath: string;
  sourceMimeType: string;
  recorder: SessionRecorder;
  state: RunState;
  stats: AgentRunStats;
}): Promise<AgentRunResult> {
  const agent = new Agent({
    id: "handnote-agent",
    name: "Handnote Agent",
    instructions: options.config.promptText,
    model: options.model,
    tools: options.tools,
    maxRetries: 0,
  });
  agent.__setLogger(new AgentErrorLogger(options.recorder));
  const source = await readFile(options.sourcePath);
  options.recorder.record("model.run.started", {
    maxSteps: options.config.maxSteps,
    source: await options.recorder.media(
      options.sourcePath,
      options.sourceMimeType,
    ),
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
            { type: "image", image: source, mimeType: options.sourceMimeType },
          ],
        },
      ],
      {
        maxSteps: options.config.maxSteps,
        stopWhen: () =>
          options.state.finalized || Boolean(options.state.fatalError),
        modelSettings: { maxRetries: 0 },
        onStepFinish: async (step) => {
          accumulateAgentUsage(options.stats, step.usage);
          options.recorder.record("model.step.completed", {
            step: options.state.modelStep,
            text: step.text,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
            usage: step.usage,
            finishReason: step.finishReason,
          });
          await options.store?.updateModel({
            steps: options.state.modelStep,
            usage: options.stats.usage,
          });
        },
        onError: ({ error }) => {
          const classified = classifyProviderError(error);
          options.recorder.record("model.stream.error", {
            step: options.state.modelStep,
            kind: classified.kind,
            message: classified.message,
          });
        },
      },
    );
    const output = {
      finishReason: String(result.finishReason),
      steps: result.steps.length,
      usage: options.stats.usage,
      text: result.text,
    };
    if (options.state.fatalError) throw options.state.fatalError;
    options.recorder.record("model.run.completed", output);
    return output;
  } catch (error) {
    const classified = classifyProviderError(error);
    options.recorder.record("model.run.failed", {
      kind: classified.kind,
      message: classified.message,
      error: safeErrorMetadata(error),
    });
    throw classified;
  }
}

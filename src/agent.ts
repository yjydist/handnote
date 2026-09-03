import { readFile } from "node:fs/promises";
import { Agent } from "@mastra/core/agent";
import type { HandnoteConfig } from "./config.ts";
import { safeErrorMetadata } from "./errors.ts";
import { classifyProviderError, type createModel } from "./provider.ts";
import type { SessionRecorder } from "./session.ts";
import type { RunState } from "./state.ts";
import type { createHandnoteTools } from "./tools/index.ts";

export interface AgentRunResult {
  finishReason: string;
  steps: number;
  usage: AgentUsage;
  text: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  textOutputTokens?: number;
}

export interface AgentRunStats {
  completedSteps: number;
  usage: AgentUsage;
}

export function createAgentRunStats(): AgentRunStats {
  return { completedSteps: 0, usage: {} };
}

function add(target: AgentUsage, key: keyof AgentUsage, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  target[key] = (target[key] ?? 0) + value;
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
  add(stats.usage, "inputTokens", usage.inputTokens);
  add(stats.usage, "outputTokens", usage.outputTokens);
  add(stats.usage, "totalTokens", usage.totalTokens);
  add(stats.usage, "cachedInputTokens", usage.cachedInputTokens);
  add(stats.usage, "reasoningTokens", usage.reasoningTokens);
  if (
    typeof usage.outputTokens === "number" &&
    typeof usage.reasoningTokens === "number"
  )
    add(
      stats.usage,
      "textOutputTokens",
      Math.max(0, usage.outputTokens - usage.reasoningTokens),
    );
}

export async function runAgent(options: {
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
        onStepFinish: (step) => {
          accumulateAgentUsage(options.stats, step.usage);
          options.recorder.record("model.step.completed", {
            step: options.state.modelStep,
            text: step.text,
            toolCalls: step.toolCalls,
            toolResults: step.toolResults,
            usage: step.usage,
            finishReason: step.finishReason,
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

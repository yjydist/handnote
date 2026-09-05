export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  textOutputTokens?: number | undefined;
}

type StepUsage = Partial<
  Record<Exclude<keyof TokenUsage, "textOutputTokens">, unknown>
>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function accumulateStepUsage(
  total: Readonly<TokenUsage>,
  step: Readonly<StepUsage>,
): TokenUsage {
  const usage = { ...total };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const) {
    const value = step[key];
    if (isFiniteNumber(value)) usage[key] = (usage[key] ?? 0) + value;
  }
  if (isFiniteNumber(step.outputTokens) && isFiniteNumber(step.reasoningTokens))
    usage.textOutputTokens =
      (usage.textOutputTokens ?? 0) +
      Math.max(0, step.outputTokens - step.reasoningTokens);
  return usage;
}

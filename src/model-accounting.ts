import type { RunManifest } from "./manifest.ts";
import { accumulateStepUsage, type StepUsage } from "./usage.ts";

export type ModelAccounting = RunManifest["model"];

export function createModelAccounting(): ModelAccounting {
  return { steps: 0, retries: 0, attempts: 0, usage: {} };
}

export function accountModelAttempt(
  model: Readonly<ModelAccounting>,
  attempt: { step: number; attempt: number },
): ModelAccounting {
  return {
    ...model,
    steps: Math.max(model.steps, attempt.step),
    attempts: model.attempts + 1,
    retries: model.retries + (attempt.attempt > 1 ? 1 : 0),
  };
}

export function accountModelStep(
  model: Readonly<ModelAccounting>,
  step: { step: number; usage: StepUsage },
): ModelAccounting {
  return {
    ...model,
    steps: Math.max(model.steps, step.step),
    usage: accumulateStepUsage(model.usage, step.usage),
  };
}

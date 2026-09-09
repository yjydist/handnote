import type { ModelEventPayload, ModelEventSink } from "./agent-events.ts";
import {
  accountModelAttempt,
  accountModelStep,
  createModelAccounting,
  type ModelAccounting,
} from "./model-accounting.ts";
import type { StepUsage } from "./usage.ts";

export class RunState {
  #modelAccounting = createModelAccounting();
  fatalError: unknown;
  hasFatalError = false;

  constructor(private readonly onEvent: ModelEventSink = async () => {}) {}

  async emit(event: ModelEventPayload): Promise<void> {
    try {
      await this.onEvent({ ...event, accounting: this.modelAccounting });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  finalized = false;

  get modelStep(): number {
    return this.#modelAccounting.steps;
  }

  get modelAccounting(): ModelAccounting {
    return {
      ...this.#modelAccounting,
      usage: { ...this.#modelAccounting.usage },
    };
  }

  beginModelStep(): number {
    return ++this.#modelAccounting.steps;
  }

  beginModelAttempt(attempt: { step: number; attempt: number }): void {
    this.#modelAccounting = accountModelAttempt(this.#modelAccounting, attempt);
  }

  completeModelStep(usage: StepUsage): void {
    this.#modelAccounting = accountModelStep(this.#modelAccounting, {
      step: this.modelStep,
      usage,
    });
  }

  fail(error: unknown): void {
    if (this.hasFatalError) return;
    this.hasFatalError = true;
    this.fatalError = error;
  }
}

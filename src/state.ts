import type { HandnoteError } from "./errors.ts";
import {
  accountModelAttempt,
  accountModelStep,
  createModelAccounting,
  type ModelAccounting,
} from "./model-accounting.ts";
import type { StepUsage } from "./usage.ts";

// Only coordinates the active model loop; document state belongs to RunStore.
export class RunState {
  #modelAccounting = createModelAccounting();
  fatalError?: HandnoteError;
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

  fail(error: HandnoteError): void {
    this.fatalError ??= error;
  }
}

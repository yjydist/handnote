import type { HandnoteError } from "./errors.ts";

// Only coordinates the active model loop; document state belongs to RunStore.
export class RunState {
  modelStep = 0;
  fatalError?: HandnoteError;
  finalized = false;

  beginModelStep(): number {
    return ++this.modelStep;
  }

  fail(error: HandnoteError): void {
    this.fatalError ??= error;
  }
}

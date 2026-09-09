import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { createAgentTools } from "../agent-tools.ts";
import { asError, HandnoteError } from "../errors.ts";
import type { RunState } from "../state.ts";
import { createCaptureFigureHandler } from "./capture-figure.ts";
import { createFinalizeNoteHandler } from "./finalize-note.ts";
import { createInspectSourceHandler } from "./inspect-source.ts";
import { createReadNoteHandler } from "./read-note.ts";
import { createReviewRenderHandler } from "./review-render.ts";
import { createMediaHandler } from "./shared.ts";
import type { ToolContext } from "./types.ts";
import { commitNoteDraft } from "./write-note.ts";

export type { ToolContext } from "./types.ts";

export function createHandnoteHandlers(
  context: ToolContext,
): HandnoteToolHandlers {
  return {
    inspect_source: createInspectSourceHandler(context),
    capture_figure: createCaptureFigureHandler(context),
    read_note: createReadNoteHandler(context),
    write_note: (input, execution) =>
      commitNoteDraft(context, execution, input, "write"),
    revise_note: (input, execution) =>
      commitNoteDraft(context, execution, input, "revise"),
    review_render: createReviewRenderHandler(context),
    finalize_note: createFinalizeNoteHandler(context),
    prepareModelMedia: createMediaHandler(context),
  };
}

export function createHandnoteTools(
  context: ToolContext & { state: RunState },
) {
  return createAgentTools({
    handlers: createHandnoteHandlers(context),
    maxSteps: context.maxSteps,
    maxInspectCalls: context.maxInspectCalls,
    currentStep: () => context.state.modelStep,
    onFatal: (error) => {
      const failure =
        error instanceof HandnoteError
          ? error
          : new HandnoteError(asError(error).message, "internal", false, {
              cause: error,
            });
      context.state.fail(failure);
      throw failure;
    },
    onFinalized: () => {
      context.state.finalized = true;
    },
  });
}

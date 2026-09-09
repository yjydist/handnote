import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { createAgentTools } from "../agent-tools.ts";
import { createCaptureFigureHandler } from "./capture-figure.ts";
import { createFinalizeNoteHandler } from "./finalize-note.ts";
import { createInspectSourceHandler } from "./inspect-source.ts";
import { createReadNoteHandler } from "./read-note.ts";
import { createReviewRenderHandler } from "./review-render.ts";
import { createToolRuntime } from "./shared.ts";
import type { ToolContext } from "./types.ts";
import { commitNoteDraft } from "./write-note.ts";

export type { ToolContext } from "./types.ts";

export function createHandnoteTools(context: ToolContext) {
  const runtime = createToolRuntime(context);
  const handlers: HandnoteToolHandlers = {
    inspect_source: createInspectSourceHandler(context),
    capture_figure: createCaptureFigureHandler(context),
    read_note: createReadNoteHandler(context),
    write_note: (input, execution) =>
      commitNoteDraft(context, execution, input, "write"),
    revise_note: (input, execution) =>
      commitNoteDraft(context, execution, input, "revise"),
    review_render: createReviewRenderHandler(context),
    finalize_note: createFinalizeNoteHandler(context),
    prepareModelMedia: runtime.prepareModelMedia,
  };
  return createAgentTools({
    handlers,
    maxSteps: context.maxSteps,
    maxInspectCalls: context.maxInspectCalls,
    currentStep: () => context.state.modelStep,
    onFatal: runtime.fatal,
    onFinalized: () => {
      context.state.finalized = true;
    },
  });
}

import type { HandnoteToolHandlers } from "@handnote/agent";
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

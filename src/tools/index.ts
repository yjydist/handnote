import { createCaptureFigureTool } from "./capture-figure.ts";
import { createFinalizeNoteTool } from "./finalize-note.ts";
import { createInspectSourceTool } from "./inspect-source.ts";
import { createReadNoteTool } from "./read-note.ts";
import { createReviewRenderTool } from "./review-render.ts";
import { createReviseNoteTool } from "./revise-note.ts";
import { createToolRuntime } from "./shared.ts";
import type { ToolContext } from "./types.ts";
import { createWriteNoteTool } from "./write-note.ts";

export type { ToolContext } from "./types.ts";

export function createHandnoteTools(context: ToolContext) {
  const runtime = createToolRuntime(context);
  return {
    inspect_source: createInspectSourceTool(context, runtime),
    capture_figure: createCaptureFigureTool(context, runtime),
    read_note: createReadNoteTool(context),
    write_note: createWriteNoteTool(context, runtime),
    revise_note: createReviseNoteTool(context, runtime),
    review_render: createReviewRenderTool(context, runtime),
    finalize_note: createFinalizeNoteTool(context, runtime),
  };
}

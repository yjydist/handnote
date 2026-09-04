import { createCaptureFigureTool } from "./capture-figure.ts";
import { createFinalizeNoteTool } from "./finalize-note.ts";
import { createInspectSourceTool } from "./inspect-source.ts";
import { createPatchDocumentTool } from "./patch-document.ts";
import { createReviewRenderTool } from "./review-render.ts";
import { createToolRuntime } from "./shared.ts";
import type { ToolContext } from "./types.ts";
import { createWriteDocumentTool } from "./write-document.ts";

export type { ToolContext } from "./types.ts";

export function createHandnoteTools(context: ToolContext) {
  const runtime = createToolRuntime(context);
  return {
    inspect_source: createInspectSourceTool(context, runtime),
    capture_figure: createCaptureFigureTool(context, runtime),
    write_document: createWriteDocumentTool(context, runtime),
    patch_document: createPatchDocumentTool(context, runtime),
    review_render: createReviewRenderTool(context, runtime),
    finalize_note: createFinalizeNoteTool(context, runtime),
  };
}

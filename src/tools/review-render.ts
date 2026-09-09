import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { toolError } from "../agent-protocol.ts";
import { createModelPreviews } from "../image.ts";
import { NoteStateError } from "../store.ts";
import { layoutSummary, remainingSteps } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createReviewRenderHandler(
  context: ToolContext,
): HandnoteToolHandlers["review_render"] {
  return async (_input, execution) => {
    try {
      const revision = await context.store.review(
        execution.step,
        async (revision) => {
          await createModelPreviews(
            context.store.path(revision.image.path),
            context.toolMedia,
          );
        },
      );
      return {
        ok: true as const,
        revision: revision.number,
        markdownSha256: revision.markdown.sha256,
        path: context.store.path(revision.image.path),
        mimeType: "image/png" as const,
        warnings: revision.warnings,
        structure: revision.structure,
        summary: `Review revision ${revision.number}; ${layoutSummary(revision.warnings)}; ${remainingSteps(execution)}. If source comparison finds no content issue, call finalize_note in the next model step without another revision.`,
      };
    } catch (error) {
      if (error instanceof NoteStateError)
        return toolError(error.code, error.message);
      throw error;
    }
  };
}

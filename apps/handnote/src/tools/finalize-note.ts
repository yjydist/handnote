import type { HandnoteToolHandlers } from "@handnote/agent";
import { toolError } from "@handnote/agent";
import { NoteStateError } from "../store.ts";
import type { ToolContext } from "./types.ts";

export function createFinalizeNoteHandler(
  context: ToolContext,
): HandnoteToolHandlers["finalize_note"] {
  return async (_input, execution) => {
    try {
      const revision = await context.store.finalize(execution.step);
      return {
        ok: true as const,
        revision: revision.number,
        markdownSha256: revision.markdown.sha256,
        summary: "Note finalized",
      };
    } catch (error) {
      if (error instanceof NoteStateError)
        return toolError(error.code, error.message);
      throw error;
    }
  };
}

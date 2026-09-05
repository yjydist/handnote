import { createTool } from "@mastra/core/tools";
import type { ToolRuntime } from "./shared.ts";
import type { ToolContext } from "./types.ts";
import {
  commitNoteDraft,
  noteDraftInputSchema,
  noteRevisionOutputSchema,
} from "./write-note.ts";

export function createReviseNoteTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "revise_note",
    description:
      "Replace the committed note with a new full GFM markdown revision in one atomic step. Input: { markdown, audit }. Copy unchanged content verbatim from the current revision (read_note recovers it exactly); never retype it from memory. The audit is session-only and never appears in the note. When deleting or rewording audited content, drop or retarget its audit item in the same revision.",
    inputSchema: noteDraftInputSchema,
    outputSchema: noteRevisionOutputSchema,
    execute: async (input) => {
      try {
        return await commitNoteDraft(context, input, "revise");
      } catch (error) {
        return runtime.fatal(error);
      }
    },
  });
}

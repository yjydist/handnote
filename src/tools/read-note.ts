import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { layoutSummary, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createReadNoteTool(context: ToolContext) {
  return createTool({
    id: "read_note",
    description:
      "Return the current committed note revision: its full GFM markdown, its sha256, and a layout summary. Use it to recover exact current content before a full-document revise_note.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        markdown: z.string(),
        markdownSha256: z.string(),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
      }),
    ]),
    execute: async () => {
      const revision = context.state.revision;
      if (!revision)
        return toolError("no_revision", "No revision exists; use write_note");
      return {
        ok: true as const,
        revision: revision.number,
        markdown: revision.markdown,
        markdownSha256: revision.markdownSha256,
        summary: `Revision ${revision.number} (${revision.markdown.length} characters); ${layoutSummary(revision.render.warnings)}`,
      };
    },
  });
}

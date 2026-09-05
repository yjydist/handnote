import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { layoutSummary, type ToolRuntime, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createReadNoteTool(context: ToolContext, runtime: ToolRuntime) {
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
      try {
        const revision = await context.store.readRevision();
        if (!revision)
          return toolError("no_revision", "No revision exists; use write_note");
        return {
          ok: true as const,
          revision: revision.number,
          markdown: revision.text,
          markdownSha256: revision.markdown.sha256,
          summary: `Revision ${revision.number} (${revision.text.length} characters); ${layoutSummary(revision.warnings)}`,
        };
      } catch (error) {
        return runtime.fatal(error);
      }
    },
  });
}

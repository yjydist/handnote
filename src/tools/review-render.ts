import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolRuntime } from "./shared.ts";
import { layoutSummary, remainingSteps, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createReviewRenderTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "review_render",
    description:
      "Return the current revision render and precise layout warnings. Compare it with the source for completeness, source-only titles, faithful wording, and absence of summaries, observer commentary, or visible audit material. Batch all discovered fixes into one full-document revision; source regions cannot fix layout.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        markdownSha256: z.string(),
        path: z.string(),
        mimeType: z.literal("image/png"),
        warnings: z.array(z.unknown()),
        structure: z.record(z.string(), z.number()),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
        summary: z.string().optional(),
      }),
    ]),
    execute: async () =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return {
            ...toolError(
              "already_finalized",
              "The note is already finalized and cannot be reviewed again",
            ),
            summary: "Note already finalized",
          };
        if (!context.state.revision)
          return {
            ...toolError("no_revision", "No revision exists to review"),
            summary: "No render",
          };
        try {
          const revision = context.state.review();
          const output = {
            ok: true as const,
            revision: revision.number,
            markdownSha256: revision.markdownSha256,
            path: revision.render.imagePath,
            mimeType: "image/png" as const,
            warnings: revision.render.warnings,
            structure: revision.render.structure,
            summary: `Review revision ${revision.number}; ${layoutSummary(revision.render.warnings)}; ${remainingSteps(context)}. If source comparison finds no content issue, call finalize_note in the next model step without another revision.`,
          };
          context.recorder.record("render.reviewed", output);
          return output;
        } catch (error) {
          return runtime.fatal(error);
        }
      }),
    toModelOutput: (output) =>
      runtime.mediaOutputWithFatal("review_render", output),
  });
}

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createModelPreviews } from "../image.ts";
import { NoteStateError } from "../store.ts";
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
      "Return the current revision render and precise layout warnings. Source audit matches do not establish visual presence. Compare it with the source for visible content, completeness, source-only titles, faithful wording, and absence of summaries, observer commentary, or visible audit material. Batch all discovered fixes into one full-document revision; source regions cannot fix layout.",
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
    execute: async () => {
      try {
        const revision = await context.store.review(
          context.state.modelStep,
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
          summary: `Review revision ${revision.number}; ${layoutSummary(revision.warnings)}; ${remainingSteps(context)}. If source comparison finds no content issue, call finalize_note in the next model step without another revision.`,
        };
      } catch (error) {
        if (error instanceof NoteStateError)
          return toolError(error.code, error.message);
        return runtime.fatal(error);
      }
    },
    toModelOutput: (output) =>
      runtime.mediaOutputWithFatal("review_render", output),
  });
}

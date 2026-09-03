import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { revisionDraftSchema } from "../document.ts";
import { renderDocument } from "../renderer.ts";
import type { ToolRuntime } from "./shared.ts";
import { layoutSummary, remainingSteps, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createWriteDocumentTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "write_document",
    description:
      "Validate, render, and commit the first complete source-faithful digital note plus session-only revision audit. The audit never appears in the rendered note. Source and audit regions record provenance only and do not control layout.",
    inputSchema: revisionDraftSchema,
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        warnings: z.array(z.unknown()),
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
    execute: async (input) =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return toolError(
            "already_finalized",
            "The note is already finalized and cannot be changed",
          );
        try {
          const draft = revisionDraftSchema.parse(input);
          const number = (context.state.revision?.number ?? 0) + 1;
          const render = await renderDocument(
            draft.document,
            context.sourcePath,
            context.runDirectory,
            number,
            context.width,
          );
          const revision = context.state.commit(
            draft.document,
            draft.audit,
            render,
          );
          context.recorder.record("document.revision.committed", {
            revision: number,
            audit: draft.audit,
            render,
          });
          return {
            ok: true as const,
            revision: revision.number,
            warnings: render.warnings,
            summary: `Revision ${revision.number} rendered; ${layoutSummary(render.warnings)}; ${remainingSteps(context)}. Review this exact revision in a later model step.`,
          };
        } catch (error) {
          if (error instanceof z.ZodError)
            return toolError("invalid_document", z.prettifyError(error));
          return runtime.fatal(error);
        }
      }),
  });
}

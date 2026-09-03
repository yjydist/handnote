import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { applyPatch, patchBatchSchema } from "../patch.ts";
import { renderDocument } from "../renderer.ts";
import type { ToolRuntime } from "./shared.ts";
import { layoutSummary, remainingSteps, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createPatchDocumentTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "patch_document",
    description:
      'Atomically apply one flat, ordered operations array, validate audit targets, render the note, and commit a revision. Batch every known edit. Exact replace example: {"operations":[{"op":"replace_block","blockId":"eq1","block":{"id":"eq1","type":"equation","latex":"x=1"}}]}. Do not nest an operation inside block. Source/audit regions are provenance only and never change rendered layout.',
    inputSchema: z.object({ operations: patchBatchSchema }).strict(),
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
    execute: async ({ operations }) =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return toolError(
            "already_finalized",
            "The note is already finalized and cannot be changed",
          );
        if (!context.state.revision)
          return toolError(
            "no_revision",
            "write_document must create the first revision",
          );
        try {
          const draft = applyPatch(
            {
              document: context.state.revision.document,
              audit: context.state.revision.audit,
            },
            operations,
          );
          const number = context.state.revision.number + 1;
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
            operations,
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
          if (
            error instanceof z.ZodError ||
            (error instanceof Error && /Unknown|Position/.test(error.message))
          ) {
            return toolError(
              "invalid_patch",
              error instanceof z.ZodError
                ? z.prettifyError(error)
                : error.message,
            );
          }
          return runtime.fatal(error);
        }
      }),
  });
}

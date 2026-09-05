import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MarkdownValidationError } from "../markdown.ts";
import { NoteStateError } from "../store.ts";
import type { ToolRuntime } from "./shared.ts";
import { layoutSummary, remainingSteps, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export const noteRevisionOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number(),
    markdownSha256: z.string(),
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
]);

export const noteDraftInputSchema = z
  .object({
    markdown: z.string().min(1),
    audit: z
      .object({
        corrections: z.array(z.unknown()).default([]),
        uncertainties: z.array(z.unknown()).default([]),
      })
      .strict()
      .default({ corrections: [], uncertainties: [] }),
  })
  .strict();

export interface NoteToolSuccess {
  ok: true;
  revision: number;
  markdownSha256: string;
  warnings: unknown[];
  summary: string;
}
export type NoteToolResult = NoteToolSuccess | ReturnType<typeof toolError>;

export async function commitNoteDraft(
  context: ToolContext,
  draft: { markdown: string; audit?: unknown },
  kind: "write" | "revise",
): Promise<NoteToolResult> {
  try {
    const revision = await context.store.commit(draft, {
      kind,
      step: context.state.modelStep,
      width: context.width,
    });
    return {
      ok: true,
      revision: revision.number,
      markdownSha256: revision.markdown.sha256,
      warnings: revision.warnings,
      summary: `Revision ${revision.number} rendered; ${layoutSummary(revision.warnings)}; ${remainingSteps(context)}. Review this exact revision in a later model step.`,
    };
  } catch (error) {
    if (error instanceof z.ZodError)
      return toolError("invalid_audit", z.prettifyError(error));
    if (error instanceof MarkdownValidationError)
      return toolError("invalid_markdown", error.message);
    if (error instanceof NoteStateError)
      return toolError(error.code, error.message);
    throw error;
  }
}

export function createWriteNoteTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "write_note",
    description:
      "Validate, render, and commit the first complete source-faithful GFM note plus session-only revision audit. Input: { markdown, audit }. Audit quotes locate exact Markdown source fragments before rendering. The markdown is the whole note in GFM; the audit never appears in the rendered note. Source and audit regions record provenance only and do not control layout.",
    inputSchema: noteDraftInputSchema,
    outputSchema: noteRevisionOutputSchema,
    execute: async (input) => {
      try {
        return await commitNoteDraft(context, input, "write");
      } catch (error) {
        return runtime.fatal(error);
      }
    },
  });
}

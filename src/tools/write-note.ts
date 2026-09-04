import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  emptyRevisionAudit,
  type RevisionAudit,
  revisionDraftSchema,
  validateAuditTargets,
} from "../document.ts";
import { MarkdownValidationError, parseNoteMarkdown } from "../markdown.ts";
import { renderDocument } from "../renderer.ts";
import { atomicWrite, sha256 } from "../utils.ts";
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
  runtime: ToolRuntime,
  draft: { markdown: string; audit?: unknown },
): Promise<NoteToolResult> {
  let parsed: {
    markdown: string;
    audit: { corrections: unknown[]; uncertainties: unknown[] };
  };
  try {
    parsed = revisionDraftSchema.parse(draft);
  } catch (error) {
    if (error instanceof z.ZodError)
      return toolError("invalid_audit", z.prettifyError(error));
    return runtime.fatal(error);
  }
  const audit: RevisionAudit = emptyRevisionAudit();
  audit.corrections = parsed.audit.corrections as typeof audit.corrections;
  audit.uncertainties = parsed.audit
    .uncertainties as typeof audit.uncertainties;
  let note: Awaited<ReturnType<typeof parseNoteMarkdown>> | undefined;
  let noteError: MarkdownValidationError | undefined;
  try {
    note = await parseNoteMarkdown(parsed.markdown, {
      runDirectory: context.runDirectory,
    });
  } catch (error) {
    if (!(error instanceof MarkdownValidationError)) throw error;
    noteError = error;
  }
  if (noteError)
    return toolError(
      "invalid_markdown",
      noteError.issues
        .map(
          (issue) =>
            `${issue.code}${issue.line ? ` (line ${issue.line})` : ""}: ${issue.message}`,
        )
        .join("; "),
    );
  if (!note) throw new Error("parseNoteMarkdown returned without a value");
  const number = (context.state.revision?.number ?? 0) + 1;
  const { render, mermaidTextBlocks } = await renderDocument(
    note,
    context.runDirectory,
    number,
    context.width,
  );
  const auditTargetErrors = validateAuditTargets(
    note.tree,
    audit,
    mermaidTextBlocks,
  );
  if (auditTargetErrors.length > 0)
    return toolError("invalid_audit", auditTargetErrors.join("; "));
  const markdownSha256 = sha256(parsed.markdown);
  const revisionPath = `${context.runDirectory}/revisions/revision-${String(number).padStart(3, "0")}.md`;
  await atomicWrite(revisionPath, parsed.markdown);
  const revision = context.state.commit(
    parsed.markdown,
    markdownSha256,
    audit,
    render,
  );
  context.recorder.record("document.revision.committed", {
    revision: number,
    markdownSha256,
    audit,
    render,
  });
  return {
    ok: true as const,
    revision: revision.number,
    markdownSha256,
    warnings: render.warnings,
    summary: `Revision ${revision.number} rendered; ${layoutSummary(render.warnings)}; ${remainingSteps(context)}. Review this exact revision in a later model step.`,
  };
}

export function createWriteNoteTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "write_note",
    description:
      "Validate, render, and commit the first complete source-faithful GFM note plus session-only revision audit. Input: { markdown, audit }. The markdown is the whole note in GFM; the audit never appears in the rendered note. Source and audit regions record provenance only and do not control layout.",
    inputSchema: noteDraftInputSchema,
    outputSchema: noteRevisionOutputSchema,
    execute: async (input) =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return toolError(
            "already_finalized",
            "The note is already finalized and cannot be changed",
          );
        if (context.state.revision)
          return toolError(
            "revision_exists",
            "A revision already exists; use revise_note to replace the full markdown",
          );
        try {
          return await commitNoteDraft(context, runtime, input);
        } catch (error) {
          return runtime.fatal(error);
        }
      }),
  });
}

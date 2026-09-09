import {
  type NoteToolResult,
  type ToolExecutionContext,
  toolError,
} from "@handnote/agent";
import { z } from "zod";
import { revisionAuditSchema } from "../document.ts";
import { MarkdownValidationError } from "../markdown.ts";
import { NoteStateError } from "../store.ts";
import { layoutSummary, remainingSteps } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export async function commitNoteDraft(
  context: ToolContext,
  execution: ToolExecutionContext,
  draft: { markdown: string; audit?: unknown },
  kind: "write" | "revise",
): Promise<NoteToolResult> {
  try {
    if (
      context.store.manifest.formatVersion === 2 &&
      !revisionAuditSchema.parse(draft.audit).ink
    )
      return toolError(
        "invalid_ink_audit",
        "Trajectory-backed revisions require audit.ink with omissions, electronicText, uncertainties and pending-human-review status (empty lists are allowed).",
      );
    const revision = await context.store.commit(draft, {
      kind,
      step: execution.step,
      width: context.width,
    });
    return {
      ok: true,
      revision: revision.number,
      markdownSha256: revision.markdown.sha256,
      warnings: revision.warnings,
      summary: `Revision ${revision.number} rendered; ${layoutSummary(revision.warnings)}; ${remainingSteps(execution)}. Review this exact revision in a later model step.`,
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

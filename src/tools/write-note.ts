import { z } from "zod";
import {
  type NoteToolResult,
  type ToolExecutionContext,
  toolError,
} from "../agent/index.ts";
import { revisionAuditSchema } from "../run/document.ts";
import { MarkdownValidationError } from "../run/markdown.ts";
import { NoteStateError } from "../run/store.ts";
import { inkLayoutFeedback } from "./ink-layout-feedback.ts";
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
    });
    const structure =
      context.store.manifest.formatVersion === 2
        ? ` ${inkLayoutFeedback(revision.structure, revision.warnings)}`
        : "";
    return {
      ok: true,
      revision: revision.number,
      markdownSha256: revision.markdown.sha256,
      warnings: revision.warnings,
      summary: `Revision ${revision.number} rendered; ${layoutSummary(revision.warnings)}; ${remainingSteps(execution)}. Review this exact revision in a later model step.${structure}`,
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

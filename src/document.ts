import type { Root } from "mdast";
import { z } from "zod";
import { parseMarkdownTree } from "./markdown-parse.ts";
import {
  type AuditTextEvidence,
  analyzeMarkdownSemantics,
  foldWhitespace,
} from "./markdown-semantics.ts";

export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1 && r.y + r.height <= 1,
    "Region exceeds normalized image bounds",
  );

export type Region = z.infer<typeof regionSchema>;

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const auditTargetSchema = z
  .object({
    quote: z.string().min(1).max(500),
    occurrence: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type AuditTarget = z.infer<typeof auditTargetSchema>;

export const correctionAuditSchema = z
  .object({
    id: idSchema,
    target: auditTargetSchema,
    original: z.string().min(1),
    corrected: z.string().min(1),
    basis: z.string().min(1),
    region: regionSchema,
    confidence: z.number().min(0.95).max(1),
  })
  .strict();
export const uncertaintyAuditSchema = z
  .object({
    id: idSchema,
    target: auditTargetSchema,
    bestGuess: z.string().min(1),
    candidates: z.array(z.string().min(1)).min(2),
    basis: z.string().min(1),
    region: regionSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const revisionAuditSchema = z
  .object({
    corrections: z.array(correctionAuditSchema).default([]),
    uncertainties: z.array(uncertaintyAuditSchema).default([]),
  })
  .strict()
  .superRefine((audit, ctx) => {
    const ids = new Set<string>();
    for (const item of [...audit.corrections, ...audit.uncertainties]) {
      if (ids.has(item.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate audit ID: ${item.id}`,
        });
      ids.add(item.id);
    }
  });

export type RevisionAudit = z.infer<typeof revisionAuditSchema>;

const asciiWord = (value: string | undefined): boolean =>
  value !== undefined && /^[A-Za-z0-9_]$/.test(value);

function quoteOccurrences(folded: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = folded.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? folded[index - 1] : undefined;
    const after = folded[index + needle.length];
    if (
      !(asciiWord(needle[0]) && asciiWord(before)) &&
      !(asciiWord(needle.at(-1)) && asciiWord(after))
    )
      count++;
    index = folded.indexOf(needle, index + 1);
  }
  return count;
}

function auditTargetValidation(
  tree: Root,
  audit: RevisionAudit,
  evidence?: AuditTextEvidence,
): { messages: string[]; mermaidCount: number; mathCount: number } {
  const { blocks, mermaidCount, mathCount } = analyzeMarkdownSemantics(
    tree,
    evidence,
  );
  const folded = blocks.join("\0");
  const occurrenceCounts = new Map<string, number>();
  const messages: string[] = [];
  for (const item of [...audit.corrections, ...audit.uncertainties]) {
    const required = item.target.occurrence ?? 1;
    const needle = foldWhitespace(item.target.quote);
    let occurrences = occurrenceCounts.get(needle);
    if (occurrences === undefined) {
      occurrences = quoteOccurrences(folded, needle);
      occurrenceCounts.set(needle, occurrences);
    }
    if (occurrences < required)
      messages.push(
        `Audit ${item.id} quote not found (occurrence ${required})`,
      );
  }
  return { messages, mermaidCount, mathCount };
}

export function validateAuditTargets(
  tree: Root,
  audit: RevisionAudit,
  evidence: AuditTextEvidence,
): string[] {
  return auditTargetValidation(tree, audit, evidence).messages;
}

export const revisionDraftSchema = z
  .object({
    markdown: z.string().min(1),
    audit: revisionAuditSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    const items = [...draft.audit.corrections, ...draft.audit.uncertainties];
    if (items.length === 0) return;

    const validation = auditTargetValidation(
      parseMarkdownTree(draft.markdown),
      draft.audit,
    );
    if (validation.mermaidCount > 0 || validation.mathCount > 0) return;
    for (const message of validation.messages)
      ctx.addIssue({ code: "custom", message, path: ["audit"] });
  });

export type RevisionDraft = z.infer<typeof revisionDraftSchema>;

export function emptyRevisionAudit(): RevisionAudit {
  return { corrections: [], uncertainties: [] };
}

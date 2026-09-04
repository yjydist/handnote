import { z } from "zod";

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

const foldWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

function quoteOccurrences(markdown: string, quote: string): number {
  const folded = foldWhitespace(markdown);
  const needle = foldWhitespace(quote);
  if (!needle) return 0;
  let count = 0;
  let index = folded.indexOf(needle);
  while (index >= 0) {
    count++;
    index = folded.indexOf(needle, index + needle.length);
  }
  return count;
}

export const revisionDraftSchema = z
  .object({
    markdown: z.string().min(1),
    audit: revisionAuditSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    for (const item of [
      ...draft.audit.corrections,
      ...draft.audit.uncertainties,
    ]) {
      const required = item.target.occurrence ?? 1;
      if (quoteOccurrences(draft.markdown, item.target.quote) < required)
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} quote not found (occurrence ${required})`,
          path: ["audit"],
        });
    }
  });

export type RevisionDraft = z.infer<typeof revisionDraftSchema>;

export function emptyRevisionAudit(): RevisionAudit {
  return { corrections: [], uncertainties: [] };
}

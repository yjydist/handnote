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
    quote: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0, "Quote must not be blank"),
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

function quoteOccurrences(markdown: string, quote: string): number {
  if (!quote) return 0;
  let count = 0;
  for (
    let index = markdown.indexOf(quote);
    index >= 0;
    index = markdown.indexOf(quote, index + 1)
  )
    count++;
  return count;
}

export const revisionDraftSchema = z
  .object({
    markdown: z.string().min(1),
    audit: revisionAuditSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    const counts = new Map<string, number>();
    for (const item of [
      ...draft.audit.corrections,
      ...draft.audit.uncertainties,
    ]) {
      const { quote, occurrence = 1 } = item.target;
      const count =
        counts.get(quote) ?? quoteOccurrences(draft.markdown, quote);
      counts.set(quote, count);
      if (count < occurrence)
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} quote not found (occurrence ${occurrence})`,
          path: ["audit"],
        });
    }
  });

export type RevisionDraft = z.infer<typeof revisionDraftSchema>;

export function emptyRevisionAudit(): RevisionAudit {
  return { corrections: [], uncertainties: [] };
}

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
const sourcesSchema = z.array(regionSchema).min(1);
const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

const paragraphSchema = z
  .object({
    id: idSchema,
    type: z.literal("paragraph"),
    text: z.string().min(1),
    sources: sourcesSchema.optional(),
  })
  .strict();
interface BulletItem {
  text: string;
  children?: BulletItem[] | undefined;
}
const bulletItemSchema: z.ZodType<BulletItem> = z.lazy(() =>
  z
    .object({
      text: z.string().min(1),
      children: z.array(bulletItemSchema).optional(),
    })
    .strict(),
);
const bulletListSchema = z
  .object({
    id: idSchema,
    type: z.literal("bullet_list"),
    items: z.array(bulletItemSchema).min(1),
    sources: sourcesSchema.optional(),
  })
  .strict();
const numberedStepsSchema = z
  .object({
    id: idSchema,
    type: z.literal("numbered_steps"),
    steps: z.array(z.string().min(1)).min(1),
    sources: sourcesSchema.optional(),
  })
  .strict();
const calloutSchema = z
  .object({
    id: idSchema,
    type: z.literal("callout"),
    tone: z.enum(["info", "warning", "tip"]),
    text: z.string().min(1),
    sources: sourcesSchema.optional(),
  })
  .strict();
const tableSchema = z
  .object({
    id: idSchema,
    type: z.literal("table"),
    headers: z.array(z.string()).min(1).max(20),
    rows: z.array(z.array(z.string())).min(1),
    sources: sourcesSchema.optional(),
  })
  .strict()
  .refine(
    (t) => t.rows.every((row) => row.length === t.headers.length),
    "Every table row must match the header count",
  );
const equationSchema = z
  .object({
    id: idSchema,
    type: z.literal("equation"),
    latex: z.string().min(1),
    label: z.string().optional(),
    sources: sourcesSchema.optional(),
  })
  .strict();
const diagramSchema = z
  .object({
    id: idSchema,
    type: z.literal("diagram"),
    mermaid: z.string().min(1).max(8000),
    sources: sourcesSchema.optional(),
  })
  .strict();
const sourceFigureSchema = z
  .object({
    id: idSchema,
    type: z.literal("source_figure"),
    region: regionSchema,
    caption: z.string().optional(),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("type", [
  paragraphSchema,
  bulletListSchema,
  numberedStepsSchema,
  calloutSchema,
  tableSchema,
  equationSchema,
  diagramSchema,
  sourceFigureSchema,
]);
export type Block = z.infer<typeof blockSchema>;

export interface Section {
  id: string;
  title?: string | undefined;
  blocks: Block[];
  sections?: Section[] | undefined;
}

export const sectionSchema: z.ZodType<Section> = z.lazy(() =>
  z
    .object({
      id: idSchema,
      title: z.string().min(1).optional(),
      blocks: z.array(blockSchema),
      sections: z.array(sectionSchema).optional(),
    })
    .strict(),
);

export const auditTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document_title") }).strict(),
  z.object({ kind: z.literal("section_title"), sectionId: idSchema }).strict(),
  z.object({ kind: z.literal("block"), blockId: idSchema }).strict(),
]);

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

export const noteDocumentSchema = z
  .object({
    title: z.string().min(1).optional(),
    sections: z.array(sectionSchema).min(1),
  })
  .strict()
  .superRefine((document, ctx) => {
    const ids = new Set<string>();
    const add = (id: string, kind: string) => {
      if (ids.has(id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate ${kind} ID: ${id}`,
        });
      ids.add(id);
    };
    const visit = (section: Section) => {
      add(section.id, "section");
      for (const block of section.blocks) {
        add(block.id, "block");
      }
      for (const child of section.sections ?? []) visit(child);
    };
    for (const section of document.sections) visit(section);
  });

export type NoteDocument = z.infer<typeof noteDocumentSchema>;

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

export const revisionDraftSchema = z
  .object({
    document: noteDocumentSchema,
    audit: revisionAuditSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    const sectionTitles = new Map<string, string | undefined>();
    const blockIds = new Set<string>();
    const visit = (section: Section) => {
      sectionTitles.set(section.id, section.title);
      for (const block of section.blocks) blockIds.add(block.id);
      for (const child of section.sections ?? []) visit(child);
    };
    for (const section of draft.document.sections) visit(section);

    for (const item of [
      ...draft.audit.corrections,
      ...draft.audit.uncertainties,
    ]) {
      const target = item.target;
      if (target.kind === "document_title" && !draft.document.title)
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} targets a missing document title`,
          path: ["audit"],
        });
      if (
        target.kind === "section_title" &&
        !sectionTitles.get(target.sectionId)
      )
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} targets a missing section title: ${target.sectionId}`,
          path: ["audit"],
        });
      if (target.kind === "block" && !blockIds.has(target.blockId))
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} targets an unknown block: ${target.blockId}`,
          path: ["audit"],
        });
    }
  });

export type RevisionDraft = z.infer<typeof revisionDraftSchema>;

export function emptyRevisionAudit(): RevisionAudit {
  return { corrections: [], uncertainties: [] };
}

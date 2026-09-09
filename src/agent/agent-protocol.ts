import { z } from "zod";
import type { InkToolHandlers } from "./ink-protocol.ts";

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

const inspectEnhancementSchema = z.enum([
  "original",
  "grayscale",
  "contrast",
  "sharpen",
  "binarize",
]);
const inspectScaleSchema = z.number().min(1).max(4);
const inspectRegionSchema = z
  .object({
    x: z.number().min(0).lt(1),
    y: z.number().min(0).lt(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    scale: inspectScaleSchema.optional(),
    enhancement: inspectEnhancementSchema.optional(),
  })
  .strict();

export const inspectInputSchema = z
  .object({
    regions: z.array(inspectRegionSchema).min(1).max(8),
    scale: inspectScaleSchema.optional(),
    enhancement: inspectEnhancementSchema.optional(),
  })
  .strict();

export type InspectRequest = z.infer<typeof inspectInputSchema>;

export const captureFigureInputSchema = z
  .object({ region: regionSchema })
  .strict();

export type CaptureFigureRequest = z.infer<typeof captureFigureInputSchema>;

export const toolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    repairable: z.literal(true),
  }),
});

export const toolError = <Code extends string>(
  code: Code,
  message: string,
): { ok: false; error: { code: Code; message: string; repairable: true } } => ({
  ok: false,
  error: { code, message, repairable: true },
});

export const noteRevisionOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number(),
    markdownSha256: z.string(),
    warnings: z.array(z.unknown()),
    summary: z.string(),
  }),
  toolErrorSchema,
]);

export const inkAuditSchema = z
  .object({
    status: z.literal("pending-human-review").default("pending-human-review"),
    omissions: z
      .array(
        z
          .object({
            strokeIndices: z.array(z.int().nonnegative()).min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    electronicText: z
      .array(
        z
          .object({ text: z.string().min(1), reason: z.string().min(1) })
          .strict(),
      )
      .default([]),
    uncertainties: z
      .array(
        z
          .object({
            strokeIndices: z.array(z.int().nonnegative()).min(1),
            description: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const noteDraftInputSchema = z
  .object({
    markdown: z.string().min(1),
    audit: z
      .object({
        corrections: z.array(z.unknown()).default([]),
        uncertainties: z.array(z.unknown()).default([]),
        ink: inkAuditSchema.optional(),
      })
      .strict()
      .default({ corrections: [], uncertainties: [] }),
  })
  .strict();

export type NoteToolResult = z.infer<typeof noteRevisionOutputSchema>;

export const inspectSourceOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    path: z.string(),
    mimeType: z.literal("image/png"),
    width: z.number(),
    height: z.number(),
    kind: z.enum(["crop", "contact_sheet"]),
    summary: z.string(),
  }),
  toolErrorSchema.extend({
    error: toolErrorSchema.shape.error.extend({
      code: z.literal("inspection_budget_exhausted"),
    }),
    summary: z.string(),
  }),
]);

export const captureFigureOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    relativePath: z.string(),
    path: z.string(),
    width: z.number(),
    height: z.number(),
    mimeType: z.literal("image/png"),
    summary: z.string(),
  }),
  toolErrorSchema,
]);

export const readNoteOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number(),
    markdown: z.string(),
    markdownSha256: z.string(),
    summary: z.string(),
  }),
  toolErrorSchema,
]);

export const reviewRenderOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number(),
    markdownSha256: z.string(),
    path: z.string(),
    mimeType: z.literal("image/png"),
    warnings: z.array(z.unknown()),
    paths: z.array(z.string()).optional(),
    reviewed: z.boolean().optional(),
    structure: z.record(z.string(), z.number()),
    summary: z.string(),
  }),
  toolErrorSchema.extend({
    summary: z.string().optional(),
  }),
]);

export const finalizeNoteOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: z.number(),
    markdownSha256: z.string(),
    summary: z.string(),
  }),
  toolErrorSchema,
]);

export interface ToolExecutionContext {
  readonly step: number;
  readonly remainingSteps: number;
}

export interface ModelMediaResult {
  ok: boolean;
  path?: string | undefined;
  paths?: string[] | undefined;
  mimeType?: string | undefined;
  summary?: string | undefined;
}

export type MediaToolName =
  | "inspect_source"
  | "review_render"
  | "capture_figure"
  | "inspect_ink"
  | "select_ink"
  | "compose_ink";
export interface PreparedPreview {
  label?: string;
  data: string;
  mediaType: string;
  width: number;
  height: number;
}

export type PreparedToolMedia =
  | { kind: "text"; text: string }
  | {
      kind: "previews";
      summary: string;
      previews: ReadonlyArray<PreparedPreview>;
    };

export interface HandnoteToolHandlers {
  ink?: InkToolHandlers;
  inspect_source(
    input: InspectRequest,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof inspectSourceOutputSchema>>;
  capture_figure(
    input: CaptureFigureRequest,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof captureFigureOutputSchema>>;
  read_note(
    input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof readNoteOutputSchema>>;
  write_note(
    input: z.input<typeof noteDraftInputSchema>,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof noteRevisionOutputSchema>>;
  revise_note(
    input: z.input<typeof noteDraftInputSchema>,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof noteRevisionOutputSchema>>;
  review_render(
    input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof reviewRenderOutputSchema>>;
  finalize_note(
    input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<z.output<typeof finalizeNoteOutputSchema>>;
  prepareModelMedia(
    purpose: MediaToolName,
    output: ModelMediaResult,
  ): Promise<PreparedToolMedia>;
}

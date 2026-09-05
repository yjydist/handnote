import { z } from "zod";

export const layoutWarningSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    blocking: z.boolean(),
    elementId: z.string().optional(),
    axis: z.literal("horizontal").optional(),
    overflowPx: z.number().optional(),
    containerPx: z.number().optional(),
    contentPx: z.number().optional(),
  })
  .strict();

export type LayoutWarning = z.infer<typeof layoutWarningSchema>;

export const noteStructureSchema = z
  .object({
    headings: z.number(),
    blocks: z.number(),
    tables: z.number(),
    equations: z.number(),
    diagrams: z.number(),
    figures: z.number(),
  })
  .strict();

export type NoteStructure = z.infer<typeof noteStructureSchema>;

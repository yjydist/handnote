import { z } from "zod";
import {
  regionSchema,
  type ToolExecutionContext,
  toolErrorSchema,
} from "./agent-protocol.ts";

const assetIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const inkPresentationSchema = z
  .object({
    kind: z.enum(["text", "diagram"]),
    referenceHeight: z.number().positive(),
    transcription: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

export const inspectInkInputSchema = z
  .object({
    views: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("page") }).strict(),
          z
            .object({ kind: z.literal("region"), region: regionSchema })
            .strict(),
          z
            .object({ kind: z.literal("asset"), assetId: assetIdSchema })
            .strict(),
        ]),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const selectInkInputSchema = z
  .object({
    selections: z
      .array(
        z
          .object({
            strokeIndices: z.array(z.int().nonnegative()).min(1),
            presentation: inkPresentationSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export const composeInkInputSchema = z
  .object({
    compositions: z
      .array(
        z
          .object({
            parts: z
              .array(
                z
                  .object({
                    assetId: assetIdSchema,
                    rotation: z.number(),
                    scale: z.number().min(0.01).max(100),
                    x: z.number(),
                    y: z.number(),
                  })
                  .strict(),
              )
              .min(1),
            presentation: inkPresentationSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export const inkToolOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    paths: z.array(z.string()).min(1),
    mimeType: z.literal("image/png"),
    summary: z.string(),
    items: z.array(z.unknown()),
    status: z.literal("pending-human-review"),
  }),
  toolErrorSchema.extend({ summary: z.string() }),
]);
export type InspectInkRequest = z.infer<typeof inspectInkInputSchema>;
export type SelectInkRequest = z.infer<typeof selectInkInputSchema>;
export type ComposeInkRequest = z.infer<typeof composeInkInputSchema>;
export type InkToolResult = z.infer<typeof inkToolOutputSchema>;
export interface InkToolHandlers {
  inspect_ink(
    input: InspectInkRequest,
    context: ToolExecutionContext,
  ): Promise<InkToolResult>;
  select_ink(
    input: SelectInkRequest,
    context: ToolExecutionContext,
  ): Promise<InkToolResult>;
  compose_ink(
    input: ComposeInkRequest,
    context: ToolExecutionContext,
  ): Promise<InkToolResult>;
}

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  inspectInputSchema,
  inspectSource,
  normalizeInspectInput,
} from "../image.ts";
import { type ToolRuntime, toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createInspectSourceTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  let inspectSequence = 0;
  type InspectionOutput = Awaited<ReturnType<typeof inspectSource>> & {
    ok: true;
    mimeType: "image/png";
    summary: string;
  };
  const inspections = new Map<string, Promise<InspectionOutput>>();
  return createTool({
    id: "inspect_source",
    description: `Inspect one to eight normalized regions from the source image. Input: { regions: [{ x, y, width, height, scale?, enhancement? }], scale?, enhancement? }. Top-level scale/enhancement are batch defaults; a region may override either for its own crop. Regions crossing the right or bottom edge are clipped to the image. Multiple regions return a numbered contact sheet. At most ${context.maxInspectCalls} unique inspection calls are allowed; batch regions and then write the note.`,
    inputSchema: inspectInputSchema,
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        path: z.string(),
        mimeType: z.literal("image/png"),
        width: z.number(),
        height: z.number(),
        kind: z.enum(["crop", "contact_sheet"]),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.literal("inspection_budget_exhausted"),
          message: z.string(),
          repairable: z.literal(true),
        }),
        summary: z.string(),
      }),
    ]),
    execute: async (input) => {
      try {
        const normalized = normalizeInspectInput(input);
        const key = JSON.stringify(normalized);
        const cached = inspections.get(key);
        if (cached) {
          const output = await cached;
          context.recorder.record("tool.inspect_source.completed", {
            input: normalized,
            output,
            cacheHit: true,
          });
          return output;
        }
        if (inspectSequence >= context.maxInspectCalls) {
          const nextTool = context.store.manifest.currentRevision
            ? "revise_note"
            : "write_note";
          const message = `Inspection budget exhausted after ${context.maxInspectCalls} unique call(s). Do not call inspect_source again. Use the source and existing inspections, then call ${nextTool} now.`;
          const output = {
            ...toolError("inspection_budget_exhausted", message),
            summary: message,
          };
          context.recorder.record("tool.inspect_source.rejected", {
            input: normalized,
            output,
          });
          return output;
        }
        const sequence = ++inspectSequence;
        const pending = (async (): Promise<InspectionOutput> => {
          const result = await inspectSource(
            context.sourcePath,
            context.store.path("intermediate/inspections"),
            normalized,
            sequence,
            context.toolMedia.maxEdge,
          );
          return {
            ok: true as const,
            ...result,
            mimeType: "image/png" as const,
            summary: `${result.kind} ${result.width}×${result.height}; ${context.maxInspectCalls - sequence} unique inspection call(s) remaining`,
          };
        })();
        inspections.set(key, pending);
        const output = await pending;
        context.recorder.record("tool.inspect_source.completed", {
          input: normalized,
          output,
          cacheHit: false,
        });
        return output;
      } catch (error) {
        try {
          inspections.delete(JSON.stringify(normalizeInspectInput(input)));
        } catch {}
        return runtime.fatal(error);
      }
    },
    toModelOutput: (output) =>
      runtime.mediaOutputWithFatal("inspect_source", output),
  });
}

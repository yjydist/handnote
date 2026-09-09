import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { toolError } from "../agent-protocol.ts";
import { inspectSource, normalizeInspectInput } from "../image.ts";
import type { ToolContext } from "./types.ts";

export function createInspectSourceHandler(
  context: ToolContext,
): HandnoteToolHandlers["inspect_source"] {
  let inspectSequence = 0;
  type InspectionOutput = Awaited<ReturnType<typeof inspectSource>> & {
    ok: true;
    mimeType: "image/png";
    summary: string;
  };
  const inspections = new Map<string, Promise<InspectionOutput>>();
  return async (input) => {
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
      throw error;
    }
  };
}

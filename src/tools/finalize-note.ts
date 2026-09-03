import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ToolRuntime } from "./shared.ts";
import { toolError } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createFinalizeNoteTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  return createTool({
    id: "finalize_note",
    description:
      "Finalize only after the current revision was reviewed in an earlier model step and has no blocking warnings.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
      }),
    ]),
    execute: async () =>
      context.state.transaction(async () => {
        const eligibility = context.state.canFinalize();
        if (!eligibility.ok) return toolError("not_ready", eligibility.reason);
        try {
          context.recorder.record("note.finalized", {
            revision: eligibility.revision.number,
          });
          context.state.markFinalized(eligibility.revision);
        } catch (error) {
          return runtime.fatal(error);
        }
        return {
          ok: true as const,
          revision: eligibility.revision.number,
          summary: "Note finalized",
        };
      }),
  });
}

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { NoteStateError } from "../store.ts";
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
      "Finalize only after the current revision was reviewed in an earlier model step and has no blocking warnings. All revision files and referenced assets must still match their recorded hashes on disk.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        markdownSha256: z.string(),
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
    execute: async () => {
      try {
        const revision = await context.store.finalize(context.state.modelStep);
        context.state.finalized = true;
        return {
          ok: true as const,
          revision: revision.number,
          markdownSha256: revision.markdown.sha256,
          summary: "Note finalized",
        };
      } catch (error) {
        if (error instanceof NoteStateError)
          return toolError(error.code, error.message);
        return runtime.fatal(error);
      }
    },
  });
}

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { HandnoteError } from "../errors.ts";
import { sha256File } from "../utils.ts";
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
      "Finalize only after the current revision was reviewed in an earlier model step and has no blocking warnings. The finalized revision markdown must still match its recorded hash on disk.",
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
    execute: async () =>
      context.state.transaction(async () => {
        const eligibility = context.state.canFinalize();
        if (!eligibility.ok) return toolError("not_ready", eligibility.reason);
        try {
          const revision = eligibility.revision;
          const markdownPath = `${context.runDirectory}/revisions/revision-${String(revision.number).padStart(3, "0")}.md`;
          let diskSha256: string;
          try {
            diskSha256 = await sha256File(markdownPath);
          } catch (error) {
            throw new HandnoteError(
              `Cannot read finalized revision markdown: ${markdownPath}`,
              "filesystem",
              false,
              { cause: error },
            );
          }
          if (diskSha256 !== revision.markdownSha256)
            throw new HandnoteError(
              `Finalized revision markdown hash mismatch: ${markdownPath}`,
              "filesystem",
              false,
            );
          context.recorder.record("note.finalized", {
            revision: revision.number,
            markdownSha256: revision.markdownSha256,
          });
          context.state.markFinalized(revision);
          return {
            ok: true as const,
            revision: revision.number,
            markdownSha256: revision.markdownSha256,
            summary: "Note finalized",
          };
        } catch (error) {
          return runtime.fatal(error);
        }
      }),
  });
}

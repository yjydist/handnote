import { readdir } from "node:fs/promises";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { captureFigure, captureFigureInputSchema } from "../image.ts";
import type { ToolRuntime } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createCaptureFigureTool(
  context: ToolContext,
  runtime: ToolRuntime,
) {
  let figureSequence = 0;
  let initialSequence: Promise<number> | undefined;
  const captures = new Map<string, Promise<Output>>();
  type Output = {
    ok: true;
    relativePath: string;
    path: string;
    width: number;
    height: number;
    mimeType: "image/png";
    summary: string;
  };
  return createTool({
    id: "capture_figure",
    description:
      "Materialize one source region as a local figure asset for the note. Input: { region: { x, y, width, height } } in normalized EXIF-rotated source coordinates. Returns the relative path (../assets/figures/figure-NNN.png) to reference with standard image syntax ![caption](../assets/figures/figure-NNN.png). Repeated identical regions are cached and return the same path. Use only for figures whose visual form the note must preserve; recreated diagrams and tables do not need a crop.",
    inputSchema: captureFigureInputSchema,
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        relativePath: z.string(),
        path: z.string(),
        width: z.number(),
        height: z.number(),
        mimeType: z.literal("image/png"),
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
    execute: async (input) => {
      const normalized = captureFigureInputSchema.parse(input);
      const key = JSON.stringify(normalized);
      let pending = captures.get(key);
      const cacheHit = Boolean(pending);
      if (!pending) {
        pending = (async (): Promise<Output> => {
          initialSequence ??= readdir(
            `${context.runDirectory}/assets/figures`,
          ).then(
            (names) =>
              Math.max(
                0,
                ...names.map((name) =>
                  Number(/^figure-(\d+)\.png$/.exec(name)?.[1] ?? 0),
                ),
              ),
            (error) => {
              if (error.code === "ENOENT") return 0;
              throw error;
            },
          );
          const initial = await initialSequence;
          figureSequence = Math.max(figureSequence, initial) + 1;
          const sequence = figureSequence;
          const result = await captureFigure(
            context.sourcePath,
            `${context.runDirectory}/assets/figures`,
            normalized,
            sequence,
          );
          return {
            ok: true as const,
            ...result,
            mimeType: "image/png" as const,
            summary: `Figure ${result.relativePath} (${result.width}×${result.height}) captured; reference it exactly as ![caption](${result.relativePath})`,
          };
        })();
        captures.set(key, pending);
      }
      try {
        const output = await pending;
        context.recorder.record("tool.capture_figure.completed", {
          input: normalized,
          output,
          cacheHit,
        });
        return output;
      } catch (error) {
        if (captures.get(key) === pending) captures.delete(key);
        return runtime.fatal(error);
      }
    },
    toModelOutput: (output) =>
      runtime.mediaOutputWithFatal("capture_figure", output),
  });
}

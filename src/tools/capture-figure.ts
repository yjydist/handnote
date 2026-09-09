import { readdir } from "node:fs/promises";
import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { captureFigure, captureFigureInputSchema } from "../image.ts";
import type { ToolContext } from "./types.ts";

export function createCaptureFigureHandler(
  context: ToolContext,
): HandnoteToolHandlers["capture_figure"] {
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
  return async (input) => {
    const normalized = captureFigureInputSchema.parse(input);
    const key = JSON.stringify(normalized);
    let pending = captures.get(key);
    const cacheHit = Boolean(pending);
    if (!pending) {
      pending = (async (): Promise<Output> => {
        initialSequence ??= readdir(context.store.path("assets/figures")).then(
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
          context.store.path("assets/figures"),
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
      throw error;
    }
  };
}

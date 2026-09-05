import { asError, HandnoteError } from "../errors.ts";
import { createModelPreviews } from "../image.ts";

import type { ToolContext } from "./types.ts";

export const toolError = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message, repairable: true as const },
});

export function remainingSteps(context: ToolContext): string {
  const remaining = Math.max(0, context.maxSteps - context.state.modelStep);
  return `${remaining} model step(s) remain after this one`;
}

export function layoutSummary(
  warnings: ReadonlyArray<{
    code: string;
    message: string;
    blocking: boolean;
    elementId?: string | undefined;
  }>,
): string {
  const blocking = warnings.filter((warning) => warning.blocking);
  if (blocking.length === 0) return "no blocking layout warnings";
  return `${blocking.length} blocking layout warning(s): ${blocking
    .map(
      (warning) =>
        `${warning.code}${warning.elementId ? `/${warning.elementId}` : ""}: ${warning.message}`,
    )
    .join("; ")}`;
}

export interface ToolRuntime {
  fatal(error: unknown): never;
  mediaOutputWithFatal(
    purpose: "inspect_source" | "review_render" | "capture_figure",
    output: {
      ok: boolean;
      path?: string | undefined;
      mimeType?: string | undefined;
      summary?: string | undefined;
    },
  ): Promise<{ type: string; value: unknown }>;
}

export function createToolRuntime(context: ToolContext): ToolRuntime {
  const fatal = (error: unknown): never => {
    const value =
      error instanceof HandnoteError
        ? error
        : new HandnoteError(asError(error).message, "internal", false, {
            cause: error,
          });
    context.state.fail(value);
    throw value;
  };
  const mediaOutputWithFatal: ToolRuntime["mediaOutputWithFatal"] = async (
    purpose,
    output,
  ) => {
    try {
      if (!output.ok || !output.path)
        return { type: "text", value: output.summary ?? "Tool failed" };
      if (purpose === "review_render") await context.store.readRevision();
      const previews = await createModelPreviews(
        output.path,
        context.toolMedia,
      );
      context.recorder.record("tool.model_media.prepared", {
        purpose,
        cacheHit: false,
        source: await context.recorder.media(
          output.path,
          output.mimeType ?? "image/png",
        ),
        previews: previews.map(({ data: _data, ...preview }) => preview),
      });
      return {
        type: "content",
        value: [
          { type: "text", text: output.summary ?? "Image result" },
          ...previews.flatMap((preview, index) => [
            {
              type: "text" as const,
              text: `Preview ${index + 1}/${previews.length} ${preview.width}×${preview.height}`,
            },
            {
              type: "image-data" as const,
              data: preview.data,
              mediaType: preview.mediaType,
            },
          ]),
        ],
      };
    } catch (error) {
      return fatal(error);
    }
  };
  return { fatal, mediaOutputWithFatal };
}

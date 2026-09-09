import type {
  HandnoteToolHandlers,
  ToolExecutionContext,
} from "../agent-protocol.ts";
import { asError, HandnoteError } from "../errors.ts";
import { createModelPreviews } from "../image.ts";

import type { ToolContext } from "./types.ts";

export function remainingSteps(context: ToolExecutionContext): string {
  const remaining = context.remainingSteps;
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

export function createToolRuntime(context: ToolContext) {
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
  const prepareModelMedia: HandnoteToolHandlers["prepareModelMedia"] = async (
    purpose,
    output,
  ) => {
    if (!output.ok || !output.path)
      return { kind: "text", text: output.summary ?? "Tool failed" };
    if (purpose === "review_render") await context.store.readRevision();
    const previews = await createModelPreviews(output.path, context.toolMedia);
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
      kind: "previews",
      summary: output.summary ?? "Image result",
      previews: previews.map(({ data, mediaType, width, height }) => ({
        data,
        mediaType,
        width,
        height,
      })),
    };
  };
  return { fatal, prepareModelMedia };
}

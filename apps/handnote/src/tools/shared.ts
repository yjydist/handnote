import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  HandnoteToolHandlers,
  ToolExecutionContext,
} from "@handnote/agent";
import { HandnoteError } from "../errors.ts";
import { createModelPreviews } from "../image.ts";
import { sha256 } from "../utils.ts";

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
    assetId?: string | undefined;
  }>,
): string {
  const blocking = warnings.filter((warning) => warning.blocking);
  if (blocking.length === 0) return "no blocking layout warnings";
  return `${blocking.length} blocking layout warning(s): ${blocking
    .map(
      (warning) =>
        `${warning.code}${warning.elementId ? `/${warning.elementId}` : ""}${warning.assetId ? ` asset=${warning.assetId}` : ""}: ${warning.message}`,
    )
    .join("; ")}`;
}

export function createMediaHandler(
  context: ToolContext,
): HandnoteToolHandlers["prepareModelMedia"] {
  const prepareModelMedia: HandnoteToolHandlers["prepareModelMedia"] = async (
    purpose,
    output,
  ) => {
    const paths = output.paths ?? (output.path ? [output.path] : []);
    if (!output.ok || paths.length === 0)
      return { kind: "text", text: output.summary ?? "Tool failed" };
    if (purpose === "review_render") await context.store.readRevision();
    const previews = [];
    for (const [index, path] of paths.entries()) {
      const batch = await createModelPreviews(path, context.toolMedia);
      const evidence = [];
      for (const preview of batch) {
        let saved: string | undefined;
        if (context.store.manifest.formatVersion === 2) {
          saved = `session/model-previews/${preview.sha256}.jpg`;
          await mkdir(context.store.path("session/model-previews"), {
            recursive: true,
          });
          const target = context.store.path(saved);
          try {
            await writeFile(target, Buffer.from(preview.data, "base64"), {
              flag: "wx",
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (sha256(await readFile(target)) !== preview.sha256)
              throw new HandnoteError(
                "Model preview evidence was modified",
                "filesystem",
              );
          }
        }
        const { data: _data, ...metadata } = preview;
        evidence.push({ ...metadata, ...(saved ? { path: saved } : {}) });
        previews.push({
          ...preview,
          ...(output.paths ? { label: `view ${index + 1}` } : {}),
        });
      }
      context.recorder.record("tool.model_media.prepared", {
        purpose,
        cacheHit: false,
        source: await context.recorder.media(
          path,
          output.mimeType ?? "image/png",
        ),
        previews: evidence,
      });
    }
    return {
      kind: "previews",
      summary: output.summary ?? "Image result",
      previews: previews.map(({ data, mediaType, width, height, label }) => ({
        data,
        mediaType,
        width,
        height,
        ...(label ? { label } : {}),
      })),
    };
  };
  return prepareModelMedia;
}

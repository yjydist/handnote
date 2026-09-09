import { mkdir, readFile, writeFile } from "node:fs/promises";
import type {
  HandnoteToolHandlers,
  ToolExecutionContext,
} from "../agent/index.ts";
import { HandnoteError } from "../run/errors.ts";
import { createModelPreviews } from "../run/image.ts";
import { sha256 } from "../run/utils.ts";

import { createInkContactSheets } from "./ink-contact-sheet.ts";
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

async function saveModelEvidence(
  context: ToolContext,
  bytes: Buffer,
  extension: "jpg" | "png",
) {
  const hash = sha256(bytes);
  const relative = `session/model-previews/${hash}.${extension}`;
  await mkdir(context.store.path("session/model-previews"), {
    recursive: true,
  });
  const target = context.store.path(relative);
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (sha256(await readFile(target)) !== hash)
      throw new HandnoteError(
        "Model preview evidence was modified",
        "filesystem",
      );
  }
  return relative;
}

async function materialContacts(context: ToolContext, paths: string[]) {
  const sheets = await createInkContactSheets(paths, context.toolMedia.maxEdge);
  const sources = [];
  for (const sheet of sheets) {
    const saved = await saveModelEvidence(context, sheet.bytes, "png");
    const originals = [];
    for (const placement of sheet.placements) {
      const path = paths[placement.view - 1];
      if (!path) throw new Error("Missing material preview source");
      originals.push({
        ...placement,
        source: await context.recorder.media(path, "image/png"),
      });
    }
    sources.push({
      path: context.store.path(saved),
      label:
        sheet.kind === "sheet"
          ? `material sheet; numbered views ${sheet.placements.map((item) => item.view).join(", ")}; match items[].previews[].view`
          : `view ${sheet.placements[0]?.view}`,
      contactSheet: { kind: sheet.kind, originals },
    });
  }
  return sources;
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
    const sources: Array<{
      path: string;
      label?: string;
      contactSheet?: unknown;
    }> =
      context.store.manifest.formatVersion === 2 &&
      paths.length > 1 &&
      (purpose === "select_ink" || purpose === "compose_ink")
        ? await materialContacts(context, paths)
        : paths.map((path, index) => ({
            path,
            ...(output.paths ? { label: `view ${index + 1}` } : {}),
          }));
    const previews = [];
    for (const source of sources) {
      const { path } = source;
      const batch = await createModelPreviews(path, context.toolMedia);
      const evidence = [];
      for (const preview of batch) {
        const saved =
          context.store.manifest.formatVersion === 2
            ? await saveModelEvidence(
                context,
                Buffer.from(preview.data, "base64"),
                "jpg",
              )
            : undefined;
        const { data: _data, ...metadata } = preview;
        evidence.push({ ...metadata, ...(saved ? { path: saved } : {}) });
        previews.push({
          ...preview,
          ...(source.label ? { label: source.label } : {}),
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
        ...(source.contactSheet ? { contactSheet: source.contactSheet } : {}),
      });
    }
    context.recorder.record("tool.model_output.prepared", {
      purpose,
      textChars: (output.summary ?? "Image result").length,
      imageCount: previews.length,
      imagePixels: previews.reduce(
        (sum, preview) => sum + preview.width * preview.height,
        0,
      ),
    });
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

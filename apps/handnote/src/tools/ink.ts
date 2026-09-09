import { lstat } from "node:fs/promises";
import {
  composeInkInputSchema,
  type InkToolHandlers,
  type InkToolResult,
  inspectInkInputSchema,
  type SelectInkRequest,
  selectInkInputSchema,
  toolError,
} from "@handnote/agent";
import {
  type Bounds,
  composeInkAssets,
  createInkFragment,
  type InkAsset,
  type InkPresentation,
  renderInkAsset,
  renderInkSvg,
  strokeBounds,
} from "@handnote/ink";
import { z } from "zod";
import { HandnoteError } from "../errors.ts";
import { loadInkAsset, loadInkLibrary, readInkSource } from "../ink-assets.ts";
import { prepareInkPreview, saveInkPreview } from "./ink-preview.ts";
import type { ToolContext } from "./types.ts";

class InkRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const status = "pending-human-review" as const;
const coordinateDescription =
  "Stroke indices are zero-based complete source strokes. Regions use normalized redraw coordinates; source bounds use original points coordinates. The recorded points-to-redraw transform is exact. The relationship to the original photograph is unknown. Geometry candidates and transcriptions are pending human review; no OCR or semantic grouping was performed.";

function presentation(
  input: SelectInkRequest["selections"][number]["presentation"],
): InkPresentation {
  return {
    kind: input.kind,
    referenceHeight: input.referenceHeight,
    ...(input.transcription === undefined
      ? {}
      : { transcription: input.transcription }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
  };
}

function geometry<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new InkRequestError(
      "invalid_ink_geometry",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function intersects(a: Bounds, b: Bounds) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

async function knownAssets(context: ToolContext, ids: readonly string[]) {
  const manifest = context.store.manifest;
  for (const id of new Set(ids)) {
    const paths = [`assets/ink/${id}.json`, `assets/ink/${id}.svg`];
    let present = false;
    for (const path of paths) {
      const exists = await lstat(context.store.path(path)).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      present ||=
        exists ||
        manifest.revisions.some((revision) =>
          revision.assets.some((artifact) => artifact.path === path),
        );
    }
    if (!present)
      throw new InkRequestError(
        "unknown_ink_asset",
        `Unknown ink asset ${id}; select complete source strokes first`,
      );
  }
}

function result(items: unknown[], paths: string[]): InkToolResult {
  return {
    ok: true,
    paths,
    mimeType: "image/png",
    items,
    status,
    summary: `${coordinateDescription}\n${JSON.stringify({ status, items })}`,
  };
}

export function createInkHandlers(context: ToolContext): InkToolHandlers {
  const execute = async (
    name: keyof InkToolHandlers,
    input: unknown,
    operation: () => Promise<InkToolResult>,
  ): Promise<InkToolResult> => {
    try {
      const output = await operation();
      context.recorder.record(`tool.${name}.completed`, { input, output });
      return output;
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof InkRequestError) {
        const message =
          error instanceof z.ZodError ? z.prettifyError(error) : error.message;
        const output = {
          ...toolError(
            error instanceof InkRequestError
              ? error.code
              : "invalid_ink_request",
            message,
          ),
          summary: message,
        };
        context.recorder.record(`tool.${name}.rejected`, { input, output });
        return output;
      }
      if (
        !(error instanceof HandnoteError) &&
        /^E[A-Z]+$/.test((error as NodeJS.ErrnoException)?.code ?? "")
      )
        throw new HandnoteError(
          "Ink tool filesystem operation failed",
          "filesystem",
          false,
          { cause: error },
        );
      throw error;
    }
  };
  const preview = async (
    svg: string,
    bounds: Bounds,
    maxScale = 4,
    labels?: Parameters<typeof prepareInkPreview>[2]["labels"],
  ) => {
    try {
      return await prepareInkPreview(svg, bounds, {
        maxEdge: context.toolMedia.maxEdge,
        maxScale,
        ...(labels ? { labels } : {}),
      });
    } catch (error) {
      throw new InkRequestError(
        "ink_preview_unavailable",
        `Cannot create a bounded ink preview: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const persist = async (
    assets: readonly InkAsset[],
    previews: Awaited<ReturnType<typeof prepareInkPreview>>[],
  ) => {
    const items = [];
    const paths: string[] = [];
    for (const [index, asset] of assets.entries()) {
      const prepared = previews[index];
      if (!prepared) throw new Error("Missing prepared ink preview");
      const saved = await context.store.saveInkAsset(asset);
      const actual = await saveInkPreview(context, prepared, "actual");
      paths.push(actual.path);
      items.push({
        asset: saved.asset,
        relativePath: saved.relativePath,
        markdown: `![](${saved.relativePath})`,
        preview: actual,
        status,
      });
    }
    return result(items, paths);
  };
  return {
    inspect_ink: (input) =>
      execute("inspect_ink", input, async () => {
        const parsed = inspectInkInputSchema.parse(input);
        const { document, metadata } = await readInkSource(context.store);
        const source = renderInkSvg(document, { background: "white" });
        await knownAssets(
          context,
          parsed.views.flatMap((view) =>
            view.kind === "asset" ? [view.assetId] : [],
          ),
        );
        const prepared = [];
        for (const view of parsed.views) {
          if (view.kind === "asset") {
            const { asset, svg, relativePath } = await loadInkAsset(
              context.store,
              view.assetId,
            );
            prepared.push({
              item: { kind: view.kind, asset, relativePath, status },
              previews: [
                {
                  kind: "actual" as const,
                  data: await preview(svg, {
                    x: 0,
                    y: 0,
                    width: asset.width,
                    height: asset.height,
                  }),
                },
              ],
            });
          } else if (view.kind === "page") {
            prepared.push({
              item: {
                kind: view.kind,
                sourceHash: document.sourceHash,
                strokeCount: document.strokes.length,
                strokeIndexRange: {
                  first: 0,
                  last: document.strokes.length - 1,
                },
                sourceBounds: source.bounds,
                redrawBounds: {
                  x: 0,
                  y: 0,
                  width: source.width,
                  height: source.height,
                },
                pointsToRedraw: metadata.redraw.transform,
                originalRelation: metadata.originalRelation,
                detail:
                  "Request normalized redraw regions for candidate stroke IDs and numbered previews",
                status,
              },
              previews: [
                {
                  kind: "actual" as const,
                  data: await preview(
                    source.svg,
                    { x: 0, y: 0, width: source.width, height: source.height },
                    1,
                  ),
                },
              ],
            });
          } else {
            const bounds = {
              x: view.region.x * source.width,
              y: view.region.y * source.height,
              width: view.region.width * source.width,
              height: view.region.height * source.height,
            };
            const candidates = document.strokes.flatMap((stroke) => {
              const originalBounds = strokeBounds(stroke);
              const transform = metadata.redraw.transform;
              const redrawBounds = {
                x: originalBounds.x * transform.scale + transform.translateX,
                y: originalBounds.y * transform.scale + transform.translateY,
                width: originalBounds.width * transform.scale,
                height: originalBounds.height * transform.scale,
              };
              if (!intersects(redrawBounds, bounds)) return [];
              const crossesBoundary =
                redrawBounds.x < bounds.x ||
                redrawBounds.y < bounds.y ||
                redrawBounds.x + redrawBounds.width > bounds.x + bounds.width ||
                redrawBounds.y + redrawBounds.height > bounds.y + bounds.height;
              return [
                {
                  strokeIndex: stroke.index,
                  sourceBounds: originalBounds,
                  redrawBounds,
                  crossesBoundary,
                },
              ];
            });
            prepared.push({
              item: {
                kind: view.kind,
                region: view.region,
                redrawBounds: bounds,
                pointsToRedraw: metadata.redraw.transform,
                candidateRule:
                  "complete stroke bounds intersect the requested redraw region",
                strokeIndices: candidates.map(
                  (candidate) => candidate.strokeIndex,
                ),
                candidates,
                status,
              },
              previews: [
                {
                  kind: "actual" as const,
                  data: await preview(source.svg, bounds),
                },
                {
                  kind: "stroke_indices" as const,
                  data: await preview(
                    source.svg,
                    bounds,
                    4,
                    candidates.map((candidate) => ({
                      strokeIndex: candidate.strokeIndex,
                      bounds: candidate.redrawBounds,
                    })),
                  ),
                },
              ],
            });
          }
        }
        const items = [];
        const paths: string[] = [];
        for (const entry of prepared) {
          const previews = [];
          for (const item of entry.previews) {
            const saved = await saveInkPreview(context, item.data, item.kind);
            previews.push(saved);
            paths.push(saved.path);
          }
          items.push({ ...entry.item, previews });
        }
        return result(items, paths);
      }),
    select_ink: (input) =>
      execute("select_ink", input, async () => {
        const parsed = selectInkInputSchema.parse(input);
        const { document } = await readInkSource(context.store);
        const assets = geometry(() =>
          parsed.selections.map((selection) =>
            createInkFragment(document, {
              ...selection,
              presentation: presentation(selection.presentation),
            }),
          ),
        );
        const previews = [];
        for (const asset of assets)
          previews.push(
            await preview(renderInkAsset(document, asset), {
              x: 0,
              y: 0,
              width: asset.width,
              height: asset.height,
            }),
          );
        return persist(assets, previews);
      }),
    compose_ink: (input) =>
      execute("compose_ink", input, async () => {
        const parsed = composeInkInputSchema.parse(input);
        const ids = parsed.compositions.flatMap((composition) =>
          composition.parts.map((part) => part.assetId),
        );
        await knownAssets(context, ids);
        const library = await loadInkLibrary(context.store, ids);
        const assets = geometry(() =>
          parsed.compositions.map((composition) =>
            composeInkAssets(
              library.document,
              {
                ...composition,
                presentation: presentation(composition.presentation),
              },
              library.assets,
            ),
          ),
        );
        const previews = [];
        for (const asset of assets)
          previews.push(
            await preview(
              renderInkAsset(library.document, asset, library.assets),
              { x: 0, y: 0, width: asset.width, height: asset.height },
            ),
          );
        return persist(assets, previews);
      }),
  };
}

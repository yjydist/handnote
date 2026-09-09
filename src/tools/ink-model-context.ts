import type { Bounds, InkAsset } from "../ink/index.ts";

interface StrokeCandidate {
  strokeIndex: number;
  sourceBounds: Bounds;
  crossesBoundary: boolean;
}

interface InspectionCoordinates {
  pointsToRedraw: { scale: number; translateX: number; translateY: number };
  redrawBounds: Bounds;
}

type InkContextItem = (
  | (InspectionCoordinates & {
      kind: "page";
      strokeCount: number;
      strokeIndexRange: { first: number; last: number };
      sourceBounds: Bounds;
      originalRelation: string;
      detail: string;
    })
  | (InspectionCoordinates & {
      kind: "region";
      region: Bounds;
      candidateRule: string;
      candidates: StrokeCandidate[];
    })
  | {
      asset: InkAsset;
      relativePath: string;
      selectionContext?:
        | {
            candidateRule: string;
            detail: string;
            candidates: StrokeCandidate[];
          }
        | undefined;
    }
) & {
  preview?: { kind: string };
  previews?: { kind: string }[];
};

export function inkModelContext(items: InkContextItem[]) {
  let view = 0;
  let selectionContext: { candidateRule: string; detail: string } | undefined;
  const modelItems = items.map((item) => {
    const previews = (
      item.previews ?? (item.preview ? [item.preview] : [])
    ).map((preview) => ({ view: ++view, kind: preview.kind }));
    if ("asset" in item) {
      const asset = item.asset;
      if (item.selectionContext)
        selectionContext ??= {
          candidateRule: item.selectionContext.candidateRule,
          detail: item.selectionContext.detail,
        };
      return {
        asset: {
          id: asset.id,
          kind: asset.kind,
          width: asset.width,
          height: asset.height,
          sourceBounds: asset.sourceBounds,
          presentation: asset.presentation,
          strokeIndices: asset.strokeIndices,
          ...(asset.kind === "composition"
            ? { bounds: asset.bounds, parts: asset.parts }
            : {}),
        },
        relativePath: item.relativePath,
        ...(item.selectionContext
          ? {
              selectionContext: {
                candidates: item.selectionContext.candidates,
              },
            }
          : {}),
        previews,
      };
    }
    if (item.kind === "page")
      return {
        kind: item.kind,
        strokeCount: item.strokeCount,
        strokeIndexRange: item.strokeIndexRange,
        sourceBounds: item.sourceBounds,
        redrawBounds: item.redrawBounds,
        pointsToRedraw: item.pointsToRedraw,
        originalRelation: item.originalRelation,
        detail: item.detail,
        previews,
      };
    return {
      kind: item.kind,
      region: item.region,
      redrawBounds: item.redrawBounds,
      pointsToRedraw: item.pointsToRedraw,
      candidateRule: item.candidateRule,
      candidates: item.candidates.map(
        ({ strokeIndex, sourceBounds, crossesBoundary }) => ({
          strokeIndex,
          sourceBounds,
          crossesBoundary,
        }),
      ),
      previews,
    };
  });
  return {
    ...(selectionContext ? { selectionContext } : {}),
    items: modelItems,
  };
}

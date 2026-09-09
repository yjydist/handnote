import {
  type Bounds,
  type InkAssociationReport,
  type InkDocument,
  measureCompleteInkLine,
  type StrokeAssociation,
  strokeBounds,
  type WordEvidence,
} from "@handnote/ink";

const parameters = Object.freeze({
  minVerticalSpanInBodyHeights: 3,
  maxWidthToHeight: 0.12,
  minSeparationInPenWidths: 1,
});

function intersects(a: Bounds, b: Bounds) {
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

/** Experimental metric evidence only: never remove or reassign an original stroke. */
export function reassessExteriorStrokes(
  document: InkDocument,
  association: InkAssociationReport,
) {
  if (document.sourceHash !== association.sourceHash)
    throw new Error("Stale exterior-stroke source");
  const proposals: {
    lineId: number;
    bodyBounds: Bounds;
    ignoredStrokeIndices: number[];
    remainingStrokeIndices: number[];
    evidence: {
      strokeIndex: number;
      bounds: Bounds;
      horizontalGap: number;
      minimumGap: number;
      associationReason: StrokeAssociation["reason"];
      lineEvidence: readonly WordEvidence[];
      qualifies: boolean;
    }[];
    accepted: boolean;
  }[] = [];
  const lines = association.lines.map((line) => {
    if (
      line.metrics.status === "available" ||
      line.unusedReason ||
      association.unusedWords.some((word) => word.lineId === line.lineId)
    )
      return line;
    const indices = association.candidates
      .filter((candidate) => candidate.lineId === line.lineId)
      .flatMap((candidate) => candidate.strokeIndices);
    if (!indices.length) return line;
    const metrics = measureCompleteInkLine(document, indices);
    const body = metrics.visibleBounds;
    const maxPenWidth = Math.max(
      ...indices.map((index) => document.strokes[index]?.penWidth ?? 0),
    );
    const margin =
      line.bounds.height * association.thresholds.nearbyMarginInLineHeights;
    const region = {
      x: line.bounds.x - margin,
      y: line.bounds.y - margin,
      width: line.bounds.width + 2 * margin,
      height: line.bounds.height + 2 * margin,
    };
    const evidence = association.unusedStrokes.flatMap((unused) => {
      if (unused.reason === "long-decoration") return [];
      const stroke = document.strokes[unused.strokeIndex];
      if (!stroke) throw new Error("Missing exterior stroke");
      const bounds = strokeBounds(stroke);
      if (
        !intersects(bounds, region) &&
        !unused.evidence.some(
          (item) => item.lineId === line.lineId && item.nearbyRatio > 0,
        )
      )
        return [];
      const horizontalGap = Math.max(
        body.x - bounds.x - bounds.width,
        bounds.x - body.x - body.width,
      );
      const minimumGap =
        Math.max(stroke.penWidth, maxPenWidth) *
        parameters.minSeparationInPenWidths;
      const lineEvidence = unused.evidence.filter(
        (item) => item.lineId === line.lineId,
      );
      const qualifies =
        // A page-level rejection can be caused by another line; local proximity still blocks metrics.
        lineEvidence.every(
          (item) => item.overlapRatio === 0 && item.nearbyRatio === 0,
        ) &&
        horizontalGap >= minimumGap &&
        bounds.y < body.y &&
        bounds.y + bounds.height > body.y + body.height &&
        bounds.height >=
          body.height * parameters.minVerticalSpanInBodyHeights &&
        bounds.width <= bounds.height * parameters.maxWidthToHeight;
      return [
        {
          strokeIndex: stroke.index,
          bounds,
          horizontalGap,
          minimumGap,
          associationReason: unused.reason,
          lineEvidence,
          qualifies,
        },
      ];
    });
    if (!evidence.length) return line;
    const ignoredStrokeIndices = evidence
      .filter((item) => item.qualifies)
      .map((item) => item.strokeIndex);
    const remainingStrokeIndices = evidence
      .filter((item) => !item.qualifies)
      .map((item) => item.strokeIndex);
    const accepted =
      ignoredStrokeIndices.length > 0 && remainingStrokeIndices.length === 0;
    proposals.push({
      lineId: line.lineId,
      bodyBounds: body,
      ignoredStrokeIndices,
      remainingStrokeIndices,
      evidence,
      accepted,
    });
    return accepted ? { ...line, metrics } : line;
  });
  return {
    association: { ...association, lines },
    annotationStatus: "pending-human-review" as const,
    method: "line-local-separated-exterior-vertical-span" as const,
    parameters,
    proposals,
  };
}

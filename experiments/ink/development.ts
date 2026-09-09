import { type InkDocument, measureCompleteInkLine } from "@handnote/ink";
import type development from "./development.json";

type DevelopmentPage = (typeof development.pages)[number];

export function prepareDevelopmentLines(
  document: InkDocument,
  page: DevelopmentPage,
) {
  const seen = new Set<number>();
  const lines = new Map<
    string,
    (typeof page.lines)[number] & {
      metrics:
        | ReturnType<typeof measureCompleteInkLine>
        | { status: "unavailable"; reason: "incomplete-line-metrics" };
    }
  >();
  for (const line of page.lines) {
    if (lines.has(line.lineId))
      throw new Error("Duplicate development line identity");
    for (const index of [
      ...line.strokeIndices,
      ...line.unresolvedStrokeIndices,
    ]) {
      if (seen.has(index) || !document.strokes[index])
        throw new Error("Invalid or reused development line stroke");
      seen.add(index);
    }
    lines.set(line.lineId, {
      ...line,
      metrics: line.unresolvedStrokeIndices.length
        ? { status: "unavailable", reason: "incomplete-line-metrics" }
        : measureCompleteInkLine(document, line.strokeIndices),
    });
  }
  for (const fragment of page.fragments) {
    const line = lines.get(fragment.lineId);
    if (
      !line ||
      fragment.strokeIndices.some(
        (index) => !line.strokeIndices.includes(index),
      )
    )
      throw new Error("Development fragment is outside its source line");
  }
  return lines;
}

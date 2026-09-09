import { createHash } from "node:crypto";
import type { InkCandidate } from "@handnote/ink";
import {
  type DocumentTarget,
  type PreparedDocument,
  validateTargets,
} from "@handnote/renderer";

export interface MatchingSource extends InkCandidate {
  readonly lineId: string;
  readonly lineText: string;
  readonly occurrence: { readonly start: number; readonly end: number };
}

export interface InkBinding {
  readonly targetId: string;
  readonly target: DocumentTarget;
  readonly sourceId: string;
  readonly text: string;
}

export interface BindingReport {
  readonly documentHash: string;
  readonly sourceHash: string;
  readonly sourcesHash: string;
  readonly bindings: readonly InkBinding[];
  readonly unusedSources: readonly { sourceId: string; reason: string }[];
  readonly fontRanges: readonly {
    target: DocumentTarget;
    text: string;
    reason: string;
  }[];
}

function occurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + 1)
  )
    positions.push(at);
  return positions;
}

function contextScore(
  left: string,
  right: string,
  source: MatchingSource,
): number {
  const before = source.lineText.slice(0, source.occurrence.start);
  const after = source.lineText.slice(source.occurrence.end);
  if (left === before && right === after)
    return 1000 + before.length + after.length;
  let prefix = 0;
  while (
    prefix < Math.min(after.length, right.length, 16) &&
    after[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(before.length, left.length, 16) &&
    before.at(-1 - suffix) === left.at(-1 - suffix)
  )
    suffix++;
  return prefix + suffix;
}

/** Exact text and occurrence context only; uncertain instances remain font text. */
export function matchInkSources(
  document: PreparedDocument,
  sourceHash: string,
  sources: readonly MatchingSource[],
  sourceLines: readonly string[],
): BindingReport {
  const ids = new Set<string>();
  for (const source of sources) {
    if (
      source.sourceHash !== sourceHash ||
      ids.has(source.id) ||
      !source.text ||
      !sourceLines.includes(source.lineText) ||
      source.lineText.slice(source.occurrence.start, source.occurrence.end) !==
        source.text
    )
      throw new Error("Invalid or stale ink source record");
    ids.add(source.id);
  }
  const blocks = new Map<string, string>();
  const offsets = new Map<string, number>();
  for (const range of document.textRanges) {
    const previous = blocks.get(range.blockId) ?? "";
    offsets.set(range.rangeId, previous.length);
    blocks.set(range.blockId, previous + range.text);
  }
  const unusedSources: { sourceId: string; reason: string }[] = [];
  const proposals: { source: MatchingSource; target: DocumentTarget }[] = [];
  for (const source of sources) {
    const targets = document.textRanges.flatMap((range) =>
      occurrences(range.text, source.text).map((start) => {
        const block = blocks.get(range.blockId) ?? "";
        const at = (offsets.get(range.rangeId) ?? 0) + start;
        return {
          target: {
            documentHash: document.documentHash,
            rangeId: range.rangeId,
            start,
            end: start + source.text.length,
          },
          left: block.slice(0, at),
          right: block.slice(at + source.text.length),
          score: contextScore(
            block.slice(0, at),
            block.slice(at + source.text.length),
            source,
          ),
        };
      }),
    );
    const first = targets[0];
    if (!first) {
      unusedSources.push({
        sourceId: source.id,
        reason: [...blocks.values()].some((block) =>
          block.includes(source.text),
        )
          ? "format-boundary"
          : "no-exact-target",
      });
      continue;
    }
    const sourceCount = sourceLines.reduce(
      (sum, line) => sum + occurrences(line, source.text).length,
      0,
    );
    if (targets.length === 1 && sourceCount === 1) {
      proposals.push({ source, target: first.target });
      continue;
    }
    targets.sort((a, b) => b.score - a.score);
    const best = targets[0] ?? first;
    const rivals = sourceLines.flatMap((lineText) =>
      occurrences(lineText, source.text).map((start) =>
        contextScore(best.left, best.right, {
          ...source,
          lineText,
          occurrence: { start, end: start + source.text.length },
        }),
      ),
    );
    if (
      best.score < 2 ||
      targets[1]?.score === best.score ||
      rivals.filter((score) => score >= best.score).length !== 1
    ) {
      unusedSources.push({
        sourceId: source.id,
        reason: "ambiguous-occurrence",
      });
      continue;
    }
    proposals.push({ source, target: best.target });
  }
  // Conflicting proposals both fall back; array order must not choose an instance.
  const conflicts = new Set<number>();
  for (const [i, a] of proposals.entries()) {
    for (const [j, b] of proposals.entries()) {
      if (j <= i) continue;
      if (
        (a.target.rangeId === b.target.rangeId &&
          a.target.start < b.target.end &&
          b.target.start < a.target.end) ||
        a.source.strokeIndices.some((index) =>
          b.source.strokeIndices.includes(index),
        )
      ) {
        conflicts.add(i);
        conflicts.add(j);
      }
    }
  }
  const bindings: InkBinding[] = [];
  proposals.forEach(({ source, target }, index) => {
    if (conflicts.has(index))
      unusedSources.push({
        sourceId: source.id,
        reason: "conflicting-binding",
      });
    else
      bindings.push({
        targetId: `${target.rangeId}:${target.start}-${target.end}`,
        target,
        sourceId: source.id,
        text: source.text,
      });
  });
  validateTargets(
    document,
    bindings.map((binding) => binding.target),
  );
  const fontRanges: BindingReport["fontRanges"][number][] = [];
  for (const range of document.textRanges) {
    const covered = bindings
      .filter((binding) => binding.target.rangeId === range.rangeId)
      .sort((a, b) => a.target.start - b.target.start);
    let start = 0;
    for (const end of [
      ...covered.map((binding) => ({
        start: binding.target.start,
        end: binding.target.end,
      })),
      { start: range.text.length, end: range.text.length },
    ]) {
      if (start < end.start)
        fontRanges.push({
          target: {
            documentHash: document.documentHash,
            rangeId: range.rangeId,
            start,
            end: end.start,
          },
          text: range.text.slice(start, end.start),
          reason: "no-reliable-exact-source",
        });
      start = end.end;
    }
  }
  return {
    documentHash: document.documentHash,
    sourceHash,
    sourcesHash: createHash("sha256")
      .update(JSON.stringify({ sources, sourceLines }))
      .digest("hex"),
    bindings,
    unusedSources,
    fontRanges,
  };
}

import { createHash } from "node:crypto";
import type { Bounds, InkCandidate } from "@handnote/ink";
import {
  type DocumentTarget,
  type PreparedDocument,
  validateTargets,
} from "@handnote/renderer";

export interface SourceLine {
  readonly lineId: string;
  readonly text: string;
  readonly bounds: Bounds;
}

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

export interface PassageAlignment {
  readonly sourceLineId: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly targetFlowId: string;
  readonly targetStart: number;
  readonly targetEnd: number;
  readonly text: string;
}

export interface BindingReport {
  readonly documentHash: string;
  readonly sourceHash: string;
  readonly sourcesHash: string;
  readonly alignments: readonly PassageAlignment[];
  readonly bindings: readonly InkBinding[];
  readonly unusedSources: readonly { sourceId: string; reason: string }[];
  readonly fontRanges: readonly {
    target: DocumentTarget;
    text: string;
    reason: string;
  }[];
}

interface Passage {
  owner: string;
  start: number;
  end: number;
  text: string;
}

function passages(
  owner: string,
  text: string,
  context: "exact" | "boundary-edits",
): Passage[] {
  const result: Passage[] = [];
  const append = (start: number, end: number) => {
    while (start < end && /\s/u.test(text[start] ?? "")) start++;
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
    if (
      start < end &&
      !result.some((entry) => entry.start === start && entry.end === end)
    )
      result.push({ owner, start, end, text: text.slice(start, end) });
  };
  const add = (start: number, end: number) => {
    append(start, end);
    if (context === "exact") return;
    while (start < end && /\s/u.test(text[start] ?? "")) start++;
    while (end > start && /\s/u.test(text[end - 1] ?? "")) end--;
    let bodyStart = start;
    if (/[①-⑳]/u.test(text[bodyStart] ?? "")) {
      bodyStart++;
      while (bodyStart < end && /\s/u.test(text[bodyStart] ?? "")) bodyStart++;
    }
    let bodyEnd = end;
    while (bodyEnd > bodyStart && /[。！？!?]/u.test(text[bodyEnd - 1] ?? ""))
      bodyEnd--;
    append(bodyStart, end);
    append(start, bodyEnd);
    append(bodyStart, bodyEnd);
  };
  add(0, text.length);
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    if (!/[。！？!?\r\n]/u.test(text[at] ?? "")) continue;
    let end = at + 1;
    while (
      end < text.length &&
      /[。！？!?\r\n”’」』）】]/u.test(text[end] ?? "")
    )
      end++;
    add(start, end);
    start = end;
    at = end - 1;
  }
  add(start, text.length);
  return result;
}

/** Reuse ink only within uniquely corresponding complete lines or sentences. */
export function matchInkSources(
  document: PreparedDocument,
  sourceHash: string,
  sources: readonly MatchingSource[],
  sourceLines: readonly SourceLine[],
  options: { context?: "exact" | "boundary-edits" } = {},
): BindingReport {
  const lines = new Map<string, SourceLine>();
  for (const line of sourceLines) {
    if (
      !line.lineId ||
      lines.has(line.lineId) ||
      typeof line.text !== "string" ||
      ![
        line.bounds.x,
        line.bounds.y,
        line.bounds.width,
        line.bounds.height,
      ].every(Number.isFinite) ||
      line.bounds.width <= 0 ||
      line.bounds.height <= 0
    )
      throw new Error("Invalid source line identity or position");
    lines.set(line.lineId, line);
  }
  const ids = new Set<string>();
  for (const source of sources) {
    if (
      source.sourceHash !== sourceHash ||
      ids.has(source.id) ||
      !source.text ||
      lines.get(source.lineId)?.text !== source.lineText ||
      !Number.isInteger(source.occurrence.start) ||
      !Number.isInteger(source.occurrence.end) ||
      source.occurrence.start < 0 ||
      source.occurrence.end > source.lineText.length ||
      source.lineText.slice(source.occurrence.start, source.occurrence.end) !==
        source.text
    )
      throw new Error("Invalid or stale ink source record");
    ids.add(source.id);
  }
  const flows = new Map<string, string>();
  const offsets = new Map<string, number>();
  for (const range of document.textRanges) {
    const previous = flows.get(range.flowId) ?? "";
    offsets.set(range.rangeId, previous.length);
    flows.set(range.flowId, previous + range.text);
  }
  const original = sourceLines.flatMap((line) =>
    passages(line.lineId, line.text, options.context ?? "exact"),
  );
  const targets = [...flows].flatMap(([id, text]) =>
    passages(id, text, options.context ?? "exact"),
  );
  const alignments: PassageAlignment[] = [];
  const ambiguous: Passage[] = [];
  for (const passage of original) {
    const matches = targets.filter((target) => target.text === passage.text);
    if (!matches.length) continue;
    if (
      matches.length !== 1 ||
      original.filter((other) => other.text === passage.text).length !== 1
    ) {
      ambiguous.push(passage);
      continue;
    }
    const target = matches[0];
    if (!target) throw new Error("Missing passage target");
    alignments.push({
      sourceLineId: passage.owner,
      sourceStart: passage.start,
      sourceEnd: passage.end,
      targetFlowId: target.owner,
      targetStart: target.start,
      targetEnd: target.end,
      text: passage.text,
    });
  }
  const unusedSources: { sourceId: string; reason: string }[] = [];
  const proposals: { source: MatchingSource; target: DocumentTarget }[] = [];
  for (const source of sources) {
    const containing = alignments
      .filter(
        (alignment) =>
          alignment.sourceLineId === source.lineId &&
          alignment.sourceStart <= source.occurrence.start &&
          alignment.sourceEnd >= source.occurrence.end,
      )
      .sort((a, b) => b.text.length - a.text.length);
    const alignment = containing[0];
    if (!alignment) {
      const isAmbiguous = ambiguous.some(
        (passage) =>
          passage.owner === source.lineId &&
          passage.start <= source.occurrence.start &&
          passage.end >= source.occurrence.end,
      );
      unusedSources.push({
        sourceId: source.id,
        reason: isAmbiguous
          ? "ambiguous-occurrence"
          : [...flows.values()].some((text) => text.includes(source.text))
            ? "no-exact-context"
            : "no-exact-target",
      });
      continue;
    }
    const at =
      alignment.targetStart + source.occurrence.start - alignment.sourceStart;
    const end = at + source.text.length;
    const range = document.textRanges.find((range) => {
      const offset = offsets.get(range.rangeId) ?? 0;
      return (
        range.flowId === alignment.targetFlowId &&
        at >= offset &&
        end <= offset + range.text.length
      );
    });
    if (!range) {
      unusedSources.push({ sourceId: source.id, reason: "format-boundary" });
      continue;
    }
    const start = at - (offsets.get(range.rangeId) ?? 0);
    proposals.push({
      source,
      target: {
        documentHash: document.documentHash,
        rangeId: range.rangeId,
        start,
        end: start + source.text.length,
      },
    });
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
    alignments,
    bindings,
    unusedSources,
    fontRanges,
  };
}

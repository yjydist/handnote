import {
  type Bounds,
  type InkAssociationReport,
  type InkDocument,
  measureCompleteInkLine,
} from "@handnote/ink";

type Rejection =
  | "shared-stroke"
  | "unused-stroke"
  | "unused-word"
  | "no-strokes"
  | "duplicate-word"
  | "duplicate-stroke-ownership"
  | "stroke-outside-candidate"
  | "missing-stroke-evidence";

export interface CharacterHeightEvidence {
  readonly wordIndex: number;
  readonly text: string;
  readonly strokeIndices: readonly number[];
  readonly rejectedReasons: readonly Rejection[];
  readonly bounds?: Bounds;
}

const isHan = (text: string) => /^\p{Script=Han}$/u.test(text);
const wordKey = (lineId: number, wordIndex: number) => `${lineId}:${wordIndex}`;

/** Diagnostic hypothesis only; neither supplies nor repairs line metrics. */
export function auditCharacterHeights(
  document: InkDocument,
  association: InkAssociationReport,
) {
  if (document.sourceHash !== association.sourceHash)
    throw new Error("Stale character-height source");

  const strokes = new Map(
    document.strokes.map((stroke) => [stroke.index, stroke]),
  );
  const touchedWords = new Map<number, Set<string>>();
  const owners = new Map<number, number>();
  const missingEvidence = new Set<string>();
  const candidateStrokes = new Map(
    association.candidates.map((candidate) => [
      candidate.id,
      new Set(candidate.strokeIndices),
    ]),
  );
  const unusedStrokes = new Set(
    association.unusedStrokes.map((stroke) => stroke.strokeIndex),
  );
  const unusedWords = new Set(
    association.unusedWords.map((word) => wordKey(word.lineId, word.wordIndex)),
  );
  for (const candidate of association.candidates) {
    if (
      candidate.sourceHash !== document.sourceHash ||
      candidate.strokeRefs.some((ref) => ref.sourceHash !== document.sourceHash)
    )
      throw new Error("Stale character-height candidate source");
    for (const index of candidate.strokeIndices) {
      if (!strokes.has(index))
        throw new Error(`Missing character-height source stroke ${index}`);
      owners.set(index, (owners.get(index) ?? 0) + 1);
      if (
        !candidate.associationEvidence.some(
          (item) => item.strokeIndex === index,
        )
      )
        missingEvidence.add(candidate.id);
    }
  }
  for (const item of [
    ...association.candidates.flatMap((candidate) =>
      candidate.associationEvidence.map((evidence) => ({
        strokeIndex: evidence.strokeIndex,
        evidence: evidence.words,
      })),
    ),
    ...association.unusedStrokes,
  ]) {
    if (!strokes.has(item.strokeIndex))
      throw new Error(
        `Missing character-height source stroke ${item.strokeIndex}`,
      );
    const words = touchedWords.get(item.strokeIndex) ?? new Set<string>();
    for (const word of item.evidence) {
      if (word.overlapRatio >= association.thresholds.minWordOverlapRatio)
        words.add(wordKey(word.lineId, word.wordIndex));
    }
    touchedWords.set(item.strokeIndex, words);
  }

  const lines = association.lines.map((line) => {
    const tokens = new Map<number, { text: string; candidates: string[] }>();
    const unsupportedTokens: {
      candidateId: string | null;
      text: string;
      wordIndices: readonly number[];
      rejectedReasons: readonly ["unsupported-tokenization"];
    }[] = [];
    for (const candidate of association.candidates) {
      if (candidate.lineId !== line.lineId) continue;
      const characters = Array.from(candidate.text);
      if (characters.length !== candidate.recognition.wordIndices.length) {
        unsupportedTokens.push({
          candidateId: candidate.id,
          text: candidate.text,
          wordIndices: candidate.recognition.wordIndices,
          rejectedReasons: ["unsupported-tokenization"],
        });
        continue;
      }
      candidate.recognition.wordIndices.forEach((wordIndex, index) => {
        const text = characters[index];
        if (!text || !isHan(text)) return;
        const token = tokens.get(wordIndex) ?? { text, candidates: [] };
        token.candidates.push(candidate.id);
        tokens.set(wordIndex, token);
      });
    }
    for (const word of association.unusedWords) {
      if (word.lineId !== line.lineId) continue;
      if (Array.from(word.text).length !== 1) {
        unsupportedTokens.push({
          candidateId: null,
          text: word.text,
          wordIndices: [word.wordIndex],
          rejectedReasons: ["unsupported-tokenization"],
        });
      } else if (isHan(word.text) && !tokens.has(word.wordIndex)) {
        tokens.set(word.wordIndex, { text: word.text, candidates: [] });
      }
    }
    const characters: CharacterHeightEvidence[] = [...tokens]
      .sort(([a], [b]) => a - b)
      .map(([wordIndex, token]) => {
        const key = wordKey(line.lineId, wordIndex);
        const strokeIndices = [...touchedWords]
          .filter(([, words]) => words.has(key))
          .map(([index]) => index)
          .sort((a, b) => a - b);
        const rejectedReasons: Rejection[] = [];
        if (unusedWords.has(key)) rejectedReasons.push("unused-word");
        if (token.candidates.length > 1) rejectedReasons.push("duplicate-word");
        if (token.candidates.some((id) => missingEvidence.has(id)))
          rejectedReasons.push("missing-stroke-evidence");
        if (!strokeIndices.length) rejectedReasons.push("no-strokes");
        if (strokeIndices.some((index) => touchedWords.get(index)?.size !== 1))
          rejectedReasons.push("shared-stroke");
        if (strokeIndices.some((index) => unusedStrokes.has(index)))
          rejectedReasons.push("unused-stroke");
        if (strokeIndices.some((index) => owners.get(index) !== 1))
          rejectedReasons.push("duplicate-stroke-ownership");
        if (
          strokeIndices.some(
            (index) =>
              !token.candidates.some((id) =>
                candidateStrokes.get(id)?.has(index),
              ),
          )
        )
          rejectedReasons.push("stroke-outside-candidate");
        return {
          wordIndex,
          text: token.text,
          strokeIndices,
          rejectedReasons,
          ...(rejectedReasons.length
            ? {}
            : {
                bounds: measureCompleteInkLine(document, strokeIndices)
                  .visibleBounds,
              }),
        };
      });
    const heights = characters
      .flatMap((character) =>
        character.bounds ? [character.bounds.height] : [],
      )
      .sort((a, b) => a - b);
    const middle = Math.floor(heights.length / 2);
    const medianHeight = heights.length
      ? ((heights[middle] as number) +
          (heights[Math.floor((heights.length - 1) / 2)] as number)) /
        2
      : null;
    return {
      lineId: line.lineId,
      metrics: line.metrics,
      hanCount: Array.from(line.text).filter(isHan).length,
      measurableHanCount: heights.length,
      medianHeight,
      characters,
      unsupportedTokens,
    };
  });
  return {
    sourceHash: document.sourceHash,
    method: "unambiguous-complete-character-median" as const,
    lines,
  };
}

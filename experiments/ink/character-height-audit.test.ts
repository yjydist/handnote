import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { associateInk, parseInkJson, renderInkSvg } from "@handnote/ink";
import { auditCharacterHeights } from "./character-height-audit.ts";
import development from "./development.json";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";
import raw from "./fixtures/ocr-page-2-baseline.json";
import { hash } from "./ocr-evidence.ts";

function fixture(text = "人，山", words = Array.from(text)) {
  const document = parseInkJson(
    JSON.stringify(
      words.map((_, index) => ({
        brush_style: "pen",
        pen_width: 2,
        pen_color: 0,
        points: [
          { x: index * 20 + 5, y: 5, time: 0 },
          { x: index * 20 + 10, y: index === 1 ? 8 : 15, time: 1 },
        ],
      })),
    ),
  );
  const association = associateInk(document, {
    raw: {
      rec_texts: [text],
      rec_scores: [0.95],
      rec_boxes: [[0, 0, words.length * 20, 20]],
      text_word: [words],
      text_word_boxes: [
        words.map((_, index) => [index * 20, 0, index * 20 + 20, 20]),
      ],
    },
    transform: { scale: 1, translateX: 0, translateY: 0 },
    ocr: {
      version: "test",
      modelHash: "a".repeat(64),
      resultHash: "b".repeat(64),
    },
  });
  return { document, association };
}

test("measures complete Han strokes including pen width, excluding punctuation without repairing metrics", () => {
  const { document, association } = fixture();
  const unavailable = {
    ...association,
    lines: association.lines.map((line) => ({
      ...line,
      metrics: {
        status: "unavailable" as const,
        reason: "incomplete-line-metrics" as const,
      },
    })),
  };
  const before = JSON.stringify({ document, unavailable });
  const line = auditCharacterHeights(document, unavailable).lines[0];
  expect(line?.hanCount).toBe(2);
  expect(line?.measurableHanCount).toBe(2);
  expect(line?.medianHeight).toBe(12);
  expect(line?.characters.map((character) => character.text)).toEqual([
    "人",
    "山",
  ]);
  expect(line?.characters.map((character) => character.strokeIndices)).toEqual([
    [0],
    [2],
  ]);
  expect(line?.metrics.status).toBe("unavailable");
  expect(JSON.stringify({ document, unavailable })).toBe(before);
});

test("a shared stroke rejects each entire touched character instead of borrowing its unshared remainder", () => {
  const { document, association } = fixture("人山");
  const shared = {
    ...association,
    candidates: association.candidates.map((candidate) => ({
      ...candidate,
      associationEvidence: candidate.associationEvidence.map((evidence) => ({
        ...evidence,
        words:
          evidence.strokeIndex === 0
            ? [
                ...evidence.words,
                { lineId: 0, wordIndex: 1, overlapRatio: 0.1, nearbyRatio: 1 },
              ]
            : evidence.words,
      })),
    })),
  };
  const line = auditCharacterHeights(document, shared).lines[0];
  expect(line?.measurableHanCount).toBe(0);
  expect(line?.medianHeight).toBeNull();
  expect(line?.characters.map((character) => character.strokeIndices)).toEqual([
    [0],
    [0, 1],
  ]);
  for (const character of line?.characters ?? []) {
    expect(character.rejectedReasons).toContain("shared-stroke");
    expect(character.bounds).toBeUndefined();
  }
});

test("multi-character OCR tokens remain unsupported rather than guessing word-to-character boundaries", () => {
  const { document, association } = fixture("人山", ["人山"]);
  const line = auditCharacterHeights(document, association).lines[0];
  expect(line?.hanCount).toBe(2);
  expect(line?.measurableHanCount).toBe(0);
  expect(line?.medianHeight).toBeNull();
  expect(line?.characters).toEqual([]);
  expect(line?.unsupportedTokens).toHaveLength(1);
  expect(line?.unsupportedTokens[0]).toMatchObject({
    text: "人山",
    wordIndices: [0],
    rejectedReasons: ["unsupported-tokenization"],
  });
});

test("unused-word evidence and duplicate ownership prevent measurement", () => {
  const { document, association } = fixture("人");
  const unused = {
    ...association,
    unusedWords: [
      {
        lineId: 0,
        wordIndex: 0,
        text: "人",
        reason: "incomplete-component" as const,
      },
    ],
  };
  expect(
    auditCharacterHeights(document, unused).lines[0]?.characters[0]
      ?.rejectedReasons,
  ).toContain("unused-word");
  const duplicate = {
    ...association,
    candidates: [...association.candidates, ...association.candidates],
  };
  const line = auditCharacterHeights(document, duplicate).lines[0];
  expect(line?.measurableHanCount).toBe(0);
  expect(line?.characters[0]?.rejectedReasons).toContain(
    "duplicate-stroke-ownership",
  );
});

test("unused strokes touching a character invalidate the whole character", () => {
  const { document, association } = fixture("人山");
  const report = {
    ...association,
    candidates: association.candidates.filter(
      (candidate) => candidate.recognition.wordIndices[0] === 0,
    ),
    unusedStrokes: [
      {
        strokeIndex: 1,
        reason: "incomplete-component" as const,
        evidence: [
          { lineId: 0, wordIndex: 0, overlapRatio: 1, nearbyRatio: 1 },
        ],
      },
    ],
  };
  const line = auditCharacterHeights(document, report).lines[0];
  expect(line?.characters[0]?.strokeIndices).toEqual([0, 1]);
  expect(line?.characters[0]?.rejectedReasons).toContain("unused-stroke");
  expect(line?.characters[0]?.bounds).toBeUndefined();
  expect(line?.medianHeight).toBeNull();
});

test("stale association and candidate sources fail before measurement", () => {
  const { document, association } = fixture("人");
  expect(() =>
    auditCharacterHeights(document, { ...association, sourceHash: "stale" }),
  ).toThrow("Stale character-height source");
  expect(() =>
    auditCharacterHeights(document, {
      ...association,
      candidates: association.candidates.map((candidate) => ({
        ...candidate,
        sourceHash: "stale",
      })),
    }),
  ).toThrow("Stale character-height candidate source");
});

test("fixed development page 2 records all fifteen Han characters and six unambiguous heights", async () => {
  const page = development.pages[0];
  if (!page) throw new Error("Missing development page");
  const document = parseInkJson(
    await readFile(new URL(`../../${page.source}`, import.meta.url)),
  );
  expect(document.sourceHash).toBe(page.sourceHash);
  const rendering = renderInkSvg(document, {
    background: "white",
    padding: 10,
  });
  const original = associateInk(document, {
    raw,
    transform: rendering.transform,
    ocr: {
      version: "paddleocr-3.3.1",
      resultHash: hash(JSON.stringify(raw)),
      modelHash: "a".repeat(64),
    },
  });
  const association = reassessExteriorStrokes(document, original).association;
  const line = auditCharacterHeights(document, association).lines.find(
    (line) => line.lineId === 5,
  );
  expect(line?.metrics.status).toBe("available");
  expect(line?.hanCount).toBe(15);
  expect(line?.characters).toHaveLength(15);
  expect(line?.measurableHanCount).toBe(6);
  expect(line?.medianHeight).toBeCloseTo(37.403333333334, 6);
  expect(
    line?.characters
      .filter((character) => character.bounds)
      .map((character) => character.wordIndex),
  ).toEqual([1, 6, 7, 8, 12, 16]);
});

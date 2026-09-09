import { describe, expect, test } from "bun:test";
import { associateInk, type InkTransform, parseInkJson } from "../src/index";
import realExcerpt from "./fixtures/ocr-page-2-excerpt.json";
import degenerateExcerpt from "./fixtures/ocr-page-69-degenerate.json";

const provenance = {
  version: "paddleocr-3.3.1/paddlepaddle-3.2.2",
  resultHash: "a".repeat(64),
  modelHash: "b".repeat(64),
};
const identity = { scale: 1, translateX: 0, translateY: 0 };
function document(paths: number[][][]) {
  return parseInkJson(
    JSON.stringify(
      paths.map((points) => ({
        brush_style: "pen",
        pen_width: 1,
        pen_color: 0,
        points: points.map(([x, y], time) => ({ x, y, time })),
      })),
    ),
  );
}
function raw(lines: string[] = ["人人"]) {
  return {
    rec_texts: lines,
    rec_scores: lines.map(() => 0.95),
    rec_boxes: lines.map((line, index) => [
      0,
      index * 30,
      line.length * 14 - 4,
      index * 30 + 20,
    ]),
    text_word: lines.map((line) => [...line]),
    text_word_boxes: lines.map((line, lineIndex) =>
      [...line].map((_, index) => [
        index * 14,
        lineIndex * 30,
        index * 14 + 10,
        lineIndex * 30 + 20,
      ]),
    ),
  };
}
function associate(
  paths: number[][][],
  result: unknown = raw(),
  transform: InkTransform = identity,
) {
  return associateInk(document(paths), {
    raw: result,
    transform,
    ocr: provenance,
  });
}

describe("complete-trajectory OCR association", () => {
  test("keeps repeated occurrences separate and never shares strokes", () => {
    const report = associate([
      [
        [5, 5],
        [5, 15],
      ],
      [
        [19, 5],
        [19, 15],
      ],
    ]);
    expect(
      report.candidates.map((candidate) => [
        candidate.text,
        candidate.occurrence,
        candidate.strokeIndices,
      ]),
    ).toEqual([
      ["人", { start: 0, end: 1 }, [0]],
      ["人", { start: 1, end: 2 }, [1]],
    ]);
    expect(
      report.candidates.every(
        (candidate) => candidate.status === "pending-human-review",
      ),
    ).toBe(true);
    expect(report.sourceHash).toBe(
      document([
        [
          [5, 5],
          [5, 15],
        ],
        [
          [19, 5],
          [19, 15],
        ],
      ]).sourceHash,
    );
    expect(report.ocr).toEqual(provenance);
  });

  test("merges adjacent words joined by a complete connecting stroke", () => {
    const report = associate([
      [
        [5, 5],
        [5, 15],
      ],
      [
        [5, 10],
        [19, 10],
      ],
      [
        [19, 5],
        [19, 15],
      ],
    ]);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.text).toBe("人人");
    expect(report.candidates[0]?.strokeIndices).toEqual([0, 1, 2]);
    expect(
      report.candidates[0]?.strokeRefs.map((ref) => ref.strokeIndex),
    ).toEqual([0, 1, 2]);
  });

  test("uses segment intersections even when endpoints lie outside the word boxes", () => {
    const report = associate([
      [
        [-5, 10],
        [29, 10],
      ],
    ]);
    expect(report.candidates[0]?.text).toBe("人人");
    expect(
      report.candidates[0]?.associationEvidence[0]?.words.every(
        (word) => word.overlapRatio > 0,
      ),
    ).toBe(true);
  });

  test("inverts known image transform and uses source-space line metrics", () => {
    const result = {
      rec_texts: ["人"],
      rec_scores: [0.95],
      rec_boxes: [[100, 200, 120, 240]],
      text_word: [["人"]],
      text_word_boxes: [[[100, 200, 120, 240]]],
    };
    const report = associate(
      [
        [
          [5, 5],
          [5, 15],
        ],
      ],
      result,
      { scale: 2, translateX: 100, translateY: 200 },
    );
    const candidate = report.candidates[0];
    expect(candidate?.bounds).toEqual({ x: 4.5, y: 4.5, width: 1, height: 11 });
    expect(candidate?.lineHeight).toBe(20);
    expect(candidate?.baseline).toBe(15.5);
    expect(candidate?.recognition.score).toBe(0.95);
    expect(candidate?.recognition.imageBoxes).toEqual([[100, 200, 120, 240]]);
  });

  test("cross-line conflicts also withhold otherwise attributable strokes", () => {
    const report = associate(
      [
        [
          [5, 5],
          [5, 35],
        ],
        [
          [5, 6],
          [8, 15],
        ],
      ],
      raw(["人", "人"]),
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes.map((stroke) => stroke.reason)).toEqual([
      "competing-lines",
      "incomplete-component",
    ]);
  });

  test("rejects nonadjacent-word strokes instead of inventing intermediate membership", () => {
    const report = associate(
      [
        [
          [5, 5],
          [5, -10],
          [33, -10],
          [33, 5],
        ],
      ],
      raw(["天地人"]),
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes[0]?.reason).toBe("nonadjacent-words");
  });

  test("isolated dots cause explicit fallback including the affected glyph", () => {
    const report = associate(
      [
        [[5, 5]],
        [
          [5, 7],
          [5, 15],
        ],
      ],
      raw(["人"]),
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes.map((stroke) => stroke.reason)).toEqual([
      "isolated-point",
      "incomplete-component",
    ]);
  });

  test("long underline-like paths are retained as unused evidence", () => {
    const report = associate(
      [
        [
          [0, 19],
          [52, 19],
        ],
      ],
      raw(["天地人和"]),
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes[0]?.reason).toBe("long-decoration");
  });

  test("does not attach a mostly external trajectory by its small intersecting part", () => {
    const report = associate(
      [
        [
          [5, 10],
          [5, 100],
        ],
      ],
      raw(["人"]),
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes[0]?.reason).toBe("long-decoration");
    expect(report.unusedStrokes[0]?.evidence[0]?.overlapRatio).toBeLessThan(
      0.2,
    );
  });

  test("never associates a line whose recognition text disagrees with its words", () => {
    const result = { ...raw(["人"]), rec_texts: ["天"] };
    const report = associate(
      [
        [
          [5, 5],
          [5, 15],
        ],
      ],
      result,
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedWords[0]?.reason).toBe("inconsistent-ocr-text");
  });

  test("parses actual PaddleOCR word-box output and reports its low recognition score", () => {
    const report = associate(
      [
        [
          [250, 24],
          [250, 42],
        ],
      ],
      realExcerpt,
    );
    expect(report.candidates).toHaveLength(0);
    expect(report.unusedStrokes[0]?.reason).toBe("low-recognition-score");
    expect(report.unusedStrokes[0]?.evidence[0]?.wordIndex).toBe(0);
  });

  test("keeps the experimental recognition gate separate from geometric assignment", () => {
    const paths = [
      [
        [5, 5],
        [5, 15],
      ],
    ];
    const low = associate(paths, { ...raw(["人"]), rec_scores: [0.899] });
    const boundary = associate(paths, { ...raw(["人"]), rec_scores: [0.9] });
    expect(low.candidates).toHaveLength(0);
    expect(low.unusedWords[0]?.reason).toBe("low-recognition-score");
    expect(boundary.candidates).toHaveLength(1);
    expect(boundary.thresholds.minRecognitionScore).toBe(0.9);
    const conflict = associate(
      [
        [
          [5, 5],
          [5, 35],
        ],
      ],
      { ...raw(["人", "人"]), rec_scores: [1, 1] },
    );
    expect(conflict.candidates).toHaveLength(0);
    expect(conflict.unusedStrokes[0]?.reason).toBe("competing-lines");
  });

  test("falls back on real zero-height OCR boxes while retaining other valid lines", () => {
    const companion = raw(["人"]);
    const report = associate(
      [
        [
          [780, 360],
          [790, 380],
        ],
        [
          [5, 5],
          [5, 15],
        ],
      ],
      {
        rec_texts: [...degenerateExcerpt.rec_texts, ...companion.rec_texts],
        rec_scores: [...degenerateExcerpt.rec_scores, ...companion.rec_scores],
        rec_boxes: [...degenerateExcerpt.rec_boxes, ...companion.rec_boxes],
        text_word: [...degenerateExcerpt.text_word, ...companion.text_word],
        text_word_boxes: [
          ...degenerateExcerpt.text_word_boxes,
          ...companion.text_word_boxes,
        ],
      },
    );
    expect(
      report.unusedWords
        .filter((word) => word.lineId === 0)
        .every((word) => word.reason === "degenerate-word-box"),
    ).toBe(true);
    expect(report.candidates.map((candidate) => candidate.text)).toEqual([
      "人",
    ]);
    expect(report.unusedStrokes[0]?.reason).toBe("degenerate-word-box");
  });

  test("rejects malformed boxes, mismatched arrays, provenance, and transforms", () => {
    expect(() =>
      associate(
        [
          [
            [5, 5],
            [5, 15],
          ],
        ],
        { ...raw(), rec_scores: [] },
      ),
    ).toThrow("line arrays");
    expect(() =>
      associate(
        [
          [
            [5, 5],
            [5, 15],
          ],
        ],
        {
          ...raw(),
          text_word_boxes: [
            [
              [10, 0, 0, 20],
              [14, 0, 24, 20],
            ],
          ],
        },
      ),
    ).toThrow("extent");
    expect(() =>
      associate(
        [
          [
            [5, 5],
            [5, 15],
          ],
        ],
        raw(),
        { ...identity, scale: 0 },
      ),
    ).toThrow("scale");
    expect(() =>
      associateInk(
        document([
          [
            [5, 5],
            [5, 15],
          ],
        ]),
        {
          raw: raw(),
          transform: identity,
          ocr: { ...provenance, resultHash: "unknown" },
        },
      ),
    ).toThrow("provenance");
  });
});

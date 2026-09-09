import { expect, test } from "bun:test";
import { refineOcrPage } from "./refine-ocr.ts";

const identity = { scale: 1, translateX: 0, translateY: 0 };
type Box = [number, number, number, number];
function raw(lines: { text: string; score: number; box: Box }[]) {
  return {
    input_path: "page.png",
    rec_texts: lines.map((line) => line.text),
    rec_scores: lines.map((line) => line.score),
    rec_boxes: lines.map((line) => line.box),
    text_word: lines.map((line) => [line.text]),
    text_word_boxes: lines.map((line) => [line.box]),
  };
}
const line = (text = "天气", score = 0.8, box: Box = [0, 0, 20, 10]) => ({
  text,
  score,
  box,
});
const crop = (result = raw([line("天气", 0.95)])) => ({
  inputId: "page-line-0-2x",
  baselineLineId: 0,
  raw: result,
  transform: identity,
  resultHash: "a".repeat(64),
});

test("refinement projects crop boxes through source coordinates and preserves all original page contexts", () => {
  const baseline = {
    raw: {
      ...raw([
        line("天气", 0.8, [110, 220, 150, 240]),
        line("天气", 0.1, [110, 300, 150, 320]),
      ]),
      rec_polys: ["stale"],
    },
    transform: { scale: 2, translateX: 10, translateY: 20 },
  };
  const cropped = {
    ...crop(raw([line("天气", 0.95, [0, 0, 80, 40])])),
    transform: { scale: 4, translateX: -200, translateY: -400 },
  };
  cropped.raw.text_word = [["天", "气"]];
  cropped.raw.text_word_boxes = [
    [
      [0, 0, 40, 40],
      [40, 0, 80, 40],
    ],
  ];
  const originalBaseline = structuredClone(baseline);
  const originalCrop = structuredClone(cropped);
  const result = refineOcrPage(baseline, [cropped]);
  expect(result.raw).toEqual({
    input_path: "page.png",
    rec_texts: ["天气", "天气"],
    rec_scores: [0.95, 0.1],
    rec_boxes: [
      [110, 220, 150, 240],
      [110, 300, 150, 320],
    ],
    text_word: [["天", "气"], ["天气"]],
    text_word_boxes: [
      [
        [110, 220, 130, 240],
        [130, 220, 150, 240],
      ],
      [[110, 300, 150, 320]],
    ],
  });
  expect(result.accepted).toEqual([
    {
      inputId: cropped.inputId,
      resultHash: cropped.resultHash,
      baselineLineId: 0,
      cropLineIndex: 0,
      baselineScore: 0.8,
      cropScore: 0.95,
      intersectionOverUnion: 1,
      competingCropLineIndices: [],
      reasons: [],
    },
  ]);
  expect(result.rejected).toEqual([]);
  expect(baseline).toEqual(originalBaseline);
  expect(cropped).toEqual(originalCrop);
});

test("empty crop collection preserves original OCR fields even when baseline text is unusable", () => {
  const baseline = raw([line("天气：", 0.1)]);
  baseline.text_word = [["天"]];
  baseline.text_word_boxes = [[[0, 0, 0, 10]]];
  expect(refineOcrPage({ raw: baseline, transform: identity }, [])).toEqual({
    raw: baseline,
    accepted: [],
    rejected: [],
  });
});

test("a higher score alone does not replace already usable recognition geometry", () => {
  const original = raw([line("天气", 0.95)]);
  const result = refineOcrPage({ raw: original, transform: identity }, [
    crop(raw([line("天气", 0.99, [1, 1, 19, 9])])),
  ]);
  expect(result.accepted).toHaveLength(0);
  expect(result.raw).toEqual(original);
  expect(result.rejected[0]?.reasons).toContain(
    "baseline-recognition-already-usable",
  );
});

test("repeated text in a neighboring crop line cannot refine the target line", () => {
  const result = refineOcrPage({ raw: raw([line()]), transform: identity }, [
    crop(raw([line("天汽", 0.95), line("天气", 0.99, [0, 30, 20, 40])])),
  ]);
  expect(result.accepted).toHaveLength(0);
  expect(result.raw.rec_scores).toEqual([0.8]);
  expect(result.rejected.map((item) => item.reasons)).toEqual([
    ["different-line-text"],
    ["insufficient-line-overlap"],
  ]);
});

test("duplicate eligible detections and low confidence overlapping detections both force abstention", () => {
  for (const other of [
    line("天气", 0.96),
    line("噪声", 0.01, [5, 0, 10, 10]),
  ]) {
    const result = refineOcrPage({ raw: raw([line()]), transform: identity }, [
      crop(raw([line("天气", 0.95), other])),
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reasons).toContain("competing-crop-detection");
    if (other.text === "天气")
      expect(result.rejected[0]?.reasons).toContain(
        "ambiguous-crop-candidates",
      );
  }
});

test("exact text includes punctuation and accepted confidence must reach threshold and improve", () => {
  const baseline = { raw: raw([line("天气：", 0.91)]), transform: identity };
  for (const [text, score, reason] of [
    ["天气:", 0.99, "different-line-text"],
    ["天气：", 0.899, "low-recognition-score"],
    ["天气：", 0.91, "recognition-score-not-improved"],
  ] as const) {
    const result = refineOcrPage(baseline, [crop(raw([line(text, score)]))]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reasons).toContain(reason);
  }
  expect(
    refineOcrPage({ raw: raw([line()]), transform: identity }, [
      crop(raw([line("天气", 0.9)])),
    ]).accepted,
  ).toHaveLength(1);
});

test("candidate tokens must reconstruct the exact original text and have positive word boxes", () => {
  const inconsistent = raw([line("天气", 0.95)]);
  inconsistent.text_word = [["天"]];
  const degenerate = raw([line("天气", 0.95)]);
  degenerate.text_word_boxes = [[[0, 0, 0, 10]]];
  for (const [candidate, reason] of [
    [inconsistent, "inconsistent-ocr-text"],
    [degenerate, "degenerate-word-box"],
  ] as const) {
    const result = refineOcrPage({ raw: raw([line()]), transform: identity }, [
      crop(candidate),
    ]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reasons).toContain(reason);
  }
});

test("empty detections are recorded and malformed boundary inputs fail explicitly", () => {
  const baseline = { raw: raw([line()]), transform: identity };
  expect(refineOcrPage(baseline, [crop(raw([]))]).rejected[0]?.reasons).toEqual(
    ["no-crop-detections"],
  );
  const candidate = crop();
  expect(() => refineOcrPage(baseline, [candidate, candidate])).toThrow(
    "duplicate",
  );
  expect(() =>
    refineOcrPage(baseline, [{ ...candidate, baselineLineId: 1 }]),
  ).toThrow("identity");
  expect(() =>
    refineOcrPage(baseline, [
      { ...candidate, transform: { ...identity, scale: 0 } },
    ]),
  ).toThrow();
  const invalid = raw([line()]);
  invalid.rec_scores = [Number.NaN];
  expect(() => refineOcrPage({ ...baseline, raw: invalid }, [])).toThrow();
  invalid.rec_scores = [];
  expect(() => refineOcrPage({ ...baseline, raw: invalid }, [])).toThrow(
    "line arrays",
  );
  const malformedWords = raw([line()]);
  malformedWords.text_word_boxes = [[]];
  expect(() => refineOcrPage(baseline, [crop(malformedWords)])).toThrow(
    "word arrays",
  );
});

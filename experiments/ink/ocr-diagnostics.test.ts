import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { associateInk, parseInkJson } from "@handnote/ink";
import {
  compareDiagnosticLines,
  summarizeOcrAssociation,
} from "./ocr-diagnostics.ts";
import {
  type ComparisonEvidence,
  validateOcrComparison,
} from "./ocr-evidence.ts";

const bounds = (x: number, y: number, width = 20, height = 10) => ({
  x,
  y,
  width,
  height,
});

test("geometric comparison preserves split lines, merged lines and unmapped neighbors", () => {
  const report = compareDiagnosticLines(
    [
      { lineId: 0, bounds: bounds(0, 0) },
      { lineId: 1, bounds: bounds(0, 15) },
      { lineId: 2, bounds: bounds(0, 40) },
    ],
    [
      {
        inputId: "page-2x",
        lines: [
          { lineId: 0, bounds: bounds(0, 0, 9) },
          { lineId: 1, bounds: bounds(11, 0, 9) },
          { lineId: 2, bounds: bounds(0, 0, 20, 25) },
          { lineId: 3, bounds: bounds(0, 70) },
        ],
      },
      {
        inputId: "crop-0",
        lines: [
          { lineId: 0, bounds: bounds(0, 0) },
          { lineId: 1, bounds: bounds(0, 15) },
          { lineId: 2, bounds: bounds(20, 40) },
        ],
      },
    ],
  );
  expect(
    report.rows[0]?.matches.map(({ inputId, lineId }) => [inputId, lineId]),
  ).toEqual([
    ["page-2x", 0],
    ["page-2x", 1],
    ["page-2x", 2],
    ["crop-0", 0],
  ]);
  expect(
    report.rows[1]?.matches.map(({ inputId, lineId }) => [inputId, lineId]),
  ).toEqual([
    ["page-2x", 2],
    ["crop-0", 1],
  ]);
  expect(report.rows[2]?.matches).toEqual([]);
  expect(report.unmappedLines).toEqual([
    { inputId: "page-2x", lineId: 3 },
    { inputId: "crop-0", lineId: 2 },
  ]);
  expect(report.rows[0]?.matches[0]?.baselineAreaFraction).toBe(0.45);
  expect(report.rows[0]?.matches[0]?.variantAreaFraction).toBe(1);
});

test("crop association summaries retain source coordinates and full-document stroke references", () => {
  const source = parseInkJson(
    JSON.stringify([
      {
        brush_style: "pen",
        pen_width: 1,
        pen_color: 0,
        points: [
          { x: 105, y: 205, time: 0 },
          { x: 105, y: 215, time: 1 },
        ],
      },
      {
        brush_style: "pen",
        pen_width: 1,
        pen_color: 0,
        points: [
          { x: 105, y: 235, time: 0 },
          { x: 105, y: 245, time: 1 },
        ],
      },
    ]),
  );
  const raw = {
    rec_texts: ["人", "邻"],
    rec_scores: [0.97, 0.98],
    rec_boxes: [
      [0, 0, 20, 40],
      [0, 60, 20, 100],
    ],
    text_word: [["人"], ["邻"]],
    text_word_boxes: [[[0, 0, 20, 40]], [[0, 60, 0, 100]]],
  };
  const association = associateInk(source, {
    raw,
    transform: { scale: 2, translateX: -200, translateY: -400 },
    ocr: {
      version: "test",
      resultHash: "a".repeat(64),
      modelHash: "b".repeat(64),
    },
  });
  const lines = summarizeOcrAssociation(association, raw);
  expect(lines).toHaveLength(2);
  expect(lines[0]?.bounds).toEqual(bounds(100, 200, 10, 20));
  expect(lines[0]?.recognitionScore).toBe(0.97);
  expect(lines[0]?.candidates[0]?.strokeRefs).toEqual([
    { sourceHash: source.sourceHash, strokeIndex: 0 },
  ]);
  expect(lines[0]?.metrics.status).toBe("available");
  expect(lines[1]?.degenerateWordIndices).toEqual([0]);
  expect(lines[1]?.unusedReason).toBe("degenerate-word-box");
  expect(lines[1]?.metrics.status).toBe("unavailable");
  expect(
    association.unusedStrokes.some((stroke) => stroke.strokeIndex === 1),
  ).toBe(true);
});

function comparisonFixture(): {
  baseline: ComparisonEvidence;
  variants: ComparisonEvidence;
} {
  const run = {
    modelLockHash: "a".repeat(64),
    packages: { paddleocr: "3.3.1", paddlepaddle: "3.2.2" },
    parameters: {
      return_word_box: true,
      nested: { mode: "fixed", sizes: [1, 2] },
    },
  };
  const inputs = ["2", "69", "70"].map((page) => ({
    rawBytes: Buffer.from(JSON.stringify({ page, rec_texts: ["baseline"] })),
    record: { page, inputId: `page-${page}`, variant: "baseline" as const },
  }));
  return {
    baseline: { run, inputs },
    variants: {
      run: {
        ...run,
        packages: { paddlepaddle: "3.2.2", paddleocr: "3.3.1" },
        parameters: {
          nested: { sizes: [1, 2], mode: "fixed" },
          return_word_box: true,
        },
      },
      inputs: inputs.flatMap(({ rawBytes, record }) =>
        ["page-2x", "line-2x"].map((variant) => ({
          rawBytes: Buffer.from("variant"),
          record: {
            page: record.page,
            inputId: `${record.inputId}-${variant}`,
            variant: variant as "page-2x" | "line-2x",
            baselineOcrHash: createHash("sha256")
              .update(rawBytes)
              .digest("hex"),
          },
        })),
      ),
    },
  };
}

test("comparison requires identical models, packages and actual baseline OCR bytes", () => {
  const { baseline, variants } = comparisonFixture();
  expect(() => validateOcrComparison(baseline, variants)).not.toThrow();
  expect(() =>
    validateOcrComparison(baseline, {
      ...variants,
      run: { ...variants.run, modelLockHash: "b".repeat(64) },
    }),
  ).toThrow("model or package versions");
  expect(() =>
    validateOcrComparison(baseline, {
      ...variants,
      run: {
        ...variants.run,
        packages: { ...variants.run.packages, paddleocr: "3.4.0" },
      },
    }),
  ).toThrow("model or package versions");
  expect(() =>
    validateOcrComparison(
      {
        ...baseline,
        inputs: baseline.inputs.map((input, index) =>
          index === 0
            ? {
                ...input,
                rawBytes: Buffer.concat([input.rawBytes, Buffer.from("\n")]),
              }
            : input,
        ),
      },
      variants,
    ),
  ).toThrow("baseline OCR hash");
  for (const variant of ["page-2x", "line-2x"])
    expect(() =>
      validateOcrComparison(baseline, {
        ...variants,
        inputs: variants.inputs.map((input) =>
          input.record.variant === variant
            ? {
                ...input,
                record: { ...input.record, baselineOcrHash: undefined },
              }
            : input,
        ),
      }),
    ).toThrow("baseline OCR hash");
});

test("comparison uses explicit structurally equal JSON parameters", () => {
  const { baseline, variants } = comparisonFixture();
  expect(() => validateOcrComparison(baseline, variants)).not.toThrow();
  for (const parameters of [undefined, null, []])
    expect(() =>
      validateOcrComparison(baseline, {
        ...variants,
        run: { ...variants.run, parameters },
      }),
    ).toThrow("explicit object parameters");
  expect(() =>
    validateOcrComparison(
      { ...baseline, run: { ...baseline.run, parameters: undefined } },
      variants,
    ),
  ).toThrow("explicit object parameters");
  for (const parameters of [
    { return_word_box: false, nested: { mode: "fixed", sizes: [1, 2] } },
    { return_word_box: true, nested: { mode: "fixed", sizes: [2, 1] } },
    { return_word_box: true, nested: { mode: "changed", sizes: [1, 2] } },
    {
      return_word_box: true,
      nested: { mode: "fixed", sizes: [1, 2], extra: true },
    },
  ])
    expect(() =>
      validateOcrComparison(baseline, {
        ...variants,
        run: { ...variants.run, parameters },
      }),
    ).toThrow("parameters differ");
});

test("comparison fixes three baseline pages and one full 2x input per page", () => {
  const { baseline, variants } = comparisonFixture();
  const firstBaseline = baseline.inputs[0];
  const firstVariant = variants.inputs[0];
  if (!firstBaseline || !firstVariant)
    throw new Error("Missing comparison fixture");
  for (const inputs of [
    baseline.inputs.slice(1),
    [firstBaseline, ...baseline.inputs],
    [firstBaseline, firstBaseline, ...baseline.inputs.slice(2)],
  ])
    expect(() =>
      validateOcrComparison({ ...baseline, inputs }, variants),
    ).toThrow("three fixed baseline pages");
  for (const inputs of [
    variants.inputs.filter(
      (input) =>
        !(input.record.page === "69" && input.record.variant === "page-2x"),
    ),
    [firstVariant, ...variants.inputs],
  ])
    expect(() =>
      validateOcrComparison(baseline, { ...variants, inputs }),
    ).toThrow("one 2x whole-page input");
  expect(() =>
    validateOcrComparison(baseline, {
      ...variants,
      inputs: [
        ...variants.inputs,
        { ...firstVariant, record: { ...firstVariant.record, page: "other" } },
      ],
    }),
  ).toThrow("Missing baseline page");
});

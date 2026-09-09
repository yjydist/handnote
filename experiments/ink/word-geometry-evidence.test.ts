import { expect, test } from "bun:test";
import { hash } from "./ocr-evidence.ts";
import { deriveMappedOcr } from "./word-geometry-evidence.ts";

function at<T>(values: readonly T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function fixture() {
  const original = [
    [10, 20],
    [50, 10],
    [52, 30],
    [12, 40],
  ];
  const word = [
    [10, 20],
    [50, 20],
    [50, 30],
    [10, 30],
  ];
  const rectified = [
    [0, 0],
    [40, 0],
    [40, 20],
    [0, 20],
  ];
  const projected = [
    [10, 20],
    [50, 20],
    [50, 40],
    [10, 40],
  ];
  const raw = {
    rec_texts: ["字"],
    rec_scores: [0.95],
    rec_polys: [original],
    rec_boxes: [[10, 10, 52, 40]],
    text_word: [["字"]],
    text_word_boxes: [[[10, 20, 50, 30]]],
    preserved: "original metadata",
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  const identity = { inputId: "page-2", imageHash: "image-hash" };
  const evidence = {
    schemaVersion: 1,
    method: "captured-paddlex-quad-crop-and-ctc",
    annotationStatus: "pending-human-review",
    rawResultHash: hash(bytes),
    inputImageHash: identity.imageHash,
    inputId: identity.inputId,
    lines: [
      {
        lineIndex: 0,
        crop: {
          orderedPoints: projected,
          outputShape: [20, 40, 3],
          preRotationShape: [20, 40],
          rotationQuarterTurnsCCW: 0,
        },
        recognition: {
          text: "字",
          dtPolygon: original,
          words: ["字"],
          wordPolygons: [word],
        },
        mapping: {
          status: "mapped",
          cropQuad: projected,
          cropShape: [20, 40, 3],
          sourceToRecognition: [
            [1, 0, -10],
            [0, 1, -20],
            [0, 0, 1],
          ],
          recognitionToSource: [
            [1, 0, 10],
            [0, 1, 20],
            [0, 0, 1],
          ],
          rectifiedWords: ["字"],
          rectifiedWordPolygons: [rectified],
          projectedWordPolygons: [projected],
          projectedWordBoxes: [[10, 20, 50, 40]],
        },
      },
    ],
  };
  return { raw, bytes, identity, evidence };
}

test("mapped evidence changes only word geometry and retains original input", () => {
  const f = fixture(),
    snapshot = JSON.stringify(f.evidence);
  const result = deriveMappedOcr(f.bytes, f.evidence, f.identity);
  expect<unknown>(result.raw).toEqual({
    ...f.raw,
    text_word_boxes: [[[10, 20, 50, 40]]],
  });
  expect(JSON.stringify(f.evidence)).toBe(snapshot);
  expect(JSON.parse(f.bytes.toString())).toEqual(f.raw);
});

test("stale raw bytes, image identity and line order are rejected", () => {
  const f = fixture();
  expect(() =>
    deriveMappedOcr(Buffer.from("changed"), f.evidence, f.identity),
  ).toThrow("Stale geometry OCR");
  expect(() =>
    deriveMappedOcr(f.bytes, f.evidence, {
      ...f.identity,
      imageHash: "different",
    }),
  ).toThrow("Geometry image differs");
  expect(() =>
    deriveMappedOcr(f.bytes, f.evidence, { ...f.identity, inputId: "page-69" }),
  ).toThrow("Geometry input identity differs");
  at(f.evidence.lines).lineIndex = 1;
  expect(() => deriveMappedOcr(f.bytes, f.evidence, f.identity)).toThrow(
    "Geometry line identity differs",
  );
});

test("word order, captured original boxes and projected bounds cannot be substituted", () => {
  const f = fixture();
  const changes = [
    (e: typeof f.evidence) => {
      at(e.lines).mapping.rectifiedWords = ["别"];
    },
    (e: typeof f.evidence) => {
      at(at(at(e.lines).recognition.wordPolygons))[0] = 11;
      at(at(at(e.lines).recognition.wordPolygons), 3)[0] = 11;
    },
    (e: typeof f.evidence) => {
      at(at(e.lines).mapping.projectedWordBoxes)[2] = 51;
    },
    (e: typeof f.evidence) => {
      at(e.lines).mapping.cropShape = [21, 40, 3];
    },
  ];
  for (const change of changes) {
    const evidence = structuredClone(f.evidence);
    change(evidence);
    expect(() => deriveMappedOcr(f.bytes, evidence, f.identity)).toThrow();
  }
});

test("singular or mismatched inverse transforms fail geometry round-trip validation", () => {
  const f = fixture();
  at(at(f.evidence.lines).mapping.recognitionToSource)[2] = 11;
  expect(() => deriveMappedOcr(f.bytes, f.evidence, f.identity)).toThrow(
    "round trip",
  );
  at(f.evidence.lines).mapping.recognitionToSource[2] = [0, 0, 0];
  expect(() => deriveMappedOcr(f.bytes, f.evidence, f.identity)).toThrow(
    "denominator",
  );
});

test("rejected mapping retains the original unusable geometry and explicit reason", () => {
  const f = fixture();
  const evidence = {
    ...f.evidence,
    lines: f.evidence.lines.map((line) => ({
      ...line,
      mapping: { status: "rejected", error: "unsupported CTC columns" },
    })),
  };
  const result = deriveMappedOcr(f.bytes, evidence, f.identity);
  expect<unknown>(result.raw).toEqual(f.raw);
  expect(result.lines).toEqual([
    { lineId: 0, status: "rejected", reason: "unsupported CTC columns" },
  ]);
});

test("mutually consistent projected boxes cannot use a transform unrelated to the captured crop", () => {
  const f = fixture();
  const mapping = at(f.evidence.lines).mapping;
  at(mapping.sourceToRecognition)[2] = -11;
  at(mapping.recognitionToSource)[2] = 11;
  mapping.projectedWordPolygons = mapping.projectedWordPolygons.map((polygon) =>
    polygon.map(([x, y]) => [(x ?? 0) + 1, y ?? 0]),
  );
  mapping.projectedWordBoxes = [[11, 20, 51, 40]];
  expect(() => deriveMappedOcr(f.bytes, f.evidence, f.identity)).toThrow();
});

test("rotated crops retain nominal W/H corners and reject a pixel-center matrix substitution", () => {
  const f = fixture();
  const line = at(f.evidence.lines);
  const quad = [
    [10, 20],
    [30, 20],
    [30, 60],
    [10, 60],
  ];
  line.crop = {
    orderedPoints: quad,
    outputShape: [20, 40, 3],
    preRotationShape: [40, 20],
    rotationQuarterTurnsCCW: 1,
  };
  line.mapping.cropQuad = quad;
  line.mapping.sourceToRecognition = [
    [0, 1, -20],
    [-1, 0, 30],
    [0, 0, 1],
  ];
  line.mapping.recognitionToSource = [
    [0, -1, 30],
    [1, 0, 20],
    [0, 0, 1],
  ];
  line.mapping.projectedWordPolygons = [
    [
      [30, 20],
      [30, 60],
      [10, 60],
      [10, 20],
    ],
  ];
  line.mapping.projectedWordBoxes = [[10, 20, 30, 60]];
  expect(
    deriveMappedOcr(f.bytes, f.evidence, f.identity).raw.text_word_boxes,
  ).toEqual([[[10, 20, 30, 60]]]);
  at(line.mapping.sourceToRecognition, 1)[2] = 29;
  at(line.mapping.recognitionToSource)[2] = 29;
  expect(() => deriveMappedOcr(f.bytes, f.evidence, f.identity)).toThrow(
    "round trip",
  );
});

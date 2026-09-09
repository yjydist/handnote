import assert from "node:assert/strict";
import { z } from "zod";
import { hash } from "./ocr-evidence.ts";

const number = z.number().finite();
const point = z.tuple([number, number]);
const polygon = z.tuple([point, point, point, point]);
const box = z.tuple([number, number, number, number]);
const row = z.tuple([number, number, number]);
const matrix = z.tuple([row, row, row]);
const mapping = z.discriminatedUnion("status", [
  z.object({ status: z.literal("rejected"), error: z.string().min(1) }),
  z.object({
    status: z.literal("mapped"),
    cropQuad: polygon,
    cropShape: z.tuple([
      z.number().int().positive(),
      z.number().int().positive(),
      z.number().int().positive(),
    ]),
    sourceToRecognition: matrix,
    recognitionToSource: matrix,
    rectifiedWords: z.array(z.string()),
    rectifiedWordPolygons: z.array(polygon),
    projectedWordPolygons: z.array(polygon),
    projectedWordBoxes: z.array(box),
  }),
]);
const schema = z.object({
  schemaVersion: z.literal(1),
  method: z.literal("captured-paddlex-quad-crop-and-ctc"),
  annotationStatus: z.literal("pending-human-review"),
  rawResultHash: z.string(),
  inputImageHash: z.string(),
  inputId: z.string(),
  lines: z.array(
    z.object({
      lineIndex: z.number().int().nonnegative(),
      crop: z.object({
        orderedPoints: polygon,
        outputShape: z.tuple([z.number(), z.number(), z.number()]),
        preRotationShape: z.tuple([
          z.number().int().positive(),
          z.number().int().positive(),
        ]),
        rotationQuarterTurnsCCW: z.union([z.literal(0), z.literal(1)]),
      }),
      recognition: z.object({
        text: z.string(),
        dtPolygon: polygon,
        words: z.array(z.string()),
        wordPolygons: z.array(polygon),
      }),
      mapping,
    }),
  ),
});
const rawSchema = z
  .object({
    rec_texts: z.array(z.string()),
    rec_scores: z.array(number),
    rec_polys: z.array(polygon),
    rec_boxes: z.array(box),
    text_word: z.array(z.array(z.string())),
    text_word_boxes: z.array(z.array(box)),
  })
  .passthrough();

const enclosing = (points: readonly (readonly [number, number])[]) => [
  Math.min(...points.map((p) => p[0])),
  Math.min(...points.map((p) => p[1])),
  Math.max(...points.map((p) => p[0])),
  Math.max(...points.map((p) => p[1])),
];
function project(p: [number, number], m: z.infer<typeof matrix>) {
  const denominator = m[2][0] * p[0] + m[2][1] * p[1] + m[2][2];
  assert(
    Number.isFinite(denominator) && Math.abs(denominator) > 1e-12,
    "Invalid projection denominator",
  );
  return [0, 1].map((index) => {
    const r = m[index];
    assert(r);
    const value = (r[0] * p[0] + r[1] * p[1] + r[2]) / denominator;
    assert(Number.isFinite(value), "Nonfinite projection");
    return value;
  });
}
function near(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  assert(
    actual.every(
      (value, i) => Math.abs(value - (expected[i] ?? Number.NaN)) < 1e-6,
    ),
    "Mapped word geometry does not round trip",
  );
}

/** Only coordinate evidence changes; original recognition and full-page context remain fixed. */
export function deriveMappedOcr(
  rawBytes: Uint8Array,
  evidence: unknown,
  identity: { inputId: string; imageHash: string },
) {
  const geometry = schema.parse(evidence);
  assert.equal(geometry.rawResultHash, hash(rawBytes), "Stale geometry OCR");
  assert.equal(
    geometry.inputId,
    identity.inputId,
    "Geometry input identity differs",
  );
  assert.equal(
    geometry.inputImageHash,
    identity.imageHash,
    "Geometry image differs",
  );
  const raw = rawSchema.parse(
    JSON.parse(Buffer.from(rawBytes).toString("utf8")),
  );
  const count = raw.rec_texts.length;
  for (const values of [
    raw.rec_scores,
    raw.rec_polys,
    raw.rec_boxes,
    raw.text_word,
    raw.text_word_boxes,
    geometry.lines,
  ])
    assert.equal(values.length, count, "Geometry line count differs");
  const mapped = structuredClone(raw);
  const lines = geometry.lines.map((line, index) => {
    assert.equal(line.lineIndex, index, "Geometry line identity differs");
    assert.equal(
      line.recognition.text,
      raw.rec_texts[index],
      "Geometry text differs",
    );
    assert.deepEqual(
      line.recognition.dtPolygon,
      raw.rec_polys[index],
      "Geometry detection polygon differs",
    );
    assert.deepEqual(
      line.recognition.words,
      raw.text_word[index],
      "Geometry word order differs",
    );
    assert.deepEqual(
      line.recognition.wordPolygons.map(enclosing),
      raw.text_word_boxes[index],
      "Geometry original word boxes differ",
    );
    const projection = line.mapping;
    if (projection.status === "rejected")
      return {
        lineId: index,
        status: "rejected" as const,
        reason: projection.error,
      };
    assert.deepEqual(
      projection.cropQuad,
      line.crop.orderedPoints,
      "Geometry crop points differ",
    );
    assert.deepEqual(
      projection.cropShape,
      line.crop.outputShape,
      "Geometry crop dimensions differ",
    );
    const [height, width] = line.crop.preRotationShape;
    const rotated = height / width >= 1.5;
    assert.equal(
      line.crop.rotationQuarterTurnsCCW,
      Number(rotated),
      "Geometry crop rotation differs",
    );
    assert.deepEqual(
      line.crop.outputShape.slice(0, 2),
      rotated ? [width, height] : [height, width],
      "Geometry rotated dimensions differ",
    );
    // Paddle's nominal rectangle extents use W/H; sampling-center rotation is separate.
    const corners: [number, number][] = rotated
      ? [
          [0, width],
          [0, 0],
          [height, 0],
          [height, width],
        ]
      : [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ];
    line.crop.orderedPoints.forEach((p, corner) => {
      const q = corners[corner];
      assert(q);
      near(project(p, projection.sourceToRecognition), q);
      near(project(q, projection.recognitionToSource), p);
    });
    assert.deepEqual(
      projection.rectifiedWords,
      line.recognition.words,
      "Projected word order differs",
    );
    const length = projection.rectifiedWords.length;
    for (const polygons of [
      projection.rectifiedWordPolygons,
      projection.projectedWordPolygons,
      projection.projectedWordBoxes,
    ])
      assert.equal(polygons.length, length, "Projected word count differs");
    projection.projectedWordPolygons.forEach((points, wordIndex) => {
      const rectified = projection.rectifiedWordPolygons[wordIndex];
      const bounds = projection.projectedWordBoxes[wordIndex];
      assert(rectified && bounds);
      assert(
        bounds[2] > bounds[0] && bounds[3] > bounds[1],
        "Degenerate mapped word box",
      );
      near(enclosing(points), bounds);
      points.forEach((p, corner) => {
        const q = rectified[corner];
        assert(q);
        near(project(p, projection.sourceToRecognition), q);
        near(project(q, projection.recognitionToSource), p);
      });
    });
    mapped.text_word_boxes[index] = projection.projectedWordBoxes;
    return {
      lineId: index,
      status: "mapped" as const,
      projectedWordPolygons: projection.projectedWordPolygons,
    };
  });
  return { raw: mapped, lines };
}

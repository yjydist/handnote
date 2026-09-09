import type { InkTransform } from "@handnote/ink";
import { z } from "zod";

export const refinementThresholds = Object.freeze({
  status: "uncalibrated-development-defaults",
  minRecognitionScore: 0.9,
  minLineIntersectionOverUnion: 0.5,
  competingDetectionAreaFraction: 0.5,
});

type Box = [number, number, number, number];
const boxSchema = z
  .tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ])
  .refine((box) => box[2] >= box[0] && box[3] >= box[1], "Invalid box extent");
const rawSchema = z
  .object({
    input_path: z.string().optional(),
    rec_texts: z.array(z.string()),
    rec_scores: z.array(z.number().finite().min(0).max(1)),
    rec_boxes: z.array(
      boxSchema.refine(
        (box) => box[2] > box[0] && box[3] > box[1],
        "Empty line box",
      ),
    ),
    text_word: z.array(z.array(z.string().min(1))),
    text_word_boxes: z.array(z.array(boxSchema)),
  })
  .superRefine((raw, context) => {
    if (
      [raw.rec_scores, raw.rec_boxes, raw.text_word, raw.text_word_boxes].some(
        (array) => array.length !== raw.rec_texts.length,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent OCR line arrays",
      });
    if (
      raw.text_word.some(
        (words, i) => words.length !== raw.text_word_boxes[i]?.length,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent OCR word arrays",
      });
  });
const transformSchema = z.object({
  scale: z.number().finite().positive(),
  translateX: z.number().finite(),
  translateY: z.number().finite(),
});

interface OcrInput {
  raw: unknown;
  transform: InkTransform;
}
interface CropInput extends OcrInput {
  inputId: string;
  baselineLineId: number;
  resultHash: string;
}
export interface RefinementEvidence {
  inputId: string;
  resultHash: string;
  baselineLineId: number;
  cropLineIndex: number | null;
  baselineScore: number;
  cropScore: number | null;
  intersectionOverUnion: number | null;
  competingCropLineIndices: number[];
  reasons: string[];
}

const area = (box: Box) => (box[2] - box[0]) * (box[3] - box[1]);
const intersection = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const sourceBox = (box: Box, transform: InkTransform): Box => [
  (box[0] - transform.translateX) / transform.scale,
  (box[1] - transform.translateY) / transform.scale,
  (box[2] - transform.translateX) / transform.scale,
  (box[3] - transform.translateY) / transform.scale,
];
const project = (box: Box, from: InkTransform, to: InkTransform): Box => {
  const source = sourceBox(box, from);
  return [
    source[0] * to.scale + to.translateX,
    source[1] * to.scale + to.translateY,
    source[2] * to.scale + to.translateX,
    source[3] * to.scale + to.translateY,
  ];
};

/** Synthetic association input only: original page line identities and text remain fixed. */
export function refineOcrPage(baseline: OcrInput, crops: readonly CropInput[]) {
  const raw = rawSchema.parse(baseline.raw);
  const baselineTransform = transformSchema.parse(baseline.transform);
  const accepted: RefinementEvidence[] = [];
  const rejected: RefinementEvidence[] = [];
  const ids = new Set<string>();
  const lineIds = new Set<number>();
  for (const crop of crops) {
    if (
      !crop.inputId ||
      !crop.resultHash ||
      ids.has(crop.inputId) ||
      !Number.isInteger(crop.baselineLineId) ||
      crop.baselineLineId < 0 ||
      crop.baselineLineId >= raw.rec_texts.length ||
      lineIds.has(crop.baselineLineId)
    )
      throw new Error("Invalid or duplicate refinement crop identity");
    ids.add(crop.inputId);
    lineIds.add(crop.baselineLineId);
    const cropped = rawSchema.parse(crop.raw);
    const cropTransform = transformSchema.parse(crop.transform);
    const baselineBox = raw.rec_boxes[crop.baselineLineId];
    const baselineScore = raw.rec_scores[crop.baselineLineId];
    if (!baselineBox || baselineScore === undefined)
      throw new Error("Missing baseline line");
    const originalBox = sourceBox(baselineBox, baselineTransform);
    const common = {
      inputId: crop.inputId,
      resultHash: crop.resultHash,
      baselineLineId: crop.baselineLineId,
      baselineScore,
    };
    const evidence = cropped.rec_texts.map(
      (text, index): RefinementEvidence => {
        const box = cropped.rec_boxes[index];
        const score = cropped.rec_scores[index];
        const words = cropped.text_word[index];
        const wordBoxes = cropped.text_word_boxes[index];
        if (!box || score === undefined || !words || !wordBoxes)
          throw new Error("Missing crop line");
        const candidateBox = sourceBox(box, cropTransform);
        const overlap = intersection(originalBox, candidateBox);
        const iou =
          overlap / (area(originalBox) + area(candidateBox) - overlap);
        const competing = cropped.rec_boxes.flatMap((other, otherIndex) =>
          otherIndex !== index &&
          intersection(box, other) >=
            refinementThresholds.competingDetectionAreaFraction *
              Math.min(area(box), area(other))
            ? [otherIndex]
            : [],
        );
        const reasons: string[] = [];
        if (
          baselineScore >= refinementThresholds.minRecognitionScore &&
          raw.text_word[crop.baselineLineId]?.join("") ===
            raw.rec_texts[crop.baselineLineId] &&
          raw.text_word_boxes[crop.baselineLineId]?.every(
            (box) => area(box) > 0,
          )
        )
          reasons.push("baseline-recognition-already-usable");
        if (text !== raw.rec_texts[crop.baselineLineId])
          reasons.push("different-line-text");
        if (score < refinementThresholds.minRecognitionScore)
          reasons.push("low-recognition-score");
        if (score <= baselineScore)
          reasons.push("recognition-score-not-improved");
        if (iou < refinementThresholds.minLineIntersectionOverUnion)
          reasons.push("insufficient-line-overlap");
        if (words.join("") !== text) reasons.push("inconsistent-ocr-text");
        if (wordBoxes.some((box) => area(box) === 0))
          reasons.push("degenerate-word-box");
        return {
          ...common,
          cropLineIndex: index,
          cropScore: score,
          intersectionOverUnion: iou,
          competingCropLineIndices: competing,
          reasons,
        };
      },
    );
    const eligible = evidence.filter((item) => item.reasons.length === 0);
    if (eligible.length > 1)
      for (const item of eligible)
        item.reasons.push("ambiguous-crop-candidates");
    for (const item of evidence) {
      if (item.competingCropLineIndices.length)
        item.reasons.push("competing-crop-detection");
      if (item.reasons.length) {
        rejected.push(item);
        continue;
      }
      const index = item.cropLineIndex;
      if (index === null) throw new Error("Missing crop line index");
      const box = cropped.rec_boxes[index];
      const score = cropped.rec_scores[index];
      const words = cropped.text_word[index];
      const wordBoxes = cropped.text_word_boxes[index];
      if (!box || score === undefined || !words || !wordBoxes)
        throw new Error("Missing selected crop line");
      raw.rec_boxes[crop.baselineLineId] = project(
        box,
        cropTransform,
        baselineTransform,
      );
      raw.rec_scores[crop.baselineLineId] = score;
      raw.text_word[crop.baselineLineId] = words;
      raw.text_word_boxes[crop.baselineLineId] = wordBoxes.map((box) =>
        project(box, cropTransform, baselineTransform),
      );
      accepted.push(item);
    }
    if (!evidence.length)
      rejected.push({
        ...common,
        cropLineIndex: null,
        cropScore: null,
        intersectionOverUnion: null,
        competingCropLineIndices: [],
        reasons: ["no-crop-detections"],
      });
  }
  return { raw, accepted, rejected };
}

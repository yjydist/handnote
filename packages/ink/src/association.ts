import {
  type Bounds,
  createInkCandidate,
  type InkCandidate,
  type InkDocument,
  type InkStroke,
  type InkTransform,
  type StrokeReference,
  strokeBounds,
} from "./trajectory.ts";

export interface OcrProvenance {
  readonly version: string;
  readonly resultHash: string;
  readonly modelHash: string;
}

export interface WordEvidence {
  readonly lineId: number;
  readonly wordIndex: number;
  readonly overlapRatio: number;
  readonly nearbyRatio: number;
}

export type UnusedStrokeReason =
  | "isolated-point"
  | "outside-word-boxes"
  | "competing-lines"
  | "nonadjacent-words"
  | "partial-coverage"
  | "long-decoration"
  | "large-shape"
  | "inconsistent-ocr-text"
  | "degenerate-word-box"
  | "low-recognition-score"
  | "incomplete-component";

export interface StrokeAssociation {
  readonly strokeIndex: number;
  readonly reason: UnusedStrokeReason;
  readonly evidence: readonly WordEvidence[];
}

export interface AssociatedInkCandidate extends InkCandidate {
  readonly lineId: number;
  readonly lineText: string;
  readonly lineBounds: Bounds;
  readonly baselineMethod: "ocr-line-box-bottom";
  readonly occurrence: { readonly start: number; readonly end: number };
  readonly strokeRefs: readonly StrokeReference[];
  readonly recognition: {
    readonly score: number;
    readonly wordIndices: readonly number[];
    readonly imageBoxes: readonly (readonly number[])[];
  };
  readonly associationEvidence: readonly {
    readonly strokeIndex: number;
    readonly words: readonly WordEvidence[];
  }[];
}

export interface InkAssociationReport {
  readonly sourceHash: string;
  readonly ocr: OcrProvenance;
  readonly transform: InkTransform;
  readonly thresholds: typeof THRESHOLDS;
  readonly thresholdStatus: "uncalibrated-development-defaults";
  readonly lines: readonly {
    lineId: number;
    text: string;
    recognitionScore: number;
    bounds: Bounds;
    unusedReason: Line["unusableReason"];
  }[];
  readonly candidates: readonly AssociatedInkCandidate[];
  readonly unusedStrokes: readonly StrokeAssociation[];
  readonly unusedWords: readonly {
    lineId: number;
    wordIndex: number;
    text: string;
    reason:
      | "no-strokes"
      | "incomplete-component"
      | "inconsistent-ocr-text"
      | "degenerate-word-box"
      | "low-recognition-score";
  }[];
}

const THRESHOLDS = Object.freeze({
  minRecognitionScore: 0.9,
  nearbyMarginInLineHeights: 0.12,
  minWordOverlapRatio: 0.1,
  minWordNearbyRatio: 0.35,
  minTouchedNearbyRatio: 0.1,
  minOverlapLengthInLineHeights: 0.12,
  minCompleteNearbyRatio: 0.7,
  minCompetingLineRatio: 0.15,
  decorationLengthInLineHeights: 2.5,
  decorationThicknessInLineHeights: 0.12,
  decorationStraightness: 0.92,
  largeShapeExtentInLineHeights: 1.8,
});

type Box = readonly [number, number, number, number];
interface Word {
  id: number;
  lineId: number;
  index: number;
  text: string;
  start: number;
  end: number;
  box: Bounds;
  imageBox: Box;
}
interface Line {
  text: string;
  score: number;
  box: Bounds;
  words: Word[];
  unusableReason:
    | "inconsistent-ocr-text"
    | "degenerate-word-box"
    | "low-recognition-score"
    | undefined;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid OCR ${name}`);
  return value;
}
function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Invalid OCR ${name}`);
  return value;
}
function box(value: unknown, allowEmpty = false): Box {
  const values = array(value, "box");
  if (values.length !== 4) throw new Error("Invalid OCR box length");
  const result = values.map((value) => number(value, "box coordinate")) as [
    number,
    number,
    number,
    number,
  ];
  if (
    result[2] < result[0] ||
    result[3] < result[1] ||
    (!allowEmpty && (result[2] === result[0] || result[3] === result[1]))
  )
    throw new Error("Invalid OCR box extent");
  return result;
}
function inverse(value: Box, transform: InkTransform): Bounds {
  return {
    x: (value[0] - transform.translateX) / transform.scale,
    y: (value[1] - transform.translateY) / transform.scale,
    width: (value[2] - value[0]) / transform.scale,
    height: (value[3] - value[1]) / transform.scale,
  };
}
function parseLines(raw: unknown, transform: InkTransform): Line[] {
  if (typeof raw !== "object" || raw === null)
    throw new Error("Invalid OCR result");
  const result = raw as Record<string, unknown>;
  const texts = array(result.rec_texts, "rec_texts");
  const scores = array(result.rec_scores, "rec_scores");
  const boxes = array(result.rec_boxes, "rec_boxes");
  const words = array(result.text_word, "text_word");
  const wordBoxes = array(result.text_word_boxes, "text_word_boxes");
  if (
    [scores, boxes, words, wordBoxes].some(
      (value) => value.length !== texts.length,
    )
  )
    throw new Error("Inconsistent OCR line arrays");
  let wordId = 0;
  return texts.map((text, lineId) => {
    if (typeof text !== "string") throw new Error("Invalid OCR line text");
    const score = number(scores[lineId], "recognition score");
    if (score < 0 || score > 1)
      throw new Error("Invalid OCR recognition score");
    const tokens = array(words[lineId], "line words");
    const tokenBoxes = array(wordBoxes[lineId], "line word boxes");
    if (tokens.length !== tokenBoxes.length)
      throw new Error("Inconsistent OCR word arrays");
    let offset = 0;
    const lineWords = tokens.map((token, index): Word => {
      if (typeof token !== "string" || !token)
        throw new Error("Invalid OCR word text");
      const imageBox = box(tokenBoxes[index], true);
      const start = offset;
      offset += token.length;
      return {
        id: wordId++,
        lineId,
        index,
        text: token,
        start,
        end: offset,
        box: inverse(imageBox, transform),
        imageBox,
      };
    });
    return {
      text,
      score,
      box: inverse(box(boxes[lineId]), transform),
      words: lineWords,
      unusableReason:
        tokens.join("") !== text
          ? "inconsistent-ocr-text"
          : lineWords.some(
                (word) => word.box.width === 0 || word.box.height === 0,
              )
            ? "degenerate-word-box"
            : score < THRESHOLDS.minRecognitionScore
              ? "low-recognition-score"
              : undefined,
    };
  });
}

function expanded(bounds: Bounds, margin: number): Bounds {
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: bounds.width + 2 * margin,
    height: bounds.height + 2 * margin,
  };
}

/** Liang–Barsky clipping retains the length of each complete trajectory segment. */
function segmentInterval(
  x: number,
  y: number,
  dx: number,
  dy: number,
  bounds: Bounds,
): [number, number] | undefined {
  let low = 0;
  let high = 1;
  const edges = [
    [-dx, x - bounds.x],
    [dx, bounds.x + bounds.width - x],
    [-dy, y - bounds.y],
    [dy, bounds.y + bounds.height - y],
  ];
  for (const edge of edges) {
    const p = edge[0] ?? 0;
    const q = edge[1] ?? 0;
    if (p === 0) {
      if (q < 0) return;
    } else if (p < 0) low = Math.max(low, q / p);
    else high = Math.min(high, q / p);
    if (low > high) return;
  }
  return [low, high];
}

function pathCoverage(stroke: InkStroke, regions: readonly Bounds[]): number {
  let covered = 0;
  for (let index = 1; index < stroke.points.length; index++) {
    const a = stroke.points[index - 1];
    const b = stroke.points[index];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const intervals = regions
      .flatMap((region) => {
        const interval = segmentInterval(a.x, a.y, dx, dy, region);
        return interval ? [interval] : [];
      })
      .sort((a, b) => a[0] - b[0]);
    let end = 0;
    let fraction = 0;
    for (const [low, high] of intervals) {
      fraction += Math.max(0, high - Math.max(end, low));
      end = Math.max(end, high);
    }
    covered += Math.hypot(dx, dy) * fraction;
  }
  return covered;
}
function pathLength(stroke: InkStroke): number {
  return stroke.points.reduce((length, point, index) => {
    const previous = stroke.points[index - 1];
    return (
      length +
      (previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0)
    );
  }, 0);
}

export function associateInk(
  document: InkDocument,
  options: { raw: unknown; transform: InkTransform; ocr: OcrProvenance },
): InkAssociationReport {
  const { transform, ocr } = options;
  for (const value of [
    transform.scale,
    transform.translateX,
    transform.translateY,
  ])
    if (!Number.isFinite(value))
      throw new Error("Invalid OCR coordinate transform");
  if (transform.scale <= 0) throw new Error("Invalid OCR coordinate scale");
  if (
    !ocr.version ||
    !/^[a-f0-9]{64}$/.test(ocr.resultHash) ||
    !/^[a-f0-9]{64}$/.test(ocr.modelHash)
  )
    throw new Error("OCR provenance requires version and SHA-256 hashes");
  const lines = parseLines(options.raw, transform);
  const words = lines.flatMap((line) => line.words);
  const parents = words.map((word) => word.id);
  const find = (id: number): number => {
    let current = id;
    while (parents[current] !== current) current = parents[current] ?? current;
    return current;
  };
  const join = (a: number, b: number) => {
    parents[find(a)] = find(b);
  };
  const assignments: {
    stroke: InkStroke;
    words: Word[];
    evidence: WordEvidence[];
  }[] = [];
  const unusedStrokes: StrokeAssociation[] = [];
  const blocked = new Set<number>();
  for (const line of lines)
    if (line.unusableReason)
      for (const word of line.words) blocked.add(word.id);
  for (const stroke of document.strokes) {
    const length = pathLength(stroke);
    const evidence = words.map((word): WordEvidence => {
      const line = lines[word.lineId];
      const radius = stroke.penWidth / 2;
      const overlap = pathCoverage(stroke, [expanded(word.box, radius)]);
      const near = pathCoverage(stroke, [
        expanded(
          word.box,
          radius +
            (line?.box.height ?? 0) * THRESHOLDS.nearbyMarginInLineHeights,
        ),
      ]);
      return {
        lineId: word.lineId,
        wordIndex: word.index,
        overlapRatio: length ? overlap / length : 0,
        nearbyRatio: length ? near / length : 0,
      };
    });
    const touched = words.filter(
      (_, index) =>
        (evidence[index]?.nearbyRatio ?? 0) > THRESHOLDS.minTouchedNearbyRatio,
    );
    let selected = words.filter((word, index) => {
      const item = evidence[index];
      if (!item) return false;
      return (
        item.overlapRatio >= THRESHOLDS.minWordOverlapRatio ||
        item.nearbyRatio >= THRESHOLDS.minWordNearbyRatio ||
        item.overlapRatio * length >=
          Math.max(
            stroke.penWidth,
            (lines[word.lineId]?.box.height ?? 0) *
              THRESHOLDS.minOverlapLengthInLineHeights,
          )
      );
    });
    const reject = (reason: UnusedStrokeReason) => {
      for (const word of [...touched, ...selected]) blocked.add(word.id);
      unusedStrokes.push({
        strokeIndex: stroke.index,
        reason,
        evidence: evidence.filter((item) => item.nearbyRatio > 0),
      });
    };
    if (length === 0) {
      const point = stroke.points[0];
      if (point)
        for (const word of words) {
          const bounds = expanded(
            word.box,
            stroke.penWidth / 2 +
              (lines[word.lineId]?.box.height ?? 0) *
                THRESHOLDS.nearbyMarginInLineHeights,
          );
          if (
            point.x >= bounds.x &&
            point.x <= bounds.x + bounds.width &&
            point.y >= bounds.y &&
            point.y <= bounds.y + bounds.height
          )
            blocked.add(word.id);
        }
      reject("isolated-point");
      continue;
    }
    const competingLines = lines.flatMap((line, lineId) => {
      const regions = line.unusableReason
        ? [line.box]
        : line.words.map((word) =>
            expanded(
              word.box,
              stroke.penWidth / 2 +
                line.box.height * THRESHOLDS.nearbyMarginInLineHeights,
            ),
          );
      return pathCoverage(stroke, regions) / length >=
        THRESHOLDS.minCompetingLineRatio
        ? [lineId]
        : [];
    });
    if (competingLines.length > 1) {
      reject("competing-lines");
      continue;
    }
    const unusableLine = competingLines
      .map((id) => lines[id])
      .find((line) => line?.unusableReason);
    if (unusableLine?.unusableReason) {
      reject(unusableLine.unusableReason);
      continue;
    }
    if (!selected.length) {
      reject("outside-word-boxes");
      continue;
    }
    if (new Set(selected.map((word) => word.lineId)).size > 1) {
      reject("competing-lines");
      continue;
    }
    const first = selected[0];
    const last = selected.at(-1);
    if (!first || !last) continue;
    const line = lines[first.lineId];
    if (!line) continue;
    if (line.unusableReason) {
      reject(line.unusableReason);
      continue;
    }
    if (last.index - first.index + 1 !== selected.length) {
      reject("nonadjacent-words");
      continue;
    }
    const bounds = strokeBounds(stroke);
    const xRange = bounds.width - stroke.penWidth;
    const yRange = bounds.height - stroke.penWidth;
    const a = stroke.points[0];
    const b = stroke.points.at(-1);
    const straightness = a && b ? Math.hypot(a.x - b.x, a.y - b.y) / length : 0;
    if (
      Math.max(xRange, yRange) >
        line.box.height * THRESHOLDS.decorationLengthInLineHeights &&
      Math.min(xRange, yRange) <
        line.box.height * THRESHOLDS.decorationThicknessInLineHeights &&
      straightness > THRESHOLDS.decorationStraightness
    ) {
      reject("long-decoration");
      continue;
    }
    if (
      xRange > line.box.height * THRESHOLDS.largeShapeExtentInLineHeights &&
      yRange > line.box.height * THRESHOLDS.largeShapeExtentInLineHeights
    ) {
      reject("large-shape");
      continue;
    }
    const covered = pathCoverage(
      stroke,
      selected.map((word) =>
        expanded(
          word.box,
          stroke.penWidth / 2 +
            line.box.height * THRESHOLDS.nearbyMarginInLineHeights,
        ),
      ),
    );
    if (covered / length < THRESHOLDS.minCompleteNearbyRatio) {
      reject("partial-coverage");
      continue;
    }
    selected = line.words.slice(first.index, last.index + 1);
    for (const word of selected) join(first.id, word.id);
    assignments.push({
      stroke,
      words: selected,
      evidence: evidence.filter((item) => item.nearbyRatio > 0),
    });
  }
  const groups = new Map<number, Word[]>();
  for (const word of words) {
    const key = find(word.id);
    const group = groups.get(key) ?? [];
    group.push(word);
    groups.set(key, group);
  }
  const candidates: AssociatedInkCandidate[] = [];
  const unusedWords: InkAssociationReport["unusedWords"][number][] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const line = lines[first.lineId];
    if (!line) continue;
    const strokes = assignments.filter((assignment) =>
      assignment.words.some((word) => find(word.id) === find(first.id)),
    );
    const incomplete = group.some((word) => blocked.has(word.id));
    if (incomplete || !strokes.length) {
      for (const word of group)
        unusedWords.push({
          lineId: word.lineId,
          wordIndex: word.index,
          text: word.text,
          reason: line.unusableReason
            ? line.unusableReason
            : incomplete
              ? "incomplete-component"
              : "no-strokes",
        });
      for (const assignment of strokes)
        unusedStrokes.push({
          strokeIndex: assignment.stroke.index,
          reason: "incomplete-component",
          evidence: assignment.evidence,
        });
      continue;
    }
    const text = line.text.slice(first.start, last.end);
    const strokeIndices = strokes.map((assignment) => assignment.stroke.index);
    candidates.push({
      ...createInkCandidate(document, {
        text,
        strokeIndices,
        lineHeight: line.box.height,
        baseline: line.box.y + line.box.height,
      }),
      lineId: first.lineId,
      lineText: line.text,
      lineBounds: line.box,
      baselineMethod: "ocr-line-box-bottom",
      occurrence: { start: first.start, end: last.end },
      strokeRefs: strokeIndices.map((strokeIndex) => ({
        sourceHash: document.sourceHash,
        strokeIndex,
      })),
      recognition: {
        score: line.score,
        wordIndices: group.map((word) => word.index),
        imageBoxes: group.map((word) => word.imageBox),
      },
      associationEvidence: strokes.map((assignment) => ({
        strokeIndex: assignment.stroke.index,
        words: assignment.evidence,
      })),
    });
  }
  return {
    sourceHash: document.sourceHash,
    ocr,
    transform,
    thresholds: THRESHOLDS,
    thresholdStatus: "uncalibrated-development-defaults",
    lines: lines.map((line, lineId) => ({
      lineId,
      text: line.text,
      recognitionScore: line.score,
      bounds: line.box,
      unusedReason: line.unusableReason,
    })),
    candidates,
    unusedStrokes: unusedStrokes.sort((a, b) => a.strokeIndex - b.strokeIndex),
    unusedWords,
  };
}

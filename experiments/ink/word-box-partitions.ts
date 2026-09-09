type WordBox = [number, number, number, number];

export type OverlapFraction = 0.25 | 0.5 | 0.75;

export type WordBoxPartitionResult = {
  boxes: number[][];
  edits: {
    leftWordIndex: number;
    rightWordIndex: number;
    originalOverlap: [number, number];
    boundary: number;
  }[];
  rejectedReason:
    | "degenerate-word-box"
    | "unordered-word-boxes"
    | "invalid-partition"
    | null;
};

/** Diagnostic geometry only; indices and vertical bounds retain their OCR meaning. */
export function partitionWordBoxOverlaps(
  boxes: readonly (readonly number[])[],
  overlapFraction: OverlapFraction,
): WordBoxPartitionResult {
  if (![0.25, 0.5, 0.75].includes(overlapFraction))
    throw new Error("Overlap fraction must be 0.25, 0.5 or 0.75");
  const originals = boxes.map((box, index): WordBox => {
    if (box.length !== 4 || !Array.from(box).every(Number.isFinite))
      throw new Error(`Word box ${index} must have four finite coordinates`);
    const copy = [...box] as WordBox;
    if (copy[2] < copy[0] || copy[3] < copy[1])
      throw new Error(`Word box ${index} has a negative extent`);
    return copy;
  });
  const reject = (
    rejectedReason: NonNullable<WordBoxPartitionResult["rejectedReason"]>,
  ): WordBoxPartitionResult => ({
    boxes: originals,
    edits: [],
    rejectedReason,
  });
  if (
    originals.some(
      ([left, top, right, bottom]) => left === right || top === bottom,
    )
  )
    return reject("degenerate-word-box");
  for (let index = 1; index < originals.length; index++) {
    const previous = originals[index - 1];
    const current = originals[index];
    if (!previous || !current) throw new Error("Missing word box");
    if (
      current[0] < previous[0] ||
      current[2] < previous[2] ||
      current[0] / 2 + current[2] / 2 <= previous[0] / 2 + previous[2] / 2
    )
      return reject("unordered-word-boxes");
  }
  const result = originals.map((box): WordBox => [...box]);
  const edits: WordBoxPartitionResult["edits"] = [];
  for (let index = 1; index < originals.length; index++) {
    const previous = originals[index - 1];
    const current = originals[index];
    const leftResult = result[index - 1];
    const rightResult = result[index];
    if (!previous || !current || !leftResult || !rightResult)
      throw new Error("Missing word box");
    if (previous[2] <= current[0]) continue;
    const overlapWidth = previous[2] - current[0];
    const boundary = Number.isFinite(overlapWidth)
      ? current[0] + overlapWidth * overlapFraction
      : current[0] * (1 - overlapFraction) + previous[2] * overlapFraction;
    leftResult[2] = boundary;
    rightResult[0] = boundary;
    edits.push({
      leftWordIndex: index - 1,
      rightWordIndex: index,
      originalOverlap: [current[0], previous[2]],
      boundary,
    });
  }
  for (let index = 0; index < result.length; index++) {
    const box = result[index];
    const previous = result[index - 1];
    if (!box) throw new Error("Missing word box");
    if (
      !box.every(Number.isFinite) ||
      box[0] >= box[2] ||
      box[1] >= box[3] ||
      (previous && previous[2] > box[0])
    )
      return reject("invalid-partition");
  }
  return { boxes: result, edits, rejectedReason: null };
}

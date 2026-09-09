import { expect, test } from "bun:test";
import {
  type OverlapFraction,
  partitionWordBoxOverlaps,
} from "./word-box-partitions.ts";

test("fractions place a shared boundary inside the original overlap", () => {
  for (const [fraction, boundary] of [
    [0.25, 9],
    [0.5, 10],
    [0.75, 11],
  ] as const) {
    expect(
      partitionWordBoxOverlaps(
        [
          [0, 1, 12, 9],
          [8, 3, 20, 11],
        ],
        fraction,
      ),
    ).toEqual({
      boxes: [
        [0, 1, boundary, 9],
        [boundary, 3, 20, 11],
      ],
      edits: [
        {
          leftWordIndex: 0,
          rightWordIndex: 1,
          originalOverlap: [8, 12],
          boundary,
        },
      ],
      rejectedReason: null,
    });
  }
});

test("gaps, touching edges and vertical bounds remain unchanged", () => {
  const boxes = [
    [0, 1, 4, 9],
    [4, 3, 8, 10],
    [10, 7, 15, 17],
    [13, -2, 20, 6],
  ];
  const result = partitionWordBoxOverlaps(boxes, 0.5);
  expect(result.boxes).toEqual([
    [0, 1, 4, 9],
    [4, 3, 8, 10],
    [10, 7, 14, 17],
    [14, -2, 20, 6],
  ]);
  expect(result.edits).toEqual([
    {
      leftWordIndex: 2,
      rightWordIndex: 3,
      originalOverlap: [13, 15],
      boundary: 14,
    },
  ]);
  expect(partitionWordBoxOverlaps(boxes.slice(0, 3), 0.5).edits).toEqual([]);
  expect(partitionWordBoxOverlaps([], 0.5)).toEqual({
    boxes: [],
    edits: [],
    rejectedReason: null,
  });
  expect(partitionWordBoxOverlaps([[0, 1, 4, 9]], 0.5).boxes).toEqual([
    [0, 1, 4, 9],
  ]);
});

test("chain and triple overlaps use original boundaries for every edit", () => {
  const result = partitionWordBoxOverlaps(
    [
      [0, 0, 16, 10],
      [4, 1, 20, 11],
      [8, 2, 24, 12],
    ],
    0.25,
  );
  expect(result).toEqual({
    boxes: [
      [0, 0, 7, 10],
      [7, 1, 11, 11],
      [11, 2, 24, 12],
    ],
    edits: [
      {
        leftWordIndex: 0,
        rightWordIndex: 1,
        originalOverlap: [4, 16],
        boundary: 7,
      },
      {
        leftWordIndex: 1,
        rightWordIndex: 2,
        originalOverlap: [8, 20],
        boundary: 11,
      },
    ],
    rejectedReason: null,
  });
});

test("unordered, nested and identical horizontal boxes reject the entire line", () => {
  for (const boxes of [
    [
      [0, 0, 10, 10],
      [4, 0, 12, 10],
      [3, 0, 15, 10],
    ],
    [
      [0, 0, 10, 10],
      [4, 0, 8, 10],
    ],
    [
      [4, 0, 8, 10],
      [0, 0, 10, 10],
    ],
    [
      [0, 0, 10, 10],
      [0, 0, 10, 10],
    ],
    [
      [0, 0, 10, 10],
      [0, 2, 10, 12],
    ],
  ]) {
    expect(partitionWordBoxOverlaps(boxes, 0.5)).toEqual({
      boxes,
      edits: [],
      rejectedReason: "unordered-word-boxes",
    });
  }
});

test("zero width or height anywhere rejects the whole line", () => {
  for (const last of [
    [20, 0, 20, 10],
    [20, 2, 30, 2],
  ]) {
    const boxes = [[0, 0, 10, 10], [8, 0, 18, 10], last];
    expect(partitionWordBoxOverlaps(boxes, 0.5)).toEqual({
      boxes,
      edits: [],
      rejectedReason: "degenerate-word-box",
    });
  }
});

test("coincident cuts roll back instead of emitting a degenerate middle box", () => {
  const boxes = [
    [0, 0, 10, 10],
    [5, 0, 10, 10],
    [5, 0, 15, 10],
  ];
  for (const fraction of [0.25, 0.5, 0.75] as const)
    expect(partitionWordBoxOverlaps(boxes, fraction)).toEqual({
      boxes,
      edits: [],
      rejectedReason: "invalid-partition",
    });
});

test("source arrays are immutable and no output box aliases an input", () => {
  for (const values of [
    [
      [0, 0, 10, 10],
      [8, 0, 18, 10],
    ],
    [
      [0, 0, 10, 10],
      [10, 0, 18, 10],
    ],
    [
      [0, 0, 10, 10],
      [8, 0, 8, 10],
    ],
    [
      [0, 0, 10, 10],
      [4, 0, 8, 10],
    ],
    [
      [0, 0, 10, 10],
      [5, 0, 10, 10],
      [5, 0, 15, 10],
    ],
  ]) {
    const before = JSON.stringify(values);
    const boxes = Object.freeze(values.map((box) => Object.freeze(box)));
    const result = partitionWordBoxOverlaps(boxes, 0.5);
    expect(JSON.stringify(boxes)).toBe(before);
    expect(result.boxes).not.toBe(boxes);
    result.boxes.forEach((box, index) => {
      expect(box).not.toBe(boxes[index]);
    });
  }
});

test("partitioning commutes with positive scaling and translation", () => {
  const boxes = [
    [0, 1, 16, 11],
    [4, 3, 20, 13],
    [8, 5, 24, 15],
    [30, 7, 40, 17],
  ];
  for (const fraction of [0.25, 0.5, 0.75] as const) {
    const original = partitionWordBoxOverlaps(boxes, fraction);
    for (const scale of [0.25, 2, 7]) {
      const mapX = (x: number) => x * scale - 100;
      const transform = (box: readonly number[]) =>
        box.map(
          (value, index) => value * scale + (index % 2 === 0 ? -100 : 37),
        );
      const transformed = partitionWordBoxOverlaps(
        boxes.map(transform),
        fraction,
      );
      expect(transformed.boxes).toEqual(original.boxes.map(transform));
      expect(transformed.edits).toEqual(
        original.edits.map((edit): (typeof original.edits)[number] => ({
          ...edit,
          originalOverlap: [
            mapX(edit.originalOverlap[0]),
            mapX(edit.originalOverlap[1]),
          ],
          boundary: mapX(edit.boundary),
        })),
      );
      expect(transformed.rejectedReason).toBeNull();
    }
  }
});

test("invalid inputs throw before any geometric rejection", () => {
  for (const invalid of [
    [],
    [0, 0, 1],
    [0, 0, 1, 1, 2],
    [0, 0, Number.NaN, 1],
    [0, 0, 1, Number.POSITIVE_INFINITY],
    new Array<number>(4),
  ])
    expect(() =>
      partitionWordBoxOverlaps([[0, 0, 0, 0], invalid], 0.5),
    ).toThrow("four finite coordinates");
  for (const invalid of [
    [2, 0, 1, 1],
    [0, 2, 1, 1],
  ])
    expect(() =>
      partitionWordBoxOverlaps([[0, 0, 0, 0], invalid], 0.5),
    ).toThrow("negative extent");
  for (const fraction of [0, 1, 0.1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() =>
      partitionWordBoxOverlaps([], fraction as OverlapFraction),
    ).toThrow("Overlap fraction");
});

test("finite extreme coordinates do not overflow the overlap calculation", () => {
  const result = partitionWordBoxOverlaps(
    [
      [-1.5e308, 0, 1e308, 10],
      [-1e308, 0, 1.5e308, 10],
    ],
    0.5,
  );
  expect(result.rejectedReason).toBeNull();
  expect(result.edits[0]?.boundary).toBe(0);
  expect(result.boxes).toEqual([
    [-1.5e308, 0, 0, 10],
    [0, 0, 1.5e308, 10],
  ]);
});

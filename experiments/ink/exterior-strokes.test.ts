import { expect, test } from "bun:test";
import { associateInk, parseInkJson } from "@handnote/ink";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";

function experiment(
  extra: number[][][],
  options: { otherWordBox?: number[]; wordRight?: number } = {},
) {
  const document = parseInkJson(
    JSON.stringify(
      [
        [
          [5, 5],
          [5, 15],
        ],
        ...extra,
      ].map((points) => ({
        brush_style: "pen",
        pen_width: 1,
        pen_color: 0,
        points: points.map(([x, y], time) => ({ x, y, time })),
      })),
    ),
  );
  const association = associateInk(document, {
    raw: {
      rec_texts: options.otherWordBox ? ["人", "山"] : ["人"],
      rec_scores: options.otherWordBox ? [0.95, 0.95] : [0.95],
      rec_boxes: [
        [0, 0, 20, 20],
        ...(options.otherWordBox ? [options.otherWordBox] : []),
      ],
      text_word: options.otherWordBox ? [["人"], ["山"]] : [["人"]],
      text_word_boxes: [
        [[0, 0, options.wordRight ?? 10, 20]],
        ...(options.otherWordBox ? [[options.otherWordBox]] : []),
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

test("separated multi-line exterior stroke can be excluded from metrics while remaining unused", () => {
  const { document, association } = experiment([
    [
      [18, -30],
      [16, 10],
      [18, 60],
    ],
  ]);
  expect(association.lines[0]?.metrics.status).toBe("unavailable");
  expect(association.candidates.map((item) => item.strokeIndices)).toEqual([
    [0],
  ]);
  const before = JSON.stringify({ document, association });
  const result = reassessExteriorStrokes(document, association);
  expect(result.association.lines[0]?.metrics.status).toBe("available");
  expect(result.proposals[0]?.ignoredStrokeIndices).toEqual([1]);
  expect(result.association.unusedStrokes).toEqual(association.unusedStrokes);
  expect(result.association.candidates).toEqual(association.candidates);
  expect(JSON.stringify({ document, association })).toBe(before);
});

test("a different line's partial coverage cannot change metrics for a separated complete body", () => {
  const path = [
    [18, -30],
    [16, 10],
    [18, 60],
  ];
  const outside = experiment([path], { otherWordBox: [50, -20, 60, -10] });
  const partial = experiment([path], { otherWordBox: [14, -20, 20, -10] });
  expect(outside.document.sourceHash).toBe(partial.document.sourceHash);
  expect(outside.association.unusedStrokes[0]?.reason).toBe(
    "outside-word-boxes",
  );
  expect(partial.association.unusedStrokes[0]?.reason).toBe("partial-coverage");
  expect(
    partial.association.unusedStrokes[0]?.evidence.every(
      (item) => item.lineId !== 0,
    ),
  ).toBe(true);
  expect(partial.association.candidates).toEqual(
    outside.association.candidates,
  );
  const before = JSON.stringify(partial);
  const baseline = reassessExteriorStrokes(
    outside.document,
    outside.association,
  );
  const revised = reassessExteriorStrokes(
    partial.document,
    partial.association,
  );
  expect(baseline.association.lines[0]?.metrics.status).toBe("available");
  const beforeMetrics = baseline.association.lines[0]?.metrics;
  if (!beforeMetrics) throw new Error("Missing baseline metrics");
  expect(revised.association.lines[0]?.metrics).toEqual(beforeMetrics);
  expect(revised.association.candidates).toEqual(
    partial.association.candidates,
  );
  expect(revised.association.unusedStrokes).toEqual(
    partial.association.unusedStrokes,
  );
  expect(JSON.stringify(partial)).toBe(before);
});

test("even small nearby evidence for the current line keeps an exterior stroke unresolved", () => {
  const { document, association } = experiment(
    [
      [
        [18, -300],
        [16, 10],
        [18, 600],
      ],
    ],
    { wordRight: 14.4 },
  );
  const unused = association.unusedStrokes[0];
  expect(unused?.reason).toBe("outside-word-boxes");
  expect(association.unusedWords).toHaveLength(0);
  expect(
    unused?.evidence.some(
      (item) =>
        item.lineId === 0 &&
        item.nearbyRatio > 0 &&
        item.nearbyRatio < association.thresholds.minTouchedNearbyRatio,
    ),
  ).toBe(true);
  const revised = reassessExteriorStrokes(document, association);
  expect(revised.association.lines[0]?.metrics.status).toBe("unavailable");
  expect(revised.proposals[0]?.accepted).toBe(false);
});

test("short marks, spanning strokes that enter the body, and isolated points remain unresolved", () => {
  for (const path of [
    [
      [18, 2],
      [18, 18],
    ],
    [
      [18, -30],
      [5, 10],
      [18, 60],
    ],
    [[18, 10]],
  ]) {
    const { document, association } = experiment([path]);
    const result = reassessExteriorStrokes(document, association);
    expect(result.association.lines[0]?.metrics.status).toBe("unavailable");
    expect(result.proposals.every((item) => !item.accepted)).toBe(true);
  }
  const { document, association } = experiment([
    [
      [18, -30],
      [16, 10],
      [18, 60],
    ],
    [[12, 2]],
  ]);
  expect(
    reassessExteriorStrokes(document, association).association.lines[0]?.metrics
      .status,
  ).toBe("unavailable");
});

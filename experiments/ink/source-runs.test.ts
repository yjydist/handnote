import { expect, test } from "bun:test";
import type { InkBinding } from "@handnote/app/ink-matching";
import type { AssociatedInkCandidate } from "@handnote/ink";
import { prepareDocument } from "@handnote/renderer";
import { groupSourceRuns } from "./source-runs.ts";

function candidate(
  id: string,
  start: number,
  overrides: Partial<AssociatedInkCandidate> = {},
): AssociatedInkCandidate {
  const strokeIndices = [start * 3, start * 3 + 1, start * 3 + 2];
  return {
    id,
    sourceHash: "source",
    text: "甲",
    strokeIndices,
    bounds: { x: start * 30, y: 0, width: 20, height: 20 },
    lineHeight: 20,
    baseline: 20,
    status: "pending-human-review",
    lineId: 0,
    lineText: "甲乙丙",
    lineBounds: { x: 0, y: 0, width: 80, height: 20 },
    baselineMethod: "ocr-line-box-bottom",
    occurrence: { start, end: start + 1 },
    strokeRefs: strokeIndices.map((strokeIndex) => ({
      sourceHash: "source",
      strokeIndex,
    })),
    recognition: { score: 1, wordIndices: [start], imageBoxes: [] },
    associationEvidence: strokeIndices.map((strokeIndex) => ({
      strokeIndex,
      words: [],
    })),
    ...overrides,
  };
}

function binding(
  source: AssociatedInkCandidate,
  start: number,
  target: Partial<InkBinding["target"]> = {},
): InkBinding {
  return {
    sourceId: source.id,
    targetId: `text-0:${start}-${start + 1}`,
    text: source.text,
    target: {
      documentHash: "document",
      rangeId: "text-0",
      start,
      end: start + 1,
      ...target,
    },
  };
}

test("groups contiguous source and target without changing bindings or stroke evidence", () => {
  const candidates = [candidate("a", 0), candidate("b", 1), candidate("c", 2)];
  const bindings = candidates.map((source, index) => binding(source, index));
  const runs = groupSourceRuns(bindings, candidates);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.bindings).toHaveLength(3);
  expect(
    runs[0]?.candidates.flatMap((candidate) => candidate.strokeIndices),
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [index, source] of candidates.entries()) {
    const original = bindings[index];
    if (!original) throw new Error("Missing test binding");
    expect(runs[0]?.bindings[index]).toBe(original);
    expect(runs[0]?.candidates[index]).toBe(source);
  }
});

for (const mode of ["whole-run", "overlapping-images"] as const) {
  test(`${mode}: empty bindings produce no runs and missing sources fail explicitly`, () => {
    expect(groupSourceRuns([], [], { mode })).toEqual([]);
    expect(() =>
      groupSourceRuns([binding(candidate("missing", 0), 0)], [], { mode }),
    ).toThrow("Unknown ink source in binding: missing");
  });
}

for (const boundary of [
  "target-gap",
  "target-overlap",
  "document",
  "range",
  "source-gap",
  "source-overlap",
  "source-hash",
  "source-line",
] as const) {
  test(`does not group across ${boundary}`, () => {
    const first = candidate("a", 0);
    const second = candidate("b", 1, {
      bounds: { x: 10, y: 0, width: 20, height: 20 },
      ...(boundary === "source-gap" && { occurrence: { start: 2, end: 3 } }),
      ...(boundary === "source-overlap" && {
        occurrence: { start: 0, end: 1 },
      }),
      ...(boundary === "source-hash" && { sourceHash: "other-source" }),
      ...(boundary === "source-line" && { lineId: 1 }),
    });
    const bindings = [
      binding(first, 0),
      binding(second, 1, {
        ...(boundary === "target-gap" && { start: 2, end: 3 }),
        ...(boundary === "target-overlap" && { start: 0, end: 1 }),
        ...(boundary === "document" && { documentHash: "other-document" }),
        ...(boundary === "range" && { rangeId: "text-1" }),
      }),
    ];
    for (const mode of ["whole-run", "overlapping-images"] as const) {
      expect(
        groupSourceRuns(bindings, [first, second], { mode }).map(
          (run) => run.bindings.length,
        ),
      ).toEqual([1, 1]);
    }
  });
}

test("keeps target input order and does not reconstruct reordered source text", () => {
  const candidates = [candidate("a", 0), candidate("b", 1), candidate("c", 2)];
  const [first, second, third] = candidates;
  if (!first || !second || !third) throw new Error("Missing test candidate");
  const bindings = [binding(third, 0), binding(first, 1), binding(second, 2)];
  const runs = groupSourceRuns(bindings, candidates);
  expect(
    runs.map((run) => run.bindings.map((binding) => binding.sourceId)),
  ).toEqual([["c"], ["a", "b"]]);
  expect(
    groupSourceRuns([binding(second, 2), binding(first, 1)], candidates).map(
      (run) => run.bindings.length,
    ),
  ).toEqual([1, 1]);
});

test("overlapping images retain original evidence and split at positive source gaps", () => {
  const candidates = [0, 15, 30, 60, 75].map((x, index) =>
    candidate(`source-${index}`, index, {
      bounds: { x, y: 0, width: 20, height: 20 },
    }),
  );
  const bindings = candidates.map((source, index) => binding(source, index));
  const runs = groupSourceRuns(bindings, candidates, {
    mode: "overlapping-images",
  });
  expect(runs.map((run) => run.bindings.length)).toEqual([3, 2]);
  for (const [index, source] of candidates.entries()) {
    const original = bindings[index];
    if (!original) throw new Error("Missing test binding");
    expect(runs.flatMap((run) => run.candidates)[index]).toBe(source);
    expect(runs.flatMap((run) => run.bindings)[index]).toBe(original);
  }
  expect(groupSourceRuns(bindings, candidates, { mode: "whole-run" })).toEqual(
    groupSourceRuns(bindings, candidates),
  );
  expect(groupSourceRuns(bindings, candidates)).toHaveLength(1);
});

test("overlapping images use the rounded PNG width for fractional source bounds", () => {
  const first = candidate("a", 0, {
    bounds: { x: 0.25, y: 0, width: 20.1, height: 20 },
  });
  for (const [x, expectedLengths] of [
    [20.8, [2]],
    [21.25, [1, 1]],
  ] as const) {
    const second = candidate("b", 1, {
      bounds: { x, y: 0, width: 20, height: 20 },
    });
    expect(
      groupSourceRuns(
        [binding(first, 0), binding(second, 1)],
        [first, second],
        { mode: "overlapping-images" },
      ).map((run) => run.bindings.length),
    ).toEqual([...expectedLengths]);
  }
});

test("overlapping images include earlier long tails in the current run envelope", () => {
  const candidates = [
    candidate("a", 0, { bounds: { x: 0, y: 0, width: 80, height: 20 } }),
    candidate("b", 1, { bounds: { x: 20, y: 0, width: 10, height: 20 } }),
    candidate("c", 2, { bounds: { x: 60, y: 0, width: 10, height: 20 } }),
    candidate("d", 3, { bounds: { x: 90, y: 0, width: 10, height: 20 } }),
  ];
  expect(
    groupSourceRuns(
      candidates.map((source, index) => binding(source, index)),
      candidates,
      { mode: "overlapping-images" },
    ).map((run) => run.candidates.map((source) => source.id)),
  ).toEqual([["a", "b", "c"], ["d"]]);
});

test("left-reaching images merge every preceding overlapping run in their contiguous chain", () => {
  for (const positions of [
    [0, 40, 10],
    [0, 40, 80, 10],
  ]) {
    const candidates = positions.map((x, index) =>
      candidate(`source-${index}`, index, {
        bounds: { x, y: 0, width: 20, height: 20 },
      }),
    );
    const bindings = candidates.map((source, index) => binding(source, index));
    const runs = groupSourceRuns(bindings, candidates, {
      mode: "overlapping-images",
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.bindings).toEqual(bindings);
    expect(runs[0]?.candidates).toEqual(candidates);
  }
});

for (const boundary of [
  "target-gap",
  "target-overlap",
  "document",
  "range",
  "source-gap",
  "source-overlap",
  "source-hash",
  "source-line",
] as const) {
  test(`left-reaching images cannot merge backward across ${boundary}`, () => {
    const first = candidate("a", 1, {
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      ...(boundary === "source-gap" && { occurrence: { start: 0, end: 1 } }),
      ...(boundary === "source-overlap" && {
        occurrence: { start: 2, end: 3 },
      }),
      ...(boundary === "source-hash" && { sourceHash: "other-source" }),
      ...(boundary === "source-line" && { lineId: 1 }),
    });
    const second = candidate("b", 2, {
      bounds: { x: 40, y: 0, width: 20, height: 20 },
    });
    const third = candidate("c", 3, {
      bounds: { x: 10, y: 0, width: 20, height: 20 },
    });
    const bindings = [
      binding(first, 1, {
        ...(boundary === "target-gap" && { start: 0, end: 1 }),
        ...(boundary === "target-overlap" && { start: 2, end: 3 }),
        ...(boundary === "document" && { documentHash: "other-document" }),
        ...(boundary === "range" && { rangeId: "text-1" }),
      }),
      binding(second, 2),
      binding(third, 3),
    ];
    expect(
      groupSourceRuns(bindings, [first, second, third], {
        mode: "overlapping-images",
      }).map((run) => run.candidates.map((source) => source.id)),
    ).toEqual([["a"], ["b", "c"]]);
  });
}

test("prepared formatting boundaries remain separate even for adjacent source text", async () => {
  const document = await prepareDocument("甲**乙**丙");
  const candidates = [candidate("a", 0), candidate("b", 1), candidate("c", 2)];
  expect(document.textRanges).toHaveLength(3);
  const bindings = document.textRanges.map((range, index) => {
    const source = candidates[index];
    if (!source) throw new Error("Missing test candidate");
    return binding(source, 0, {
      documentHash: document.documentHash,
      rangeId: range.rangeId,
    });
  });
  expect(
    groupSourceRuns(bindings, candidates).map((run) => run.bindings.length),
  ).toEqual([1, 1, 1]);
});

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { matchInkSources } from "@handnote/app/ink-matching";
import { associateInk, parseInkJson, renderInkSvg } from "@handnote/ink";
import { prepareDocument } from "@handnote/renderer";
import development from "./development.json";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";
import raw from "./fixtures/ocr-page-2-baseline.json";
import mapped from "./fixtures/ocr-page-2-mapped.json";
import { hash } from "./ocr-evidence.ts";
import { groupSourceRuns } from "./source-runs.ts";

test("fixed ending passage reuses its complete original body strokes after boundary edits, with exterior brace unused", async () => {
  const page = development.pages[0];
  if (!page) throw new Error("Missing development page");
  const source = parseInkJson(
    await readFile(new URL(`../../${page.source}`, import.meta.url)),
  );
  expect(source.sourceHash).toBe(page.sourceHash);
  const rendering = renderInkSvg(source, { background: "white", padding: 10 });
  const original = associateInk(source, {
    raw,
    transform: rendering.transform,
    ocr: {
      version: "paddleocr-3.3.1",
      resultHash: hash(JSON.stringify(raw)),
      modelHash: "a".repeat(64),
    },
  });
  const revised = reassessExteriorStrokes(source, original);
  expect(original.lines[5]?.metrics.status).toBe("unavailable");
  expect(revised.association.lines[5]?.metrics.status).toBe("available");
  expect(
    revised.proposals.find((proposal) => proposal.lineId === 5)
      ?.ignoredStrokeIndices,
  ).toEqual([800]);
  const prepared = await prepareDocument(page.markdown);
  const sources = revised.association.candidates.map((candidate) => ({
    ...candidate,
    lineId: String(candidate.lineId),
  }));
  const lines = revised.association.lines.map((line) => ({
    ...line,
    lineId: String(line.lineId),
  }));
  expect(
    matchInkSources(prepared, source.sourceHash, sources, lines).bindings,
  ).toHaveLength(0);
  const report = matchInkSources(prepared, source.sourceHash, sources, lines, {
    context: "boundary-edits",
  });
  expect(report.bindings.map((binding) => binding.text).join("")).toBe(
    "结尾方式：悲剧式、喜剧式、首尾呼应式",
  );
  const indices = report.bindings.flatMap(
    (binding) =>
      sources.find((source) => source.id === binding.sourceId)?.strokeIndices ??
      [],
  );
  expect(indices).toEqual(
    Array.from({ length: 85 }, (_, index) => index + 211),
  );
  expect(report.fontRanges.map((range) => range.text)).toEqual([
    "情节安排",
    "。",
  ]);
  expect(revised.association.unusedStrokes).toEqual(original.unusedStrokes);
  const runs = groupSourceRuns(report.bindings, revised.association.candidates);
  expect(runs).toHaveLength(1);
  const run = runs[0];
  if (!run) throw new Error("Missing complete source passage");
  const combined = renderInkSvg(source, {
    strokeIndices: run.candidates.flatMap(
      (candidate) => candidate.strokeIndices,
    ),
  });
  expect(combined.strokeRefs.map((ref) => ref.strokeIndex)).toEqual(indices);
  expect(combined.bounds.width).toBeCloseTo(540.08, 2);
  const separateWidth = run.candidates.reduce(
    (width, candidate) => width + candidate.bounds.width,
    0,
  );
  expect(combined.bounds.width - separateWidth).toBeCloseTo(71.795, 3);
});

test("captured crop mapping preserves complete body metrics despite brace evidence on another line", async () => {
  const page = development.pages[0];
  if (!page) throw new Error("Missing development page");
  const document = parseInkJson(
    await readFile(new URL(`../../${page.source}`, import.meta.url)),
  );
  expect(document.sourceHash).toBe(mapped.provenance.sourceHash);
  expect(mapped.rec_texts).toEqual(raw.rec_texts);
  expect(mapped.rec_scores).toEqual(raw.rec_scores);
  const { transform } = renderInkSvg(document, {
    background: "white",
    padding: 10,
  });
  const associate = (input: unknown) =>
    associateInk(document, {
      raw: input,
      transform,
      ocr: {
        version: "paddleocr-3.3.1",
        resultHash: hash(JSON.stringify(input)),
        modelHash: "a".repeat(64),
      },
    });
  const original = associate(raw),
    projected = associate(mapped);
  const brace = projected.unusedStrokes.find(
    (stroke) => stroke.strokeIndex === 800,
  );
  expect(brace?.reason).toBe("partial-coverage");
  expect(
    brace?.evidence.some((item) => item.lineId === 3 && item.overlapRatio > 0),
  ).toBe(true);
  expect(brace?.evidence.every((item) => item.lineId !== 5)).toBe(true);
  const baseline = reassessExteriorStrokes(document, original);
  const revised = reassessExteriorStrokes(document, projected);
  expect(projected.lines[5]?.metrics.status).toBe("unavailable");
  const beforeMetrics = baseline.association.lines[5]?.metrics;
  if (!beforeMetrics) throw new Error("Missing baseline metrics");
  expect(revised.association.lines[5]?.metrics).toEqual(beforeMetrics);
  const metrics = revised.association.lines[5]?.metrics;
  if (metrics?.status !== "available")
    throw new Error("Expected complete body metrics");
  expect(metrics.strokeIndices).toEqual(
    Array.from({ length: 87 }, (_, i) => 209 + i),
  );
  expect(
    revised.proposals.find((item) => item.lineId === 5)?.ignoredStrokeIndices,
  ).toEqual([800]);
  const { candidates, unusedStrokes, unusedWords, thresholds } =
    revised.association;
  expect({ candidates, unusedStrokes, unusedWords, thresholds }).toEqual({
    candidates: projected.candidates,
    unusedStrokes: projected.unusedStrokes,
    unusedWords: projected.unusedWords,
    thresholds: projected.thresholds,
  });
  const prepared = await prepareDocument(page.markdown);
  const bindings = matchInkSources(
    prepared,
    document.sourceHash,
    candidates.map((candidate) => ({
      ...candidate,
      lineId: String(candidate.lineId),
    })),
    revised.association.lines.map((line) => ({
      ...line,
      lineId: String(line.lineId),
    })),
    { context: "boundary-edits" },
  ).bindings;
  expect(bindings.map((binding) => binding.text).join("")).toBe(
    "结尾方式：悲剧式、喜剧式、首尾呼应式",
  );
  expect(
    bindings.flatMap(
      (binding) =>
        candidates.find((candidate) => candidate.id === binding.sourceId)
          ?.strokeIndices ?? [],
    ),
  ).toEqual(Array.from({ length: 85 }, (_, i) => 211 + i));
});

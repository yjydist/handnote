import { expect, test } from "bun:test";
import {
  createInkFragment,
  inkAssetJson,
  parseInkJson,
  renderInkAsset,
} from "../src/index.ts";

const raw = JSON.stringify([
  {
    brush_style: "pen",
    pen_width: 4,
    pen_color: 255,
    points: [
      { x: -10, y: 20, time: 2 },
      { x: 30, y: 40, time: 1 },
    ],
  },
  {
    brush_style: "pen",
    pen_width: 2,
    pen_color: 255,
    points: [{ x: 50, y: 60, time: 0 }],
  },
]);
const source = parseInkJson(raw);
const display = { kind: "text" as const, referenceHeight: 24 };

test("fragments preserve complete source strokes and regenerate without transcription", () => {
  const before = JSON.stringify(source);
  const asset = createInkFragment(source, {
    strokeIndices: [1, 0],
    presentation: display,
  });
  expect(asset.strokeIndices).toEqual([0, 1]);
  expect(asset.sourceBounds).toEqual({ x: -12, y: 18, width: 63, height: 43 });
  const svg = renderInkAsset(source, JSON.parse(inkAssetJson(asset)));
  expect(svg).toContain('points="-10,20 30,40"');
  expect(svg).toContain('<circle cx="50" cy="60" r="1"');
  expect(svg).toBe(renderInkAsset(source, asset));
  expect(asset.id).toBe(
    createInkFragment(source, { strokeIndices: [0, 1], presentation: display })
      .id,
  );
  expect(JSON.stringify(source)).toBe(before);
  expect(Object.isFrozen(asset.strokeIndices)).toBe(true);
});

test("asset identity includes presentation while source identity remains byte-level", () => {
  const asset = createInkFragment(source, {
    strokeIndices: [0],
    presentation: display,
  });
  expect(
    createInkFragment(source, {
      strokeIndices: [0],
      presentation: { ...display, transcription: "标题" },
    }).id,
  ).not.toBe(asset.id);
  expect(() => renderInkAsset(parseInkJson(`${raw}\n`), asset)).toThrow(
    "mismatch",
  );
  for (const changed of [
    { ...asset, width: 999 },
    { ...asset, id: "bad" },
    { ...asset, extra: true },
    { ...asset, strokeIndices: [1] },
  ])
    expect(() => renderInkAsset(source, changed)).toThrow("mismatch");
});

test("selection rejects empty, duplicate, partial or nonexistent stroke identifiers", () => {
  for (const strokeIndices of [[], [0, 0], [-1], [2], [0.5]])
    expect(() =>
      createInkFragment(source, { strokeIndices, presentation: display }),
    ).toThrow();
  for (const referenceHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() =>
      createInkFragment(source, {
        strokeIndices: [0],
        presentation: { ...display, referenceHeight },
      }),
    ).toThrow();
});

import { expect, test } from "bun:test";
import {
  composeInkAssets,
  createInkFragment,
  type InkAsset,
  inkAssetJson,
  parseInkJson,
  renderInkAsset,
} from "../../src/ink/index.ts";

test("rotation and nested composition bound actual points including scaled pen radius", () => {
  const a = createInkFragment(source, {
    strokeIndices: [0],
    presentation: display,
  });
  const b = createInkFragment(source, {
    strokeIndices: [1],
    presentation: display,
  });
  const library = new Map<string, InkAsset>([
    [a.id, a],
    [b.id, b],
  ]);
  const c = composeInkAssets(
    source,
    {
      parts: [{ assetId: a.id, rotation: 90, scale: 2, x: -7, y: 13 }],
      presentation: display,
    },
    library,
  );
  expect(c.bounds.x).toBeCloseTo(-55);
  expect(c.bounds.y).toBeCloseTo(13);
  expect(c.bounds.width).toBeCloseTo(48);
  expect(c.bounds.height).toBeCloseTo(88);
  library.set(c.id, c);
  const d = composeInkAssets(
    source,
    {
      parts: [
        { assetId: c.id, rotation: -90, scale: 0.5, x: 10, y: -5 },
        { assetId: b.id, rotation: 45, scale: 3, x: 100, y: 50 },
      ],
      presentation: display,
    },
    library,
  );
  const svg = renderInkAsset(source, d, library);
  expect(svg).toContain('points="-10,20 30,40"');
  expect(svg).toContain('<circle cx="50" cy="60" r="1"');
  expect((svg.match(/<polyline/g) ?? []).length).toBe(1);
  expect(d.strokeIndices).toEqual([0, 1]);
  expect(renderInkAsset(source, JSON.parse(inkAssetJson(d)), library)).toBe(
    svg,
  );
  expect(d.id).not.toBe(c.id);
  expect(() =>
    renderInkAsset(
      source,
      { ...d, parts: d.parts.map((p) => ({ ...p, x: p.x + 1 })) },
      library,
    ),
  ).toThrow("mismatch");
});

test("compositions reject repeated strokes, stale dependencies and invalid transforms", () => {
  const a = createInkFragment(source, {
    strokeIndices: [0],
    presentation: display,
  });
  const part = { assetId: a.id, rotation: 0, scale: 1, x: 0, y: 0 };
  const library = new Map<string, InkAsset>([[a.id, a]]);
  for (const parts of [
    [],
    [part, part],
    [{ ...part, scale: 0 }],
    [{ ...part, rotation: Infinity }],
    [{ ...part, x: NaN }],
    [{ ...part, scale: 1e308 }],
  ])
    expect(() =>
      composeInkAssets(source, { parts, presentation: display }, library),
    ).toThrow();
  expect(() =>
    composeInkAssets(
      parseInkJson(`${raw}\n`),
      { parts: [part], presentation: display },
      library,
    ),
  ).toThrow("source");
  expect(() =>
    composeInkAssets(
      source,
      { parts: [part], presentation: display },
      new Map(),
    ),
  ).toThrow("dependency");
  const c = composeInkAssets(
    source,
    { parts: [part], presentation: display },
    library,
  );
  const cycle = { ...c, parts: [{ ...part, assetId: c.id }] };
  library.set(cycle.id, cycle);
  expect(() => renderInkAsset(source, cycle, library)).toThrow("cyclic");
});

test("a valid neighbouring stroke cannot conceal an underflowed nested stroke", () => {
  const a = createInkFragment(source, {
    strokeIndices: [0],
    presentation: display,
  });
  const b = createInkFragment(source, {
    strokeIndices: [1],
    presentation: display,
  });
  const library = new Map<string, InkAsset>([
    [a.id, a],
    [b.id, b],
  ]);
  for (const scale of [1e-200, 1e-50, 1e40])
    expect(() =>
      composeInkAssets(
        source,
        {
          parts: [{ assetId: a.id, rotation: 0, scale, x: 0, y: 0 }],
          presentation: display,
        },
        library,
      ),
    ).toThrow("stroke scale");
  const tiny = composeInkAssets(
    source,
    {
      parts: [{ assetId: a.id, rotation: 0, scale: 0.01, x: 0, y: 0 }],
      presentation: display,
    },
    library,
  );
  library.set(tiny.id, tiny);
  expect(() =>
    composeInkAssets(
      source,
      {
        parts: [
          { assetId: tiny.id, rotation: 0, scale: 0.01, x: 0, y: 0 },
          { assetId: b.id, rotation: 0, scale: 1, x: 0, y: 0 },
        ],
        presentation: display,
      },
      library,
    ),
  ).toThrow("stroke scale");
});

test("rotation roundoff does not reject the permitted scale boundaries", () => {
  const asset = createInkFragment(source, {
    strokeIndices: [0],
    presentation: display,
  });
  for (const scale of [0.01, 100])
    for (const rotation of [-171, 37, 94])
      expect(() =>
        composeInkAssets(
          source,
          {
            parts: [{ assetId: asset.id, rotation, scale, x: 0, y: 0 }],
            presentation: display,
          },
          new Map([[asset.id, asset]]),
        ),
      ).not.toThrow();
});

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

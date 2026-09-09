import { describe, expect, test } from "bun:test";
import {
  createInkCandidate,
  measureCompleteInkLine,
  parseInkJson,
  renderInkSvg,
  strokeBounds,
} from "../src/index.ts";

function input() {
  return [
    {
      brush_style: "ballpoint_pen",
      pen_width: 4,
      pen_color: 255,
      points: [
        { x: 10, y: 20, time: 90 },
        { x: 30, y: 40, time: 10 },
        { x: 20, y: 35, time: 50 },
      ],
    },
    {
      brush_style: "ballpoint_pen",
      pen_width: 2,
      pen_color: 65280,
      points: [{ x: 50, y: 60, time: 0 }],
    },
  ];
}

describe("trajectory source identity and validation", () => {
  test("complete line metrics transform together with source coordinates and pen width", () => {
    const source = input();
    const original = measureCompleteInkLine(
      parseInkJson(JSON.stringify(source)),
      [0, 1],
    );
    const transformed = measureCompleteInkLine(
      parseInkJson(
        JSON.stringify(
          source.map((stroke) => ({
            ...stroke,
            pen_width: stroke.pen_width * 3,
            points: stroke.points.map((point) => ({
              ...point,
              x: point.x * 3 + 7,
              y: point.y * 3 - 11,
            })),
          })),
        ),
      ),
      [0, 1],
    );
    expect(transformed.bodyHeight).toBe(original.bodyHeight * 3);
    expect(transformed.bodyBottom).toBe(original.bodyBottom * 3 - 11);
    expect(transformed.visibleBounds.width).toBe(
      original.visibleBounds.width * 3,
    );
  });

  test("retains original stroke and point ordering with byte-level identity", () => {
    const raw = JSON.stringify(input());
    const document = parseInkJson(raw);
    expect(document.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseInkJson(Buffer.from(raw)).sourceHash).toBe(document.sourceHash);
    expect(parseInkJson(`${raw}\n`).sourceHash).not.toBe(document.sourceHash);
    expect(document.strokes.map((stroke) => stroke.index)).toEqual([0, 1]);
    expect(document.strokes[0]?.points).toEqual([
      { x: 10, y: 20, time: 90 },
      { x: 30, y: 40, time: 10 },
      { x: 20, y: 35, time: 50 },
    ]);
    expect(Object.isFrozen(document.strokes[0]?.points[0])).toBe(true);
    expect(Object.isFrozen(document.strokes)).toBe(true);
  });

  test("rejects malformed input instead of synthesizing geometry", () => {
    for (const raw of ["{}", "[]", "null", "not json", '[{"points":[]}]']) {
      expect(() => parseInkJson(raw)).toThrow();
    }
    for (const patch of [
      { pen_width: 0 },
      { pen_width: -2 },
      { pen_color: 0.5 },
      { brush_style: "" },
      { points: [] },
      { points: [{ x: "10", y: 20, time: 0 }] },
      { points: [{ x: 10, y: 20 }] },
    ]) {
      expect(() =>
        parseInkJson(JSON.stringify([{ ...input()[0], ...patch }])),
      ).toThrow();
    }
    expect(() => parseInkJson(new Uint8Array([0xff]))).toThrow();
    expect(() =>
      parseInkJson(
        '[{"brush_style":"pen","pen_width":2,"pen_color":255,"points":[{"x":1e999,"y":0,"time":0}]}]',
      ),
    ).toThrow("finite");
  });
});

describe("complete black trajectories and transparent fragments", () => {
  test("bounds include line radius and transform explicit source coordinates", () => {
    const document = parseInkJson(JSON.stringify(input()));
    const stroke = document.strokes[0];
    if (!stroke) throw new Error("Missing fixture stroke");
    expect(strokeBounds(stroke)).toEqual({
      x: 8,
      y: 18,
      width: 24,
      height: 24,
    });
    const rendering = renderInkSvg(document, {
      strokeIndices: [0],
      scale: 2,
      padding: 3,
    });
    expect(rendering.width).toBe(54);
    expect(rendering.height).toBe(54);
    const { scale, translateX, translateY } = rendering.transform;
    expect(10 * scale + translateX).toBe(7);
    expect(20 * scale + translateY).toBe(7);
    expect(rendering.svg).toContain('points="10,20 30,40 20,35"');
    expect(rendering.svg).toContain('stroke="black"');
    expect(rendering.svg).toContain('stroke-width="4"');
    expect(rendering.svg).not.toContain("<rect");
    expect(rendering.strokeRefs).toEqual([
      { sourceHash: document.sourceHash, strokeIndex: 0 },
    ]);
  });

  test("single points and stationary repeated points remain visible", () => {
    const document = parseInkJson(JSON.stringify(input()));
    const dot = renderInkSvg(document, { strokeIndices: [1] });
    expect(dot.width).toBe(2);
    expect(dot.height).toBe(2);
    expect(dot.svg).toContain('<circle cx="50" cy="60" r="1" fill="black"/>');
    const stationary = parseInkJson(
      JSON.stringify([
        {
          ...input()[1],
          points: [
            { x: 50, y: 60, time: 0 },
            { x: 50, y: 60, time: 30 },
          ],
        },
      ]),
    );
    expect(renderInkSvg(stationary).svg).toContain("<circle");
    expect(stationary.strokes[0]?.points.length).toBe(2);
  });

  test("subset rendering preserves source order and all selected points", () => {
    const document = parseInkJson(JSON.stringify(input()));
    const rendering = renderInkSvg(document, {
      strokeIndices: [1, 0],
      background: "white",
    });
    expect(rendering.strokeRefs.map((ref) => ref.strokeIndex)).toEqual([0, 1]);
    expect(rendering.svg.indexOf("<polyline")).toBeLessThan(
      rendering.svg.indexOf("<circle"),
    );
    expect(rendering.svg).toContain(
      '<rect width="100%" height="100%" fill="white"/>',
    );
    expect(rendering.bounds).toEqual({ x: 8, y: 18, width: 43, height: 43 });
  });

  test("rejects invalid selection and geometry parameters", () => {
    const document = parseInkJson(JSON.stringify(input()));
    for (const strokeIndices of [[], [0, 0], [-1], [2], [0.5]]) {
      expect(() => renderInkSvg(document, { strokeIndices })).toThrow();
    }
    for (const options of [
      { scale: 0 },
      { scale: Number.NaN },
      { scale: Number.POSITIVE_INFINITY },
      { padding: -1 },
    ]) {
      expect(() => renderInkSvg(document, options)).toThrow();
    }
  });

  test("candidate records are pending review and source identities do not depend on OCR text", () => {
    const document = parseInkJson(JSON.stringify(input()));
    const options = { strokeIndices: [0], lineHeight: 32, baseline: 40 };
    const candidate = createInkCandidate(document, {
      ...options,
      text: "候选",
    });
    expect(candidate.status).toBe("pending-human-review");
    expect(candidate.baseline).toBe(22);
    expect(candidate.lineHeight).toBe(32);
    expect(candidate.id).toBe(
      createInkCandidate(document, { ...options, text: "修正" }).id,
    );
    expect(() =>
      createInkCandidate(document, { ...options, text: " " }),
    ).toThrow();
    expect(() =>
      createInkCandidate(document, { ...options, text: "候选", lineHeight: 0 }),
    ).toThrow();
  });
});

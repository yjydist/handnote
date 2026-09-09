import { createHash } from "node:crypto";

export interface InkPoint {
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

export interface InkStroke {
  readonly index: number;
  readonly brushStyle: string;
  readonly penWidth: number;
  readonly penColor: number;
  readonly points: readonly InkPoint[];
}

export interface InkDocument {
  readonly sourceHash: string;
  readonly strokes: readonly InkStroke[];
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StrokeReference {
  readonly sourceHash: string;
  readonly strokeIndex: number;
}

/** Image coordinates equal source coordinates * scale + translation. */
export interface InkTransform {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export interface InkRendering {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly bounds: Bounds;
  readonly transform: InkTransform;
  readonly strokeRefs: readonly StrokeReference[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function positive(value: unknown, context: string): number {
  const number = finite(value, context);
  if (number <= 0) throw new Error(`${context} must be positive`);
  return number;
}

export function parseInkJson(raw: string | Uint8Array): InkDocument {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const data: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Ink input must be a nonempty array of strokes");
  }
  const strokes = data.map((value, index): InkStroke => {
    const context = `stroke[${index}]`;
    const stroke = record(value, context);
    if (typeof stroke.brush_style !== "string" || !stroke.brush_style.trim()) {
      throw new Error(`${context}.brush_style must be a nonempty string`);
    }
    const penWidth = positive(stroke.pen_width, `${context}.pen_width`);
    const penColor = finite(stroke.pen_color, `${context}.pen_color`);
    if (!Number.isInteger(penColor))
      throw new Error(`${context}.pen_color must be an integer`);
    if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
      throw new Error(`${context}.points must be a nonempty array`);
    }
    const points = stroke.points.map((value, pointIndex): InkPoint => {
      const pointContext = `${context}.points[${pointIndex}]`;
      const point = record(value, pointContext);
      return Object.freeze({
        x: finite(point.x, `${pointContext}.x`),
        y: finite(point.y, `${pointContext}.y`),
        time: finite(point.time, `${pointContext}.time`),
      });
    });
    const result = Object.freeze({
      index,
      brushStyle: stroke.brush_style,
      penWidth,
      penColor,
      points: Object.freeze(points),
    });
    strokeBounds(result);
    return result;
  });
  return Object.freeze({ sourceHash, strokes: Object.freeze(strokes) });
}

export function strokeBounds(stroke: InkStroke): Bounds {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const radius = stroke.penWidth / 2;
  for (const point of stroke.points) {
    left = Math.min(left, point.x - radius);
    top = Math.min(top, point.y - radius);
    right = Math.max(right, point.x + radius);
    bottom = Math.max(bottom, point.y + radius);
  }
  return checkedBounds(left, top, right, bottom);
}

function checkedBounds(
  left: number,
  top: number,
  right: number,
  bottom: number,
): Bounds {
  return Object.freeze({
    x: finite(left, "bounds.x"),
    y: finite(top, "bounds.y"),
    width: positive(right - left, "bounds.width"),
    height: positive(bottom - top, "bounds.height"),
  });
}

function selectStrokes(
  document: InkDocument,
  indices?: readonly number[],
): readonly InkStroke[] {
  if (indices === undefined) return document.strokes;
  if (indices.length === 0)
    throw new Error("A fragment requires at least one complete stroke");
  const selected = new Set<number>();
  for (const index of indices) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= document.strokes.length
    ) {
      throw new Error(`Invalid stroke index: ${index}`);
    }
    if (selected.has(index))
      throw new Error(`Duplicate stroke index: ${index}`);
    selected.add(index);
  }
  return document.strokes.filter((stroke) => selected.has(stroke.index));
}

function boundsFor(strokes: readonly InkStroke[]): Bounds {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return checkedBounds(left, top, right, bottom);
}

export function strokeSvg(stroke: InkStroke): string {
  const point = stroke.points[0];
  if (!point) throw new Error("Cannot render empty stroke");
  const isDot = stroke.points.every(
    (other) => other.x === point.x && other.y === point.y,
  );
  if (isDot)
    return `<circle cx="${point.x}" cy="${point.y}" r="${stroke.penWidth / 2}" fill="black"/>`;
  return `<polyline points="${stroke.points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="black" stroke-width="${stroke.penWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

export function renderInkSvg(
  document: InkDocument,
  options: {
    strokeIndices?: readonly number[];
    scale?: number;
    /** Padding in output image pixels. */
    padding?: number;
    background?: "transparent" | "white";
  } = {},
): InkRendering {
  const strokes = selectStrokes(document, options.strokeIndices);
  const bounds = boundsFor(strokes);
  const scale = positive(options.scale ?? 1, "scale");
  const padding = finite(options.padding ?? 0, "padding");
  if (padding < 0) throw new Error("padding must be nonnegative");
  const width = positive(
    Math.ceil(bounds.width * scale + 2 * padding),
    "image width",
  );
  const height = positive(
    Math.ceil(bounds.height * scale + 2 * padding),
    "image height",
  );
  const transform = Object.freeze({
    scale,
    translateX: finite(padding - bounds.x * scale, "translateX"),
    translateY: finite(padding - bounds.y * scale, "translateY"),
  });
  const paths = strokes.map(strokeSvg);
  const background =
    options.background === "white"
      ? '<rect width="100%" height="100%" fill="white"/>'
      : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}<g transform="translate(${transform.translateX} ${transform.translateY}) scale(${scale})">${paths.join("")}</g></svg>`;
  return Object.freeze({
    svg,
    width,
    height,
    bounds,
    transform,
    strokeRefs: Object.freeze(
      strokes.map((stroke) =>
        Object.freeze({
          sourceHash: document.sourceHash,
          strokeIndex: stroke.index,
        }),
      ),
    ),
  });
}

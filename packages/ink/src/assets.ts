import { createHash } from "node:crypto";
import {
  type Bounds,
  type InkDocument,
  renderInkSvg,
  strokeSvg,
} from "./trajectory.ts";

export interface InkPresentation {
  readonly kind: "text" | "diagram";
  /** Height of representative handwriting in asset coordinates, not the whole line envelope. */
  readonly referenceHeight: number;
  readonly transcription?: string;
  readonly description?: string;
}

export interface InkFragment {
  readonly version: 1;
  readonly id: string;
  readonly kind: "fragment";
  readonly sourceHash: string;
  readonly strokeIndices: readonly number[];
  readonly sourceBounds: Bounds;
  readonly width: number;
  readonly height: number;
  readonly presentation: InkPresentation;
}

export interface InkPlacement {
  readonly assetId: string;
  /** Clockwise degrees about the asset's top-left local origin (SVG y points down). */
  readonly rotation: number;
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface InkComposition {
  readonly version: 1;
  readonly id: string;
  readonly kind: "composition";
  readonly sourceHash: string;
  readonly strokeIndices: readonly number[];
  readonly sourceBounds: Bounds;
  readonly bounds: Bounds;
  readonly width: number;
  readonly height: number;
  readonly parts: readonly InkPlacement[];
  readonly presentation: InkPresentation;
}

export type InkAsset = InkFragment | InkComposition;
type Matrix = readonly [number, number, number, number, number, number];
interface PlacedStroke {
  index: number;
  matrix: Matrix;
}
type AssetLibrary = ReadonlyMap<string, InkAsset>;

// v1 supports typographic adjustments, not scales that lose strokes in SVG's numeric representation.
function checkInkScale(scale: number): void {
  const roundoff = 1e-12;
  if (
    !Number.isFinite(scale) ||
    scale < 0.01 * (1 - roundoff) ||
    scale > 100 * (1 + roundoff)
  )
    throw new Error(
      "Ink stroke scale must remain between 0.01 and 100, including nested transforms",
    );
}

/** Stable encoding also rejects unknown fields when compared with a regenerated descriptor. */
export function inkAssetJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inkAssetJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${inkAssetJson(item)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (
    result === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw new Error("Ink metadata must contain finite JSON values");
  return result;
}

function presentation(input: InkPresentation): InkPresentation {
  if (
    !input ||
    !["text", "diagram"].includes(input.kind) ||
    !Number.isFinite(input.referenceHeight) ||
    input.referenceHeight <= 0
  )
    throw new Error(
      "Ink presentation requires a kind and positive referenceHeight",
    );
  for (const key of ["transcription", "description"] as const)
    if (input[key] !== undefined && typeof input[key] !== "string")
      throw new Error(`Invalid ink ${key}`);
  return Object.freeze({
    kind: input.kind,
    referenceHeight: input.referenceHeight,
    ...(input.transcription === undefined
      ? {}
      : { transcription: input.transcription }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
  });
}

function identify<T extends object>(value: T): T & { readonly id: string } {
  const id = createHash("sha256").update(inkAssetJson(value)).digest("hex");
  return Object.freeze({ ...value, id });
}

export function createInkFragment(
  document: InkDocument,
  input: { strokeIndices: readonly number[]; presentation: InkPresentation },
): InkFragment {
  const rendered = renderInkSvg(document, {
    strokeIndices: input.strokeIndices,
  });
  return identify({
    version: 1 as const,
    kind: "fragment" as const,
    sourceHash: document.sourceHash,
    strokeIndices: Object.freeze(
      rendered.strokeRefs.map((ref) => ref.strokeIndex),
    ),
    sourceBounds: rendered.bounds,
    width: rendered.width,
    height: rendered.height,
    presentation: presentation(input.presentation),
  });
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function placement(input: InkPlacement): InkPlacement {
  if (
    !input ||
    !/^[a-f0-9]{64}$/.test(input.assetId) ||
    ![input.rotation, input.scale, input.x, input.y].every(Number.isFinite) ||
    input.scale <= 0
  )
    throw new Error(
      "Invalid ink placement; rotation, positive scale and translation are required",
    );
  checkInkScale(input.scale);
  return Object.freeze({
    assetId: input.assetId,
    rotation: input.rotation,
    scale: input.scale,
    x: input.x,
    y: input.y,
  });
}

function resolveAsset(
  document: InkDocument,
  asset: InkAsset,
  library: AssetLibrary,
  active: Set<string>,
): PlacedStroke[] {
  if (!asset || active.has(asset.id))
    throw new Error("Missing or cyclic ink asset");
  active.add(asset.id);
  try {
    let regenerated: InkAsset;
    let strokes: PlacedStroke[];
    if (asset.kind === "fragment") {
      regenerated = createInkFragment(document, asset);
      strokes = regenerated.strokeIndices.map((index) => ({
        index,
        matrix: [
          1,
          0,
          0,
          1,
          -regenerated.sourceBounds.x,
          -regenerated.sourceBounds.y,
        ],
      }));
    } else if (asset.kind === "composition") {
      const result = buildComposition(document, asset, library, active);
      regenerated = result.asset;
      strokes = result.strokes;
    } else throw new Error("Unsupported ink asset kind");
    if (inkAssetJson(regenerated) !== inkAssetJson(asset))
      throw new Error("Ink asset identity or source geometry mismatch");
    return strokes;
  } finally {
    active.delete(asset.id);
  }
}

function buildComposition(
  document: InkDocument,
  input: { parts: readonly InkPlacement[]; presentation: InkPresentation },
  library: AssetLibrary,
  active: Set<string>,
) {
  if (!Array.isArray(input.parts) || input.parts.length === 0)
    throw new Error("Composition requires ink parts");
  const parts = Object.freeze(input.parts.map(placement));
  const seen = new Set<number>();
  const strokes: PlacedStroke[] = [];
  for (const part of parts) {
    const child = library.get(part.assetId);
    if (
      !child ||
      child.id !== part.assetId ||
      child.sourceHash !== document.sourceHash
    )
      throw new Error("Missing ink dependency or different source");
    const angle = ((part.rotation % 360) * Math.PI) / 180;
    const c = Math.cos(angle) * part.scale;
    const s = Math.sin(angle) * part.scale;
    const transform: Matrix = [c, s, -s, c, part.x, part.y];
    for (const stroke of resolveAsset(document, child, library, active)) {
      if (seen.has(stroke.index))
        throw new Error("Composition repeats a complete source stroke");
      seen.add(stroke.index);
      strokes.push({
        index: stroke.index,
        matrix: multiply(transform, stroke.matrix),
      });
    }
  }
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const placed of strokes) {
    const stroke = document.strokes[placed.index];
    if (!stroke) throw new Error("Missing source stroke");
    const [a, b, c, d, e, f] = placed.matrix;
    const scale = Math.hypot(a, b);
    checkInkScale(scale);
    const radius = (stroke.penWidth / 2) * scale;
    for (const point of stroke.points) {
      const x = a * point.x + c * point.y + e,
        y = b * point.x + d * point.y + f;
      left = Math.min(left, x - radius);
      right = Math.max(right, x + radius);
      top = Math.min(top, y - radius);
      bottom = Math.max(bottom, y + radius);
    }
  }
  const width = Math.ceil(right - left),
    height = Math.ceil(bottom - top);
  if (
    ![left, top, right, bottom, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Invalid transformed ink bounds");
  const strokeIndices = Object.freeze([...seen].sort((a, b) => a - b));
  const sourceBounds = renderInkSvg(document, { strokeIndices }).bounds;
  const asset: InkComposition = identify({
    version: 1 as const,
    kind: "composition" as const,
    sourceHash: document.sourceHash,
    strokeIndices,
    sourceBounds,
    bounds: Object.freeze({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    }),
    width,
    height,
    parts,
    presentation: presentation(input.presentation),
  });
  return {
    asset,
    strokes: strokes.map((stroke) => ({
      ...stroke,
      matrix: multiply([1, 0, 0, 1, -left, -top], stroke.matrix),
    })),
  };
}

export function composeInkAssets(
  document: InkDocument,
  input: { parts: readonly InkPlacement[]; presentation: InkPresentation },
  library: AssetLibrary,
): InkComposition {
  return buildComposition(document, input, library, new Set()).asset;
}

export function renderInkAsset(
  document: InkDocument,
  asset: InkAsset,
  library: AssetLibrary = new Map(),
): string {
  const strokes = resolveAsset(document, asset, library, new Set());
  if (asset.kind === "fragment")
    return renderInkSvg(document, { strokeIndices: asset.strokeIndices }).svg;
  const paths = strokes.map(({ index, matrix }) => {
    const stroke = document.strokes[index];
    if (!stroke) throw new Error("Missing source stroke");
    // Keep the original point strings; the SVG matrix carries all geometry changes.
    return `<g transform="matrix(${matrix.join(" ")})">${strokeSvg(stroke)}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}" viewBox="0 0 ${asset.width} ${asset.height}">${paths.join("")}</svg>`;
}

import { createHash } from "node:crypto";
import { type Bounds, type InkDocument, renderInkSvg } from "./trajectory.ts";

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

export type InkAsset = InkFragment;

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

export function renderInkAsset(document: InkDocument, asset: InkAsset): string {
  const regenerated = createInkFragment(document, asset);
  if (inkAssetJson(regenerated) !== inkAssetJson(asset))
    throw new Error("Ink asset identity or source geometry mismatch");
  return renderInkSvg(document, { strokeIndices: asset.strokeIndices }).svg;
}

import type { Bounds } from "@handnote/ink";
import sharp from "sharp";
import { atomicWrite, sha256 } from "../utils.ts";
import type { ToolContext } from "./types.ts";

const maximumPreviewEdge = 2048;
const maximumPreviewPixels = maximumPreviewEdge ** 2;

export interface StrokeLabel {
  strokeIndex: number;
  bounds: Bounds;
}

export async function prepareInkPreview(
  svg: string,
  viewBox: Bounds,
  options: {
    maxEdge: number;
    maxScale: number;
    labels?: readonly StrokeLabel[];
  },
) {
  const factor = Math.min(
    options.maxScale,
    Math.min(options.maxEdge, maximumPreviewEdge) /
      Math.max(viewBox.width, viewBox.height),
  );
  const width = Math.max(1, Math.floor(viewBox.width * factor));
  const height = Math.max(1, Math.floor(viewBox.height * factor));
  const scale = Math.min(width / viewBox.width, height / viewBox.height);
  const transform = {
    scale,
    translateX: (width - viewBox.width * scale) / 2 - viewBox.x * scale,
    translateY: (height - viewBox.height * scale) / 2 - viewBox.y * scale,
  };
  if (
    ![factor, scale, transform.translateX, transform.translateY].every(
      Number.isFinite,
    ) ||
    scale <= 0
  )
    throw new Error(
      "Ink preview coordinates exceed the supported numeric range",
    );
  const fontSize = Math.min(14 / scale, viewBox.height * 0.8);
  const labels = (options.labels ?? [])
    .map(({ strokeIndex, bounds }) => {
      const x = Math.max(
        viewBox.x,
        Math.min(
          bounds.x,
          viewBox.x + viewBox.width - fontSize * String(strokeIndex).length,
        ),
      );
      const y = Math.max(
        viewBox.y + fontSize,
        Math.min(bounds.y, viewBox.y + viewBox.height),
      );
      return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="#d42323" stroke="white" stroke-width="${2 / scale}" paint-order="stroke">${strokeIndex}</text>`;
    })
    .join("");
  // Only the trusted generated SVG is reframed; immutable material SVGs keep their source geometry.
  const content = svg.replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>$/, "");
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}">${content}${labels}</svg>`;
  const bytes = await sharp(Buffer.from(preview), {
    limitInputPixels: maximumPreviewPixels,
  })
    .flatten({ background: "white" })
    .png()
    .toBuffer();
  return { bytes, width, height, viewBox, transform };
}

export async function saveInkPreview(
  context: ToolContext,
  preview: Awaited<ReturnType<typeof prepareInkPreview>>,
  kind: "actual" | "stroke_indices",
) {
  const path = context.store.path(
    `intermediate/inspections/ink/${sha256(preview.bytes)}.png`,
  );
  await atomicWrite(path, preview.bytes);
  return {
    kind,
    path,
    width: preview.width,
    height: preview.height,
    viewBox: preview.viewBox,
    coordinatesToPreview: preview.transform,
  };
}

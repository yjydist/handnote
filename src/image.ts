import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { type Region, regionSchema } from "./document.ts";
import { HandnoteError } from "./errors.ts";

const inspectEnhancementSchema = z.enum([
  "original",
  "grayscale",
  "contrast",
  "sharpen",
  "binarize",
]);
const inspectScaleSchema = z.number().min(1).max(4);
const inspectRegionSchema = z
  .object({
    x: z.number().min(0).lt(1),
    y: z.number().min(0).lt(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    scale: inspectScaleSchema.optional(),
    enhancement: inspectEnhancementSchema.optional(),
  })
  .strict();

export const inspectInputSchema = z
  .object({
    regions: z.array(inspectRegionSchema).min(1).max(8),
    scale: inspectScaleSchema.optional(),
    enhancement: inspectEnhancementSchema.optional(),
  })
  .strict();

export type InspectRequest = z.infer<typeof inspectInputSchema>;

export interface InspectRegion extends Region {
  scale: number;
  enhancement: z.infer<typeof inspectEnhancementSchema>;
}

export interface InspectInput {
  regions: InspectRegion[];
}

export function normalizeInspectInput(input: InspectRequest): InspectInput {
  const parsed = inspectInputSchema.parse(input);
  return {
    regions: parsed.regions.map((region) => ({
      ...regionSchema.parse({
        x: region.x,
        y: region.y,
        width: Math.min(region.width, 1 - region.x),
        height: Math.min(region.height, 1 - region.y),
      }),
      scale: region.scale ?? parsed.scale ?? 2,
      enhancement: region.enhancement ?? parsed.enhancement ?? "original",
    })),
  };
}

export interface ModelMediaOptions {
  maxEdge: number;
  jpegQuality: number;
}

export interface ModelPreview {
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

const previewOverlap = 32;
const contactHorizontalPadding = 32;
const contactVerticalPadding = 56;
const maximumInspectionPixels = 16 * 1024 * 1024;

interface PlannedCrop {
  pixels: ReturnType<typeof regionPixels>;
  width: number;
  height: number;
  enhancement: InspectRegion["enhancement"];
}

function fitDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const factor = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

function contactDimensions(
  crops: Array<Pick<PlannedCrop, "width" | "height">>,
  columns: number,
): { width: number; height: number; cellWidth: number; cellHeight: number } {
  const cellWidth =
    Math.max(...crops.map((crop) => crop.width)) + contactHorizontalPadding;
  const cellHeight =
    Math.max(...crops.map((crop) => crop.height)) + contactVerticalPadding;
  return {
    width: columns * cellWidth,
    height: Math.ceil(crops.length / columns) * cellHeight,
    cellWidth,
    cellHeight,
  };
}

function boundContactPixels(
  crops: PlannedCrop[],
  columns: number,
): PlannedCrop[] {
  const initial = contactDimensions(crops, columns);
  if (initial.width * initial.height <= maximumInspectionPixels) return crops;
  let low = 0;
  let high = 1;
  let best = crops.map((crop) => ({ ...crop, width: 1, height: 1 }));
  for (let iteration = 0; iteration < 40; iteration++) {
    const factor = (low + high) / 2;
    const candidate = crops.map((crop) => ({
      ...crop,
      width: Math.max(1, Math.floor(crop.width * factor)),
      height: Math.max(1, Math.floor(crop.height * factor)),
    }));
    const dimensions = contactDimensions(candidate, columns);
    if (dimensions.width * dimensions.height <= maximumInspectionPixels) {
      best = candidate;
      low = factor;
    } else high = factor;
  }
  return best;
}

function tileStarts(height: number, maxEdge: number): number[] {
  if (height <= maxEdge) return [0];
  const starts = [0];
  const stride = Math.max(1, maxEdge - previewOverlap);
  while (true) {
    const previous = starts.at(-1) ?? 0;
    if (previous + maxEdge >= height) break;
    const next = previous + stride;
    if (next <= previous) break;
    starts.push(next);
  }
  return starts;
}

export async function createModelPreviews(
  path: string,
  options: ModelMediaOptions,
): Promise<ModelPreview[]> {
  const metadata = await displayMetadata(path);
  const width = Math.min(metadata.width, options.maxEdge);
  const prepared = await sharp(path, { failOn: "error" })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  const starts = tileStarts(prepared.info.height, options.maxEdge);
  return await Promise.all(
    starts.map(async (top) => {
      const height = Math.min(options.maxEdge, prepared.info.height - top);
      const jpeg = await sharp(prepared.data)
        .extract({ left: 0, top, width: prepared.info.width, height })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: options.jpegQuality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      return {
        data: jpeg.data.toString("base64"),
        mediaType: "image/jpeg" as const,
        width: jpeg.info.width,
        height: jpeg.info.height,
        bytes: jpeg.data.byteLength,
        sha256: createHash("sha256").update(jpeg.data).digest("hex"),
      };
    }),
  );
}

export async function displayMetadata(
  path: string,
): Promise<{ width: number; height: number; mimeType: string }> {
  const metadata = await sharp(path, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error("Image has no dimensions");
  const rotated = (metadata.orientation ?? 1) >= 5;
  let mimeType: string;
  if (metadata.format === "png") mimeType = "image/png";
  else if (metadata.format === "jpeg") mimeType = "image/jpeg";
  else if (metadata.format === "webp") mimeType = "image/webp";
  else
    throw new HandnoteError(
      `Unsupported decoded image format: ${metadata.format ?? "unknown"}`,
      "validation",
    );
  return {
    width: rotated ? metadata.height : metadata.width,
    height: rotated ? metadata.width : metadata.height,
    mimeType,
  };
}

export function regionPixels(
  region: Region,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.floor(region.x * width);
  const top = Math.floor(region.y * height);
  const right = Math.ceil((region.x + region.width) * width);
  const bottom = Math.ceil((region.y + region.height) * height);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function enhance(
  pipeline: sharp.Sharp,
  mode: InspectRegion["enhancement"],
): sharp.Sharp {
  if (mode === "grayscale") return pipeline.grayscale();
  if (mode === "contrast") return pipeline.normalize();
  if (mode === "sharpen") return pipeline.sharpen();
  if (mode === "binarize") return pipeline.grayscale().threshold();
  return pipeline;
}

export async function inspectSource(
  source: string,
  outputDirectory: string,
  input: InspectRequest,
  sequence: number,
  maxEdge: number,
): Promise<{
  path: string;
  width: number;
  height: number;
  kind: "crop" | "contact_sheet";
}> {
  const parsed = normalizeInspectInput(input);
  const metadata = await displayMetadata(source);
  await mkdir(outputDirectory, { recursive: true });
  const columns = Math.min(2, parsed.regions.length);
  const maximumCropWidth =
    parsed.regions.length === 1
      ? maxEdge
      : Math.max(1, Math.floor(maxEdge / columns) - contactHorizontalPadding);
  let plans = parsed.regions.map((region): PlannedCrop => {
    const pixels = regionPixels(region, metadata.width, metadata.height);
    const requestedWidth = Math.max(1, Math.round(pixels.width * region.scale));
    const requestedHeight = Math.max(
      1,
      Math.round(pixels.height * region.scale),
    );
    return {
      pixels,
      enhancement: region.enhancement,
      ...fitDimensions(
        requestedWidth,
        requestedHeight,
        maximumCropWidth,
        maxEdge,
      ),
    };
  });
  if (plans.length > 1) plans = boundContactPixels(plans, columns);
  const crops: Array<{ input: Buffer; width: number; height: number }> = [];
  for (const plan of plans) {
    const data = await enhance(
      sharp(source)
        .rotate()
        .extract(plan.pixels)
        .resize({ width: plan.width, height: plan.height, fit: "fill" }),
      plan.enhancement,
    )
      .png()
      .toBuffer();
    crops.push({ input: data, width: plan.width, height: plan.height });
  }
  const suffix = String(sequence).padStart(3, "0");
  if (crops.length === 1) {
    const crop = crops[0];
    if (!crop) throw new Error("Missing crop");
    const path = `${outputDirectory}/crop-${suffix}.png`;
    await Bun.write(path, crop.input);
    return { path, width: crop.width, height: crop.height, kind: "crop" };
  }
  const { width, height, cellWidth, cellHeight } = contactDimensions(
    crops,
    columns,
  );
  const composite = crops.map((crop, index) => ({
    input: crop.input,
    left: (index % columns) * cellWidth + 16,
    top: Math.floor(index / columns) * cellHeight + 40,
  }));
  const labels = crops.map((_, index) => ({
    input: Buffer.from(
      `<svg width="${cellWidth}" height="40"><text x="16" y="28" font-size="24" font-family="sans-serif">${index + 1}</text></svg>`,
    ),
    left: (index % columns) * cellWidth,
    top: Math.floor(index / columns) * cellHeight,
  }));
  const path = `${outputDirectory}/contact-${suffix}.png`;
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([...composite, ...labels])
    .png()
    .toFile(path);
  return {
    path,
    width,
    height,
    kind: "contact_sheet",
  };
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type InkTransform, parseInkJson, renderInkSvg } from "@handnote/ink";
import sharp from "sharp";
import { z } from "zod";
import development from "./development.json";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const transformSchema = z.object({
  scale: z.number().positive(),
  translateX: z.number(),
  translateY: z.number(),
});
const cropSchema = z.object({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const recordSchema = z
  .object({
    page: z.enum(["2", "69", "70"]),
    variant: z.enum(["baseline", "page-2x", "line-2x"]).default("baseline"),
    inputId: z.string().optional(),
    image: z.string(),
    imageHash: z.string(),
    sourceHash: z.string(),
    transform: transformSchema,
    rawResult: z.string(),
    seconds: z.number().nonnegative(),
    baselineOcrHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    baselineOcrFile: z.string().optional(),
    baselineLineId: z.number().int().nonnegative().optional(),
    crop: cropSchema.optional(),
  })
  .passthrough();
const runSchema = z
  .object({
    status: z.literal("complete"),
    modelLockHash: z.string(),
    packages: z.record(z.string(), z.string()),
    pages: z.array(recordSchema).min(1),
  })
  .passthrough();

export type OcrCrop = z.infer<typeof cropSchema>;
export const lineBoxesSchema = z.object({
  rec_boxes: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
  rec_texts: z.array(z.string()),
});

/** Crop coordinates are integral pixels in the doubled full-page redraw. */
export function lineCrop(
  box: readonly [number, number, number, number],
  baseline: InkTransform,
  doubled: InkTransform,
  dimensions: { width: number; height: number },
): OcrCrop {
  const [x, y, right, bottom] = box;
  if (!box.every(Number.isFinite) || right <= x || bottom <= y)
    throw new Error("Cannot crop a degenerate baseline line box");
  const margin = (bottom - y) / 2;
  const projectX = (at: number) =>
    ((at - baseline.translateX) / baseline.scale) * doubled.scale +
    doubled.translateX;
  const projectY = (at: number) =>
    ((at - baseline.translateY) / baseline.scale) * doubled.scale +
    doubled.translateY;
  const left = Math.max(0, Math.floor(projectX(x - margin)));
  const top = Math.max(0, Math.floor(projectY(y - margin)));
  const endX = Math.min(dimensions.width, Math.ceil(projectX(right + margin)));
  const endY = Math.min(
    dimensions.height,
    Math.ceil(projectY(bottom + margin)),
  );
  return cropSchema.parse({
    left,
    top,
    width: endX - left,
    height: endY - top,
  });
}

export function cropTransform(
  transform: InkTransform,
  crop: OcrCrop,
): InkTransform {
  return {
    ...transform,
    translateX: transform.translateX - crop.left,
    translateY: transform.translateY - crop.top,
  };
}

export async function loadOcrEvidence(
  preparedInput: string,
  ocrDirectory: string,
) {
  const bytes = await readFile(join(ocrDirectory, "run.json"));
  const run = runSchema.parse(JSON.parse(bytes.toString("utf8")));
  const ids = new Set<string>();
  const records = run.pages.map((record) => {
    const inputId =
      record.variant === "baseline"
        ? `page-${record.page}`
        : record.variant === "page-2x"
          ? `page-${record.page}-2x`
          : `page-${record.page}-line-${record.baselineLineId}-2x`;
    if (
      ids.has(inputId) ||
      (record.inputId !== undefined && record.inputId !== inputId) ||
      record.rawResult !== `${inputId}.raw.json` ||
      (record.variant !== "baseline" &&
        (!record.inputId ||
          !record.baselineOcrHash ||
          !record.baselineOcrFile)) ||
      (record.variant === "line-2x"
        ? !record.crop || record.baselineLineId === undefined
        : record.crop !== undefined || record.baselineLineId !== undefined)
    )
      throw new Error("Invalid or duplicate OCR input identity");
    ids.add(inputId);
    return { ...record, inputId };
  });
  const sources = await Promise.all(
    development.pages.map(async (page) => {
      const sourceBytes = await readFile(
        join(preparedInput, `page-${page.page}/source.json`),
      );
      const source = parseInkJson(sourceBytes);
      const markdown = await readFile(
        join(preparedInput, `page-${page.page}/note.md`),
        "utf8",
      );
      if (source.sourceHash !== page.sourceHash || markdown !== page.markdown)
        throw new Error(`Stale input evidence for page ${page.page}`);
      const baseline = renderInkSvg(source, {
        background: "white",
        padding: 10,
      });
      const doubled = renderInkSvg(source, {
        background: "white",
        scale: 2,
        padding: 20,
      });
      return {
        page,
        sourceBytes,
        source,
        markdown,
        baseline,
        doubled,
        baselinePixels: await sharp(Buffer.from(baseline.svg)).png().toBuffer(),
        doubledPixels: await sharp(Buffer.from(doubled.svg)).png().toBuffer(),
      };
    }),
  );
  const inputs = [];
  for (const record of records) {
    const sourceData = sources.find((item) => item.page.page === record.page);
    if (!sourceData) throw new Error("Missing development source");
    const { baseline, doubled, baselinePixels, doubledPixels, ...source } =
      sourceData;
    if (
      record.sourceHash !== source.source.sourceHash ||
      hash(await readFile(record.image)) !== record.imageHash
    )
      throw new Error(`Stale input evidence for page ${record.page}`);
    let pixels = record.variant === "baseline" ? baselinePixels : doubledPixels;
    let transform =
      record.variant === "baseline" ? baseline.transform : doubled.transform;
    if (record.variant !== "baseline") {
      if (!record.baselineOcrFile) throw new Error("Missing baseline OCR file");
      const baselineBytes = await readFile(record.baselineOcrFile);
      if (hash(baselineBytes) !== record.baselineOcrHash)
        throw new Error("Stale baseline OCR evidence");
      const baselineRaw: unknown = JSON.parse(baselineBytes.toString("utf8"));
      const baselineImage = z
        .object({ input_path: z.string().min(1) })
        .parse(baselineRaw).input_path;
      if (hash(await readFile(baselineImage)) !== hash(baselinePixels))
        throw new Error("Baseline OCR belongs to a different source redraw");
      if (record.variant === "line-2x") {
        const raw = lineBoxesSchema.parse(baselineRaw);
        const box = raw.rec_boxes[record.baselineLineId ?? -1];
        if (!box || raw.rec_boxes.length !== raw.rec_texts.length)
          throw new Error("Missing baseline line");
        const crop = lineCrop(
          box,
          baseline.transform,
          doubled.transform,
          doubled,
        );
        if (
          !record.crop ||
          Object.keys(crop).some(
            (key) =>
              crop[key as keyof OcrCrop] !==
              record.crop?.[key as keyof OcrCrop],
          )
        )
          throw new Error("Mismatched OCR crop evidence");
        pixels = await sharp(doubledPixels).extract(crop).png().toBuffer();
        transform = cropTransform(doubled.transform, crop);
      }
    }
    if (
      record.transform.scale !== transform.scale ||
      record.transform.translateX !== transform.translateX ||
      record.transform.translateY !== transform.translateY ||
      hash(pixels) !== record.imageHash
    )
      throw new Error(`Mismatched OCR redraw evidence for page ${record.page}`);
    const rawBytes = await readFile(join(ocrDirectory, record.rawResult));
    const raw: unknown = JSON.parse(rawBytes.toString("utf8"));
    const rawText = z
      .object({ input_path: z.string().min(1), rec_texts: z.array(z.string()) })
      .parse(raw);
    if (resolve(rawText.input_path) !== resolve(record.image))
      throw new Error(`Mismatched OCR result image for page ${record.page}`);
    inputs.push({
      ...source,
      record,
      raw,
      rawBytes,
      sourceLines: rawText.rec_texts,
    });
  }
  return { bytes, run, inputs };
}

export interface ComparisonEvidence {
  run: {
    modelLockHash: string;
    packages: Record<string, string>;
    parameters?: unknown;
  };
  inputs: readonly {
    rawBytes: Uint8Array;
    record: {
      page: string;
      inputId: string;
      variant: "baseline" | "page-2x" | "line-2x";
      baselineOcrHash?: string | undefined;
    };
  }[];
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  throw new Error("OCR comparison parameters must contain JSON values");
}

export function validateOcrComparison(
  baseline: ComparisonEvidence,
  variants: ComparisonEvidence,
) {
  if (
    baseline.run.modelLockHash !== variants.run.modelLockHash ||
    canonicalJson(baseline.run.packages) !==
      canonicalJson(variants.run.packages)
  )
    throw new Error(
      "OCR model or package versions differ between comparison runs",
    );
  for (const run of [baseline.run, variants.run])
    if (
      typeof run.parameters !== "object" ||
      run.parameters === null ||
      Array.isArray(run.parameters)
    )
      throw new Error(
        "OCR comparison requires explicit object parameters in both runs",
      );
  if (
    canonicalJson(baseline.run.parameters) !==
    canonicalJson(variants.run.parameters)
  )
    throw new Error("OCR parameters differ between comparison runs");
  if (
    baseline.inputs.some((input) => input.record.variant !== "baseline") ||
    variants.inputs.some((input) => input.record.variant === "baseline")
  )
    throw new Error("Expected fixed baseline run and separate variant run");
  if (
    baseline.inputs.length !== development.pages.length ||
    development.pages.some(
      (page) =>
        baseline.inputs.filter((input) => input.record.page === page.page)
          .length !== 1,
    )
  )
    throw new Error("Expected exactly the three fixed baseline pages");
  for (const page of development.pages)
    if (
      variants.inputs.filter(
        (input) =>
          input.record.page === page.page && input.record.variant === "page-2x",
      ).length !== 1
    )
      throw new Error(`Expected one 2x whole-page input for page ${page.page}`);
  for (const input of variants.inputs) {
    const original = baseline.inputs.find(
      (item) => item.record.page === input.record.page,
    );
    if (!original)
      throw new Error(`Missing baseline page ${input.record.page}`);
    if (input.record.baselineOcrHash !== hash(original.rawBytes))
      throw new Error(
        `Mismatched baseline OCR hash for ${input.record.inputId}`,
      );
  }
}

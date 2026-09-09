import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInkJson, renderInkSvg } from "@handnote/ink";
import sharp from "sharp";
import development from "./development.json";
import {
  cropTransform,
  hash,
  lineCrop,
  loadOcrEvidence,
} from "./ocr-evidence.ts";
import { prepareOcrInputs } from "./ocr-inputs.ts";

test("line crops retain half-line padding, clamp edges and round-trip source coordinates", () => {
  const baseline = { scale: 1, translateX: 10, translateY: -20 };
  const doubled = { scale: 2, translateX: 20, translateY: -40 };
  const crop = lineCrop([10, 20, 40, 30], baseline, doubled, {
    width: 100,
    height: 100,
  });
  expect(crop).toEqual({ left: 10, top: 30, width: 80, height: 40 });
  const transformed = cropTransform(doubled, crop);
  for (const [x, y] of [
    [0, 0],
    [-10, 40],
    [35.5, 60.25],
  ]) {
    if (x === undefined || y === undefined)
      throw new Error("Missing coordinate");
    expect(
      (x * transformed.scale +
        transformed.translateX -
        transformed.translateX) /
        transformed.scale,
    ).toBe(x);
    expect(y * transformed.scale + transformed.translateY).toBe(
      y * doubled.scale + doubled.translateY - crop.top,
    );
  }
  expect(
    lineCrop([0, 0, 45, 45], baseline, doubled, { width: 80, height: 80 }),
  ).toEqual({ left: 0, top: 0, width: 80, height: 80 });
  expect(() =>
    lineCrop([0, 0, 5, 0], baseline, doubled, { width: 80, height: 80 }),
  ).toThrow("degenerate");
});

test("variant evidence regenerates pixels and rejects stale identities, crops and raw results", async () => {
  const root = await mkdtemp(join(tmpdir(), "handnote-ocr-variants-"));
  try {
    const prepared = join(root, "prepared");
    const baseline = join(root, "baseline");
    const output = join(root, "inputs");
    const variants = join(root, "variants");
    await mkdir(baseline);
    await mkdir(variants);
    const pages = [];
    for (const page of development.pages) {
      const folder = join(prepared, `page-${page.page}`);
      await mkdir(folder, { recursive: true });
      const bytes = await readFile(
        new URL(`../../${page.source}`, import.meta.url),
      );
      await writeFile(join(folder, "source.json"), bytes);
      await writeFile(join(folder, "note.md"), page.markdown);
      const document = parseInkJson(bytes);
      const redraw = renderInkSvg(document, {
        background: "white",
        padding: 10,
      });
      const pixels = await sharp(Buffer.from(redraw.svg)).png().toBuffer();
      const image = join(folder, "redraw.png");
      await writeFile(image, pixels);
      const rawResult = `page-${page.page}.raw.json`;
      await writeFile(
        join(baseline, rawResult),
        JSON.stringify({
          input_path: image,
          rec_texts: ["候选"],
          rec_boxes: [[0, 0, 100, 30]],
        }),
      );
      pages.push({
        page: page.page,
        image,
        imageHash: hash(pixels),
        sourceHash: document.sourceHash,
        rawResult,
        seconds: 1,
        transform: redraw.transform,
      });
    }
    const common = {
      status: "complete",
      modelLockHash: "a".repeat(64),
      packages: { paddleocr: "3.3.1" },
    };
    await writeFile(
      join(baseline, "run.json"),
      JSON.stringify({ ...common, pages }),
    );
    await prepareOcrInputs(prepared, baseline, output);
    const manifest = JSON.parse(
      await readFile(join(output, "ocr-input.json"), "utf8"),
    );
    expect(manifest.pages).toHaveLength(6);
    await expect(prepareOcrInputs(prepared, baseline, output)).rejects.toThrow(
      "EEXIST",
    );
    const records = [];
    for (const entry of manifest.pages) {
      const image = join(output, entry.image);
      const rawResult = `${entry.inputId}.raw.json`;
      await writeFile(
        join(variants, rawResult),
        JSON.stringify({ input_path: image, rec_texts: [] }),
      );
      records.push({ ...entry, image, rawResult, seconds: 1 });
    }
    const writeRun = (pages: unknown) =>
      writeFile(
        join(variants, "run.json"),
        JSON.stringify({ ...common, pages }),
      );
    await writeRun(records);
    const verified = await loadOcrEvidence(prepared, variants);
    expect(verified.inputs.map((item) => item.record.variant)).toEqual([
      "page-2x",
      "line-2x",
      "page-2x",
      "line-2x",
      "page-2x",
      "line-2x",
    ]);
    const full = records[0];
    const line = records[1];
    for (const bad of [
      { ...full, inputId: "page-69-2x" },
      { ...full, page: "3" },
      {
        ...full,
        baselineOcrFile: records[2].baselineOcrFile,
        baselineOcrHash: records[2].baselineOcrHash,
      },
      { ...full, baselineOcrHash: "b".repeat(64) },
      { ...full, transform: { ...full.transform, scale: 1 } },
      { ...line, crop: { ...line.crop, left: line.crop.left + 1 } },
      { ...line, baselineLineId: 1 },
      { ...full, image: line.image, imageHash: line.imageHash },
    ]) {
      await writeRun([bad]);
      await expect(loadOcrEvidence(prepared, variants)).rejects.toThrow();
    }
    await writeRun([full, full]);
    await expect(loadOcrEvidence(prepared, variants)).rejects.toThrow(
      "duplicate",
    );
    await writeRun(records);
    await writeFile(
      join(variants, full.rawResult),
      JSON.stringify({ input_path: line.image, rec_texts: [] }),
    );
    await expect(loadOcrEvidence(prepared, variants)).rejects.toThrow(
      "result image",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

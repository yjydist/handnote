import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { associateInk } from "@handnote/ink";
import sharp from "sharp";
import { z } from "zod";
import { renderAssociatedPage } from "./automatic.ts";
import { auditCharacterHeights } from "./character-height-audit.ts";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";
import { hash, loadOcrEvidence } from "./ocr-evidence.ts";
import { deriveMappedOcr } from "./word-geometry-evidence.ts";

const save = async (file: string, value: unknown) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(file, bytes, { flag: "wx" });
  return hash(bytes);
};
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const metadataSchema = z.object({
  file: z.string(),
  sha256: z.string(),
  lineCount: z.number().int(),
  rejectedMappings: z.number().int(),
});
const codeFiles = [
  "geometry-diagnostics.ts",
  "word-geometry-evidence.ts",
  "automatic.ts",
  "character-height-audit.ts",
  "exterior-strokes.ts",
  "source-runs.ts",
  "ocr-evidence.ts",
  "../../packages/ink/src/association.ts",
  "../../packages/ink/src/trajectory.ts",
  "../../packages/renderer/src/ink-renderer.ts",
  "../../apps/handnote/src/ink-matching.ts",
];
async function codeHashes() {
  return Object.fromEntries(
    await Promise.all(
      codeFiles.map(async (file) => [
        file,
        hash(await readFile(new URL(file, import.meta.url))),
      ]),
    ),
  );
}

async function lineOverlay(
  pixels: Buffer,
  region: number[],
  polygons: readonly (readonly (readonly number[])[])[],
) {
  const size = await sharp(pixels).metadata();
  assert(size.width && size.height);
  const [x, y, right, bottom] = region as [number, number, number, number];
  const margin = (bottom - y) / 2;
  const left = Math.max(0, Math.floor(x - margin)),
    top = Math.max(0, Math.floor(y - margin));
  const width = Math.min(size.width, Math.ceil(right + margin)) - left,
    height = Math.min(size.height, Math.ceil(bottom + margin)) - top;
  assert(width > 0 && height > 0);
  const shapes = polygons
    .map(
      (points, index) =>
        `<polygon points="${points.map((p) => p.join(",")).join(" ")}" fill="${index % 2 ? "#e46b16" : "#1463cd"}" fill-opacity=".1" stroke="${index % 2 ? "#e46b16" : "#1463cd"}" stroke-width=".7"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">${shapes}</svg>`;
  const overlay = await sharp(pixels)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  return {
    bytes: await sharp(overlay)
      .extract({ left, top, width, height })
      .png()
      .toBuffer(),
    viewport: { left, top, width, height },
  };
}

export async function compareWordGeometry(
  prepared: string,
  baselineOcr: string,
  geometryOcr: string,
  output: string,
) {
  const hashes = await codeHashes();
  const [baseline, capture] = await Promise.all([
    loadOcrEvidence(prepared, baselineOcr),
    loadOcrEvidence(prepared, geometryOcr),
  ]);
  assert.equal(
    baseline.run.modelLockHash,
    capture.run.modelLockHash,
    "OCR models differ",
  );
  assert.deepEqual(
    baseline.run.packages,
    capture.run.packages,
    "OCR packages differ",
  );
  assert.deepEqual(
    baseline.run.parameters,
    capture.run.parameters,
    "OCR parameters differ",
  );
  assert.equal(baseline.inputs.length, 3);
  assert.equal(capture.inputs.length, 3);
  assert(
    [...baseline.inputs, ...capture.inputs].every(
      (input) => input.record.variant === "baseline",
    ),
  );
  const pythonHashes = z
    .record(z.string(), z.string())
    .parse(capture.run.wordGeometryCodeHashes);
  assert.deepEqual(Object.keys(pythonHashes).sort(), [
    "rectified_word_mapping.py",
    "runner.py",
    "word_geometry_capture.py",
  ]);
  for (const [file, expected] of Object.entries(pythonHashes))
    assert.equal(
      hash(await readFile(new URL(`ocr/${file}`, import.meta.url))),
      expected,
      "Capture implementation changed",
    );
  const cases = await Promise.all(
    capture.inputs.map(async (input) => {
      const previous = baseline.inputs.find(
        (entry) => entry.record.inputId === input.record.inputId,
      );
      assert(previous);
      assert.equal(input.record.imageHash, previous.record.imageHash);
      const rawWithPath = z.object({ input_path: z.string() }).passthrough();
      const { input_path: capturedInputPath, ...capturedContent } =
        rawWithPath.parse(input.raw);
      const { input_path: originalInputPath, ...originalContent } =
        rawWithPath.parse(previous.raw);
      assert.deepEqual(
        capturedContent,
        originalContent,
        "Capture changed OCR content",
      );
      const metadata = z
        .object({ wordGeometry: metadataSchema })
        .parse(input.record).wordGeometry;
      assert.equal(metadata.file, `${input.record.inputId}.word-geometry.json`);
      const geometryBytes = await readFile(join(geometryOcr, metadata.file));
      assert.equal(
        hash(geometryBytes),
        metadata.sha256,
        "Stale captured geometry",
      );
      const geometry: unknown = JSON.parse(geometryBytes.toString());
      const derived = deriveMappedOcr(input.rawBytes, geometry, {
        inputId: input.record.inputId,
        imageHash: input.record.imageHash,
      });
      assert.equal(metadata.lineCount, derived.lines.length);
      assert.equal(
        metadata.rejectedMappings,
        derived.lines.filter((line) => line.status === "rejected").length,
      );
      const mappedBytes = Buffer.from(
        `${JSON.stringify(derived.raw, null, 2)}\n`,
      );
      const associate = (raw: unknown, bytes: Uint8Array) =>
        associateInk(input.source, {
          raw,
          transform: input.record.transform,
          ocr: {
            version: `paddleocr-${capture.run.packages.paddleocr}`,
            modelHash: capture.run.modelLockHash,
            resultHash: hash(bytes),
          },
        });
      const original = associate(input.raw, input.rawBytes),
        mapped = associate(derived.raw, mappedBytes);
      assert.deepEqual(original.thresholds, mapped.thresholds);
      const originalExterior = reassessExteriorStrokes(input.source, original),
        mappedExterior = reassessExteriorStrokes(input.source, mapped);
      return {
        input,
        metadata,
        geometryBytes,
        derived,
        mappedBytes,
        original,
        mapped,
        originalExterior,
        mappedExterior,
        originalBytesIdentical:
          hash(input.rawBytes) === hash(previous.rawBytes),
        originalInputPath,
        capturedInputPath,
      };
    }),
  );
  const destination = resolve(output);
  await mkdir(destination);
  await writeFile(join(destination, "baseline-run.json"), baseline.bytes, {
    flag: "wx",
  });
  await writeFile(join(destination, "capture-run.json"), capture.bytes, {
    flag: "wx",
  });
  const evidence = [],
    pages = [],
    diagrams = [],
    sections = [];
  for (const item of cases) {
    const page = item.input.record.page;
    const folder = `page-${page}`;
    await mkdir(join(destination, folder));
    await writeFile(
      join(destination, folder, "source.json"),
      item.input.sourceBytes,
      { flag: "wx" },
    );
    await writeFile(
      join(destination, folder, "ocr.raw.json"),
      item.input.rawBytes,
      { flag: "wx" },
    );
    await writeFile(
      join(destination, folder, "ocr.mapped.synthetic.json"),
      item.mappedBytes,
      { flag: "wx" },
    );
    await writeFile(
      join(destination, folder, "word-geometry.json"),
      item.geometryBytes,
      { flag: "wx" },
    );
    const audits = {
      original: auditCharacterHeights(item.input.source, item.original),
      mapped: auditCharacterHeights(item.input.source, item.mapped),
    };
    const auditHash = await save(
      join(destination, folder, "height-audits.json"),
      audits,
    );
    const originalAssociationHash = await save(
      join(destination, folder, "original.association.json"),
      item.original,
    );
    const mappedAssociationHash = await save(
      join(destination, folder, "mapped.association.json"),
      item.mapped,
    );
    await save(join(destination, folder, "exterior-evidence.json"), {
      original: item.originalExterior,
      mapped: item.mappedExterior,
    });
    evidence.push({
      page,
      sourceHash: item.input.source.sourceHash,
      originalOcrHash: hash(item.input.rawBytes),
      originalBytesIdentical: item.originalBytesIdentical,
      originalInputPath: item.originalInputPath,
      capturedInputPath: item.capturedInputPath,
      originalContentIdentical: true,
      syntheticHash: hash(item.mappedBytes),
      geometryHash: hash(item.geometryBytes),
      auditHash,
      originalAssociationHash,
      mappedAssociationHash,
      lines: item.derived.lines,
    });
    const originalRaw = item.input.raw as {
      text_word_boxes: number[][][];
      rec_boxes: number[][];
    };
    const pixels = await readFile(item.input.record.image);
    for (const line of item.original.lines) {
      const boxes = originalRaw.text_word_boxes[line.lineId],
        region = originalRaw.rec_boxes[line.lineId];
      assert(boxes && region);
      const originalPolygons = boxes.map((b) => [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]],
      ]) as number[][][];
      const changed = item.derived.lines[line.lineId];
      const mappedPolygons =
        changed?.status === "mapped"
          ? changed.projectedWordPolygons
          : originalPolygons;
      const figures = [];
      for (const [mode, polygons] of [
        ["original", originalPolygons],
        ["mapped", mappedPolygons],
      ] as const) {
        const rendered = await lineOverlay(pixels, region, polygons);
        const image = `${folder}/line-${line.lineId}-${mode}.png`;
        await writeFile(join(destination, image), rendered.bytes, {
          flag: "wx",
        });
        diagrams.push({
          page,
          lineId: line.lineId,
          mode,
          image,
          imageHash: hash(rendered.bytes),
          viewport: rendered.viewport,
        });
        figures.push(
          `<figure><figcaption>${mode}</figcaption><a href="${image}"><img src="${image}" alt="${mode} 字框"/></a></figure>`,
        );
      }
      sections.push(
        `<section><h2>页 ${page} / 行 ${line.lineId}：${escapeHtml(line.text)}</h2><div class="grid">${figures.join("")}</div></section>`,
      );
    }
    for (const width of [360, 720, 1200, 1600]) {
      for (const [mode, association, refined] of [
        ["original", item.original, false],
        ["mapped", item.mapped, false],
        ["original-exterior-spacing", item.originalExterior.association, true],
        ["mapped-exterior-spacing", item.mappedExterior.association, true],
      ] as const) {
        const relative = `${width}/${mode}/${folder}`;
        const report = await renderAssociatedPage(item.input, association, {
          directory: join(destination, relative),
          width,
          variant: mode,
          context: refined ? "boundary-edits" : "exact",
          fragmentLayout: refined ? "source-spacing" : "separate",
        });
        pages.push({
          ...report,
          image: `${relative}/note.png`,
          report: `${relative}/report.json`,
        });
      }
    }
  }
  assert.deepEqual(
    await codeHashes(),
    hashes,
    "Geometry diagnostic code changed during rendering",
  );
  const report = {
    annotationStatus: "pending-human-review",
    accuracy: null,
    method: "captured-recognition-crop-inverse-mapping",
    limitation:
      "Word widths still use the original CTC heuristic. Association consumes enclosing axis-aligned boxes; polygons are preserved separately.",
    baselineRunHash: hash(baseline.bytes),
    captureRunHash: hash(capture.bytes),
    codeHashes: hashes,
    pythonHashes,
    evidence,
    pages,
    diagrams,
  };
  await save(join(destination, "report.json"), report);
  const layouts = pages
    .map(
      (page) =>
        `<figure><figcaption>页 ${page.page} / ${page.width}px / ${page.variant} · ${page.inkCharacters}/${page.eligibleCharacters}</figcaption><a href="${page.image}"><img src="${page.image}" alt="排版对照"/></a></figure>`,
    )
    .join("");
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>识别裁图逆映射</title><style>body{font:16px system-ui;margin:24px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;padding:8px;border:1px solid #ccd}img{width:100%;height:auto}section{margin:32px 0}</style><h1>识别裁图逆映射</h1><p>pending-human-review · 原始OCR内容、模型与阈值不变。四边形映射只修复坐标链；字宽仍是CTC估计，关联仍使用轴对齐外接框。</p><h2>排版对照</h2><div class="grid">${layouts}</div>${sections.join("\n")}</html>`,
    { flag: "wx" },
  );
  return destination;
}

if (import.meta.main) {
  const options = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index],
      value = process.argv[index + 1];
    if (
      !key ||
      !value ||
      options.has(key) ||
      !["--prepared", "--baseline-ocr", "--geometry-ocr", "--output"].includes(
        key,
      )
    )
      throw new Error("Invalid geometry diagnostic arguments");
    options.set(key, value);
  }
  const prepared = options.get("--prepared"),
    baseline = options.get("--baseline-ocr"),
    geometry = options.get("--geometry-ocr"),
    output = options.get("--output");
  if (!prepared || !baseline || !geometry || !output)
    throw new Error("Missing geometry diagnostic arguments");
  console.log(await compareWordGeometry(prepared, baseline, geometry, output));
}

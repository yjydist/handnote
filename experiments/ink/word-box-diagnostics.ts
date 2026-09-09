import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { associateInk, type InkAssociationReport } from "@handnote/ink";
import sharp from "sharp";
import { auditCharacterHeights } from "./character-height-audit.ts";
import { hash, loadOcrEvidence } from "./ocr-evidence.ts";
import { partitionWordBoxOverlaps } from "./word-box-partitions.ts";

const fractions = [0.25, 0.5, 0.75] as const;
const save = async (path: string, value: unknown) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx" });
  return hash(bytes);
};
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
type Audit = ReturnType<typeof auditCharacterHeights>;
type Raw = {
  rec_texts: string[];
  rec_scores: number[];
  rec_boxes: number[][];
  text_word: string[][];
  text_word_boxes: number[][][];
};
const codeFiles = [
  "word-box-diagnostics.ts",
  "word-box-partitions.ts",
  "character-height-audit.ts",
  "ocr-evidence.ts",
  "../../packages/ink/src/association.ts",
  "../../packages/ink/src/trajectory.ts",
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

function sampleStability(original: Audit, variants: readonly Audit[]) {
  return original.lines.map((line) => {
    const others = variants.map((audit) =>
      audit.lines.find((other) => other.lineId === line.lineId),
    );
    assert(others.every(Boolean));
    const wordIndices = [
      ...new Set(
        [line, ...others].flatMap(
          (l) => l?.characters.map((c) => c.wordIndex) ?? [],
        ),
      ),
    ].sort((a, b) => a - b);
    return {
      lineId: line.lineId,
      characters: wordIndices.map((wordIndex) => {
        const samples = [line, ...others].map((l) =>
          l?.characters.find((c) => c.wordIndex === wordIndex),
        );
        const first = samples[0];
        const changed = samples.slice(1);
        const reference = changed[0];
        const samePartitionSamples =
          reference?.bounds !== undefined &&
          changed.every(
            (sample) =>
              sample?.bounds !== undefined &&
              JSON.stringify(sample.strokeIndices) ===
                JSON.stringify(reference.strokeIndices),
          );
        const status = samePartitionSamples
          ? first?.bounds === undefined
            ? "new-partition-stable-sample"
            : JSON.stringify(first.strokeIndices) ===
                JSON.stringify(reference.strokeIndices)
              ? "unchanged-sample"
              : "changed-partition-stable-sample"
          : changed.some((sample) => sample?.bounds !== undefined)
            ? "partition-sensitive-sample"
            : "unmeasurable-under-partitions";
        return {
          wordIndex,
          text: samples.find(Boolean)?.text,
          status,
          original: first ?? null,
          partitions: fractions.map((fraction, index) => ({
            fraction,
            sample: changed[index] ?? null,
          })),
        };
      }),
    };
  });
}

function verifyPartition(
  association: InkAssociationReport,
  strokeCount: number,
) {
  const ids = [
    ...association.candidates.flatMap((c) => c.strokeIndices),
    ...association.unusedStrokes.map((s) => s.strokeIndex),
  ].sort((a, b) => a - b);
  assert.deepEqual(
    ids,
    Array.from({ length: strokeCount }, (_, index) => index),
    "Association lost or duplicated original strokes",
  );
}

async function overlay(
  pixels: Buffer,
  dimensions: { width: number; height: number },
  lineBox: number[],
  boxes: number[][],
) {
  const [x, y, right, bottom] = lineBox as [number, number, number, number];
  const margin = (bottom - y) / 2;
  const left = Math.max(0, Math.floor(x - margin));
  const top = Math.max(0, Math.floor(y - margin));
  const width = Math.min(dimensions.width, Math.ceil(right + margin)) - left;
  const height = Math.min(dimensions.height, Math.ceil(bottom + margin)) - top;
  assert(width > 0 && height > 0);
  const rectangles = boxes
    .map((box, index) => {
      const [bx, by, br, bb] = box as [number, number, number, number];
      const color = index % 2 === 0 ? "#1364c8" : "#d85e0b";
      return `<rect x="${bx}" y="${by}" width="${br - bx}" height="${bb - by}" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-width=".6"/><text x="${bx}" y="${by - 2}" font-size="8" fill="${color}">${index}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}">${rectangles}</svg>`;
  const composed = await sharp(pixels)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  return {
    pixels: await sharp(composed)
      .extract({ left, top, width, height })
      .png()
      .toBuffer(),
    viewport: { left, top, width, height },
  };
}

/** Synthetic word-box evidence only. These associations are never used for target binding or rendering. */
export async function diagnoseWordBoxes(
  prepared: string,
  baselineOcr: string,
  output: string,
) {
  const hashes = await codeHashes();
  const baseline = await loadOcrEvidence(prepared, baselineOcr);
  assert.equal(baseline.inputs.length, 3);
  assert(baseline.inputs.every((input) => input.record.variant === "baseline"));
  const inputs = baseline.inputs.map((input) => {
    const ocr = {
      version: `paddleocr-${baseline.run.packages.paddleocr}`,
      modelHash: baseline.run.modelLockHash,
      resultHash: hash(input.rawBytes),
    };
    const association = associateInk(input.source, {
      raw: input.raw,
      transform: input.record.transform,
      ocr,
    });
    // associateInk has validated the arrays and coordinates before they are copied.
    const raw = input.raw as Raw;
    return { input, ocr, association, raw };
  });
  const destination = resolve(output);
  await mkdir(destination);
  await writeFile(join(destination, "baseline-run.json"), baseline.bytes, {
    flag: "wx",
  });
  const pages = [];
  const html = [];
  for (const { input, ocr, association, raw } of inputs) {
    const pageId = input.record.page;
    const relative = `page-${pageId}`;
    const folder = join(destination, relative);
    await mkdir(folder);
    await writeFile(join(folder, "source.json"), input.sourceBytes, {
      flag: "wx",
    });
    await writeFile(join(folder, "ocr.raw.json"), input.rawBytes, {
      flag: "wx",
    });
    const originalAudit = auditCharacterHeights(input.source, association);
    const variants = [];
    for (const fraction of fractions) {
      const modifications = raw.text_word_boxes.map((boxes, lineId) => ({
        lineId,
        ...partitionWordBoxOverlaps(boxes, fraction),
      }));
      const synthetic = {
        ...structuredClone(raw),
        text_word_boxes: modifications.map((line) => line.boxes),
      };
      const syntheticHash = await save(
        join(folder, `partition-${fraction}.synthetic.json`),
        synthetic,
      );
      assert.deepEqual(synthetic.rec_texts, raw.rec_texts);
      assert.deepEqual(synthetic.rec_scores, raw.rec_scores);
      assert.deepEqual(synthetic.rec_boxes, raw.rec_boxes);
      assert.deepEqual(synthetic.text_word, raw.text_word);
      const associated = associateInk(input.source, {
        raw: synthetic,
        transform: input.record.transform,
        ocr: { ...ocr, resultHash: syntheticHash },
      });
      assert.deepEqual(associated.thresholds, association.thresholds);
      variants.push({
        mode: `partition-${fraction}`,
        fraction,
        raw: synthetic,
        association: associated,
        audit: auditCharacterHeights(input.source, associated),
        modifications,
        syntheticHash,
      });
    }
    const modes = [
      {
        mode: "original",
        raw,
        association,
        audit: originalAudit,
        modifications: [],
        fraction: null,
        syntheticHash: null,
      },
      ...variants,
    ];
    const modeReports = [];
    const imageReports = [];
    for (const mode of modes) {
      verifyPartition(mode.association, input.source.strokes.length);
      const associationHash = await save(
        join(folder, `${mode.mode}.association.json`),
        mode.association,
      );
      const auditHash = await save(
        join(folder, `${mode.mode}.height-audit.json`),
        mode.audit,
      );
      modeReports.push({
        mode: mode.mode,
        fraction: mode.fraction,
        syntheticHash: mode.syntheticHash,
        association: `${relative}/${mode.mode}.association.json`,
        associationHash,
        audit: `${relative}/${mode.mode}.height-audit.json`,
        auditHash,
        candidates: mode.association.candidates.length,
        unusedStrokes: mode.association.unusedStrokes.length,
        measurableHan: mode.audit.lines.reduce(
          (sum, line) => sum + line.measurableHanCount,
          0,
        ),
        changedBoundaries: mode.modifications.reduce(
          (sum, line) => sum + line.edits.length,
          0,
        ),
        modifications: mode.modifications,
      });
    }
    const pixels = await readFile(input.record.image);
    const metadata = await sharp(pixels).metadata();
    assert(metadata.width && metadata.height);
    for (const line of association.lines) {
      const figures = [];
      for (const mode of modes) {
        const boxes = mode.raw.text_word_boxes[line.lineId];
        const lineBox = raw.rec_boxes[line.lineId];
        assert(boxes && lineBox);
        const image = await overlay(
          pixels,
          { width: metadata.width, height: metadata.height },
          lineBox,
          boxes,
        );
        const file = `${relative}/line-${line.lineId}-${mode.mode}.png`;
        await writeFile(join(destination, file), image.pixels, { flag: "wx" });
        imageReports.push({
          lineId: line.lineId,
          mode: mode.mode,
          image: file,
          imageHash: hash(image.pixels),
          viewport: image.viewport,
        });
        const measured = mode.audit.lines.find((l) => l.lineId === line.lineId);
        figures.push(
          `<figure><figcaption>${escapeHtml(mode.mode)} · 可测 ${measured?.measurableHanCount}/${measured?.hanCount}</figcaption><a href="${file}"><img src="${file}" alt="${escapeHtml(mode.mode)} 字框与原笔迹"/></a></figure>`,
        );
      }
      html.push(
        `<section><h2>页 ${pageId} / 行 ${line.lineId}：${escapeHtml(line.text)}</h2><div class="grid">${figures.join("")}</div></section>`,
      );
    }
    const stability = sampleStability(
      originalAudit,
      variants.map((v) => v.audit),
    );
    const stabilityHash = await save(
      join(folder, "sample-stability.json"),
      stability,
    );
    const statusCounts: Record<string, number> = {};
    for (const line of stability)
      for (const character of line.characters)
        statusCounts[character.status] =
          (statusCounts[character.status] ?? 0) + 1;
    pages.push({
      page: pageId,
      sourceHash: input.source.sourceHash,
      originalOcrHash: hash(input.rawBytes),
      imageHash: input.record.imageHash,
      transform: input.record.transform,
      originalLineCount: association.lines.length,
      modes: modeReports,
      stability: `${relative}/sample-stability.json`,
      stabilityHash,
      statusCounts,
      images: imageReports,
    });
  }
  assert.deepEqual(
    await codeHashes(),
    hashes,
    "Diagnostic code changed during execution",
  );
  const report = {
    annotationStatus: "pending-human-review",
    accuracy: null,
    method: "original-ocr-overlap-partition-diagnostics",
    use: "diagnostic-only; no automatic binding or typography changes",
    interpretation:
      "Stable samples refer only to identical complete-stroke IDs across the three synthetic partitions, not verified character ownership.",
    baselineRunHash: hash(baseline.bytes),
    codeHashes: hashes,
    fractions,
    pages,
  };
  await save(join(destination, "report.json"), report);
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>OCR 字框重叠诊断</title><style>body{font:16px system-ui;margin:24px;color:#17202a}section{margin:32px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;border:1px solid #ccd;padding:8px}img{width:100%;height:auto}figcaption{margin-bottom:8px}</style><h1>OCR 字框重叠诊断</h1><p>pending-human-review · 固定文字、分数、行身份、原始轨迹及阈值。仅移动相邻字框重叠区的分界；不进入自动绑定。框上数字为原 OCR 字序号。观察窗口边缘的原始笔画可能延伸到窗外。</p>${html.join("\n")}</html>`,
    { flag: "wx" },
  );
  return destination;
}

if (import.meta.main) {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index],
      value = process.argv[index + 1];
    if (
      !key ||
      !value ||
      !["--prepared", "--baseline-ocr", "--output"].includes(key) ||
      args.has(key)
    )
      throw new Error(
        "Expected --prepared, --baseline-ocr and --output exactly once",
      );
    args.set(key, value);
  }
  const prepared = args.get("--prepared"),
    baseline = args.get("--baseline-ocr"),
    output = args.get("--output");
  if (!prepared || !baseline || !output)
    throw new Error("Missing diagnostic arguments");
  console.log(await diagnoseWordBoxes(prepared, baseline, output));
}

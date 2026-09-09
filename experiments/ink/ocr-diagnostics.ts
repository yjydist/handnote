import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  associateInk,
  type Bounds,
  type InkAssociationReport,
} from "@handnote/ink";
import sharp from "sharp";
import { loadOcrEvidence, validateOcrComparison } from "./ocr-evidence.ts";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const save = async (path: string, value: unknown) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, bytes, { flag: "wx" });
  return hash(bytes);
};

export interface DiagnosticLine {
  lineId: number;
  text: string;
  recognitionScore: number;
  bounds: Bounds;
  metrics: InkAssociationReport["lines"][number]["metrics"];
  unusedReason: string | null;
  wordBoxes: readonly (readonly number[])[];
  degenerateWordIndices: number[];
  candidates: InkAssociationReport["candidates"];
}

/** The association parser validates the raw arrays before this summary is built. */
export function summarizeOcrAssociation(
  association: InkAssociationReport,
  raw: unknown,
): DiagnosticLine[] {
  const boxes = (raw as { text_word_boxes: number[][][] }).text_word_boxes;
  return association.lines.map((line) => {
    const wordBoxes = boxes[line.lineId];
    if (!wordBoxes)
      throw new Error(`Missing word boxes for line ${line.lineId}`);
    return {
      ...line,
      unusedReason: line.unusedReason ?? null,
      wordBoxes,
      degenerateWordIndices: wordBoxes.flatMap((box, index) =>
        box[0] === box[2] || box[1] === box[3] ? [index] : [],
      ),
      candidates: association.candidates.filter(
        (candidate) => candidate.lineId === line.lineId,
      ),
    };
  });
}

/** Geometry is in source coordinates, independent of recognition text and input scale. */
export function compareDiagnosticLines(
  baseline: readonly Pick<DiagnosticLine, "lineId" | "bounds">[],
  variants: readonly {
    inputId: string;
    lines: readonly Pick<DiagnosticLine, "lineId" | "bounds">[];
  }[],
) {
  const overlap = (a: Bounds, b: Bounds) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const rows = baseline.map((line) => ({
    baselineLineId: line.lineId,
    matches: variants.flatMap((input) =>
      input.lines.flatMap((candidate) => {
        const area = overlap(line.bounds, candidate.bounds);
        return area > 0
          ? [
              {
                inputId: input.inputId,
                lineId: candidate.lineId,
                intersectionArea: area,
                baselineAreaFraction:
                  area / (line.bounds.width * line.bounds.height),
                variantAreaFraction:
                  area / (candidate.bounds.width * candidate.bounds.height),
              },
            ]
          : [];
      }),
    ),
  }));
  return {
    method: "positive-area-intersection-in-source-coordinates" as const,
    rows,
    unmappedLines: variants.flatMap((input) =>
      input.lines.flatMap((line) =>
        rows.some((row) =>
          row.matches.some(
            (match) =>
              match.inputId === input.inputId && match.lineId === line.lineId,
          ),
        )
          ? []
          : [{ inputId: input.inputId, lineId: line.lineId }],
      ),
    ),
  };
}

const escapeHtml = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const lineHtml = (line: DiagnosticLine) =>
  `<p><b>Line ${line.lineId}</b>: ${escapeHtml(line.text)}<br>score ${line.recognitionScore.toFixed(4)}; degenerate word boxes: ${escapeHtml(JSON.stringify(line.degenerateWordIndices))}<br>metrics: ${escapeHtml(JSON.stringify(line.metrics))}<br>candidate strokes: ${escapeHtml(JSON.stringify(line.candidates.map((candidate) => ({ id: candidate.id, text: candidate.text, strokeRefs: candidate.strokeRefs }))))}</p>`;

export async function compareOcrInputs(
  prepared: string,
  baselineOcr: string,
  variantOcr: string,
  output: string,
): Promise<string> {
  const [baseline, variants] = await Promise.all([
    loadOcrEvidence(prepared, baselineOcr),
    loadOcrEvidence(prepared, variantOcr),
  ]);
  validateOcrComparison(baseline, variants);
  const all = [
    ...baseline.inputs.map((input) => ({ input, run: baseline.run })),
    ...variants.inputs.map((input) => ({ input, run: variants.run })),
  ].map(({ input, run }) => {
    const association = associateInk(input.source, {
      raw: input.raw,
      transform: input.record.transform,
      ocr: {
        version: `paddleocr-${run.packages.paddleocr}`,
        resultHash: hash(input.rawBytes),
        modelHash: run.modelLockHash,
      },
    });
    return {
      input,
      association,
      lines: summarizeOcrAssociation(association, input.raw),
    };
  });
  for (const { input, lines } of all.filter(
    ({ input }) => input.record.variant === "baseline",
  )) {
    const pageInputs = variants.inputs.filter(
      (variant) => variant.record.page === input.record.page,
    );
    const crops = pageInputs.filter(
      (variant) => variant.record.variant === "line-2x",
    );
    if (
      crops.length !== lines.length ||
      lines.some(
        (line) =>
          crops.filter((crop) => crop.record.baselineLineId === line.lineId)
            .length !== 1,
      )
    )
      throw new Error(
        `Expected one diagnostic crop for every baseline line on page ${input.record.page}`,
      );
  }
  const destination = resolve(output);
  await mkdir(destination);
  await writeFile(join(destination, "baseline-run.json"), baseline.bytes, {
    flag: "wx",
  });
  await writeFile(join(destination, "variant-run.json"), variants.bytes, {
    flag: "wx",
  });
  const inputs = [];
  for (const [index, item] of all.entries()) {
    const { input, association, lines } = item;
    const directory = `input-${index}`;
    await mkdir(join(destination, directory));
    const image = await readFile(input.record.image);
    await writeFile(join(destination, directory, "input.png"), image, {
      flag: "wx",
    });
    await writeFile(
      join(destination, directory, "source.json"),
      input.sourceBytes,
      { flag: "wx" },
    );
    await writeFile(
      join(destination, directory, "ocr.raw.json"),
      input.rawBytes,
      { flag: "wx" },
    );
    const sourcesHash = await save(
      join(destination, directory, "sources.json"),
      association,
    );
    const report = {
      ...input.record,
      image: `${directory}/input.png`,
      rawResult: `${directory}/ocr.raw.json`,
      source: `${directory}/source.json`,
      sources: `${directory}/sources.json`,
      imageHash: hash(image),
      rawResultHash: hash(input.rawBytes),
      sourceHash: hash(input.sourceBytes),
      sourcesHash,
      annotationStatus: "pending-human-review",
      role:
        input.record.variant === "line-2x" ? "diagnostic-only" : "whole-page",
      sourceStrokeCount: input.source.strokes.length,
      lines,
    };
    await save(join(destination, directory, "report.json"), report);
    inputs.push(report);
  }
  const pages = [];
  const html: string[] = [];
  for (const original of inputs.filter(
    (input) => input.variant === "baseline",
  )) {
    const alternatives = inputs.filter(
      (input) => input.page === original.page && input.variant !== "baseline",
    );
    const comparison = compareDiagnosticLines(original.lines, alternatives);
    const rows = [];
    const baselineInput = baseline.inputs.find(
      (input) => input.record.page === original.page,
    );
    if (!baselineInput) throw new Error("Missing baseline input");
    const imageBytes = await readFile(baselineInput.record.image);
    const metadata = await sharp(imageBytes).metadata();
    if (!metadata.width || !metadata.height)
      throw new Error("Missing image dimensions");
    html.push(
      `<h2>Page ${escapeHtml(original.page)}</h2><table><thead><tr><th>Baseline source region</th><th>Baseline OCR</th><th>2x whole-page geometric overlaps</th><th>Targeted crop, including recognized neighbors</th></tr></thead><tbody>`,
    );
    for (const row of comparison.rows) {
      const line = original.lines.find(
        (line) => line.lineId === row.baselineLineId,
      );
      if (!line) throw new Error("Missing baseline line");
      const { bounds } = line;
      const transform = baselineInput.record.transform;
      const margin = (bounds.height * transform.scale) / 2;
      const left = Math.max(
        0,
        Math.min(
          metadata.width - 1,
          Math.floor(
            bounds.x * transform.scale + transform.translateX - margin,
          ),
        ),
      );
      const top = Math.max(
        0,
        Math.min(
          metadata.height - 1,
          Math.floor(
            bounds.y * transform.scale + transform.translateY - margin,
          ),
        ),
      );
      const right = Math.max(
        left + 1,
        Math.min(
          metadata.width,
          Math.ceil(
            (bounds.x + bounds.width) * transform.scale +
              transform.translateX +
              margin,
          ),
        ),
      );
      const bottom = Math.max(
        top + 1,
        Math.min(
          metadata.height,
          Math.ceil(
            (bounds.y + bounds.height) * transform.scale +
              transform.translateY +
              margin,
          ),
        ),
      );
      const cropImage = `page-${original.page}-baseline-line-${line.lineId}.png`;
      const cropBytes = await sharp(imageBytes)
        .extract({ left, top, width: right - left, height: bottom - top })
        .png()
        .toBuffer();
      await writeFile(join(destination, cropImage), cropBytes, { flag: "wx" });
      const crop = alternatives.find(
        (input) =>
          input.variant === "line-2x" && input.baselineLineId === line.lineId,
      );
      if (!crop) throw new Error("Missing crop input");
      rows.push({
        ...row,
        sourceCrop: cropImage,
        sourceCropHash: hash(cropBytes),
        sourceCropImageBounds: {
          left,
          top,
          width: right - left,
          height: bottom - top,
        },
        cropInputId: crop.inputId,
        cropRecognizedLineIds: crop.lines.map((line) => line.lineId),
      });
      const wholeLines = row.matches
        .filter((match) =>
          alternatives.some(
            (input) =>
              input.inputId === match.inputId && input.variant === "page-2x",
          ),
        )
        .map((match) => {
          const input = alternatives.find(
            (input) => input.inputId === match.inputId,
          );
          const line = input?.lines.find(
            (line) => line.lineId === match.lineId,
          );
          return input && line
            ? `<a href="${escapeHtml(input.sources)}">association evidence</a>${lineHtml(line)}`
            : "";
        })
        .join("");
      html.push(
        `<tr><td><img src="${escapeHtml(cropImage)}" alt="Baseline source line ${line.lineId}"><a href="${escapeHtml(original.sources)}">baseline associations</a></td><td>${lineHtml(line)}</td><td>${wholeLines || "No positive-area overlap"}</td><td><img src="${escapeHtml(crop.image)}" alt="2x diagnostic crop"><a href="${escapeHtml(crop.rawResult)}">raw OCR</a> · <a href="${escapeHtml(crop.sources)}">associations</a>${crop.lines.map(lineHtml).join("") || "No recognized lines"}</td></tr>`,
      );
    }
    html.push("</tbody></table><h3>Unmapped variant lines</h3>");
    for (const reference of comparison.unmappedLines) {
      const input = alternatives.find(
        (input) => input.inputId === reference.inputId,
      );
      const line = input?.lines.find(
        (line) => line.lineId === reference.lineId,
      );
      if (input && line)
        html.push(
          `<p>${escapeHtml(input.inputId)} <a href="${escapeHtml(input.sources)}">associations</a></p>${lineHtml(line)}`,
        );
    }
    pages.push({
      page: original.page,
      method: comparison.method,
      rows,
      unmappedLines: comparison.unmappedLines,
    });
  }
  await save(join(destination, "report.json"), {
    annotationStatus: "pending-human-review",
    accuracy: null,
    accuracyReason:
      "No human-verified labels. Geometric overlap only joins diagnostic evidence; it does not establish text equivalence or correctness.",
    localCropUse:
      "diagnostic-only; full original source strokes used for association; no local OCR results used for Markdown matching",
    baselineRunHash: hash(baseline.bytes),
    variantRunHash: hash(variants.bytes),
    inputs,
    pages,
  });
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>OCR input diagnostics</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:10px;vertical-align:top;width:25%;overflow-wrap:anywhere}img{display:block;max-width:100%;height:auto}p{white-space:pre-wrap}</style><h1>OCR input diagnostics</h1><p>Pending human review. Scores are model confidence, not accuracy. Rows are anchored to baseline boxes; positive-area source-coordinate overlaps may join multiple lines. Crop output includes all recognized neighbors and is used only for diagnostics.</p><p><a href="report.json">Complete report and evidence hashes</a></p>${html.join("\n")}</html>`,
    { flag: "wx" },
  );
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 8 ||
    args[0] !== "--prepared" ||
    args[2] !== "--baseline-ocr" ||
    args[4] !== "--variant-ocr" ||
    args[6] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5] ||
    !args[7]
  )
    throw new Error(
      "Usage: bun experiments/ink/ocr-diagnostics.ts --prepared <directory> --baseline-ocr <directory> --variant-ocr <directory> --output <new-directory>",
    );
  console.log(await compareOcrInputs(args[1], args[3], args[5], args[7]));
}

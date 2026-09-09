import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { associateInk, parseInkJson, renderInkSvg } from "@handnote/ink";
import {
  type InkReplacement,
  prepareDocument,
  renderPreparedDocument,
} from "@handnote/renderer";
import sharp from "sharp";
import { z } from "zod";
import { matchInkSources } from "../../src/ink-matching.ts";
import development from "./development.json";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const transformSchema = z.object({
  scale: z.number().positive(),
  translateX: z.number(),
  translateY: z.number(),
});
const ocrRunSchema = z.object({
  status: z.literal("complete"),
  modelLockHash: z.string(),
  packages: z.record(z.string(), z.string()),
  pages: z.array(
    z.object({
      page: z.string(),
      image: z.string(),
      imageHash: z.string(),
      sourceHash: z.string(),
      transform: transformSchema,
      rawResult: z.string(),
      seconds: z.number().nonnegative(),
    }),
  ),
});
const save = async (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const counts = (items: readonly { reason: string }[]) =>
  Object.fromEntries(
    [...new Set(items.map((i) => i.reason))]
      .sort()
      .map((reason) => [
        reason,
        items.filter((i) => i.reason === reason).length,
      ]),
  );

export async function renderAutomatic(
  preparedInput: string,
  ocrInput: string,
  output: string,
): Promise<string> {
  const input = resolve(preparedInput);
  const ocrDirectory = resolve(ocrInput);
  const destination = resolve(output);
  const ocrBytes = await readFile(join(ocrDirectory, "run.json"));
  const ocrRun = ocrRunSchema.parse(JSON.parse(ocrBytes.toString("utf8")));
  const inputs = await Promise.all(
    development.pages.map(async (page) => {
      const record = ocrRun.pages.find((entry) => entry.page === page.page);
      if (!record || record.rawResult !== `page-${page.page}.raw.json`)
        throw new Error(`Missing OCR result for page ${page.page}`);
      const sourceBytes = await readFile(
        join(input, `page-${page.page}/source.json`),
      );
      const source = parseInkJson(sourceBytes);
      const markdown = await readFile(
        join(input, `page-${page.page}/note.md`),
        "utf8",
      );
      if (
        source.sourceHash !== page.sourceHash ||
        record.sourceHash !== source.sourceHash ||
        markdown !== page.markdown ||
        hash(await readFile(record.image)) !== record.imageHash
      )
        throw new Error(`Stale input evidence for page ${page.page}`);
      const redraw = renderInkSvg(source, {
        background: "white",
        padding: 10,
      });
      if (
        record.transform.scale !== redraw.transform.scale ||
        record.transform.translateX !== redraw.transform.translateX ||
        record.transform.translateY !== redraw.transform.translateY ||
        hash(await sharp(Buffer.from(redraw.svg)).png().toBuffer()) !==
          record.imageHash
      )
        throw new Error(`Mismatched OCR redraw evidence for page ${page.page}`);
      const rawBytes = await readFile(join(ocrDirectory, record.rawResult));
      const raw: unknown = JSON.parse(rawBytes.toString("utf8"));
      const rawText = z
        .object({
          input_path: z.string().min(1),
          rec_texts: z.array(z.string()),
        })
        .parse(raw);
      if (resolve(rawText.input_path) !== resolve(record.image))
        throw new Error(`Mismatched OCR result image for page ${page.page}`);
      return {
        page,
        record,
        sourceBytes,
        source,
        markdown,
        rawBytes,
        raw,
        sourceLines: rawText.rec_texts,
      };
    }),
  );
  await mkdir(destination);
  await writeFile(join(destination, "ocr-run.json"), ocrBytes, { flag: "wx" });
  const pages = [];
  for (const {
    page,
    record,
    sourceBytes,
    source,
    markdown,
    rawBytes,
    raw,
    sourceLines,
  } of inputs) {
    const started = performance.now();
    const associated = associateInk(source, {
      raw,
      transform: record.transform,
      ocr: {
        version: `paddleocr-${ocrRun.packages.paddleocr}`,
        resultHash: hash(rawBytes),
        modelHash: ocrRun.modelLockHash,
      },
    });
    const prepared = await prepareDocument(markdown);
    const binding = matchInkSources(
      prepared,
      source.sourceHash,
      associated.candidates.map((candidate) => ({
        ...candidate,
        lineId: String(candidate.lineId),
      })),
      sourceLines,
    );
    const replacements: InkReplacement[] = [];
    for (const match of binding.bindings) {
      const candidate = associated.candidates.find(
        (item) => item.id === match.sourceId,
      );
      if (!candidate) throw new Error("Missing source binding");
      const image = renderInkSvg(source, {
        strokeIndices: candidate.strokeIndices,
      });
      replacements.push({
        target: match.target,
        sourceId: candidate.id,
        text: candidate.text,
        png: await sharp(Buffer.from(image.svg)).png().toBuffer(),
        width: image.width,
        height: image.height,
        lineHeight: candidate.lineHeight,
        baseline: candidate.baseline,
      });
    }
    const pageDirectory = join(destination, `page-${page.page}`);
    const render = await renderPreparedDocument(prepared, {
      directory: pageDirectory,
      width: 1200,
      replacements,
    });
    const eligibleCharacters = prepared.textRanges.reduce(
      (sum, range) => sum + Array.from(range.text.replace(/\s/g, "")).length,
      0,
    );
    const inkCharacters = render.replacements
      .filter((item) => item.mode === "ink")
      .reduce(
        (sum, item) => sum + Array.from(item.text.replace(/\s/g, "")).length,
        0,
      );
    await writeFile(join(pageDirectory, "source.json"), sourceBytes, {
      flag: "wx",
    });
    await writeFile(join(pageDirectory, "ocr.raw.json"), rawBytes, {
      flag: "wx",
    });
    await writeFile(join(pageDirectory, "note.md"), markdown, { flag: "wx" });
    await save(join(pageDirectory, "sources.json"), associated);
    await save(join(pageDirectory, "bindings.json"), binding);
    const report = {
      page: page.page,
      status: inkCharacters ? "candidate-result" : "partial-zero-coverage",
      annotationStatus: "pending-human-review",
      coverageDenominator: "fixed-excerpts-only",
      sourceHash: source.sourceHash,
      markdownHash: hash(markdown),
      sourcesHash: hash(JSON.stringify(associated)),
      bindingsHash: hash(JSON.stringify(binding)),
      ocrResultHash: hash(rawBytes),
      imageHash: hash(await readFile(render.imagePath)),
      recognizedLines: sourceLines.length,
      sourceCandidates: associated.candidates.length,
      sourceStrokes: source.strokes.length,
      unusedStrokeReasons: counts(associated.unusedStrokes),
      unusedWordReasons: counts(associated.unusedWords),
      bindingFallbackReasons: counts(binding.unusedSources),
      eligibleCharacters,
      inkCharacters,
      candidateCoverage: eligibleCharacters
        ? inkCharacters / eligibleCharacters
        : 0,
      ocrSeconds: record.seconds,
      associationMatchingRenderingSeconds: (performance.now() - started) / 1000,
      replacements: render.replacements,
      warnings: render.warnings,
      image: `page-${page.page}/note.png`,
    };
    await save(join(pageDirectory, "report.json"), report);
    pages.push(report);
  }
  await save(join(destination, "report.json"), {
    annotationStatus: "pending-human-review",
    scope: "development-excerpts",
    ocrRunHash: hash(ocrBytes),
    accuracy: null,
    accuracyReason:
      "No human-verified source labels; coverage is not accuracy.",
    pages,
  });
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--prepared" ||
    args[2] !== "--ocr-run" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5]
  )
    throw new Error(
      "Usage: bun experiments/ink/automatic.ts --prepared <directory> --ocr-run <directory> --output <new-directory>",
    );
  console.log(await renderAutomatic(args[1], args[3], args[5]));
}

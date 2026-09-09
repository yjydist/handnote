import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { matchInkSources } from "@handnote/app/ink-matching";
import {
  associateInk,
  type InkAssociationReport,
  renderInkSvg,
} from "@handnote/ink";
import {
  type InkReplacement,
  prepareDocument,
  renderPreparedDocument,
} from "@handnote/renderer";
import sharp from "sharp";
import { hash, loadOcrEvidence } from "./ocr-evidence.ts";
import { groupSourceRuns } from "./source-runs.ts";

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

type ExperimentPageInput = Awaited<
  ReturnType<typeof loadOcrEvidence>
>["inputs"][number];

export async function renderAssociatedPage(
  input: ExperimentPageInput,
  associated: InkAssociationReport,
  options: {
    directory: string;
    width: number;
    variant: string;
    startedAt?: number;
    context?: "exact" | "boundary-edits";
    fragmentLayout?: "separate" | "source-runs" | "source-spacing";
    /** Diagnostic hypothesis only; unavailable line metrics still fall back. */
    characterHeightReferences?: ReadonlyMap<number, number>;
  },
) {
  const { page, record, sourceBytes, source, markdown, rawBytes, sourceLines } =
    input;
  const { width, variant } = options;
  const started = options.startedAt ?? performance.now();
  const prepared = await prepareDocument(markdown);
  const binding = matchInkSources(
    prepared,
    source.sourceHash,
    associated.candidates.map((candidate) => ({
      ...candidate,
      lineId: String(candidate.lineId),
    })),
    associated.lines.map((line) => ({
      lineId: String(line.lineId),
      text: line.text,
      bounds: line.bounds,
    })),
    { context: options.context ?? "exact" },
  );
  const replacements: InkReplacement[] = [];
  const metricFallbacks = [];
  const renderFragments = [];
  const sourceRuns = groupSourceRuns(binding.bindings, associated.candidates, {
    mode:
      options.fragmentLayout === "source-spacing"
        ? "overlapping-images"
        : "whole-run",
  });
  const groups =
    options.fragmentLayout === "source-runs" ||
    options.fragmentLayout === "source-spacing"
      ? sourceRuns
      : sourceRuns.flatMap((run) =>
          run.bindings.map((match, index) => {
            const candidate = run.candidates[index];
            if (!candidate) throw new Error("Missing source run candidate");
            return { bindings: [match], candidates: [candidate] };
          }),
        );
  for (const group of groups) {
    const first = group.bindings[0];
    const last = group.bindings.at(-1);
    if (!first || !last) throw new Error("Missing source run binding");
    const candidate = group.candidates[0];
    if (!candidate) throw new Error("Missing source binding");
    const strokeIndices = group.candidates
      .flatMap((item) => item.strokeIndices)
      .sort((a, b) => a - b);
    const match = {
      target: { ...first.target, end: last.target.end },
      targetId: `${first.target.rangeId}:${first.target.start}-${last.target.end}`,
      sourceId: `${source.sourceHash}:${strokeIndices.join(",")}`,
      text: group.bindings.map((item) => item.text).join(""),
    };
    const line = associated.lines.find(
      (line) => line.lineId === candidate.lineId,
    );
    if (!line || line.metrics.status !== "available") {
      metricFallbacks.push({ ...match, reason: "incomplete-line-metrics" });
      continue;
    }
    const image = renderInkSvg(source, {
      strokeIndices,
    });
    const proposedHeight = options.characterHeightReferences?.get(
      candidate.lineId,
    );
    const bodyHeight = proposedHeight ?? line.metrics.bodyHeight;
    renderFragments.push({
      ...match,
      candidateIds: group.candidates.map((item) => item.id),
      strokeIndices,
      sourceBounds: image.bounds,
      layoutReference: {
        bodyHeight,
        bodyBottom: line.metrics.bodyBottom,
        method:
          proposedHeight === undefined
            ? line.metrics.method
            : "observed-character-median-hypothesis",
      },
    });
    replacements.push({
      target: match.target,
      sourceId: match.sourceId,
      text: match.text,
      png: await sharp(Buffer.from(image.svg)).png().toBuffer(),
      width: image.width,
      height: image.height,
      lineHeight: candidate.lineHeight,
      baseline: line.metrics.bodyBottom - image.bounds.y,
      layout: {
        mode: "shared-line",
        lineId: `${source.sourceHash}:${candidate.lineId}`,
        sourceTop: image.bounds.y,
        bodyHeight,
        bodyBottom: line.metrics.bodyBottom,
        ...(options.fragmentLayout === "source-spacing"
          ? {
              sourceSpan: {
                left: image.bounds.x,
                start: candidate.occurrence.start,
                end:
                  group.candidates.at(-1)?.occurrence.end ??
                  candidate.occurrence.end,
              },
            }
          : {}),
      },
    });
  }
  const pageDirectory = options.directory;
  const render = await renderPreparedDocument(prepared, {
    directory: pageDirectory,
    width,
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
    variant,
    matchingContext: options.context ?? "exact",
    fragmentLayout: options.fragmentLayout ?? "separate",
    width,
    status: inkCharacters ? "candidate-result" : "partial-zero-coverage",
    annotationStatus: "pending-human-review",
    coverageDenominator: "fixed-excerpts-only",
    sourceHash: source.sourceHash,
    markdownHash: hash(markdown),
    sourcesHash: hash(JSON.stringify(associated)),
    bindingsHash: hash(JSON.stringify(binding)),
    ocrResultHash: hash(rawBytes),
    associationInputHash: associated.ocr.resultHash,
    imageHash: hash(await readFile(render.imagePath)),
    recognizedLines: sourceLines.length,
    sourceCandidates: associated.candidates.length,
    sourceStrokes: source.strokes.length,
    unusedStrokeReasons: counts(associated.unusedStrokes),
    unusedWordReasons: counts(associated.unusedWords),
    bindingFallbackReasons: counts(binding.unusedSources),
    metricFallbackReasons: counts(metricFallbacks),
    metricFallbacks,
    layoutMethod: options.characterHeightReferences
      ? "observed-character-median-hypothesis"
      : "complete-line-visible-envelope",
    eligibleCharacters,
    inkCharacters,
    candidateCoverage: eligibleCharacters
      ? inkCharacters / eligibleCharacters
      : 0,
    ocrSeconds: record.seconds,
    ...(options.startedAt === undefined
      ? { matchingRenderingSeconds: (performance.now() - started) / 1000 }
      : {
          associationMatchingRenderingSeconds:
            (performance.now() - started) / 1000,
        }),
    replacements: render.replacements,
    renderFragments,
    sourceSpacing: render.sourceSpacing,
    warnings: render.warnings,
    image: `page-${page.page}/note.png`,
  };
  await save(join(pageDirectory, "report.json"), report);
  return report;
}

export async function renderAutomatic(
  preparedInput: string,
  ocrInput: string,
  output: string,
  options: { variant?: "baseline" | "page-2x"; width?: number } = {},
): Promise<string> {
  const input = resolve(preparedInput);
  const ocrDirectory = resolve(ocrInput);
  const destination = resolve(output);
  const {
    bytes: ocrBytes,
    run: ocrRun,
    inputs: allInputs,
  } = await loadOcrEvidence(input, ocrDirectory);
  const variant = options.variant ?? "baseline";
  const width = options.width ?? 1200;
  if (![720, 1200, 1600].includes(width))
    throw new Error("Unsupported comparison width");
  const inputs = allInputs.filter((entry) => entry.record.variant === variant);
  if (inputs.length !== 3)
    throw new Error("Expected three whole-page OCR inputs");
  await mkdir(destination);
  await writeFile(join(destination, "ocr-run.json"), ocrBytes, { flag: "wx" });
  const pages = [];
  for (const input of inputs) {
    const { page, record, source, raw, rawBytes } = input;
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
    const report = await renderAssociatedPage(input, associated, {
      directory: join(destination, `page-${page.page}`),
      width,
      variant,
      startedAt: started,
    });
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

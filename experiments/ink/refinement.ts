import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { associateInk } from "@handnote/ink";
import { renderAssociatedPage } from "./automatic.ts";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";
import {
  hash,
  loadOcrEvidence,
  validateOcrComparison,
} from "./ocr-evidence.ts";
import { refineOcrPage } from "./refine-ocr.ts";

const save = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

async function readCodeHashes() {
  return Object.fromEntries(
    await Promise.all(
      [
        "automatic.ts",
        "refine-ocr.ts",
        "exterior-strokes.ts",
        "refinement.ts",
        "source-runs.ts",
        "ocr-evidence.ts",
        "../../apps/handnote/src/ink-matching.ts",
        "../../packages/ink/src/association.ts",
        "../../packages/ink/src/trajectory.ts",
        "../../packages/renderer/src/ink-renderer.ts",
      ].map(async (file) => [
        file,
        hash(await readFile(new URL(file, import.meta.url))),
      ]),
    ),
  );
}

export async function runRefinement(
  prepared: string,
  baselineOcr: string,
  variantOcr: string,
  output: string,
) {
  const codeHashes = await readCodeHashes();
  const baseline = await loadOcrEvidence(prepared, baselineOcr);
  const variants = await loadOcrEvidence(prepared, variantOcr);
  validateOcrComparison(baseline, variants);
  const cases = baseline.inputs.map((input) => {
    const crops = variants.inputs.filter(
      (variant) =>
        variant.record.page === input.page.page &&
        variant.record.variant === "line-2x",
    );
    if (
      crops.length !== input.sourceLines.length ||
      input.sourceLines.some(
        (_, lineId) =>
          crops.filter((crop) => crop.record.baselineLineId === lineId)
            .length !== 1,
      )
    )
      throw new Error("Expected every original line crop exactly once");
    const refinement = refineOcrPage(
      { raw: input.raw, transform: input.record.transform },
      crops.map((crop) => ({
        inputId: crop.record.inputId,
        baselineLineId: crop.record.baselineLineId ?? -1,
        raw: crop.raw,
        transform: crop.record.transform,
        resultHash: hash(crop.rawBytes),
      })),
    );
    const refinedBytes = Buffer.from(
      `${JSON.stringify(refinement.raw, null, 2)}\n`,
    );
    const associate = (raw: unknown, bytes: Uint8Array) =>
      associateInk(input.source, {
        raw,
        transform: input.record.transform,
        ocr: {
          version: `paddleocr-${baseline.run.packages.paddleocr}`,
          resultHash: hash(bytes),
          modelHash: baseline.run.modelLockHash,
        },
      });
    const original = associate(input.raw, input.rawBytes);
    const refined = associate(refinement.raw, refinedBytes);
    const exterior = reassessExteriorStrokes(input.source, refined);
    return { input, refinement, refinedBytes, original, refined, exterior };
  });
  const destination = resolve(output);
  await mkdir(destination);
  await writeFile(join(destination, "baseline-run.json"), baseline.bytes, {
    flag: "wx",
  });
  await writeFile(join(destination, "variant-run.json"), variants.bytes, {
    flag: "wx",
  });
  const reports: (Awaited<ReturnType<typeof renderAssociatedPage>> & {
    report: string;
  })[] = [];
  const evidence = [];
  for (const item of cases) {
    const pageDirectory = `page-${item.input.page.page}`;
    await mkdir(join(destination, pageDirectory));
    await save(
      join(destination, pageDirectory, "refinement.json"),
      item.refinement,
    );
    await writeFile(
      join(destination, pageDirectory, "ocr.refined.json"),
      item.refinedBytes,
      { flag: "wx" },
    );
    await save(
      join(destination, pageDirectory, "baseline-association.json"),
      item.original,
    );
    await save(
      join(destination, pageDirectory, "refined-association.json"),
      item.refined,
    );
    await save(
      join(destination, pageDirectory, "exterior-strokes.json"),
      item.exterior,
    );
    evidence.push({
      page: item.input.page.page,
      refinement: `${pageDirectory}/refinement.json`,
      associationInput: `${pageDirectory}/ocr.refined.json`,
      associationInputHash: hash(item.refinedBytes),
      exterior: `${pageDirectory}/exterior-strokes.json`,
    });
    for (const width of [360, 720, 1200, 1600]) {
      for (const [mode, association] of [
        ["baseline", item.original],
        ["refined", item.refined],
        ["refined-exterior", item.exterior.association],
        ["boundary-edits", item.exterior.association],
        ["source-runs", item.exterior.association],
        ["source-spacing", item.exterior.association],
      ] as const) {
        const relative = `${width}/${mode}/${pageDirectory}`;
        const report = await renderAssociatedPage(item.input, association, {
          directory: join(destination, relative),
          width,
          variant: mode,
          context:
            mode === "boundary-edits" ||
            mode === "source-runs" ||
            mode === "source-spacing"
              ? "boundary-edits"
              : "exact",
          fragmentLayout:
            mode === "source-spacing"
              ? "source-spacing"
              : mode === "source-runs"
                ? "source-runs"
                : "separate",
        });
        reports.push({
          ...report,
          image: `${relative}/note.png`,
          report: `${relative}/report.json`,
        });
      }
    }
  }
  if (JSON.stringify(codeHashes) !== JSON.stringify(await readCodeHashes()))
    throw new Error(
      "Experiment code changed during rendering; outputs are incomplete",
    );
  await save(join(destination, "report.json"), {
    annotationStatus: "pending-human-review",
    accuracy: null,
    method: "baseline-context-exact-text-crop-refinement",
    baselineRunHash: hash(baseline.bytes),
    variantRunHash: hash(variants.bytes),
    codeHashes,
    evidence,
    pages: reports,
  });
  const sections = cases.flatMap(({ input }) =>
    [360, 720, 1200, 1600].map(
      (width) =>
        `<section><h2>第 ${input.page.page} 页 · ${width}px</h2><p><a href="page-${input.page.page}/refinement.json">识别取舍证据</a> · <a href="page-${input.page.page}/exterior-strokes.json">外侧笔画度量证据</a></p><div>${[
          "baseline",
          "refined",
          "refined-exterior",
          "boundary-edits",
          "source-runs",
          "source-spacing",
        ]
          .map((mode) => {
            const report = reports.find(
              (item) =>
                item.page === input.page.page &&
                item.width === width &&
                item.variant === mode,
            );
            if (!report) throw new Error("Missing refinement output");
            return `<figure><figcaption>${mode} · ${report.inkCharacters}/${report.eligibleCharacters} · <a href="${report.report}">报告</a></figcaption><a href="${report.image}"><img src="${report.image}" alt="${input.page.page} ${mode}"></a></figure>`;
          })
          .join("")}</div></section>`,
    ),
  );
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>来源上下文与外侧笔画实验</title><style>body{font:16px system-ui;margin:24px;background:#f4f4f4}section{margin-bottom:32px}section>div{display:flex;gap:16px}figure{width:16.66%;min-width:0;margin:0}img{width:100%}figcaption{margin-bottom:10px}</style><h1>来源上下文与外侧笔画实验</h1><p>待人工核验。保留整页原文上下文，局部识别只更新文字完全一致的同位置行。外侧笔画规则是独立实验，不改动原轨迹；第四组仅放宽圈号前缀和句末标点的上下文匹配。第五组将源文和目标都连续的已绑定片段一起重绘，保留原始空隙；整段过宽仍回退字体，不能据此替代可换行排版。第六组只合并包围盒相交的连续片段，有空隙的片段间保留换行机会，并在换行或字体回退时移除空隙。</p>${sections.join("")}</html>`,
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
      "Usage: bun experiments/ink/refinement.ts --prepared <directory> --baseline-ocr <directory> --variant-ocr <directory> --output <new-directory>",
    );
  console.log(await runRefinement(args[1], args[3], args[5], args[7]));
}

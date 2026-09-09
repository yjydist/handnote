import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareDocument, renderPreparedDocument } from "@handnote/renderer";
import { renderAutomatic } from "./automatic.ts";
import {
  hash,
  loadOcrEvidence,
  validateOcrComparison,
} from "./ocr-evidence.ts";

export async function renderOcrComparison(
  prepared: string,
  baselineOcr: string,
  variantOcr: string,
  output: string,
) {
  const baseline = await loadOcrEvidence(prepared, baselineOcr);
  const variants = await loadOcrEvidence(prepared, variantOcr);
  validateOcrComparison(baseline, variants);
  const destination = resolve(output);
  await mkdir(destination);
  const rows: {
    page: string;
    width: number;
    mode: string;
    inkCharacters: number;
    eligibleCharacters: number;
    image: string;
    report: string;
  }[] = [];
  for (const width of [720, 1200, 1600]) {
    for (const variant of ["baseline", "page-2x"] as const) {
      const relative = `${width}/${variant}`;
      await mkdir(join(destination, String(width)), { recursive: true });
      await renderAutomatic(
        prepared,
        variant === "baseline" ? baselineOcr : variantOcr,
        join(destination, relative),
        { width, variant },
      );
      const report = JSON.parse(
        await readFile(join(destination, relative, "report.json"), "utf8"),
      );
      for (const page of report.pages)
        rows.push({
          page: page.page as string,
          width,
          mode: variant as string,
          inkCharacters: page.inkCharacters as number,
          eligibleCharacters: page.eligibleCharacters as number,
          image: `${relative}/${page.image}`,
          report: `${relative}/page-${page.page}/report.json`,
        });
    }
    for (const input of baseline.inputs) {
      const relative = `${width}/font/page-${input.page.page}`;
      const document = await prepareDocument(input.markdown);
      const directory = join(destination, relative);
      const render = await renderPreparedDocument(document, {
        directory,
        width,
        replacements: [],
      });
      const eligibleCharacters = document.textRanges.reduce(
        (sum, range) => sum + Array.from(range.text.replace(/\s/g, "")).length,
        0,
      );
      const report = {
        annotationStatus: "pending-human-review",
        page: input.page.page,
        width,
        inkCharacters: 0,
        eligibleCharacters,
        warnings: render.warnings,
        markdownHash: hash(input.markdown),
        sourceHash: input.source.sourceHash,
        imageHash: hash(await readFile(render.imagePath)),
      };
      await writeFile(
        join(directory, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        { flag: "wx" },
      );
      await writeFile(join(directory, "note.md"), input.markdown, {
        flag: "wx",
      });
      rows.push({
        page: input.page.page,
        width,
        mode: "font",
        inkCharacters: 0,
        eligibleCharacters,
        image: `${relative}/note.png`,
        report: `${relative}/report.json`,
      });
    }
  }
  await writeFile(
    join(destination, "comparison.json"),
    `${JSON.stringify({ annotationStatus: "pending-human-review", accuracy: null, baselineRunHash: hash(baseline.bytes), variantRunHash: hash(variants.bytes), rows }, null, 2)}\n`,
    { flag: "wx" },
  );
  const sections = ["2", "69", "70"].flatMap((page) =>
    [720, 1200, 1600].map(
      (width) =>
        `<section><h2>第 ${page} 页 · ${width}px</h2><div class="comparison">${[
          "font",
          "baseline",
          "page-2x",
        ]
          .map((mode) => {
            const row = rows.find(
              (item) =>
                item.page === page &&
                item.width === width &&
                item.mode === mode,
            );
            if (!row) throw new Error("Missing comparison output");
            return `<figure><figcaption>${mode} · ${row.inkCharacters}/${row.eligibleCharacters} · <a href="${row.report}">报告</a></figcaption><a href="${row.image}"><img src="${row.image}" alt="${page} ${mode}"></a></figure>`;
          })
          .join("")}</div></section>`,
    ),
  );
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>第三轮 OCR 混排对照</title><style>body{font:16px system-ui;margin:24px;background:#f4f4f4}section{margin-bottom:36px}.comparison{display:flex;gap:16px}figure{margin:0;width:33.3%;min-width:0}img{width:100%;background:white}figcaption{margin-bottom:12px}</style><h1>第三轮 OCR 混排对照</h1><p>待人工核验 · 固定摘录覆盖，不是准确率。点击图片查看原始尺寸。</p>${sections.join("")}</html>`,
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
      "Usage: bun experiments/ink/ocr-comparison.ts --prepared <directory> --baseline-ocr <directory> --variant-ocr <directory> --output <new-directory>",
    );
  console.log(await renderOcrComparison(args[1], args[3], args[5], args[7]));
}

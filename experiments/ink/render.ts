import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createInkCandidate,
  type InkDocument,
  parseInkJson,
  renderInkSvg,
} from "@handnote/ink";
import {
  type DocumentTarget,
  type InkReplacement,
  type PreparedDocument,
  prepareDocument,
  renderPreparedDocument,
} from "@handnote/renderer";
import sharp from "sharp";
import development from "./development.json";

export const comparisonWidths = [720, 1200, 1600] as const;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function locate(
  document: PreparedDocument,
  text: string,
  occurrence: number,
): DocumentTarget {
  let seen = 0;
  for (const range of document.textRanges) {
    for (
      let start = range.text.indexOf(text);
      start !== -1;
      start = range.text.indexOf(text, start + 1)
    ) {
      if (seen++ === occurrence)
        return {
          documentHash: document.documentHash,
          rangeId: range.rangeId,
          start,
          end: start + text.length,
        };
    }
  }
  throw new Error(
    `Fixed candidate has no format-compatible target: ${text} occurrence ${occurrence}`,
  );
}

async function fragment(document: InkDocument, selection: readonly number[]) {
  const rendered = renderInkSvg(document, { strokeIndices: selection });
  return {
    ...rendered,
    png: await sharp(Buffer.from(rendered.svg)).png().toBuffer(),
  };
}

export async function renderComparison(
  input: string,
  output: string,
): Promise<string> {
  const inputDirectory = resolve(input);
  const outputDirectory = resolve(output);
  const inputs = await Promise.all(
    development.pages.map(async (page) => {
      const source = parseInkJson(
        await readFile(join(inputDirectory, `page-${page.page}/source.json`)),
      );
      const markdown = await readFile(
        join(inputDirectory, `page-${page.page}/note.md`),
        "utf8",
      );
      if (source.sourceHash !== page.sourceHash || markdown !== page.markdown)
        throw new Error(
          `Page ${page.page}: stale experiment source or Markdown`,
        );
      return {
        page,
        source,
        markdown,
        prepared: await prepareDocument(markdown),
      };
    }),
  );
  await mkdir(outputDirectory, { recursive: false });
  const reports = [];
  for (const { page, source, markdown, prepared } of inputs) {
    const natural: InkReplacement[] = [];
    const fixed: InkReplacement[] = [];
    const fixedFallbacks = [];
    for (const selection of page.fragments) {
      const target = locate(prepared, selection.text, selection.occurrence);
      const candidate = createInkCandidate(source, selection);
      const ink = await fragment(source, selection.strokeIndices);
      natural.push({
        target,
        sourceId: candidate.id,
        text: candidate.text,
        png: ink.png,
        width: ink.width,
        height: ink.height,
        lineHeight: candidate.lineHeight,
        baseline: candidate.baseline,
      });
      if (!("singleCharacterStrokeGroups" in selection)) {
        fixedFallbacks.push({
          sourceId: candidate.id,
          target,
          text: candidate.text,
          reason: "no-separable-character-candidate",
        });
        continue;
      }
      const groups = selection.singleCharacterStrokeGroups;
      if (
        groups.flat().join(",") !== selection.strokeIndices.join(",") ||
        groups.length !== Array.from(selection.text).length
      )
        throw new Error("Invalid complete-stroke character partition");
      let offset = target.start;
      for (const [index, text] of Array.from(selection.text).entries()) {
        const indices = groups[index];
        if (!indices) throw new Error("Missing character strokes");
        const character = await fragment(source, indices);
        // Fixed character cells are an experiment-only control, preserving each complete character.
        const png = await sharp(character.png)
          .resize(64, 64, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();
        fixed.push({
          target: { ...target, start: offset, end: offset + text.length },
          sourceId: `${source.sourceHash}:${indices.join(",")}`,
          text,
          png,
          width: 64,
          height: 64,
          lineHeight: 64,
          baseline: 54,
        });
        offset += text.length;
      }
    }
    const eligibleCharacters = prepared.textRanges.reduce(
      (sum, range) => sum + Array.from(range.text.replace(/\s/g, "")).length,
      0,
    );
    for (const width of comparisonWidths) {
      for (const [mode, replacements] of [
        ["font", []],
        ["fixed-character", fixed],
        ["natural", natural],
      ] as const) {
        const relative = `page-${page.page}/${width}/${mode}`;
        const directory = join(outputDirectory, relative);
        const render = await renderPreparedDocument(prepared, {
          directory,
          width,
          replacements,
        });
        await writeFile(join(directory, "note.md"), markdown, { flag: "wx" });
        const inkCharacters = render.replacements
          .filter((result) => result.mode === "ink")
          .reduce(
            (sum, result) =>
              sum + Array.from(result.text.replace(/\s/g, "")).length,
            0,
          );
        const report = {
          page: page.page,
          mode,
          width,
          height: render.height,
          sourceHash: source.sourceHash,
          markdownHash: hash(markdown),
          candidatesHash: hash(JSON.stringify(page.fragments)),
          bindingHash: hash(
            JSON.stringify(
              replacements.map(({ png, ...binding }) => ({
                ...binding,
                pngHash: hash(png),
              })),
            ),
          ),
          imageHash: hash(await readFile(render.imagePath)),
          eligibleCharacters,
          inkCharacters,
          candidateCoverage: eligibleCharacters
            ? inkCharacters / eligibleCharacters
            : 0,
          coverageDenominator: "fixed-excerpts-only",
          annotationStatus: "pending-human-review",
          replacements: render.replacements,
          warnings: render.warnings,
          fixedFallbacks: mode === "fixed-character" ? fixedFallbacks : [],
          image: `${relative}/note.png`,
          html: `${relative}/note.html`,
        };
        await writeFile(
          join(directory, "report.json"),
          `${JSON.stringify(report, null, 2)}\n`,
          { flag: "wx" },
        );
        reports.push(report);
      }
    }
  }
  await writeFile(
    join(outputDirectory, "comparison.json"),
    `${JSON.stringify(
      {
        annotationStatus: "pending-human-review",
        coverageDenominator: "fixed-excerpts-only",
        widths: comparisonWidths,
        reports,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  const rows = reports
    .map(
      (row) =>
        `<tr><td>${row.page}</td><td>${row.width}</td><td>${row.mode}</td><td>${row.inkCharacters}/${row.eligibleCharacters}</td><td><a href="${row.image}">PNG</a> · <a href="${row.html}">HTML</a></td></tr>`,
    )
    .join("");
  await writeFile(
    join(outputDirectory, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>原笔迹排版对照</title><style>body{font:16px sans-serif;max-width:1100px;margin:40px auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:10px}img{max-width:100%}</style><h1>原笔迹排版对照</h1><p>所有片段与转写待人工核验。覆盖分母仅为固定摘录，不是整页准确率。固定字框仅使用三页标题的候选完整单字分组，其余文字明确回退，不切断连笔。</p><table><tr><th>页</th><th>宽度</th><th>方式</th><th>候选笔迹字符</th><th>产物</th></tr>${rows}</table><h2>第69页：1200px 自然片段</h2><img src="page-69/1200/natural/note.png">`,
    { flag: "wx" },
  );
  return outputDirectory;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--input" ||
    args[2] !== "--output" ||
    !args[1] ||
    !args[3]
  )
    throw new Error(
      "Usage: bun experiments/ink/render.ts --input <prepared-directory> --output <new-directory>",
    );
  console.log(await renderComparison(args[1], args[3]));
}

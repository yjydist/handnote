import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInkCandidate,
  type InkDocument,
  type InkRendering,
  parseInkJson,
  renderInkSvg,
  strokeBounds,
} from "@handnote/ink";
import sharp from "sharp";
import development from "./development.json";

const repository = fileURLToPath(new URL("../../", import.meta.url));

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function numberedSvg(document: InkDocument, rendering: InkRendering): string {
  const { scale, translateX, translateY } = rendering.transform;
  const labels = rendering.strokeRefs.map(({ strokeIndex }) => {
    const stroke = document.strokes[strokeIndex];
    if (!stroke) throw new Error(`Missing stroke ${strokeIndex}`);
    const bounds = strokeBounds(stroke);
    const x = bounds.x * scale + translateX;
    const y = bounds.y * scale + translateY;
    return `<text x="${x}" y="${Math.max(9, y)}" font-family="sans-serif" font-size="9" fill="#c00000" stroke="white" stroke-width="2" paint-order="stroke">${strokeIndex}</text>`;
  });
  return rendering.svg.replace("</svg>", `${labels.join("")}</svg>`);
}

export async function prepareExperiment(output: string): Promise<string> {
  const outputDirectory = resolve(output);
  const sources = await Promise.all(
    development.pages.map(async (page) => {
      const bytes = await readFile(join(repository, page.source));
      const document = parseInkJson(bytes);
      if (document.sourceHash !== page.sourceHash) {
        throw new Error(
          `Page ${page.page} changed; candidate stroke references need renewed review`,
        );
      }
      const seen = new Set<number>();
      for (const fragment of page.fragments) {
        for (const index of fragment.strokeIndices) {
          if (seen.has(index))
            throw new Error(`Page ${page.page} reuses stroke ${index}`);
          seen.add(index);
        }
      }
      return { page, document, bytes };
    }),
  );
  await mkdir(dirname(outputDirectory), { recursive: true });
  // An experiment owns a new directory; reruns must never replace earlier evidence.
  await mkdir(outputDirectory);
  const ocrPages = [];
  const pages = [];
  for (const { page, document, bytes } of sources) {
    const pageDirectory = join(outputDirectory, `page-${page.page}`);
    const fragmentsDirectory = join(pageDirectory, "fragments");
    await mkdir(fragmentsDirectory, { recursive: true });
    await writeFile(join(pageDirectory, "source.json"), bytes, { flag: "wx" });
    await copyFile(
      join(repository, page.sourceImage),
      join(pageDirectory, "original.png"),
      constants.COPYFILE_EXCL,
    );
    await writeFile(join(pageDirectory, "note.md"), page.markdown, {
      flag: "wx",
    });
    const rendering = renderInkSvg(document, {
      background: "white",
      padding: 10,
    });
    await writeFile(join(pageDirectory, "redraw.svg"), rendering.svg, {
      flag: "wx",
    });
    await sharp(Buffer.from(rendering.svg))
      .png()
      .toFile(join(pageDirectory, "redraw.png"));
    const numbered = renderInkSvg(document, {
      background: "white",
      scale: 2,
      padding: 20,
    });
    await sharp(Buffer.from(numberedSvg(document, numbered)))
      .png()
      .toFile(join(pageDirectory, "stroke-indices.png"));
    const candidates = [];
    const overlay = [];
    for (const fragment of page.fragments) {
      const candidate = createInkCandidate(document, fragment);
      const ink = renderInkSvg(document, {
        strokeIndices: fragment.strokeIndices,
      });
      await writeFile(
        join(fragmentsDirectory, `${fragment.key}.svg`),
        ink.svg,
        { flag: "wx" },
      );
      await sharp(Buffer.from(ink.svg))
        .png()
        .toFile(join(fragmentsDirectory, `${fragment.key}.png`));
      const numbered = renderInkSvg(document, {
        strokeIndices: fragment.strokeIndices,
        scale: 3,
        padding: 16,
        background: "white",
      });
      await sharp(Buffer.from(numberedSvg(document, numbered)))
        .png()
        .toFile(join(fragmentsDirectory, `${fragment.key}-indices.png`));
      const singleCharacters = [];
      if ("singleCharacterStrokeGroups" in fragment) {
        for (const [
          index,
          strokeIndices,
        ] of fragment.singleCharacterStrokeGroups.entries()) {
          const character = renderInkSvg(document, { strokeIndices });
          const image = `fragments/${fragment.key}-char-${index}.png`;
          await sharp(Buffer.from(character.svg))
            .png()
            .toFile(join(pageDirectory, image));
          singleCharacters.push({
            text: Array.from(fragment.text)[index],
            strokeIndices,
            image,
            bounds: character.bounds,
            transform: character.transform,
            baseline: fragment.baseline - character.bounds.y,
            lineHeight: fragment.lineHeight,
          });
        }
      }
      candidates.push({
        ...candidate,
        key: fragment.key,
        target: { text: fragment.text, occurrence: fragment.occurrence },
        image: `fragments/${fragment.key}.png`,
        width: ink.width,
        height: ink.height,
        transform: ink.transform,
        singleCharacters,
      });
      const x = candidate.bounds.x + rendering.transform.translateX;
      const y = candidate.bounds.y + rendering.transform.translateY;
      overlay.push(
        `<rect x="${x}" y="${y}" width="${candidate.bounds.width}" height="${candidate.bounds.height}" fill="none" stroke="#bd1e59" stroke-width="1"/><text x="${x}" y="${Math.max(9, y - 3)}" font-family="sans-serif" font-size="10" fill="#bd1e59" stroke="white" stroke-width="2" paint-order="stroke">${fragment.key}</text>`,
      );
    }
    await sharp(
      Buffer.from(rendering.svg.replace("</svg>", `${overlay.join("")}</svg>`)),
    )
      .png()
      .toFile(join(pageDirectory, "overlay.png"));
    await writeJson(join(pageDirectory, "candidates.json"), {
      status: development.status,
      coverageDenominator: development.coverageDenominator,
      sourceHash: document.sourceHash,
      candidates,
    });
    const pageSummary = {
      page: page.page,
      source: page.source,
      sourceHash: document.sourceHash,
      markdownHash: createHash("sha256").update(page.markdown).digest("hex"),
      markdownCharacters: Array.from(page.markdown).length,
      candidateCharacters: candidates.reduce(
        (count, candidate) => count + Array.from(candidate.text).length,
        0,
      ),
      candidateCount: candidates.length,
      sourceStrokeCount: document.strokes.length,
      selectedStrokeCount: candidates.reduce(
        (count, candidate) => count + candidate.strokeIndices.length,
        0,
      ),
    };
    pages.push(pageSummary);
    ocrPages.push({
      page: page.page,
      image: `page-${page.page}/redraw.png`,
      source: `page-${page.page}/source.json`,
      sourceHash: document.sourceHash,
      transform: rendering.transform,
    });
  }
  await writeJson(join(outputDirectory, "ocr-input.json"), { pages: ocrPages });
  await writeJson(join(outputDirectory, "manifest.json"), {
    status: development.status,
    coverageDenominator: development.coverageDenominator,
    provenance: development.provenance,
    createdAt: new Date().toISOString(),
    pages,
  });
  await writeFile(
    join(outputDirectory, "README.md"),
    "# 原笔迹排版实验输入\n\n所有转写、片段、行高和基线均为待人工核验候选。候选由 agent 查看原图和轨迹片段准备，未使用 OCR 作为真值。Markdown 是固定实验摘录，覆盖分母只限摘录，不能报告整页准确率。\n\n每页保留原始 JSON、原图、统一黑色重绘、候选框叠图及全页与片段笔画编号叠图。编号是原数组的零基索引。透明片段仅包含完整笔画；未选择的轨迹不等于错误或无关。第 2 页括号笔画 800 未选入文字，第 69 页孤立点 883 归属不明并留在原图。三页标题的单字分组也需要人工核验；第 70 页第二字的转写尤其存疑。\n\n排版与 OCR 对照共用源文件哈希和固定摘录。OCR 可读取 ocr-input.json；坐标满足 image = source * scale + translation。\n",
    { flag: "wx" },
  );
  return outputDirectory;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error(
      "Usage: bun experiments/ink/prepare.ts --output <new-directory>",
    );
  }
  console.log(await prepareExperiment(args[1]));
}

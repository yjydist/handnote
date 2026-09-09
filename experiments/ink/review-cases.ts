import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Bounds,
  type InkAssociationReport,
  type InkCandidate,
  type InkDocument,
  parseInkJson,
  renderInkSvg,
  strokeBounds,
} from "@handnote/ink";
import sharp from "sharp";
import { z } from "zod";

const boxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const rawSchema = z.object({
  rec_texts: z.array(z.string()),
  rec_scores: z.array(z.number()),
  rec_boxes: z.array(boxSchema),
  text_word: z.array(z.array(z.string())),
  text_word_boxes: z.array(z.array(boxSchema)),
});
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const save = (path: string, data: unknown) =>
  writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });

interface PreparedCandidate extends InkCandidate {
  key: string;
  lineId: string;
}
interface BindingEvidence {
  bindings: { sourceId: string; text: string }[];
  unusedSources: { sourceId: string; reason: string }[];
}

function union(boxes: readonly Bounds[], padding: number): Bounds {
  const left = Math.min(...boxes.map((box) => box.x)) - padding;
  const top = Math.min(...boxes.map((box) => box.y)) - padding;
  return {
    x: left,
    y: top,
    width: Math.max(...boxes.map((box) => box.x + box.width)) + padding - left,
    height: Math.max(...boxes.map((box) => box.y + box.height)) + padding - top,
  };
}
function imageBounds(values: readonly number[]): Bounds {
  const [x = 0, y = 0, right = 0, bottom = 0] = values;
  return { x, y, width: right - x, height: bottom - y };
}
function rectangle(box: Bounds, color: string, label: string): string {
  return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="1.2"/><text x="${box.x}" y="${box.y - 4}" font-size="10" font-family="sans-serif" fill="${color}" stroke="white" stroke-width="2" paint-order="stroke">${escapeHtml(label)}</text>`;
}
async function numberedFragment(
  document: InkDocument,
  indices: readonly number[],
  path: string,
) {
  const image = renderInkSvg(document, {
    strokeIndices: indices,
    scale: 3,
    padding: 16,
    background: "white",
  });
  const labels = indices.map((index) => {
    const stroke = document.strokes[index];
    if (!stroke) throw new Error(`Missing complete stroke ${index}`);
    const bounds = strokeBounds(stroke);
    return `<text x="${bounds.x * 3 + image.transform.translateX}" y="${Math.max(10, bounds.y * 3 + image.transform.translateY)}" font-size="9" font-family="sans-serif" fill="#bc1837" stroke="white" stroke-width="2" paint-order="stroke">${index}</text>`;
  });
  await sharp(
    Buffer.from(image.svg.replace("</svg>", `${labels.join("")}</svg>`)),
  )
    .png()
    .toFile(path);
}

export async function createReviewCases(
  preparedInput: string,
  automaticInput: string,
  output: string,
): Promise<string> {
  const prepared = resolve(preparedInput);
  const automatic = resolve(automaticInput);
  const destination = resolve(output);
  const pages = await Promise.all(
    ["69", "70"].map(async (page) => {
      const sourceBytes = await readFile(
        join(prepared, `page-${page}/source.json`),
      );
      const document = parseInkJson(sourceBytes);
      const rawBytes = await readFile(
        join(automatic, `page-${page}/ocr.raw.json`),
      );
      const raw = rawSchema.parse(JSON.parse(rawBytes.toString("utf8")));
      const association: InkAssociationReport = JSON.parse(
        await readFile(join(automatic, `page-${page}/sources.json`), "utf8"),
      );
      const fixed: { sourceHash: string; candidates: PreparedCandidate[] } =
        JSON.parse(
          await readFile(
            join(prepared, `page-${page}/candidates.json`),
            "utf8",
          ),
        );
      const bindings: BindingEvidence = JSON.parse(
        await readFile(join(automatic, `page-${page}/bindings.json`), "utf8"),
      );
      const redraw = renderInkSvg(document, { padding: 10 });
      if (
        association.sourceHash !== document.sourceHash ||
        fixed.sourceHash !== document.sourceHash ||
        association.ocr.resultHash !== hash(rawBytes) ||
        JSON.stringify(association.transform) !==
          JSON.stringify(redraw.transform)
      ) {
        throw new Error(`Mismatched fixed source evidence for page ${page}`);
      }
      return { page, document, raw, association, fixed, bindings, redraw };
    }),
  );
  const specifications = [
    {
      id: "settlement-occurrences",
      page: "70",
      title: "独立“聚落”与“聚落类型”来自不同位置",
      lineIds: [1, 3],
      manualKeys: ["70-2"],
      explanation:
        "OCR 行 L1 的“聚落”来自笔画 269–283；固定片段 C70-2 的“聚落类型”来自另一物理行的 285–314。两组原笔画不能相互借用。本轮 L1 候选因 no-exact-context 回退；L3 原 OCR 为“0聚溶类型”，低于固定识别门槛。",
    },
    {
      id: "weather-occurrences",
      page: "69",
      title: "重复“天气”保留各自来源实例",
      lineIds: [0, 5, 9, 11, 18],
      manualKeys: ["69-1", "69-2", "69-3"],
      explanation:
        "标题、定义、预报、诗句与穿衣例句中的“天气”来自不同位置。固定候选只选了标题、定义与诗句三处；自动候选另包含预报行的一处。本轮仅标题形成最终绑定。低置信度或没有可用笔迹的其他 OCR 行仍须参与实例判断。",
    },
    {
      id: "degenerate-word-boxes",
      page: "69",
      title: "OCR 行 L12 的七个字框高度为零",
      lineIds: [12],
      manualKeys: [],
      explanation:
        "原始 OCR 的 L12/W0–W6 全部满足 y1 = y2 = 372。图中用红线和端点保留零高度事实，不人为扩出矩形。附近编号笔画仅用于定位，不声明它们分别属于哪个 OCR 字。该行以 degenerate-word-box 回退，没有自动片段。",
    },
  ];
  await mkdir(destination);
  const cases = [];
  for (const spec of specifications) {
    const page = pages.find((page) => page.page === spec.page);
    if (!page) throw new Error(`Missing page ${spec.page}`);
    const directory = join(destination, spec.id);
    await mkdir(directory);
    const lines = spec.lineIds.map((lineId) => {
      const line = page.association.lines.find(
        (line) => line.lineId === lineId,
      );
      const box = page.raw.rec_boxes[lineId];
      const words = page.raw.text_word[lineId];
      const wordBoxes = page.raw.text_word_boxes[lineId];
      if (!line || !box || !words || !wordBoxes)
        throw new Error(`Missing OCR line ${lineId}`);
      return {
        ...line,
        rawLineBox: box,
        words: words.map((text, wordIndex) => ({
          wordIndex,
          text,
          rawBox: wordBoxes[wordIndex],
        })),
      };
    });
    const manual = page.fixed.candidates.filter((candidate) =>
      spec.manualKeys.includes(candidate.key),
    );
    if (manual.length !== spec.manualKeys.length)
      throw new Error("Missing fixed candidate");
    const automaticCandidates = page.association.candidates.filter(
      (candidate) => spec.lineIds.includes(candidate.lineId),
    );
    const annotations = lines.map((line) =>
      rectangle(imageBounds(line.rawLineBox), "#2463b4", `L${line.lineId}`),
    );
    for (const candidate of manual)
      annotations.push(
        rectangle(
          {
            ...candidate.bounds,
            x: candidate.bounds.x + page.redraw.transform.translateX,
            y: candidate.bounds.y + page.redraw.transform.translateY,
          },
          "#b32669",
          `C${candidate.key}`,
        ),
      );
    const wordAnnotations: string[] = [];
    for (const line of lines)
      for (const word of line.words) {
        if (!word.rawBox) throw new Error("Missing raw word box");
        const box = imageBounds(word.rawBox);
        const label = `L${line.lineId}/W${word.wordIndex}`;
        if (box.height === 0 || box.width === 0) {
          wordAnnotations.push(
            `<line x1="${box.x}" y1="${box.y}" x2="${box.x + box.width}" y2="${box.y + box.height}" stroke="#d0182d" stroke-width="2"/><circle cx="${box.x}" cy="${box.y}" r="2" fill="#d0182d"/><text x="${box.x}" y="${box.y - 7 - (word.wordIndex % 2) * 12}" font-size="9" font-family="sans-serif" fill="#d0182d">${label}</text>`,
          );
        } else wordAnnotations.push(rectangle(box, "#26805c", label));
      }
    const inner = page.redraw.svg
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "");
    const region = union(
      lines.map((line) => imageBounds(line.rawLineBox)),
      28,
    );
    const wrap = (content: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(region.width * 2)}" height="${Math.ceil(region.height * 2)}" viewBox="${region.x} ${region.y} ${region.width} ${region.height}"><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="white"/>${inner}${content}</svg>`;
    await sharp(Buffer.from(wrap(annotations.join(""))))
      .png()
      .toFile(join(directory, "locations.png"));
    await sharp(
      Buffer.from(wrap([...annotations, ...wordAnnotations].join(""))),
    )
      .png()
      .toFile(join(directory, "ocr-boxes.png"));
    const candidates = [];
    for (const candidate of manual) {
      const image = `manual-${candidate.key}.png`;
      await numberedFragment(
        page.document,
        candidate.strokeIndices,
        join(directory, image),
      );
      candidates.push({
        kind: "fixed-visual-candidate",
        id: candidate.id,
        key: candidate.key,
        lineId: candidate.lineId,
        text: candidate.text,
        strokeIndices: candidate.strokeIndices,
        image,
      });
    }
    for (const [index, candidate] of automaticCandidates.entries()) {
      const image = `automatic-L${candidate.lineId}-${index}.png`;
      await numberedFragment(
        page.document,
        candidate.strokeIndices,
        join(directory, image),
      );
      candidates.push({
        kind: "automatic-candidate",
        id: candidate.id,
        lineId: candidate.lineId,
        text: candidate.text,
        strokeIndices: candidate.strokeIndices,
        occurrence: candidate.occurrence,
        recognition: candidate.recognition,
        binding:
          page.bindings.bindings.find(
            (binding) => binding.sourceId === candidate.id,
          ) ??
          page.bindings.unusedSources.find(
            (binding) => binding.sourceId === candidate.id,
          ),
        image,
      });
    }
    const vicinity = page.document.strokes
      .filter((stroke) => {
        const bounds = strokeBounds(stroke);
        return lines.some(
          (line) =>
            bounds.x <= line.bounds.x + line.bounds.width &&
            bounds.x + bounds.width >= line.bounds.x &&
            bounds.y <= line.bounds.y + line.bounds.height &&
            bounds.y + bounds.height >= line.bounds.y,
        );
      })
      .map((stroke) => stroke.index);
    await numberedFragment(
      page.document,
      vicinity,
      join(directory, "nearby-strokes.png"),
    );
    const data = {
      id: spec.id,
      title: spec.title,
      page: spec.page,
      status: "pending-human-review",
      explanation: spec.explanation,
      sourceHash: page.document.sourceHash,
      ocr: page.association.ocr,
      transform: page.association.transform,
      indexConvention: "zero-based original stroke, OCR line and word indices",
      vicinityMeaning:
        "Complete strokes with bounding boxes intersecting the OCR line region; geometric vicinity only, not character membership",
      nearbyStrokeIndices: vicinity,
      lines,
      candidates,
      unusedStrokes: page.association.unusedStrokes
        .filter(
          (stroke) =>
            vicinity.includes(stroke.strokeIndex) ||
            stroke.evidence.some((evidence) =>
              spec.lineIds.includes(evidence.lineId),
            ),
        )
        .map((stroke) => ({
          ...stroke,
          reviewRelevance: stroke.evidence.some((evidence) =>
            spec.lineIds.includes(evidence.lineId),
          )
            ? "association-evidence"
            : "line-bounds-intersection-only",
        })),
      unusedWords: page.association.unusedWords.filter((word) =>
        spec.lineIds.includes(word.lineId),
      ),
      images: ["locations.png", "ocr-boxes.png", "nearby-strokes.png"],
    };
    await save(join(directory, "case.json"), data);
    cases.push(data);
  }
  await save(join(destination, "cases.json"), {
    status: "pending-human-review",
    prepared,
    automatic,
    cases,
  });
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>原笔迹来源核验案例</title><style>body{max-width:1120px;margin:32px auto;padding:0 24px;font:16px/1.7 system-ui;color:#17202b;background:#f7f8fa}nav,a{color:#17599a}section{margin:40px 0;padding:24px;background:white;border:1px solid #d9dfe8;border-radius:12px}img{max-width:100%;height:auto;background:white;border:1px solid #e0e3e7}figure{margin:22px 0}figcaption{font-size:14px;color:#4e5968}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}code{overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.badge{color:#923700;font-weight:600}h1,h2{line-height:1.3}</style><h1>原笔迹来源核验案例</h1><p class="badge">全部待人工核验 · pending-human-review</p><p>这些案例定位现有开发页证据，不是准确率评测。蓝框为原 OCR 行，绿框为原 OCR 字框，紫框为固定视觉候选，红色编号为原笔画索引。所有索引从零开始。零高框保持为红线；不根据框猜分字归属。</p><nav>${cases.map((item) => `<a href="#${item.id}">${escapeHtml(item.title)}</a>`).join(" · ")} · <a href="cases.json">结构化索引</a></nav>${cases.map((item) => `<section id="${item.id}"><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.explanation)}</p><p><a href="${item.id}/case.json">case.json：来源哈希、原 OCR 框、完整笔画索引与回退原因</a></p><figure><a href="${item.id}/locations.png"><img src="${item.id}/locations.png" alt="来源行和固定候选位置"></a><figcaption>来源位置；可点击查看原尺寸。</figcaption></figure><details><summary>查看原始 OCR 字框及附近笔画编号</summary><figure><img src="${item.id}/ocr-boxes.png" alt="OCR原字框"><figcaption>字框仅用于展示原始识别证据。</figcaption></figure><figure><img src="${item.id}/nearby-strokes.png" alt="附近完整笔画编号"><figcaption>附近笔画仅按 bbox 相交选取，可能包括邻行或装饰；不表示字归属。</figcaption></figure></details><div class="grid">${item.candidates.map((candidate) => `<figure><img src="${item.id}/${candidate.image}" alt="候选完整笔画编号"><figcaption>${escapeHtml(candidate.kind)} · ${escapeHtml(candidate.text)} · lineId ${escapeHtml(String(candidate.lineId))}<br>笔画：${candidate.strokeIndices.join(", ")}</figcaption></figure>`).join("")}</div><details><summary>查看本案例完整结构化证据</summary><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></details></section>`).join("")}</html>`;
  await writeFile(join(destination, "index.html"), html, { flag: "wx" });
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--prepared" ||
    args[2] !== "--automatic" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5]
  )
    throw new Error(
      "Usage: bun experiments/ink/review-cases.ts --prepared <directory> --automatic <directory> --output <new-directory>",
    );
  console.log(await createReviewCases(args[1], args[3], args[5]));
}

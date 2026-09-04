import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import katex from "katex";
import { type Browser, chromium } from "playwright";
import sharp from "sharp";
import type { Block, NoteDocument, Section } from "./document.ts";
import { HandnoteError } from "./errors.ts";
import { displayMetadata, regionPixels } from "./image.ts";
import { atomicWrite } from "./utils.ts";

export interface LayoutWarning {
  code: string;
  message: string;
  blocking: boolean;
  elementId?: string;
  axis?: "horizontal";
  overflowPx?: number;
  containerPx?: number;
  contentPx?: number;
}

export interface RenderResult {
  htmlPath: string;
  imagePath: string;
  width: number;
  height: number;
  warnings: LayoutWarning[];
  structure: {
    sections: number;
    blocks: number;
    diagrams: number;
    tables: number;
    sourceFigures: number;
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function fontCss(): Promise<string> {
  const directory = resolve(
    packageRoot,
    "node_modules/@fontsource-variable/noto-sans-sc",
  );
  let css = await readFile(`${directory}/wght.css`, "utf8");
  const matches = [...css.matchAll(/url\((\.\/files\/[^)]+\.woff2)\)/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  for (const relative of new Set(matches)) {
    const data = await readFile(resolve(directory, relative));
    css = css.replaceAll(
      `url(${relative})`,
      `url(data:font/woff2;base64,${data.toString("base64")})`,
    );
  }
  return css.replaceAll("'Noto Sans SC Variable'", "'Handnote Noto Sans SC'");
}

async function katexCss(): Promise<string> {
  const directory = resolve(packageRoot, "node_modules/katex/dist");
  let css = await readFile(`${directory}/katex.min.css`, "utf8");
  const sources = [...css.matchAll(/src:url\(fonts\/([^)]+\.woff2)\)[^}]*/g)];
  for (const match of sources) {
    const declaration = match[0];
    const filename = match[1];
    if (!declaration || !filename) continue;
    const data = await readFile(resolve(directory, "fonts", filename));
    css = css.replace(
      declaration,
      `src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2")`,
    );
  }
  if (/url\(fonts\//.test(css))
    throw new Error("KaTeX CSS contains unresolved font URLs");
  return css;
}

async function sourceFigureData(
  sourcePath: string,
  block: Extract<Block, { type: "source_figure" }>,
): Promise<string> {
  const metadata = await displayMetadata(sourcePath);
  const pixels = regionPixels(block.region, metadata.width, metadata.height);
  const data = await sharp(sourcePath)
    .rotate()
    .extract(pixels)
    .normalize()
    .sharpen({ sigma: 0.6 })
    .png()
    .toBuffer();
  return `data:image/png;base64,${data.toString("base64")}`;
}

async function renderBlock(
  block: Block,
  sourcePath: string,
  warnings: LayoutWarning[],
): Promise<string> {
  const attrs = `class="block block-${block.type}" data-block-id="${escapeHtml(block.id)}"`;
  switch (block.type) {
    case "paragraph":
      return `<p ${attrs}>${escapeHtml(block.text)}</p>`;
    case "bullet_list": {
      const items = (values: typeof block.items): string =>
        `<ul>${values.map((item) => `<li>${escapeHtml(item.text)}${item.children?.length ? items(item.children as typeof block.items) : ""}</li>`).join("")}</ul>`;
      return `<div ${attrs}>${items(block.items)}</div>`;
    }
    case "numbered_steps":
      return `<ol ${attrs}>${block.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`;
    case "callout":
      return `<aside ${attrs} data-tone="${block.tone}">${escapeHtml(block.text)}</aside>`;
    case "table":
      return `<div class="block block-table table-wrap" data-block-id="${escapeHtml(block.id)}"><table><thead><tr>${block.headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    case "equation": {
      try {
        const equation = katex.renderToString(block.latex, {
          displayMode: true,
          throwOnError: true,
          output: "html",
        });
        return `<div ${attrs}>${equation}${block.label ? `<div class="caption">${escapeHtml(block.label)}</div>` : ""}</div>`;
      } catch {
        warnings.push({
          code: "equation_fallback",
          message: `Invalid KaTeX in ${block.id}; rendered as text`,
          blocking: false,
          elementId: block.id,
        });
        return `<pre ${attrs}>${escapeHtml(block.latex)}</pre>`;
      }
    }
    case "diagram":
      return `<div ${attrs}><pre class="mermaid">${escapeHtml(block.mermaid)}</pre></div>`;
    case "source_figure":
      return `<figure ${attrs}><img src="${await sourceFigureData(sourcePath, block)}" alt="${escapeHtml(block.caption ?? "Source figure")}" />${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
  }
}

async function renderSection(
  section: Section,
  sourcePath: string,
  warnings: LayoutWarning[],
  depth = 2,
): Promise<string> {
  const heading = Math.min(depth, 6);
  const blocks = await Promise.all(
    section.blocks.map((block) => renderBlock(block, sourcePath, warnings)),
  );
  const children = await Promise.all(
    (section.sections ?? []).map((child) =>
      renderSection(
        child,
        sourcePath,
        warnings,
        depth + (section.title ? 1 : 0),
      ),
    ),
  );
  const title = section.title
    ? `<h${heading}>${escapeHtml(section.title)}</h${heading}>`
    : "";
  return `<section data-section-id="${escapeHtml(section.id)}">${title}${blocks.join("")}${children.join("")}</section>`;
}

function countStructure(document: NoteDocument): RenderResult["structure"] {
  const value = {
    sections: 0,
    blocks: 0,
    diagrams: 0,
    tables: 0,
    sourceFigures: 0,
  };
  const visit = (section: Section) => {
    value.sections++;
    value.blocks += section.blocks.length;
    value.diagrams += section.blocks.filter(
      (block) => block.type === "diagram",
    ).length;
    value.tables += section.blocks.filter(
      (block) => block.type === "table",
    ).length;
    value.sourceFigures += section.blocks.filter(
      (block) => block.type === "source_figure",
    ).length;
    for (const child of section.sections ?? []) visit(child);
  };
  for (const section of document.sections) visit(section);
  return value;
}

async function buildHtml(
  document: NoteDocument,
  sourcePath: string,
  width: number,
  warnings: LayoutWarning[],
): Promise<string> {
  const [font, math, mermaid, sections] = await Promise.all([
    fontCss(),
    katexCss(),
    readFile(
      resolve(packageRoot, "node_modules/mermaid/dist/mermaid.min.js"),
      "utf8",
    ),
    Promise.all(
      document.sections.map((section) =>
        renderSection(section, sourcePath, warnings),
      ),
    ),
  ]);
  const title = document.title ? `<h1>${escapeHtml(document.title)}</h1>` : "";
  const pageClass = document.title ? "page has-title" : "page";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><style>${font}${math}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;background:#edf1f4;color:#17212b;font-family:'Handnote Noto Sans SC',sans-serif}body{padding:48px}.page{width:${width - 96}px;background:#fff;border-radius:18px;padding:64px 72px;box-shadow:0 12px 40px #17212b18;overflow:visible}.page:not(.has-title)>section:first-of-type>h2:first-child{margin-top:0}h1{font-size:48px;line-height:1.2;margin:0 0 20px}h2{font-size:32px;border-bottom:2px solid #e7edf2;padding-bottom:10px;margin-top:42px}h3{font-size:26px}h4,h5,h6{font-size:21px}p,li,td,th,aside{font-size:20px;line-height:1.75;overflow-wrap:anywhere}.block{margin:18px 0}.block-callout{border-left:6px solid #5d88b3;background:#eef6ff;padding:18px 24px;border-radius:8px}.block-callout[data-tone=warning]{border-color:#db9b30;background:#fff7e6}.block-callout[data-tone=tip]{border-color:#4b9b72;background:#edfbf4}.table-wrap{overflow:visible}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #cfdae3;padding:12px;vertical-align:top}th{background:#f3f6f8}figure{text-align:center}img{max-width:100%;height:auto}figcaption,.caption,small{display:block;color:#607282;margin-top:8px}.mermaid{display:flex;justify-content:center;white-space:pre-wrap}.mermaid svg{max-width:100%;height:auto}.katex-display{overflow:visible}.block-equation{overflow-wrap:anywhere}pre.block-equation{white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px}</style></head><body><main class="${pageClass}">${title}${sections.join("")}</main><script>${mermaid}</script><script>window.__handnoteReady=false;window.__handnoteMermaidError='';(async()=>{try{mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});await mermaid.run({querySelector:'.mermaid'});}catch(error){window.__handnoteMermaidError=error instanceof Error?error.message:String(error);}finally{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.__handnoteReady=true;}})();</script></body></html>`;
}

async function screenshotTall(
  browser: Browser,
  htmlPath: string,
  imagePath: string,
  width: number,
): Promise<{ width: number; height: number; warnings: LayoutWarning[] }> {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.waitForFunction(
    () =>
      (globalThis as typeof globalThis & { __handnoteReady?: boolean })
        .__handnoteReady === true,
    undefined,
    { timeout: 30_000 },
  );
  const result = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const height = Math.ceil(
      Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      ),
    );
    const warnings: LayoutWarning[] = [];
    const runtime = globalThis as typeof globalThis & {
      __handnoteMermaidError?: string;
    };
    const diagramErrorIds = new Set<string>();
    for (const marker of document.querySelectorAll(".error-icon")) {
      const block = marker.closest<HTMLElement>("[data-block-id]");
      if (block?.dataset.blockId) diagramErrorIds.add(block.dataset.blockId);
    }
    for (const id of diagramErrorIds)
      warnings.push({
        code: "diagram_render_error",
        message: `Diagram ${id} failed to render`,
        blocking: true,
        elementId: id,
      });
    if (runtime.__handnoteMermaidError && diagramErrorIds.size === 0)
      warnings.push({
        code: "diagram_render_error",
        message: `Diagram rendering failed: ${runtime.__handnoteMermaidError}`,
        blocking: true,
      });
    const documentOverflow = Math.ceil(
      document.documentElement.scrollWidth - width,
    );
    if (documentOverflow > 1)
      warnings.push({
        code: "horizontal_overflow",
        message: `Document content is ${documentOverflow}px wider than the configured ${width}px output`,
        blocking: true,
        axis: "horizontal",
        overflowPx: documentOverflow,
        containerPx: width,
        contentPx: document.documentElement.scrollWidth,
      });
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-block-id]",
    )) {
      const rect = element.getBoundingClientRect();
      const id = element.dataset.blockId;
      if (rect.width <= 0 || rect.height <= 0)
        warnings.push({
          code: "zero_size",
          message: `Block ${id} has zero size`,
          blocking: true,
          ...(id ? { elementId: id } : {}),
        });
      if (rect.left < 0 || rect.right > width + 1)
        warnings.push({
          code: "clipped",
          message: `Block ${id} is clipped`,
          blocking: true,
          ...(id ? { elementId: id } : {}),
        });
      const horizontalOverflow = Math.ceil(
        element.scrollWidth - element.clientWidth,
      );
      if (horizontalOverflow > 1)
        warnings.push({
          code: "element_horizontal_overflow",
          message: `Block ${id} content is ${horizontalOverflow}px wider than its ${element.clientWidth}px container; change the visible block content or layout, not its source regions`,
          blocking: true,
          axis: "horizontal",
          overflowPx: horizontalOverflow,
          containerPx: element.clientWidth,
          contentPx: element.scrollWidth,
          ...(id ? { elementId: id } : {}),
        });
    }
    return { width, height, warnings };
  });
  const segmentHeight = 12_000;
  if (result.height <= segmentHeight) {
    await page.screenshot({ path: imagePath, fullPage: true });
  } else {
    const parts: Array<{ input: Buffer; top: number; left: number }> = [];
    for (let y = 0; y < result.height; y += segmentHeight) {
      const height = Math.min(segmentHeight, result.height - y);
      const input = await page.screenshot({
        type: "png",
        clip: { x: 0, y, width, height },
      });
      parts.push({ input, top: y, left: 0 });
    }
    await sharp({
      create: {
        width,
        height: result.height,
        channels: 4,
        background: "#ffffff",
      },
    })
      .composite(parts)
      .png()
      .toFile(imagePath);
  }
  await page.close();
  return result;
}

export async function renderDocument(
  document: NoteDocument,
  sourcePath: string,
  runDirectory: string,
  revision: number,
  width: number,
): Promise<RenderResult> {
  const warnings: LayoutWarning[] = [];
  const directory = `${runDirectory}/intermediate/revisions`;
  const htmlPath = `${directory}/revision-${String(revision).padStart(3, "0")}.html`;
  const imagePath = `${directory}/revision-${String(revision).padStart(3, "0")}.png`;
  let browser: Browser | undefined;
  try {
    const html = await buildHtml(document, sourcePath, width, warnings);
    await atomicWrite(htmlPath, html);
    browser = await chromium.launch({ headless: true });
    const screenshot = await screenshotTall(
      browser,
      htmlPath,
      imagePath,
      width,
    );
    warnings.push(...screenshot.warnings);
    return {
      htmlPath,
      imagePath,
      width: screenshot.width,
      height: screenshot.height,
      warnings,
      structure: countStructure(document),
    };
  } catch (error) {
    if (error instanceof HandnoteError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code &&
      ["EACCES", "ENOSPC", "EROFS", "EMFILE", "ENFILE"].includes(code)
    )
      throw new HandnoteError(
        "Renderer could not write its artifacts",
        "filesystem",
        false,
        {
          cause: error,
        },
      );
    throw new HandnoteError(
      "Renderer failed; ensure Chromium is installed with `bunx playwright install chromium`",
      "rendering",
      false,
      { cause: error },
    );
  } finally {
    await browser?.close();
  }
}

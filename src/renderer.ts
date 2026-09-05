import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium } from "playwright";
import sharp from "sharp";
import { parseSrcset } from "srcset";
import { HandnoteError } from "./errors.ts";
import {
  type CompiledNote,
  MarkdownValidationError,
  type NoteStructure,
} from "./markdown.ts";
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
  structure: NoteStructure;
}

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

async function buildHtml(note: CompiledNote, width: number): Promise<string> {
  const [font, math, mermaid] = await Promise.all([
    fontCss(),
    katexCss(),
    readFile(
      resolve(packageRoot, "node_modules/mermaid/dist/mermaid.min.js"),
      "utf8",
    ),
  ]);
  const title = note.hasTitle ? "page has-title" : "page";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}"><style>${font}${math}
*{box-sizing:border-box}html,body{margin:0;width:${width}px;background:#edf1f4;color:#17212b;font-family:'Handnote Noto Sans SC',sans-serif}body{padding:48px}.page{width:${width - 96}px;background:#fff;border-radius:18px;padding:64px 72px;box-shadow:0 12px 40px #17212b18;overflow:visible}:where(.page)>*{margin:18px 0}.page:not(.has-title)>section:first-of-type>h2:first-child{margin-top:0}h1{font-size:48px;line-height:1.2;margin:0 0 20px}h2{font-size:32px;border-bottom:2px solid #e7edf2;padding-bottom:10px;margin-top:42px}h3{font-size:26px}h4,h5,h6{font-size:21px}p,li,td,th{font-size:20px;line-height:1.75;overflow-wrap:anywhere}blockquote{border-left:6px solid #5d88b3;background:#eef6ff;padding:18px 24px;border-radius:8px;margin:18px 0}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #cfdae3;padding:12px;vertical-align:top}th{background:#f3f6f8}figure{text-align:center}img{max-width:100%;height:auto}figcaption,small{display:block;color:#607282;margin-top:8px}.mermaid{display:flex;justify-content:center;white-space:pre-wrap}.mermaid svg{max-width:100%;height:auto}.katex-display{overflow:visible;overflow-wrap:anywhere}pre:not(.mermaid){white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px;overflow-wrap:anywhere}pre code{background:transparent;padding:0}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em;background:#f3f6f8;padding:2px 5px;border-radius:4px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}</style></head><body><main class="${title}">${note.html}</main><script>${mermaid}</script><script>window.__handnoteReady=false;window.__handnoteMermaidError='';(async()=>{try{mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'neutral'});await mermaid.run({querySelector:'.mermaid'});}catch(error){window.__handnoteMermaidError=error instanceof Error?error.message:String(error);}finally{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.__handnoteReady=true;}})();</script></body></html>`;
}

export function isAllowedRenderRequest(
  requestUrl: string,
  documentUrl: string,
): boolean {
  return requestUrl === documentUrl || requestUrl.startsWith("data:");
}

async function screenshotTall(
  browser: Browser,
  htmlPath: string,
  imagePath: string,
  width: number,
): Promise<{
  width: number;
  height: number;
  warnings: LayoutWarning[];
}> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
  });
  const documentUrl = pathToFileURL(htmlPath).href;
  const blockedRequests = new Set<string>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (isAllowedRenderRequest(url, documentUrl)) return route.continue();
    blockedRequests.add(url);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(documentUrl, { waitUntil: "load" });
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
      const block = marker.closest<HTMLElement>("[data-hn-id]");
      if (block?.dataset.hnId) diagramErrorIds.add(block.dataset.hnId);
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
      "[data-hn-id]",
    )) {
      if (element.classList.contains("sr-only")) continue;
      const rect = element.getBoundingClientRect();
      const id = element.dataset.hnId;
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
          message: `Block ${id} content is ${horizontalOverflow}px wider than its ${element.clientWidth}px container`,
          blocking: true,
          axis: "horizontal",
          overflowPx: horizontalOverflow,
          containerPx: element.clientWidth,
          contentPx: element.scrollWidth,
          ...(id ? { elementId: id } : {}),
        });
    }
    return {
      width,
      height,
      warnings,
    };
  });
  const media = await page
    .locator("img, image, video, audio, source, iframe, object, embed")
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        ["src", "href", "xlink:href", "poster", "data"]
          .map((name) => element.getAttribute(name))
          .filter((value): value is string => Boolean(value)),
      ),
    );
  const sourceSets = await page
    .locator("[srcset]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("srcset") ?? ""),
    );
  media.push(
    ...sourceSets.flatMap((value) =>
      parseSrcset(value).map((candidate) => candidate.url),
    ),
  );
  if (blockedRequests.size > 0 || media.some((url) => !url.startsWith("data:")))
    throw new MarkdownValidationError([
      {
        code: "external_resource",
        message:
          "Rendered content requires non-inline media; use captured local figures instead",
      },
    ]);
  const segmentHeight = 12_000;
  if (result.height <= segmentHeight) {
    await page.screenshot({
      path: imagePath,
      fullPage: true,
      clip: { x: 0, y: 0, width, height: result.height },
    });
  } else {
    const parts: Array<{ input: Buffer; top: number; left: number }> = [];
    for (let y = 0; y < result.height; y += segmentHeight) {
      const height = Math.min(segmentHeight, result.height - y);
      const input = await page.screenshot({
        type: "png",
        fullPage: true,
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
  await context.close();
  return result;
}

export async function renderDocument(
  note: CompiledNote,
  runDirectory: string,
  revision: number,
  width: number,
): Promise<RenderResult> {
  const warnings: LayoutWarning[] = [...note.warnings];
  const directory = `${runDirectory}/intermediate/revisions`;
  const htmlPath = `${directory}/revision-${String(revision).padStart(3, "0")}.html`;
  const imagePath = `${directory}/revision-${String(revision).padStart(3, "0")}.png`;
  let browser: Browser | undefined;
  try {
    const html = await buildHtml(note, width);
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
      structure: note.structure,
    };
  } catch (error) {
    if (
      error instanceof HandnoteError ||
      error instanceof MarkdownValidationError
    )
      throw error;
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

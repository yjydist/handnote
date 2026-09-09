import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { a4Page } from "../../src/renderer/index.ts";
import { compileNoteMarkdown } from "../../src/run/markdown.ts";
import {
  isAllowedRenderRequest,
  renderDocument,
} from "../../src/run/renderer.ts";
import {
  createStoreFixture,
  createTestHandlers,
  fullRegion,
  ModelSteps,
  simpleDraft,
  simpleMarkdown,
} from "./helpers.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-render-`);
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("renderer", () => {
  test("loads bundled rendering resources outside the repository cwd", async () => {
    const directory = await temporary();
    const compiler = import.meta.resolve("../../src/renderer/index.ts");
    const renderer = import.meta.resolve("../../src/renderer/index.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { compileNoteMarkdown } from ${JSON.stringify(compiler)};
       import { renderDocument } from ${JSON.stringify(renderer)};
       const note = await compileNoteMarkdown("# 中文\\n\\n$x$\\n\\n\`\`\`mermaid\\ngraph TD\\n A --> B\\n\`\`\`", {});
       const result = await renderDocument(note, "render");
       console.log(JSON.stringify(result));`,
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      width: a4Page.width,
      warnings: [],
      structure: { headings: 1, equations: 1, diagrams: 1 },
    });
    expect(await Bun.file(`${directory}/render/note.png`).exists()).toBe(true);
  }, 30_000);

  test("renders self-contained Chinese HTML, KaTeX fallback, Mermaid, table, and figure", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 320, height: 200, channels: 3, background: "#f2d9a6" },
    })
      .png()
      .toFile(source);
    const figureMarkdown = await (async () => {
      await mkdir(`${directory}/assets/figures`, { recursive: true });
      await sharp({
        create: { width: 120, height: 80, channels: 3, background: "#cfe6ff" },
      })
        .png()
        .toFile(`${directory}/assets/figures/figure-001.png`);
      return "![原图](../assets/figures/figure-001.png)";
    })();
    const markdown = `# 测试笔记

## 第一节

这是正文。

| 列一 | 列二 |
| --- | --- |
| 内容 | 更多内容 |

$$
\\frac{x^2}{y}
$$

$$
\\notACommand{
$$

\`\`\`mermaid
flowchart TD
  开始 -->|标签| 结束
\`\`\`

${figureMarkdown}
`;
    const note = await compileNoteMarkdown(markdown, {
      runDirectory: directory,
    });
    const result = await renderDocument(note, `${directory}/render-1`);
    expect(result.width).toBe(a4Page.width);
    expect(result.height).toBeGreaterThan(0);
    expect(await sharp(result.imagePath).metadata()).toMatchObject({
      width: a4Page.width,
      height: result.height,
      density: a4Page.dpi,
    });
    expect(result.structure).toEqual({
      headings: 2,
      blocks: 8,
      tables: 1,
      equations: 2,
      diagrams: 1,
      figures: 1,
    });
    expect(
      result.warnings.some((warning) => warning.code === "equation_fallback"),
    ).toBe(true);
    const html = await readFile(result.htmlPath, "utf8");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain(".katex{");
    expect(html).toContain("font-family:KaTeX_Main");
    expect(html).not.toContain("url(fonts/");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("flowchart TD");
    expect(html).not.toMatch(/<(?:script|img)[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).toContain(
      '<div data-hn-id="block-5"><span class="katex-display">',
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: a4Page.layoutWidth, height: 900 },
      });
      await page.goto(pathToFileURL(result.htmlPath).href);
      await page.waitForFunction(
        () =>
          (globalThis as typeof globalThis & { __handnoteReady?: boolean })
            .__handnoteReady === true,
      );
      const styles = await page.evaluate(() => {
        const values = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing ${selector}`);
          const style = getComputedStyle(element);
          return {
            marginTop: style.marginTop,
            marginBottom: style.marginBottom,
            paddingTop: style.paddingTop,
            backgroundColor: style.backgroundColor,
          };
        };
        return {
          h1: values("h1"),
          h2: values("h2"),
          mermaid: values("pre.mermaid"),
        };
      });
      expect(styles.h1).toMatchObject({
        marginTop: "0px",
        marginBottom: "20px",
      });
      expect(styles.h2.marginTop).toBe("42px");
      expect(styles.mermaid).toMatchObject({
        paddingTop: "0px",
        backgroundColor: "rgba(0, 0, 0, 0)",
      });
    } finally {
      await browser.close();
    }
    expect(
      result.warnings.some(
        (warning) => warning.code === "diagram_render_error",
      ),
    ).toBe(false);
    expect(
      result.warnings.some((warning) =>
        warning.code.includes("horizontal_overflow"),
      ),
    ).toBe(false);
    expect(await Bun.file(result.imagePath).exists()).toBe(true);
  }, 60_000);

  test("visually hides the footnote heading while preserving accessible footnotes", async () => {
    const directory = await temporary();
    const note = await compileNoteMarkdown(
      "## 原文标题\n\n这是正文[^1]。\n\n[^1]: 原文脚注。",
      { runDirectory: directory },
    );
    const result = await renderDocument(note, `${directory}/render-1`);
    expect(result.warnings).toEqual([]);
    expect((await sharp(result.imagePath).metadata()).width).toBe(a4Page.width);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: a4Page.layoutWidth, height: 900 },
      });
      await page.goto(pathToFileURL(result.htmlPath).href);
      await page.waitForFunction(
        () =>
          (globalThis as typeof globalThis & { __handnoteReady?: boolean })
            .__handnoteReady === true,
      );
      expect(
        await page.getByRole("heading", { name: "原文标题" }).isVisible(),
      ).toBe(true);
      expect(
        await page.getByText("原文脚注。", { exact: false }).isVisible(),
      ).toBe(true);
      const footnoteHeading = page.locator("[data-footnotes] h2");
      expect(await footnoteHeading.textContent()).toBe("Footnotes");
      expect(await page.locator("main").ariaSnapshot()).toContain(
        'heading "Footnotes" [level=2]',
      );
      const links = await page
        .locator("[data-footnote-ref], [data-footnote-backref]")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const href = element.getAttribute("href") ?? "";
            return Boolean(
              href.startsWith("#") &&
                document.getElementById(decodeURIComponent(href.slice(1))),
            );
          }),
        );
      expect(links).toEqual([true, true]);

      const before = await page.screenshot({ fullPage: true });
      await footnoteHeading.evaluate((element) => element.remove());
      const after = await page.screenshot({ fullPage: true });
      expect(before.equals(after)).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);

  test("renders from a run directory containing URL fragment characters", async () => {
    const root = await temporary();
    const runDirectory = `${root}/output#fragment`;
    await mkdir(runDirectory);
    const note = await compileNoteMarkdown(simpleMarkdown(), {
      runDirectory,
    });
    const result = await renderDocument(note, `${runDirectory}/render-1`);
    expect(result.width).toBe(a4Page.width);
    expect(await Bun.file(result.imagePath).exists()).toBe(true);
  }, 30_000);

  test("renders untitled content while keeping uncertainty audit session-only", async () => {
    const directory = await temporary();
    const draft = simpleDraft();
    const markdown = draft.markdown.replace("# 测试笔记\n\n## 第一节\n\n", "");
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const state = new ModelSteps();
    const tools = createTestHandlers({
      store,
      sourcePath: `${directory}/source.png`,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder,
    });
    const execute = tools.write_note;
    if (!execute) throw new Error("missing write_note execute");
    const result = await execute(
      {
        markdown,
        audit: {
          uncertainties: [
            {
              id: "uncertainText",
              target: { quote: "这是正文。" },
              bestGuess: "这是正文。",
              candidates: ["这是正文。", "这是证文。"],
              basis: "session-only-basis",
              region: fullRegion,
              confidence: 0.7,
            },
          ],
          corrections: [
            {
              id: "correctedText",
              target: { quote: "这是正文。" },
              original: "这是证文。",
              corrected: "这是正文。",
              basis: "session-only-correction-basis",
              region: fullRegion,
              confidence: 0.99,
            },
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(result).toMatchObject({ ok: true, revision: 1 });
    expect(result).toMatchObject({
      summary: expect.stringContaining("model step(s) remain"),
    });
    const htmlPath = store.path(
      store.manifest.revisions.at(-1)?.html.path ?? "missing",
    );
    if (!htmlPath) throw new Error("missing rendered HTML");
    const html = await readFile(htmlPath, "utf8");
    expect(html).toContain("这是正文。");
    expect(html).not.toContain("这是证文。");
    expect(html).not.toContain("session-only-basis");
    expect(html).not.toContain("session-only-correction-basis");
    expect(html).not.toMatch(/<h[12]>/);
    expect(html).not.toContain("存疑");
    expect(html).not.toContain("修正");

    const committed = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "document.revision.committed");
    expect(committed.data.audit.uncertainties[0]).toMatchObject({
      id: "uncertainText",
      bestGuess: "这是正文。",
      basis: "session-only-basis",
    });
    expect(committed.data.audit.corrections[0]).toMatchObject({
      id: "correctedText",
      original: "这是证文。",
      corrected: "这是正文。",
      basis: "session-only-correction-basis",
      confidence: 0.99,
    });
  }, 30_000);

  test("reports Mermaid runtime failures as blocking warnings", async () => {
    const directory = await temporary();
    const note = await compileNoteMarkdown(
      "正文。\n\n```mermaid\nnot a diagram directive at all\n```\n",
      { runDirectory: directory },
    );
    const result = await renderDocument(note, `${directory}/render-1`);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "diagram_render_error",
          blocking: true,
        }),
      ]),
    );
  }, 30_000);

  test("blocks non-file browser requests during rendering", async () => {
    const directory = await temporary();
    let requests = 0;
    const server: Server = createServer(() => {
      requests++;
    }).listen(0);
    const port = (server.address() as { port: number }).port;
    const probeUrl = `http://127.0.0.1:${port}/probe`;
    const markdown = "# 测试笔记\n";
    const note = await compileNoteMarkdown(markdown, {
      runDirectory: directory,
    });
    note.html += `<iframe src="${probeUrl}"></iframe>`;
    try {
      await expect(
        renderDocument(note, `${directory}/render-1`),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "external_resource" })],
      });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  test("allows only the exact render document file URL and data URLs", () => {
    const documentUrl = "file:///tmp/run/revision-001.html";
    expect(isAllowedRenderRequest(documentUrl, documentUrl)).toBe(true);
    expect(
      isAllowedRenderRequest("data:image/png;base64,AA==", documentUrl),
    ).toBe(true);
    expect(
      isAllowedRenderRequest("file:///tmp/run/other.png", documentUrl),
    ).toBe(false);
    expect(isAllowedRenderRequest("http://127.0.0.1/probe", documentUrl)).toBe(
      false,
    );
    expect(isAllowedRenderRequest("blob:null/id", documentUrl)).toBe(false);
  });
});

describe("standard rendering boundaries", () => {
  test("renders local HTML picture candidates without external resources", async () => {
    const runDirectory = await temporary();
    await mkdir(`${runDirectory}/assets/figures`, { recursive: true });
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: "red" },
    })
      .png()
      .toFile(`${runDirectory}/assets/figures/a.png`);
    const local = "../assets/figures/a.png";
    const note = await compileNoteMarkdown(
      `<picture><source srcset="${local} 1x, ${local} 2x"><img src="${local}"></picture>`,
      { runDirectory },
    );
    const render = await renderDocument(note, `${runDirectory}/render-1`);
    expect(render.warnings).toEqual([]);
    expect((await sharp(render.imagePath).metadata()).width).toBe(a4Page.width);
  }, 30_000);

  test("Mermaid strict mode accepts links while external diagram media is a repairable resource error", async () => {
    const runDirectory = await temporary();
    const linked = await compileNoteMarkdown(
      '```mermaid\nflowchart TD\n a["Safe <b>label</b>"]\n click a "https://example.test"\n```',
      { runDirectory },
    );
    const render = await renderDocument(linked, `${runDirectory}/render-1`);
    expect(render.warnings).toEqual([]);
    const external = await compileNoteMarkdown(
      '```mermaid\nflowchart TD\n a@{ img: "https://example.test/remote.png", label: "Remote" }\n```',
      { runDirectory },
    );
    await expect(
      renderDocument(external, `${runDirectory}/render-2`),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "external_resource" })],
    });
  }, 30_000);

  test("preserves A4 screenshot width when content overflows", async () => {
    const directory = await temporary();
    const note = await compileNoteMarkdown(`$${"x".repeat(250)}$`, {
      runDirectory: directory,
    });
    const render = await renderDocument(note, `${directory}/render-1`);
    expect(
      render.warnings.some(
        (warning) => warning.blocking && warning.code.includes("overflow"),
      ),
    ).toBe(true);
    expect((await sharp(render.imagePath).metadata()).width).toBe(a4Page.width);
  }, 30_000);

  test("stitches native A4 screenshots without gaps, repeated rows, or raster enlargement", async () => {
    const directory = await temporary();
    const note = await compileNoteMarkdown("# Long page", {
      runDirectory: directory,
    });
    note.html +=
      '<div style="height:6400px;background:repeating-linear-gradient(to bottom,#123456 0px,#123456 7px,#abcdef 7px,#abcdef 15px)"></div>';
    const render = await renderDocument(note, `${directory}/render`);
    const metadata = await sharp(render.imagePath).metadata();
    expect(metadata).toMatchObject({
      width: a4Page.width,
      height: render.height,
      density: a4Page.dpi,
    });
    expect(render.height).toBeGreaterThan(
      (6400 * a4Page.width) / a4Page.layoutWidth,
    );
    expect(render.warnings).toEqual([]);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: a4Page.layoutWidth, height: 900 },
        deviceScaleFactor: a4Page.width / a4Page.layoutWidth,
      });
      await page.goto(pathToFileURL(render.htmlPath).href);
      await page.waitForFunction(
        () =>
          (globalThis as typeof globalThis & { __handnoteReady?: boolean })
            .__handnoteReady === true,
      );
      // Sample around the stitched boundary against an independent native browser screenshot.
      const y = 5985;
      const reference = await page.screenshot({
        type: "png",
        scale: "device",
        fullPage: true,
        clip: { x: 0, y, width: a4Page.layoutWidth, height: 90 },
      });
      const expected = await sharp(reference)
        .extract({ left: 800, top: 0, width: 8, height: 186 })
        .removeAlpha()
        .raw()
        .toBuffer();
      const actual = await sharp(render.imagePath)
        .extract({
          left: 800,
          top: (y * a4Page.width) / a4Page.layoutWidth,
          width: 8,
          height: 186,
        })
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(actual.equals(expected)).toBe(true);
      expect(new Set(actual).size).toBeGreaterThan(3);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

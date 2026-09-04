import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import sharp from "sharp";
import { unified } from "unified";
import { chromium } from "playwright";
import { emptyRevisionAudit } from "../src/document.ts";
import type { NoteMarkdown } from "../src/markdown.ts";
import { parseNoteMarkdown } from "../src/markdown.ts";
import { isAllowedRenderRequest, renderDocument } from "../src/renderer.ts";
import { SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { sha256File } from "../src/utils.ts";
import { fullRegion, simpleDraft, simpleMarkdown } from "./helpers.ts";

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

const fakeRender = (
  warnings: { code: string; message: string; blocking: boolean }[] = [],
  imagePath = "b",
) => ({
  htmlPath: "a",
  imagePath,
  width: 1,
  height: 1,
  warnings,
  structure: {
    headings: 1,
    blocks: 1,
    tables: 0,
    equations: 0,
    diagrams: 0,
    figures: 0,
  },
});

describe("renderer", () => {
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
      return "![原图](assets/figures/figure-001.png)";
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
    const note = await parseNoteMarkdown(markdown, { runDirectory: directory });
    const result = await renderDocument(note, directory, 1, 900);
    expect(result.width).toBe(900);
    expect(result.height).toBeGreaterThan(0);
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
      '<div data-hn-id="hn-0005"><span class="katex-display">',
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 900, height: 900 },
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

  test("renders from a run directory containing URL fragment characters", async () => {
    const root = await temporary();
    const runDirectory = `${root}/output#fragment`;
    await mkdir(runDirectory);
    const note = await parseNoteMarkdown(simpleMarkdown(), {
      runDirectory,
    });
    const result = await renderDocument(note, runDirectory, 1, 700);
    expect(result.width).toBe(700);
    expect(await Bun.file(result.imagePath).exists()).toBe(true);
  }, 30_000);

  test("renders untitled content while keeping uncertainty audit session-only", async () => {
    const directory = await temporary();
    const draft = simpleDraft();
    const markdown = draft.markdown.replace("# 测试笔记\n\n## 第一节\n\n", "");
    const recorder = new SessionRecorder(directory);
    const state = new RunState();
    const tools = createHandnoteTools({
      sourcePath: `${directory}/source.png`,
      runDirectory: directory,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder,
    });
    const execute = tools.write_note.execute;
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
    const htmlPath = state.revision?.render.htmlPath;
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
    const note = await parseNoteMarkdown(
      "正文。\n\n```mermaid\nnot a diagram directive at all\n```\n",
      { runDirectory: directory },
    );
    const result = await renderDocument(note, directory, 1, 700);
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
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .parse(markdown) as NoteMarkdown["tree"];
    tree.children.push({
      type: "resource-probe",
      data: { hName: "iframe", hProperties: { src: probeUrl } },
      children: [],
    } as never);
    const note: NoteMarkdown = {
      markdown,
      tree,
      structure: {
        headings: 1,
        blocks: 2,
        tables: 0,
        equations: 0,
        diagrams: 0,
        figures: 0,
      },
      mathWarnings: [],
    };
    try {
      const result = await renderDocument(note, directory, 1, 700);
      expect(result.width).toBe(700);
      expect(await Bun.file(result.imagePath).exists()).toBe(true);
      expect(await Bun.file(result.htmlPath).text()).toContain(probeUrl);
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

describe("finalization state machine", () => {
  test("requires render, later review, later finalize, and no blocking warnings", () => {
    const state = new RunState();
    state.beginModelStep();
    state.commit(simpleMarkdown(), "hash", emptyRevisionAudit(), fakeRender());
    expect(state.canFinalize().ok).toBe(false);
    state.review();
    expect(state.canFinalize().ok).toBe(false);
    state.beginModelStep();
    state.review();
    expect(state.canFinalize().ok).toBe(false);
    state.beginModelStep();
    expect(state.canFinalize().ok).toBe(true);
  });

  test("mutation clears review eligibility and blocking warnings prevent finalization", () => {
    const state = new RunState();
    state.beginModelStep();
    state.commit(
      simpleMarkdown(),
      "hash",
      emptyRevisionAudit(),
      fakeRender([{ code: "overflow", message: "bad", blocking: true }]),
    );
    state.beginModelStep();
    state.review();
    state.beginModelStep();
    expect(state.canFinalize()).toEqual({
      ok: false,
      reason: "Review contains blocking layout warnings",
    });
    state.commit(
      simpleMarkdown(),
      "hash2",
      emptyRevisionAudit(),
      fakeRender([], "d"),
    );
    expect(state.canFinalize()).toEqual({
      ok: false,
      reason: "Current revision has not been reviewed",
    });
  });

  test("serializes concurrent state transactions", async () => {
    const state = new RunState();
    const order: number[] = [];
    await Promise.all([
      state.transaction(async () => {
        await Bun.sleep(10);
        order.push(1);
      }),
      state.transaction(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  test("keeps finalization and concurrent revisions on the same revision", async () => {
    const setup = async () => {
      const directory = await temporary();
      const state = new RunState();
      state.beginModelStep();
      const initialMarkdown = simpleMarkdown();
      await mkdir(`${directory}/revisions`, { recursive: true });
      await Bun.write(
        `${directory}/revisions/revision-001.md`,
        initialMarkdown,
      );
      state.commit(
        initialMarkdown,
        await sha256File(`${directory}/revisions/revision-001.md`),
        emptyRevisionAudit(),
        fakeRender(),
      );
      state.beginModelStep();
      state.review();
      state.beginModelStep();
      const tools = createHandnoteTools({
        sourcePath: `${directory}/source.png`,
        runDirectory: directory,
        width: 700,
        maxSteps: 18,
        maxInspectCalls: 3,
        toolMedia: { maxEdge: 2048, jpegQuality: 85 },
        state,
        recorder: new SessionRecorder(directory),
      });
      return { state, tools, directory };
    };

    const reviseFirst = await setup();
    const reviseFirstContext = {} as Parameters<
      NonNullable<typeof reviseFirst.tools.revise_note.execute>
    >[1];
    const revisionMarkdown = "修订后的正文。\n";
    const [reviseResult, finalizeAfterRevise] = await Promise.all([
      reviseFirst.tools.revise_note.execute?.(
        { markdown: revisionMarkdown, audit: {} },
        reviseFirstContext,
      ),
      reviseFirst.tools.finalize_note.execute?.({}, reviseFirstContext),
    ]);
    expect(reviseResult).toMatchObject({ ok: true, revision: 2 });
    expect(finalizeAfterRevise).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });
    expect(reviseFirst.state.finalized).toBe(false);
    expect(reviseFirst.state.revision?.number).toBe(2);
    expect(
      await Bun.file(
        `${reviseFirst.directory}/revisions/revision-002.md`,
      ).exists(),
    ).toBe(true);

    const finalizeFirst = await setup();
    const finalizeFirstContext = {} as Parameters<
      NonNullable<typeof finalizeFirst.tools.finalize_note.execute>
    >[1];
    const [finalizeResult, reviseAfterFinalize] = await Promise.all([
      finalizeFirst.tools.finalize_note.execute?.({}, finalizeFirstContext),
      finalizeFirst.tools.revise_note.execute?.(
        { markdown: revisionMarkdown, audit: {} },
        finalizeFirstContext,
      ),
    ]);
    expect(finalizeResult).toMatchObject({ ok: true, revision: 1 });
    expect(reviseAfterFinalize).toMatchObject({
      ok: false,
      error: { code: "already_finalized" },
    });
    expect(finalizeFirst.state.finalized).toBe(true);
    expect(finalizeFirst.state.finalizedRevision).toBe(1);
    expect(finalizeFirst.state.revision?.number).toBe(1);
  }, 60_000);
});

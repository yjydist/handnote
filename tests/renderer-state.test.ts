import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { emptyRevisionAudit } from "../src/document.ts";
import type { PatchOperation } from "../src/patch.ts";
import { renderDocument } from "../src/renderer.ts";
import { SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { fullRegion, simpleDocument, simpleDraft } from "./helpers.ts";

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
  test("renders self-contained Chinese HTML, KaTeX fallback, Mermaid, table, and source figure", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 320, height: 200, channels: 3, background: "#f2d9a6" },
    })
      .png()
      .toFile(source);
    const document = simpleDocument();
    document.sections[0]?.blocks.push(
      {
        id: "table",
        type: "table",
        headers: ["列一", "列二"],
        rows: [["内容", "更多内容"]],
      },
      { id: "valid-equation", type: "equation", latex: "\\frac{x^2}{y}" },
      { id: "equation", type: "equation", latex: "\\notACommand{" },
      {
        id: "diagram",
        type: "diagram",
        mermaid: 'flowchart TD\n  start["开始"] --> fin["结束"]',
      },
      {
        id: "figure",
        type: "source_figure",
        region: fullRegion,
        caption: "原图",
      },
    );
    const result = await renderDocument(document, source, directory, 1, 900);
    expect(result.width).toBe(900);
    expect(result.height).toBeGreaterThan(0);
    expect(
      result.warnings.some((warning) => warning.code === "equation_fallback"),
    ).toBe(true);
    const html = await readFile(result.htmlPath, "utf8");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain(".katex{");
    expect(html).toContain("font-family:KaTeX_Main");
    expect(html).not.toContain("url(fonts/");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain(
      "start[&quot;开始&quot;] --&gt; fin[&quot;结束&quot;]",
    );
    expect(html).not.toMatch(/<(?:script|img)[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
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
    expect(
      result.warnings.some(
        (warning) => warning.elementId === "valid-equation" && warning.blocking,
      ),
    ).toBe(false);
    expect(await Bun.file(result.imagePath).exists()).toBe(true);
  }, 30_000);

  test("renders from a run directory containing URL fragment characters", async () => {
    const root = await temporary();
    const source = `${root}/source.png`;
    const runDirectory = `${root}/output#fragment`;
    await mkdir(runDirectory);
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const result = await renderDocument(
      simpleDocument(),
      source,
      runDirectory,
      1,
      700,
    );
    expect(result.width).toBe(700);
    expect(await Bun.file(result.imagePath).exists()).toBe(true);
  }, 30_000);

  test("renders untitled content while keeping uncertainty audit session-only", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const draft = simpleDraft();
    delete draft.document.title;
    delete draft.document.sections[0]?.title;
    draft.audit.uncertainties.push({
      id: "uncertainText",
      target: { kind: "block", blockId: "paragraph-1" },
      bestGuess: "这是正文。",
      candidates: ["这是正文。", "这是证文。"],
      basis: "session-only-basis",
      region: fullRegion,
      confidence: 0.7,
    });
    draft.audit.corrections.push({
      id: "correctedText",
      target: { kind: "block", blockId: "paragraph-1" },
      original: "这是证文。",
      corrected: "这是正文。",
      basis: "session-only-correction-basis",
      region: fullRegion,
      confidence: 0.99,
    });
    const recorder = new SessionRecorder(directory);
    const state = new RunState();
    const tools = createHandnoteTools({
      sourcePath: source,
      runDirectory: directory,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder,
    });
    const execute = tools.write_document.execute;
    if (!execute) throw new Error("missing write_document execute");
    const result = await execute(draft, {} as Parameters<typeof execute>[1]);
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
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const document = simpleDocument();
    document.sections[0]?.blocks.push({
      id: "broken-diagram",
      type: "diagram",
      mermaid: "flowchart TD\n  A -->> B",
    });
    const result = await renderDocument(document, source, directory, 1, 700);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "diagram_render_error",
          blocking: true,
          elementId: "broken-diagram",
        }),
      ]),
    );
  }, 30_000);
});

describe("finalization state machine", () => {
  test("requires render, later review, later finalize, and no blocking warnings", () => {
    const state = new RunState();
    state.beginModelStep();
    state.commit(simpleDocument(), emptyRevisionAudit(), {
      htmlPath: "a",
      imagePath: "b",
      width: 1,
      height: 1,
      warnings: [],
      structure: {
        sections: 1,
        blocks: 1,
        diagrams: 0,
        tables: 0,
        sourceFigures: 0,
      },
    });
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
    state.commit(simpleDocument(), emptyRevisionAudit(), {
      htmlPath: "a",
      imagePath: "b",
      width: 1,
      height: 1,
      warnings: [{ code: "overflow", message: "bad", blocking: true }],
      structure: {
        sections: 1,
        blocks: 1,
        diagrams: 0,
        tables: 0,
        sourceFigures: 0,
      },
    });
    state.beginModelStep();
    state.review();
    state.beginModelStep();
    expect(state.canFinalize()).toEqual({
      ok: false,
      reason: "Review contains blocking layout warnings",
    });
    state.commit(simpleDocument(), emptyRevisionAudit(), {
      htmlPath: "c",
      imagePath: "d",
      width: 1,
      height: 1,
      warnings: [],
      structure: {
        sections: 1,
        blocks: 1,
        diagrams: 0,
        tables: 0,
        sourceFigures: 0,
      },
    });
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

  test("keeps finalization and concurrent patches on the same revision", async () => {
    const operations: PatchOperation[] = [
      {
        op: "replace_block",
        blockId: "paragraph-1",
        block: { id: "ignored", type: "paragraph", text: "changed" },
      },
    ];
    const setup = async () => {
      const directory = await temporary();
      const source = `${directory}/source.png`;
      await sharp({
        create: { width: 100, height: 100, channels: 3, background: "white" },
      })
        .png()
        .toFile(source);
      const state = new RunState();
      state.beginModelStep();
      state.commit(simpleDocument(), emptyRevisionAudit(), {
        htmlPath: "old.html",
        imagePath: source,
        width: 700,
        height: 100,
        warnings: [],
        structure: {
          sections: 1,
          blocks: 1,
          diagrams: 0,
          tables: 0,
          sourceFigures: 0,
        },
      });
      state.beginModelStep();
      state.review();
      state.beginModelStep();
      const tools = createHandnoteTools({
        sourcePath: source,
        runDirectory: directory,
        width: 700,
        maxSteps: 18,
        maxInspectCalls: 3,
        toolMedia: { maxEdge: 2048, jpegQuality: 85 },
        state,
        recorder: new SessionRecorder(directory),
      });
      return { state, tools };
    };

    const patchFirst = await setup();
    const patchFirstContext = {} as Parameters<
      NonNullable<typeof patchFirst.tools.patch_document.execute>
    >[1];
    const [patchResult, finalizeAfterPatch] = await Promise.all([
      patchFirst.tools.patch_document.execute?.(
        { operations },
        patchFirstContext,
      ),
      patchFirst.tools.finalize_note.execute?.({}, patchFirstContext),
    ]);
    expect(patchResult).toMatchObject({ ok: true, revision: 2 });
    expect(finalizeAfterPatch).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });
    expect(patchFirst.state.finalized).toBe(false);
    expect(patchFirst.state.revision?.number).toBe(2);

    const finalizeFirst = await setup();
    const finalizeFirstContext = {} as Parameters<
      NonNullable<typeof finalizeFirst.tools.finalize_note.execute>
    >[1];
    const [finalizeResult, patchAfterFinalize] = await Promise.all([
      finalizeFirst.tools.finalize_note.execute?.({}, finalizeFirstContext),
      finalizeFirst.tools.patch_document.execute?.(
        { operations },
        finalizeFirstContext,
      ),
    ]);
    expect(finalizeResult).toMatchObject({ ok: true, revision: 1 });
    expect(patchAfterFinalize).toMatchObject({
      ok: false,
      error: { code: "already_finalized" },
    });
    expect(finalizeFirst.state.finalizedRevision).toBe(1);
    expect(finalizeFirst.state.revision?.number).toBe(1);
  }, 30_000);
});

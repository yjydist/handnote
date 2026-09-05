import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { revisionDraftSchema } from "../src/document.ts";
import { SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { fullRegion, simpleMarkdown } from "./helpers.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-contract-`);
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

async function setup(directory: string) {
  const source = `${directory}/source.png`;
  await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  })
    .png()
    .toFile(source);
  const state = new RunState();
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
}

const firstStep = async (
  directory: string,
): Promise<{
  state: RunState;
  tools: ReturnType<typeof createHandnoteTools>;
  context: unknown;
}> => {
  const { state, tools } = await setup(directory);
  state.beginModelStep();
  const writeExecute = tools.write_note.execute;
  if (!writeExecute) throw new Error("missing write_note");
  const result = await writeExecute(
    { markdown: simpleMarkdown(), audit: {} },
    {} as Parameters<typeof writeExecute>[1],
  );
  if (!("ok" in result) || !result.ok)
    throw new Error(`write_note failed: ${JSON.stringify(result)}`);
  state.beginModelStep();
  const reviewExecute = tools.review_render.execute;
  if (!reviewExecute) throw new Error("missing review_render");
  await reviewExecute({}, {} as Parameters<typeof reviewExecute>[1]);
  state.beginModelStep();
  return { state, tools, context: undefined };
};

describe("note tool sequencing", () => {
  test("revise_note before write_note is rejected as no_revision", async () => {
    const directory = await temporary();
    const { tools } = await setup(directory);
    const execute = tools.revise_note.execute;
    if (!execute) throw new Error("missing revise_note");
    const result = await execute(
      { markdown: simpleMarkdown(), audit: {} },
      {} as Parameters<typeof execute>[1],
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "no_revision" },
    });
  });

  test("write_note after a revision exists is rejected as revision_exists", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    await execute(
      { markdown: simpleMarkdown(), audit: {} },
      {} as Parameters<typeof execute>[1],
    );
    const second = await execute(
      { markdown: simpleMarkdown(), audit: {} },
      {} as Parameters<typeof execute>[1],
    );
    expect(second).toMatchObject({
      ok: false,
      error: { code: "revision_exists" },
    });
  });

  test("read_note round-trips the committed markdown and hash", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const write = tools.write_note.execute;
    const read = tools.read_note.execute;
    if (!write || !read) throw new Error("missing tools");
    const committed = await write(
      { markdown: simpleMarkdown(), audit: {} },
      {} as Parameters<typeof write>[1],
    );
    if (!("ok" in committed) || !committed.ok)
      throw new Error("write_note failed");
    const result = await read({}, {} as Parameters<typeof read>[1]);
    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      markdown: simpleMarkdown(),
      markdownSha256: committed.markdownSha256,
    });
  });

  test("read_note without a revision is rejected as no_revision", async () => {
    const directory = await temporary();
    const { tools } = await setup(directory);
    const read = tools.read_note.execute;
    if (!read) throw new Error("missing read_note");
    const result = await read({}, {} as Parameters<typeof read>[1]);
    expect(result).toMatchObject({ ok: false, error: { code: "no_revision" } });
  });

  test("write_note rejects audit quotes missing from the markdown as invalid_audit", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    const result = await execute(
      {
        markdown: simpleMarkdown(),
        audit: {
          uncertainties: [
            {
              id: "u1",
              target: { quote: "不存在的引文" },
              bestGuess: "x",
              candidates: ["x", "y"],
              basis: "b",
              region: fullRegion,
              confidence: 0.5,
            },
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_audit" },
    });
    expect(state.revision).toBeUndefined();
  });

  test("note draft input schema strips no unknown keys: strict rejection at the tool boundary", async () => {
    const directory = await temporary();
    const { tools } = await setup(directory);
    const schema = tools.write_note.inputSchema;
    if (!schema) throw new Error("missing write_note inputSchema");
    expect(
      schema.safeParse({
        markdown: simpleMarkdown(),
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        markdown: simpleMarkdown(),
        audit: { corrections: [], uncertainties: [], extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ markdown: simpleMarkdown(), audit: {} }).success,
    ).toBe(true);
  });
});

describe("finalize hash binding", () => {
  test("classifies an unreadable revision file as filesystem", async () => {
    const directory = await temporary();
    const { state, tools } = await firstStep(directory);
    await rm(`${directory}/revisions/revision-001.md`);
    const finalize = tools.finalize_note.execute;
    if (!finalize) throw new Error("missing finalize_note");
    await expect(
      finalize({}, {} as Parameters<typeof finalize>[1]),
    ).rejects.toMatchObject({
      kind: "filesystem",
      message: expect.stringContaining("Cannot read finalized revision"),
    });
    expect(state.finalized).toBe(false);
  });

  test("finalize fails fatally when the revision file on disk no longer matches the reviewed hash", async () => {
    const directory = await temporary();
    const { state, tools } = await firstStep(directory);
    const markdownPath = `${directory}/revisions/revision-001.md`;
    await writeFile(markdownPath, "tampered after review\n");
    const finalize = tools.finalize_note.execute;
    if (!finalize) throw new Error("missing finalize_note");
    await expect(
      finalize({}, {} as Parameters<typeof finalize>[1]),
    ).rejects.toMatchObject({
      kind: "filesystem",
      message: expect.stringContaining("hash mismatch"),
    });
    expect(state.finalized).toBe(false);
  });

  test("finalize succeeds when the revision file matches and records its hash", async () => {
    const directory = await temporary();
    const { state, tools } = await firstStep(directory);
    const finalize = tools.finalize_note.execute;
    if (!finalize) throw new Error("missing finalize_note");
    const result = await finalize({}, {} as Parameters<typeof finalize>[1]);
    expect(result).toMatchObject({ ok: true, revision: 1 });
    const session = await readFile(`${directory}/session/events.jsonl`, "utf8");
    const finalized = session
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "note.finalized");
    expect(finalized.data).toMatchObject({
      revision: 1,
      markdownSha256: state.revision?.markdownSha256,
    });
  });
});

describe("quote locator validation", () => {
  const draft = (quote: string, occurrence?: number) => ({
    markdown: "重复\n文本。\n\n重复\n文本。\n",
    audit: {
      uncertainties: [
        {
          id: "u1",
          target: occurrence !== undefined ? { quote, occurrence } : { quote },
          bestGuess: "x",
          candidates: ["x", "y"],
          basis: "b",
          region: fullRegion,
          confidence: 0.5,
        },
      ],
    },
  });

  test("matches source markup, TeX and line breaks exactly", () => {
    const markdown =
      "# **Visible** heading\n\n$\\frac{x}{y}$\n\n![caption](assets/figures/a.png)\n\nfirst\nsecond\n\nconcatenate";
    for (const quote of [
      "**Visible**",
      "$\\frac{x}{y}$",
      "![caption](assets/figures/a.png)",
      "first\nsecond",
      "cat",
      "heading\n\n$",
    ])
      expect(
        revisionDraftSchema.safeParse({ ...draft(quote), markdown }).success,
      ).toBe(true);
    for (const quote of [
      "Visible heading",
      "first second",
      "First\nsecond",
      "xy",
      "",
      " ",
      "\n",
    ])
      expect(
        revisionDraftSchema.safeParse({ ...draft(quote), markdown }).success,
      ).toBe(false);
    expect(
      revisionDraftSchema.safeParse(draft("重复\n文本。", 2)).success,
    ).toBe(true);
    expect(
      revisionDraftSchema.safeParse(draft("重复\n文本。", 3)).success,
    ).toBe(false);
  });

  test("retains audit structure constraints", () => {
    const input = draft("重复");
    expect(
      revisionDraftSchema.safeParse({
        ...input,
        audit: {
          uncertainties: [
            input.audit.uncertainties[0],
            input.audit.uncertainties[0],
          ],
        },
      }).success,
    ).toBe(false);
    for (const occurrence of [0, 21, 1.5])
      expect(
        revisionDraftSchema.safeParse(draft("重复", occurrence)).success,
      ).toBe(false);
  });

  test("counts overlapping occurrences", () => {
    const overlapping = draft("哈哈", 2);
    overlapping.markdown = "哈哈哈";
    expect(revisionDraftSchema.safeParse(overlapping).success).toBe(true);
  });

  test("validates many audit targets against a maximum-size note promptly", () => {
    const quotes = Array.from({ length: 100 }, (_, index) => `word${index}`);
    const line = `${quotes.join(" ")}\n`;
    const markdown = line
      .repeat(Math.ceil(200_000 / line.length))
      .slice(0, 200_000);
    const corrections = Array.from({ length: 50 }, (_, index) => ({
      id: `c${index}`,
      target: { quote: quotes[index], occurrence: 20 },
      original: quotes[index] ?? "",
      corrected: quotes[index] ?? "",
      basis: "b",
      region: fullRegion,
      confidence: 0.95,
    }));
    const uncertainties = Array.from({ length: 50 }, (_, index) => ({
      id: `u${index}`,
      target: { quote: quotes[index + 50], occurrence: 20 },
      bestGuess: quotes[index + 50] ?? "",
      candidates: [quotes[index + 50] ?? "", "term"],
      basis: "b",
      region: fullRegion,
      confidence: 0.5,
    }));

    const start = performance.now();
    const parsed = revisionDraftSchema.safeParse({
      markdown,
      audit: { corrections, uncertainties },
    });
    const elapsed = performance.now() - start;

    expect(parsed.success).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  }, 10_000);

  test("rejects quotes that occur too few times", () => {
    expect(revisionDraftSchema.safeParse(draft("重复文本。", 3)).success).toBe(
      false,
    );
    expect(revisionDraftSchema.safeParse(draft("不存在的句子")).success).toBe(
      false,
    );
  });

  test("error message names the audit id and occurrence", () => {
    const parsed = revisionDraftSchema.safeParse(draft("重复文本。", 3));
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0]?.message).toBe(
        "Audit u1 quote not found (occurrence 3)",
      );
  });
});

describe("source audit tool contract", () => {
  const audit = (quote: string, occurrence = 1) => ({
    uncertainties: [
      {
        id: "sourceQuote",
        target: { quote, occurrence },
        bestGuess: quote,
        candidates: [quote, "alternative"],
        basis: "source image",
        region: fullRegion,
        confidence: 0.5,
      },
    ],
  });

  test("validates source locators before rendering and preserves a reviewed revision on failure", async () => {
    const directory = await temporary();
    const { state, tools } = await firstStep(directory);
    const revise = tools.revise_note.execute;
    if (!revise) throw new Error("missing revise_note");
    const revision = state.revision;
    if (!revision) throw new Error("missing revision");
    const markdown =
      "**Changed**\n\n$\\frac{x}{y}$\n\nfirst\nsecond\n\n![local](assets/figures/missing.png)";
    const invalid = await revise(
      { markdown, audit: audit("Changed first") },
      {} as Parameters<typeof revise>[1],
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_audit", repairable: true },
    });
    expect(state.revision).toBe(revision);
    expect(
      await Bun.file(
        `${directory}/intermediate/revisions/revision-002.html`,
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(`${directory}/revisions/revision-002.md`).exists(),
    ).toBe(false);
    expect(
      await Bun.file(`${directory}/revisions/revision-001.md`).text(),
    ).toBe(simpleMarkdown());
    const resource = await revise(
      { markdown, audit: audit("**Changed**") },
      {} as Parameters<typeof revise>[1],
    );
    expect(resource).toMatchObject({
      ok: false,
      error: {
        code: "invalid_markdown",
        message: expect.stringContaining("missing_figure"),
      },
    });
    expect(state.revision).toBe(revision);
    const valid = markdown.slice(0, markdown.indexOf("\n\n![local]"));
    expect(
      await revise(
        { markdown: valid, audit: audit("first\nsecond") },
        {} as Parameters<typeof revise>[1],
      ),
    ).toMatchObject({ ok: true, revision: 2 });
    expect(state.revision?.markdown).toBe(valid);
    expect(
      await Bun.file(`${directory}/revisions/revision-002.md`).text(),
    ).toBe(valid);
    expect(state.canFinalize().ok).toBe(false);
  }, 30_000);

  test("nonblank invisible content can commit but still needs later review and finalize", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const write = tools.write_note.execute;
    const review = tools.review_render.execute;
    const finalize = tools.finalize_note.execute;
    if (!write || !review || !finalize) throw new Error("missing tools");
    const context = {} as Parameters<typeof write>[1];
    state.beginModelStep();
    const markdown =
      '```mermaid\nflowchart TD\n a[" "]\n style a fill:#ff000000,stroke:none\n```\n\n$\\phantom{x}$';
    expect(
      await write({ markdown, audit: audit("fill:#ff000000") }, context),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(state.revision?.render.warnings).toEqual([]);
    expect(await finalize({}, context)).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });
    state.beginModelStep();
    await review({}, context);
    expect(await finalize({}, context)).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });
    state.beginModelStep();
    expect(await finalize({}, context)).toMatchObject({
      ok: true,
      revision: 1,
    });
    expect(state.finalized).toBe(true);
  }, 30_000);

  test("source occurrences include discarded cells and sanitized content", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const write = tools.write_note.execute;
    if (!write) throw new Error("missing write_note");
    const context = {} as Parameters<typeof write>[1];
    const markdown = "| A |\n| - |\n| B | Hidden |\n\n<script>Hidden</script>";
    expect(
      await write({ markdown, audit: audit("Hidden", 3) }, context),
    ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
    expect(state.revision).toBeUndefined();
    expect(
      await write({ markdown, audit: audit("Hidden", 2) }, context),
    ).toMatchObject({ ok: true });
    const html = await Bun.file(state.revision?.render.htmlPath ?? "").text();
    expect(html).not.toContain("<script>Hidden</script>");
    expect(html).not.toContain("<td>Hidden</td>");
  }, 30_000);

  test("blank, oversized and remote-image drafts return repairable input errors", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const write = tools.write_note.execute;
    if (!write) throw new Error("missing write_note");
    for (const [markdown, code] of [
      [" \n\t", "empty_document"],
      ["x".repeat(200_001), "markdown_too_large"],
      ['<img src="https://example.test/p.png">', "invalid_image_path"],
    ]) {
      if (!markdown || !code) throw new Error("missing case");
      expect(
        await write({ markdown, audit: {} }, {} as Parameters<typeof write>[1]),
      ).toMatchObject({
        ok: false,
        error: {
          code: "invalid_markdown",
          message: expect.stringContaining(code),
          repairable: true,
        },
      });
      expect(state.revision).toBeUndefined();
    }
  });
});

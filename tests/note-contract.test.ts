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

  test("write_note returns repairable invalid_markdown with issue list", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    const result = await execute(
      { markdown: "<b>hi</b>\n\n[link](https://example.test)", audit: {} },
      {} as Parameters<typeof execute>[1],
    );
    const message = (result as { error?: { message?: string } }).error?.message;
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_markdown",
        repairable: true,
        message: expect.any(String),
      },
    });
    expect(message).toContain("raw_html");
    expect(message).toContain("link_not_allowed");
    expect(state.revision).toBeUndefined();
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
          target: occurrence ? { quote, occurrence } : { quote },
          bestGuess: "x",
          candidates: ["x", "y"],
          basis: "b",
          region: fullRegion,
          confidence: 0.5,
        },
      ],
    },
  });

  test("accepts a quote present enough times and folds whitespace", () => {
    expect(revisionDraftSchema.safeParse(draft("重复\n文本。")).success).toBe(
      true,
    );
    expect(
      revisionDraftSchema.safeParse(draft("重复\n文本。", 2)).success,
    ).toBe(true);
  });

  test("matches visible Markdown text without markup or cross-block phantoms", () => {
    const markdown = [
      "# **Visible** heading",
      "",
      "first block",
      "",
      "second block",
      "",
      "| cell | `code` |",
      "| --- | --- |",
      "| value | $x$ |",
      "",
      "![figure alt](assets/figures/figure-001.png)",
    ].join("\n");
    const withMarkdown = (quote: string) => ({
      ...draft(quote),
      markdown,
    });
    for (const quote of ["Visible heading", "cell", "code", "x", "figure alt"])
      expect(revisionDraftSchema.safeParse(withMarkdown(quote)).success).toBe(
        true,
      );
    expect(
      revisionDraftSchema.safeParse(withMarkdown("**Visible**")).success,
    ).toBe(false);
    expect(
      revisionDraftSchema.safeParse(withMarkdown("block second")).success,
    ).toBe(false);
  });

  test("uses ASCII word boundaries while retaining Chinese fragment matches", () => {
    const withMarkdown = (markdown: string, quote: string) => ({
      ...draft(quote),
      markdown,
    });
    expect(
      revisionDraftSchema.safeParse(withMarkdown("concatenate", "cat")).success,
    ).toBe(false);
    expect(
      revisionDraftSchema.safeParse(withMarkdown("cat_2 cat", "cat")).success,
    ).toBe(true);
    expect(
      revisionDraftSchema.safeParse(withMarkdown("这是中文片段。", "中文"))
        .success,
    ).toBe(true);
  });

  test("counts overlapping occurrences", () => {
    const overlapping = draft("哈哈", 2);
    overlapping.markdown = "哈哈哈";
    expect(revisionDraftSchema.safeParse(overlapping).success).toBe(true);
  });

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

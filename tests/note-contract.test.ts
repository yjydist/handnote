import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("math fences cannot create or replace a committed revision", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const write = tools.write_note.execute;
    const revise = tools.revise_note.execute;
    if (!write || !revise) throw new Error("missing tools");
    state.beginModelStep();
    for (const formula of ["x+1", String.raw`\phantom{x}`]) {
      expect(
        await write(
          { markdown: `\`\`\`math\n${formula}\n\`\`\``, audit: {} },
          {} as Parameters<typeof write>[1],
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: "invalid_markdown",
          repairable: true,
          message: expect.stringContaining("invalid_math_fence (line 1)"),
        },
      });
      expect(state.revision).toBeUndefined();
      expect(
        await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
      ).toBe(false);
    }
    expect(
      await write(
        { markdown: simpleMarkdown(), audit: {} },
        {} as Parameters<typeof write>[1],
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    const committed = state.revision;
    if (!committed) throw new Error("missing committed revision");
    state.beginModelStep();
    expect(
      await revise(
        { markdown: "```math\n\\phantom{x}\n```", audit: {} },
        {} as Parameters<typeof revise>[1],
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_markdown" } });
    expect(state.revision).toBe(committed);
    expect(
      await readFile(`${directory}/revisions/revision-001.md`, "utf8"),
    ).toBe(simpleMarkdown());
    expect(
      await Bun.file(`${directory}/revisions/revision-002.md`).exists(),
    ).toBe(false);
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

  test("write_note validates audit targets against rendered Mermaid labels", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    const markdown = [
      "Visible label",
      "",
      "```mermaid",
      "flowchart TD",
      '  internal_id["Visible label"] -->|Edge label| b[End]',
      '  hidden_id["Hidden label"]',
      "  classDef hiddenClass opacity:0",
      "  class hidden_id hiddenClass",
      "```",
    ].join("\n");
    const uncertainty = (id: string, quote: string, occurrence?: number) => ({
      id,
      target: { quote, ...(occurrence ? { occurrence } : {}) },
      bestGuess: quote,
      candidates: [quote, "alternative"],
      basis: "b",
      region: fullRegion,
      confidence: 0.5,
    });

    const rejected = await execute(
      {
        markdown,
        audit: {
          uncertainties: [
            uncertainty("u1", "flowchart TD"),
            uncertainty("u2", "internal_id"),
            uncertainty("u3", "Visible label Edge label"),
            uncertainty("u6", "Hidden label"),
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid_audit" },
    });
    const rejectedMessage = (rejected as { error?: { message?: string } }).error
      ?.message;
    for (const id of ["u1", "u2", "u3", "u6"])
      expect(rejectedMessage).toContain(`Audit ${id} quote not found`);
    expect(state.revision).toBeUndefined();
    expect(
      await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
    ).toBe(false);

    const accepted = await execute(
      {
        markdown,
        audit: {
          uncertainties: [
            uncertainty("u4", "Visible label", 2),
            uncertainty("u5", "Edge label"),
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(accepted).toMatchObject({ ok: true, revision: 1 });
    expect(state.revision?.audit.uncertainties).toHaveLength(2);
    expect(state.revision?.render).not.toHaveProperty("semanticEvidence");
    const session = await readFile(`${directory}/session/events.jsonl`, "utf8");
    expect(session).not.toContain("semanticEvidence");
  });

  test("transparent Mermaid labels cannot supply audit quotes or occurrences", async () => {
    for (const htmlLabels of [true, false]) {
      const directory = await temporary();
      const { state, tools } = await setup(directory);
      const write = tools.write_note.execute;
      const revise = tools.revise_note.execute;
      if (!write || !revise) throw new Error("missing note tools");
      const markdown = [
        "```mermaid",
        `%%{init: ${JSON.stringify({ htmlLabels })}}%%`,
        "flowchart TD",
        "a[Hidden]:::transparent",
        "b[Visible]",
        "c[Visible]:::transparent",
        "classDef transparent color:transparent",
        "```",
      ].join("\n");
      const audit = (quote: string, occurrence = 1) => ({
        uncertainties: [
          {
            id: "u1",
            target: { quote, occurrence },
            bestGuess: quote,
            candidates: [quote, "alternative"],
            basis: "ambiguous source",
            region: fullRegion,
            confidence: 0.5,
          },
        ],
      });
      state.beginModelStep();
      for (const invalidAudit of [audit("Hidden"), audit("Visible", 2)]) {
        expect(
          await write(
            { markdown, audit: invalidAudit },
            {} as Parameters<typeof write>[1],
          ),
        ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
        expect(state.revision).toBeUndefined();
      }
      expect(
        await write(
          { markdown, audit: audit("Visible") },
          {} as Parameters<typeof write>[1],
        ),
      ).toMatchObject({ ok: true, revision: 1 });
      const committed = state.revision;
      if (!committed) throw new Error("missing revision");
      state.beginModelStep();
      expect(
        await revise(
          { markdown, audit: audit("Hidden") },
          {} as Parameters<typeof revise>[1],
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
      expect(state.revision).toBe(committed);
      expect(
        await readFile(`${directory}/revisions/revision-001.md`, "utf8"),
      ).toBe(markdown);
      expect(
        await Bun.file(`${directory}/revisions/revision-002.md`).exists(),
      ).toBe(false);
    }
  }, 30_000);

  test("Mermaid math does not shift subsequent body audit targets", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    state.beginModelStep();
    const markdown =
      '```mermaid\nflowchart TD\n a["$$x$$"] --> b[Done]\n```\n\nValue $y$.';
    for (const quote of ["Value x.", "Value y."]) {
      const result = await execute(
        {
          markdown,
          audit: {
            uncertainties: [
              {
                id: "u1",
                target: { quote },
                bestGuess: "y",
                candidates: ["y", "z"],
                basis: "ambiguous source",
                region: fullRegion,
                confidence: 0.5,
              },
            ],
          },
        },
        {} as Parameters<typeof execute>[1],
      );
      if (quote === "Value x.") {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "invalid_audit" },
        });
        expect(state.revision).toBeUndefined();
      } else {
        expect(result).toMatchObject({ ok: true, revision: 1 });
        expect(state.revision?.audit.uncertainties[0]?.target.quote).toBe(
          quote,
        );
      }
    }
  });

  test("write_note rejects a Mermaid declaration with no rendered content", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");

    const result = await execute(
      {
        markdown: "```mermaid\nflowchart TD\n```",
        audit: {},
      },
      {} as Parameters<typeof execute>[1],
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_markdown",
        message: expect.stringContaining("empty_document"),
      },
    });
    expect(state.revision).toBeUndefined();
    expect(
      await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
    ).toBe(false);
  }, 30_000);

  test("write_note validates audit targets against rendered math text", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    state.beginModelStep();
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    const markdown = [
      "xy",
      "",
      "Inline $E=mc^2$ tail.",
      "",
      "Visible $a+\\phantom{hidden}+b$ operands.",
      "",
      "$\\smash{x}$",
      "",
      "$$",
      "\\frac{x}{y}",
      "$$",
      "",
      "$$",
      "\\notACommand{",
      "$$",
    ].join("\n");
    const uncertainty = (id: string, quote: string, occurrence?: number) => ({
      id,
      target: { quote, ...(occurrence ? { occurrence } : {}) },
      bestGuess: quote,
      candidates: [quote, "alternative"],
      basis: "b",
      region: fullRegion,
      confidence: 0.5,
    });

    const rejected = await execute(
      {
        markdown,
        audit: {
          uncertainties: [
            uncertainty("u1", "frac"),
            uncertainty("u2", "\\frac"),
            uncertainty("u3", "E=mc^2"),
            uncertainty("u4", "tail. xy"),
            uncertainty("u8", "hidden"),
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid_audit" },
    });
    const rejectedMessage = (rejected as { error?: { message?: string } }).error
      ?.message;
    for (const id of ["u1", "u2", "u3", "u4", "u8"])
      expect(rejectedMessage).toContain(`Audit ${id} quote not found`);
    expect(state.revision).toBeUndefined();
    expect(
      await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
    ).toBe(false);

    const accepted = await execute(
      {
        markdown,
        audit: {
          uncertainties: [
            uncertainty("u5", "Inline E=mc2 tail."),
            uncertainty("u6", "xy", 2),
            uncertainty("u7", "\\notACommand{"),
            uncertainty("u9", "Visible a++b operands."),
            uncertainty("u10", "x"),
          ],
        },
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(accepted).toMatchObject({ ok: true, revision: 1 });
    expect(state.revision?.render).not.toHaveProperty("semanticEvidence");
    const session = await readFile(`${directory}/session/events.jsonl`, "utf8");
    expect(session).not.toContain("semanticEvidence");
  });

  test("write_note rejects notes containing only hidden math", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    state.beginModelStep();
    for (const formula of [
      String.raw`\phantom{x}`,
      String.raw`\hphantom{x}`,
      String.raw`\vphantom{x}`,
      String.raw`\textcolor{transparent}{x}`,
    ]) {
      for (const markdown of [`$${formula}$`, `$$\n${formula}\n$$`]) {
        expect(
          await execute(
            { markdown, audit: {} },
            {} as Parameters<typeof execute>[1],
          ),
        ).toMatchObject({
          ok: false,
          error: {
            code: "invalid_markdown",
            message:
              "empty_document: Markdown document must contain visible content",
          },
        });
        expect(state.revision).toBeUndefined();
        expect(
          await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
        ).toBe(false);
      }
    }
  }, 30_000);

  test("write_note matches only rendered image captions across Markdown contexts", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    await mkdir(`${directory}/assets/figures`, { recursive: true });
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toFile(`${directory}/assets/figures/figure-001.png`);
    const img = (alt: string) => `![${alt}](assets/figures/figure-001.png)`;
    const markdown = [
      `Before ${img("inline secret")} after.`,
      `# ${img("heading secret")}`,
      `| image |\n| --- |\n| ${img("table secret")} |`,
      `**${img("emphasis secret")}**`,
      `- ${img("tight secret")}\n- second item`,
      "Separate lists.",
      `- ${img("loose caption")}\n\n- second item`,
      "Separate tasks.",
      `- [ ] ${img("task secret")}\n\n- [x] complete`,
      img("standalone &amp; caption"),
      `> ${img("quoted caption")}`,
      img(""),
      "Shared words",
      img("Shared   words"),
      `Inline ${img("Shared words")} tail`,
      "$\\text{Shared words}$",
      '```mermaid\nflowchart TD\n a["Shared words"]\n```',
    ].join("\n\n");
    const audit = (targets: { quote: string; occurrence?: number }[]) => ({
      uncertainties: targets.map((target, index) => ({
        id: `u${index}`,
        target,
        bestGuess: target.quote,
        candidates: [target.quote, "alternative"],
        basis: "b",
        region: fullRegion,
        confidence: 0.5,
      })),
    });
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    state.beginModelStep();
    const rejectedTargets: { quote: string; occurrence?: number }[] = [
      ...[
        "inline secret",
        "heading secret",
        "table secret",
        "emphasis secret",
        "tight secret",
        "task secret",
        "caption quoted",
      ].map((quote) => ({ quote })),
      { quote: "Shared words", occurrence: 5 },
    ];
    const rejected = await execute(
      { markdown, audit: audit(rejectedTargets) },
      {} as Parameters<typeof execute>[1],
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "invalid_audit" },
    });
    for (const [index, target] of rejectedTargets.entries()) {
      expect(
        (rejected as { error: { message: string } }).error.message,
      ).toContain(
        `Audit u${index} quote not found (occurrence ${target.occurrence ?? 1})`,
      );
    }
    expect(state.revision).toBeUndefined();
    expect(
      await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
    ).toBe(false);
    const accepted = await execute(
      {
        markdown,
        audit: audit([
          { quote: "Before after." },
          { quote: "loose caption" },
          { quote: "standalone & caption" },
          { quote: "quoted caption" },
          { quote: "Shared words", occurrence: 4 },
        ]),
      },
      {} as Parameters<typeof execute>[1],
    );
    expect(accepted).toMatchObject({ ok: true, revision: 1 });
    expect(JSON.stringify(accepted)).not.toContain("imageCaptionBlocks");
    expect(JSON.stringify(state.revision)).not.toContain("imageCaptionBlocks");
    expect(
      await readFile(`${directory}/session/events.jsonl`, "utf8"),
    ).not.toContain("imageCaptionBlocks");
  }, 30_000);

  test("write_note accepts an image without alt as content", async () => {
    const directory = await temporary();
    const { tools } = await setup(directory);
    await mkdir(`${directory}/assets/figures`, { recursive: true });
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toFile(`${directory}/assets/figures/figure-001.png`);
    const execute = tools.write_note.execute;
    if (!execute) throw new Error("missing write_note");
    expect(
      await execute(
        { markdown: "![](assets/figures/figure-001.png)", audit: {} },
        {} as Parameters<typeof execute>[1],
      ),
    ).toMatchObject({ ok: true, revision: 1 });
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

describe("GFM table audit", () => {
  const audit = (quote: string, occurrence = 1) => ({
    uncertainties: [
      {
        id: "u1",
        target: { quote, occurrence },
        bestGuess: quote,
        candidates: [quote, "alternative"],
        basis: "ambiguous source",
        region: fullRegion,
        confidence: 0.5,
      },
    ],
  });

  test("discarded table cells cannot supply quotes or extra occurrences", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    const write = tools.write_note.execute;
    const revise = tools.revise_note.execute;
    if (!write || !revise) throw new Error("missing note tools");
    const markdown = "| A |\n| - |\n| B | Hidden |\n| C | B |\n";
    state.beginModelStep();
    for (const invalidAudit of [audit("Hidden"), audit("B", 2)]) {
      expect(
        await write(
          { markdown, audit: invalidAudit },
          {} as Parameters<typeof write>[1],
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
      expect(state.revision).toBeUndefined();
      expect(
        await Bun.file(`${directory}/revisions/revision-001.md`).exists(),
      ).toBe(false);
    }
    expect(
      await write(
        { markdown, audit: audit("B") },
        {} as Parameters<typeof write>[1],
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    const committed = state.revision;
    if (!committed) throw new Error("missing revision");
    expect(committed.markdown).toBe(markdown);
    state.beginModelStep();
    expect(
      await revise(
        { markdown, audit: audit("Hidden") },
        {} as Parameters<typeof revise>[1],
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
    expect(state.revision).toBe(committed);
    expect(
      await readFile(`${directory}/revisions/revision-001.md`, "utf8"),
    ).toBe(markdown);
    expect(
      await Bun.file(`${directory}/revisions/revision-002.md`).exists(),
    ).toBe(false);
  });

  test("discarded table media does not shift subsequent math or captions", async () => {
    const directory = await temporary();
    const { state, tools } = await setup(directory);
    await mkdir(`${directory}/assets/figures`, { recursive: true });
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "white" },
    })
      .png()
      .toFile(`${directory}/assets/figures/figure-001.png`);
    const markdown = [
      "| A |",
      "| - |",
      "| B | $x$ ![Hidden](assets/figures/figure-001.png) |",
      "",
      "Value $y$.",
      "",
      "Before ![Inline alt](assets/figures/figure-001.png) after.",
      "",
      "![Visible caption](assets/figures/figure-001.png)",
    ].join("\n");
    const write = tools.write_note.execute;
    if (!write) throw new Error("missing write_note");
    state.beginModelStep();
    expect(
      await write(
        { markdown, audit: audit("Hidden") },
        {} as Parameters<typeof write>[1],
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_audit" } });
    expect(state.revision).toBeUndefined();
    expect(
      await write(
        {
          markdown,
          audit: {
            uncertainties: ["Value y.", "Before after.", "Visible caption"].map(
              (quote, index) => ({
                ...audit(quote).uncertainties[0],
                id: `u${index}`,
              }),
            ),
          },
        },
        {} as Parameters<typeof write>[1],
      ),
    ).toMatchObject({ ok: true, revision: 1 });
    expect(state.revision?.markdown).toBe(markdown);
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

  test("defers image locators to rendering while preserving audit structure checks", () => {
    const input = {
      ...draft("caption"),
      markdown: "![caption](assets/figures/figure-001.png)",
    };
    expect(revisionDraftSchema.safeParse(input).success).toBe(true);
    expect(
      revisionDraftSchema.safeParse({
        ...input,
        audit: {
          uncertainties: [{ ...input.audit.uncertainties[0], confidence: 2 }],
        },
      }).success,
    ).toBe(false);
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
      "| value | plain |",
    ].join("\n");
    const withMarkdown = (quote: string) => ({
      ...draft(quote),
      markdown,
    });
    for (const quote of ["Visible heading", "cell", "code", "plain"])
      expect(revisionDraftSchema.safeParse(withMarkdown(quote)).success).toBe(
        true,
      );
    expect(
      revisionDraftSchema.safeParse(withMarkdown("**Visible**")).success,
    ).toBe(false);
    expect(
      revisionDraftSchema.safeParse(withMarkdown("block second")).success,
    ).toBe(false);
    expect(
      revisionDraftSchema.safeParse({
        ...draft("x"),
        markdown: "Math $x$ is render-dependent.",
      }).success,
    ).toBe(true);
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

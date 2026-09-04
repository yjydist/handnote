import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  type MarkdownIssue,
  MarkdownValidationError,
  maxMarkdownLength,
  noteMarkdownToHtml,
  parseNoteMarkdown,
} from "../src/markdown.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-markdown-`);
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

async function figureFixture(runDirectory: string): Promise<string> {
  await mkdir(`${runDirectory}/assets/figures`, { recursive: true });
  const path = `${runDirectory}/assets/figures/figure-001.png`;
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#d0e4f2" },
  })
    .png()
    .toFile(path);
  return path;
}

const expectIssues = async (
  markdown: string,
  runDirectory: string,
  codes: string[],
): Promise<MarkdownIssue[]> => {
  let caught: unknown;
  try {
    await parseNoteMarkdown(markdown, { runDirectory });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MarkdownValidationError);
  const issues = (caught as MarkdownValidationError).issues;
  expect(issues.map((issue) => issue.code)).toEqual(codes);
  return issues;
};

describe("parseNoteMarkdown", () => {
  test("parses a strict GFM document and counts its structure", async () => {
    const runDirectory = await temporary();
    await figureFixture(runDirectory);
    const note = await parseNoteMarkdown(
      `# 标题

段落一 $x^2$ 内容。

| 列一 | 列二 |
| --- | --- |
| 1 | 2 |

\`\`\`mermaid
flowchart TD
  a --> b
\`\`\`

$$
\\frac{x^2}{y}
$$

![说明](assets/figures/figure-001.png)
`,
      { runDirectory },
    );
    expect(note.structure).toEqual({
      headings: 1,
      blocks: 6,
      tables: 1,
      equations: 2,
      diagrams: 1,
      figures: 1,
    });
    expect(note.mathWarnings).toEqual([]);
  });

  test("rejects raw HTML, links, autolinks, definitions, and frontmatter", async () => {
    const runDirectory = await temporary();
    await expectIssues("", runDirectory, ["empty_document"]);
    await expectIssues("<div>hi</div>\n\n正文。", runDirectory, [
      "raw_html",
    ]).then((issues) => expect(issues[0]?.line).toBe(1));
    await expectIssues("[点击](https://example.test)", runDirectory, [
      "link_not_allowed",
    ]);
    await expectIssues("访问 https://example.test 查看", runDirectory, [
      "link_not_allowed",
    ]);
    await expectIssues("[ref]: https://example.test", runDirectory, [
      "link_not_allowed",
    ]);
    await expectIssues("---\ntitle: x\n---\n\n正文。", runDirectory, [
      "frontmatter_unsupported",
    ]);
    await expectIssues("", runDirectory, ["empty_document"]);
    await expectIssues("   \n\n", runDirectory, ["empty_document"]);
  });

  test("rejects oversized markdown", async () => {
    const runDirectory = await temporary();
    await expectIssues("正".repeat(maxMarkdownLength + 1), runDirectory, [
      "markdown_too_large",
    ]);
  });

  test("rejects invalid and unknown image paths", async () => {
    const runDirectory = await temporary();
    await expectIssues("![x](https://example.test/a.png)", runDirectory, [
      "invalid_image_path",
    ]);
    await expectIssues("![x](assets/figures/../escape.png)", runDirectory, [
      "invalid_image_path",
    ]);
    await expectIssues("![x](assets/figures/missing.png)", runDirectory, [
      "unknown_image",
    ]);
    await figureFixture(runDirectory);
    const note = await parseNoteMarkdown(
      "![x](assets/figures/figure-001.png)",
      { runDirectory },
    );
    expect(note.structure.figures).toBe(1);
  });

  test("rejects every reference-style image form", async () => {
    const runDirectory = await temporary();
    for (const markdown of [
      "![defined][figure]\n\n[figure]: assets/figures/figure-001.png",
      "![undefined][figure]",
      "![collapsed][]",
      "![shortcut]",
    ])
      await expectIssues(markdown, runDirectory, ["invalid_image_syntax"]);
    await parseNoteMarkdown("\\![escaped]", { runDirectory });
  });

  test("rejects footnote references and definitions as links", async () => {
    const runDirectory = await temporary();
    await expectIssues("正文[^1]。\n\n[^1]: 注释内容", runDirectory, [
      "link_not_allowed",
      "link_not_allowed",
    ]);
  });

  test("rejects raw HTML inside mermaid blocks", async () => {
    const runDirectory = await temporary();
    const cases = [
      'a["<img src="data:image/png;base64,AAAA">"] --> b',
      'a["<span>text</span>"] --> b',
      'a["line<br/>break"] --> b',
      'a["<IMG\n  src="data:image/png;base64,AAAA">"] --> b',
      "a[\"<a href='https://example.test'>x</a>\"] --> b",
      'a["<!-- hidden -->text"] --> b',
      'a["<!DOCTYPE html>text"] --> b',
      'a["<![CDATA[text]]>"] --> b',
      'a["<?processing instruction?>text"] --> b',
    ];
    for (const source of cases)
      await expectIssues(
        `前文。\n\n\`\`\`mermaid\nflowchart TD\n  ${source}\n\`\`\``,
        runDirectory,
        ["raw_html"],
      ).then((issues) => {
        expect(issues[0]?.line).toBe(3);
        expect(issues[0]?.message).toContain("Mermaid");
      });
  });

  test("rejects links, click directives, asset directives, and URLs inside mermaid blocks", async () => {
    const runDirectory = await temporary();
    await expectIssues(
      '```mermaid\nflowchart TD\n  a --> b\n  click a "https://example.test"\n```',
      runDirectory,
      ["link_not_allowed"],
    ).then((issues) => expect(issues[0]?.message).toContain("Mermaid"));
    await expectIssues(
      '```mermaid\nflowchart TD\n  a["[label](https://example.test)"] --> b\n```',
      runDirectory,
      ["link_not_allowed"],
    );
    await expectIssues(
      '```mermaid\nflowchart TD\n  a@{ img: "https://example.test/x.png" } --> b\n```',
      runDirectory,
      ["link_not_allowed"],
    );
    await expectIssues(
      '```mermaid\nflowchart TD\n  a@{ img: "/local.png" } --> b\n```',
      runDirectory,
      ["link_not_allowed"],
    );
    for (const attribute of [
      'IMG: "/local.png"',
      '"img": "/local.png"',
      "img",
      "img, shape: diamond",
      "ImG: '/local.png'",
    ])
      await expectIssues(
        `\`\`\`mermaid\nflowchart TD\n  a@{ ${attribute} } --> b\n\`\`\``,
        runDirectory,
        ["link_not_allowed"],
      );
    await expectIssues(
      "```mermaid\nflowchart TD\n  a[see https://example.test] --> b\n```",
      runDirectory,
      ["link_not_allowed"],
    );
    await parseNoteMarkdown(
      "```mermaid\nflowchart TD\n  a[plain label] --> b\n```",
      { runDirectory },
    );
    await parseNoteMarkdown(
      '```mermaid\nflowchart TD\n  a@{ shape: diamond, label: "Decision" } --> b\n```',
      { runDirectory },
    );
    await parseNoteMarkdown(
      '```mermaid\nflowchart TD\n  a@{ shape: diamond, label: "Decision } \\"ok\\"" } --> b\n```',
      { runDirectory },
    );
    await parseNoteMarkdown(
      '```mermaid\nflowchart TD\n  a["A < B > C"] --> b\n  b["&lt;span&gt;text&lt;/span&gt;"] --> c\n```',
      { runDirectory },
    );
    await parseNoteMarkdown("```mermaid\nflowchart TD\n  click --> node\n```", {
      runDirectory,
    });
    await expectIssues(
      "```mermaid\nflowchart TD\n  click node callback\n```",
      runDirectory,
      ["link_not_allowed"],
    );
  });

  test("requires the lowercase mermaid fence name", async () => {
    const runDirectory = await temporary();
    for (const language of ["Mermaid", "MERMAID", "mErMaId"])
      await expectIssues(
        `\`\`\`${language}\nflowchart TD\n  a --> b\n\`\`\``,
        runDirectory,
        ["invalid_mermaid_fence"],
      );
  });

  test("keeps single-dollar math and escaped currency distinct", async () => {
    const runDirectory = await temporary();
    const note = await parseNoteMarkdown("Price \\$5; formula $x+1$.", {
      runDirectory,
    });
    expect(note.structure.equations).toBe(1);
  });

  test("reports invalid KaTeX as non-blocking equation_fallback warnings", async () => {
    const runDirectory = await temporary();
    const note = await parseNoteMarkdown(
      "公式 $\\notACommand{x}$ 一段。\n\n$$\n\\notACommand{y}\n$$\n\n另一段 $\\frac{1}{2}$。",
      { runDirectory },
    );
    expect(note.mathWarnings).toHaveLength(2);
    expect(
      note.mathWarnings.every(
        (warning) => warning.code === "equation_fallback",
      ),
    ).toBe(true);
    expect(note.mathWarnings.every((warning) => !warning.blocking)).toBe(true);
    expect(note.mathWarnings[0]?.elementId).toBe("hn-0001");
    expect(note.mathWarnings[1]?.elementId).toBe("hn-0002");
  });
});

describe("noteMarkdownToHtml", () => {
  test("renders anchors, KaTeX, GFM tables, and mermaid swap with anchor moved to pre", async () => {
    const runDirectory = await temporary();
    await figureFixture(runDirectory);
    const note = await parseNoteMarkdown(
      `# 标题

正文 $x^2$ 一句。

| 列一 | 列二 |
| --- | --- |
| 1 | 2 |

\`\`\`mermaid
flowchart TD
  a --> b
\`\`\`

\`\`\`python
print("hi")
\`\`\`
`,
      { runDirectory },
    );
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toContain('<h1 data-hn-id="hn-0001"');
    expect(html).toContain('data-hn-id="hn-0002"');
    expect(html).toContain("katex");
    expect(html).toContain("<table");
    expect(html).toContain("<th>列一</th>");
    expect(html).toMatch(
      /<pre class="mermaid" data-hn-id="hn-0004">[^<]*flowchart TD/,
    );
    expect(html).not.toContain("language-mermaid");
    expect(html).toContain("<code");
    expect(html).toContain('class="language-python"');
  });

  test("preserves the display-math anchor through KaTeX conversion", async () => {
    const runDirectory = await temporary();
    const note = await parseNoteMarkdown("$$\nx^2\n$$", { runDirectory });
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toMatch(
      /^<div data-hn-id="hn-0001"><span class="katex-display">/,
    );
  });

  test("inlines local figures as data URIs and wraps standalone images in figure", async () => {
    const runDirectory = await temporary();
    await figureFixture(runDirectory);
    const note = await parseNoteMarkdown(
      "前文。\n\n![裁片说明](assets/figures/figure-001.png)\n\n后文 ![行内](assets/figures/figure-001.png) 图片。",
      { runDirectory },
    );
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("assets/figures/figure-001.png");
    expect(html).toMatch(/<figure data-hn-id="hn-0002">/);
    expect(html).toContain("<figcaption>裁片说明</figcaption>");
    expect(html).not.toMatch(/<figcaption>[^<]*行内/);
  });

  test("leaves inline images un-wrapped and skips figure caption for empty alt", async () => {
    const runDirectory = await temporary();
    await figureFixture(runDirectory);
    const note = await parseNoteMarkdown("![](assets/figures/figure-001.png)", {
      runDirectory,
    });
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toContain("<figure");
    expect(html).not.toContain("<figcaption");
  });

  test("accepts GFM task lists", async () => {
    const runDirectory = await temporary();
    const markdown = "- [ ] 待办\n- [x] 完成\n";
    const note = await parseNoteMarkdown(markdown, { runDirectory });
    expect(note.structure.blocks).toBe(3);
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toContain("待办");
  });

  test("blockquote and nested list anchors are assigned per block", async () => {
    const runDirectory = await temporary();
    const note = await parseNoteMarkdown(
      "> 引用内容\n\n- 项目一\n  - 子项目\n",
      { runDirectory },
    );
    const html = await noteMarkdownToHtml(note, { runDirectory });
    expect(html).toContain('data-hn-id="hn-0001"');
    expect(html).toContain('data-hn-id="hn-0002"');
    expect(html).toContain('data-hn-id="hn-0003"');
  });
});

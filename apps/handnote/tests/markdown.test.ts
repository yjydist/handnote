import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { compileNoteMarkdown, maxMarkdownLength } from "../src/markdown.ts";
import { sha256File } from "../src/utils.ts";

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
async function figureFixture(directory: string): Promise<string> {
  await mkdir(`${directory}/assets/figures`, { recursive: true });
  const path = `${directory}/assets/figures/figure-001.png`;
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#d0e4f2" },
  })
    .png()
    .toFile(path);
  return path;
}

describe("Markdown compilation", () => {
  test("supports GFM links, footnotes and sanitized HTML with working fragments", async () => {
    const markdown = `# Note

[link](https://example.test) and [reference][ref], https://example.test and note[^one].

[ref]: https://example.test/reference
[^one]: Footnote **body**.

<a href="#target">Jump</a><b id="target" onclick="alert(1)" style="color:red">Safe</b>
<script>alert('script-body')</script>
<a href="javascript:alert(1)">Unsafe URL</a>

- [x] done

| A | B |
| - | - |
| a | b |
`;
    const note = await compileNoteMarkdown(markdown, {
      runDirectory: await temporary(),
    });
    expect(note.markdown).toBe(markdown);
    expect(note.html).toContain('href="https://example.test/reference"');
    expect(note.html).toContain('href="#user-content-target"');
    expect(note.html).toContain('id="user-content-target"');
    expect(note.html).toContain('href="#user-content-user-content-fn-one"');
    expect(note.html).toContain('id="user-content-user-content-fn-one"');
    expect(note.html).toContain('href="#user-content-user-content-fnref-one"');
    expect(note.html).toContain(
      'aria-describedby="user-content-footnote-label"',
    );
    expect(note.html).toContain('id="user-content-footnote-label"');
    expect(note.html).toContain("<strong>body</strong>");
    expect(note.html).toContain('type="checkbox"');
    expect(note.html).not.toMatch(
      /<script|script-body|onclick|style=|javascript:/,
    );
    expect(note.structure).toMatchObject({ headings: 2, tables: 1 });
  });

  test("inlines Markdown, reference and HTML images through the same resource boundary", async () => {
    const directory = await temporary();
    const path = await figureFixture(directory);
    const markdown =
      '![Caption](../assets/figures/figure-001.png)\n\n![Reference][image]\n\n[image]: ../assets/figures/figure-001.png\n\n<p><img src="../assets/figures/figure-001.png" alt="HTML" onerror="alert(1)"></p>\n\nInline ![alt](../assets/figures/figure-001.png) text.';
    const note = await compileNoteMarkdown(markdown, {
      runDirectory: directory,
    });
    const uri = `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
    expect(note.html.split(uri)).toHaveLength(5);
    expect(note.html).toContain("<figcaption>Caption</figcaption>");
    expect(note.html).toContain("<figcaption>Reference</figcaption>");
    expect(note.html).toContain("<figcaption>HTML</figcaption>");
    expect(note.html).not.toContain("<figcaption>alt</figcaption>");
    expect(note.html).not.toContain("onerror");
    expect(note.structure.figures).toBe(4);
    expect(note.assets).toEqual([
      {
        path: "assets/figures/figure-001.png",
        sha256: await sha256File(path),
      },
    ]);
  });

  test("validates every HTML picture candidate before inlining srcset", async () => {
    const runDirectory = await temporary();
    const path = await figureFixture(runDirectory);
    const local = "../assets/figures/figure-001.png";
    const note = await compileNoteMarkdown(
      `<picture><source srcset="${local} 1x, ${local} 2x"><img src="${local}"></picture>`,
      { runDirectory },
    );
    const uri = `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
    expect(note.html).toContain(`srcset="${uri} 1x, ${uri} 2x"`);
    for (const url of [
      "https://example.test/remote.png",
      "data:image/png;base64,YQ==",
      "../source.png",
    ])
      await expect(
        compileNoteMarkdown(
          `<picture><source srcset="${local} 1x, ${url} 2x"><img src="${local}"></picture>`,
          { runDirectory },
        ),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "invalid_image_path" })],
      });
  });

  test("rejects remote, missing and escaping images regardless of source syntax", async () => {
    const directory = await temporary();
    const outside = await temporary();
    const outsideFigure = await figureFixture(outside);
    await figureFixture(directory);
    await symlink(outsideFigure, `${directory}/assets/figures/escape.png`);
    for (const src of [
      "https://example.test/image.png",
      "//example.test/image.png",
      "../source.png",
      "../assets/figures/escape.png",
      "data:image/png;base64,YQ==",
    ]) {
      for (const markdown of [
        `![alt](${src})`,
        `![alt][ref]\n\n[ref]: ${src}`,
        `<img src="${src}">`,
      ]) {
        await expect(
          compileNoteMarkdown(markdown, { runDirectory: directory }),
        ).rejects.toMatchObject({
          issues: [expect.objectContaining({ code: "invalid_image_path" })],
        });
      }
    }
    await expect(
      compileNoteMarkdown("![alt](../assets/figures/missing.png)", {
        runDirectory: directory,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "missing_figure" })],
    });
    const linked = await temporary();
    await mkdir(`${linked}/assets`);
    await symlink(`${outside}/assets/figures`, `${linked}/assets/figures`);
    await expect(
      compileNoteMarkdown("![alt](../assets/figures/figure-001.png)", {
        runDirectory: linked,
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "invalid_image_path" })],
    });
  });

  test("rejects internal symbolic links and non-file figures for all image syntax", async () => {
    const directory = await temporary();
    const original = await figureFixture(directory);
    await symlink(original, `${directory}/assets/figures/link.png`);
    await symlink(
      `${directory}/assets/figures`,
      `${directory}/assets/figures/alias`,
    );
    await symlink(
      `${directory}/assets/figures/missing.png`,
      `${directory}/assets/figures/dangling.png`,
    );
    await mkdir(`${directory}/assets/figures/directory.png`);
    for (const src of [
      "../assets/figures/link.png",
      "../assets/figures/dangling.png",
      "../assets/figures/directory.png",
      "../assets/figures/alias/figure-001.png",
    ])
      for (const markdown of [
        `![alt](${src})`,
        `![alt][ref]\n\n[ref]: ${src}`,
        `<img src="${src}">`,
        `<picture><source srcset="${src} 1x"><img src="../assets/figures/figure-001.png"></picture>`,
      ])
        await expect(
          compileNoteMarkdown(markdown, { runDirectory: directory }),
        ).rejects.toMatchObject({
          issues: [expect.objectContaining({ code: "invalid_image_path" })],
        });
  });

  test("uses library math and code conventions with nonblocking KaTeX fallback", async () => {
    const note = await compileNoteMarkdown(
      "$x$\n\n$$\ny^2\n$$\n\n```math\n\\frac{a}{b}\n```\n\n```MATH\nliteral\n```\n\n$\\notACommand{$\n\n```mermaid\nflowchart TD\n A --> B\n```\n\n```Mermaid\nliteral\n```",
      { runDirectory: await temporary() },
    );
    expect(note.structure).toMatchObject({ equations: 4, diagrams: 1 });
    expect(note.html).toContain('class="katex"');
    expect(note.html).toContain('class="katex-error"');
    expect(note.html).toContain('class="language-MATH"');
    expect(note.html).toContain('class="language-Mermaid"');
    expect(note.html).toMatch(
      /<div data-hn-id="[^"]+"><span class="katex-display">/,
    );
    expect(note.warnings).toEqual([
      expect.objectContaining({
        code: "equation_fallback",
        blocking: false,
        elementId: expect.any(String),
      }),
    ]);
  });

  test("rejects only blank or oversized text at the syntax boundary", async () => {
    const runDirectory = await temporary();
    for (const markdown of ["", " \n\t\r"])
      await expect(
        compileNoteMarkdown(markdown, { runDirectory }),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "empty_document" })],
      });
    await expect(
      compileNoteMarkdown("x".repeat(maxMarkdownLength + 1), { runDirectory }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "markdown_too_large" })],
    });
    for (const markdown of [
      "---\ntitle: Note\n---",
      "---",
      "<script>gone</script>",
      "$\\phantom{x}$",
      "[definition]: https://example.test",
      "| |\n|-|\n| | Hidden |",
      '```mermaid\nflowchart TD\n a[" "]\n style a fill:#ff000000,stroke:none\n```',
    ]) {
      const note = await compileNoteMarkdown(markdown, { runDirectory });
      expect(note.markdown).toBe(markdown);
    }
  });

  test("leaves table projection and missing cells to standard GFM rendering", async () => {
    const note = await compileNoteMarkdown(
      "| A | B |\n| - | - |\n| One |\n| Two | Visible | Hidden |",
      { runDirectory: await temporary() },
    );
    expect(note.html).toContain("<td>One</td><td></td>");
    expect(note.html).toContain("<td>Two</td><td>Visible</td>");
    expect(note.html).not.toContain("Hidden");
  });
});

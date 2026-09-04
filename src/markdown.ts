import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElementContent, Root as HastRoot } from "hast";
import katex from "katex";
import type { Root } from "mdast";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { LayoutWarning } from "./renderer.ts";

export const maxMarkdownLength = 200_000;

const figurePathPattern = /^assets\/figures\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

const blockNodeTypes = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
  "list",
  "table",
  "math",
  "thematicBreak",
]);

export interface MarkdownIssue {
  code: string;
  message: string;
  line?: number;
}

export class MarkdownValidationError extends Error {
  issues: MarkdownIssue[];

  constructor(issues: MarkdownIssue[]) {
    super(
      `Markdown failed validation: ${issues
        .map(
          (issue) =>
            `${issue.code}${issue.line ? ` (line ${issue.line})` : ""}: ${issue.message}`,
        )
        .join("; ")}`,
    );
    this.name = "MarkdownValidationError";
    this.issues = issues;
  }
}

export interface NoteStructure {
  headings: number;
  blocks: number;
  tables: number;
  equations: number;
  diagrams: number;
  figures: number;
}

export interface NoteMarkdown {
  markdown: string;
  tree: Root;
  structure: NoteStructure;
  mathWarnings: LayoutWarning[];
}

interface LocatedNode {
  type: string;
  position?: { start?: { line?: number } | undefined } | undefined;
}

const startLine = (node: LocatedNode): number | undefined =>
  node.position?.start?.line;

function validateIssues(tree: Root): MarkdownIssue[] {
  const issues: MarkdownIssue[] = [];
  const add = (code: string, message: string, node: LocatedNode) => {
    const line = startLine(node);
    issues.push({ code, message, ...(line ? { line } : {}) });
  };
  for (const node of tree.children) {
    if (node.type === "html")
      add(
        "raw_html",
        "Raw HTML is not allowed; express the content in GFM syntax",
        node,
      );
    if (node.type === "definition")
      add(
        "link_not_allowed",
        "Link definitions are not allowed; write URLs as inline code instead",
        node,
      );
  }
  visit(tree, (node) => {
    if (node.type === "link")
      add(
        "link_not_allowed",
        "Links are not allowed; write URLs as inline code instead",
        node,
      );
    if (node.type === "image") {
      const url = (node as { url?: string }).url ?? "";
      if (!figurePathPattern.test(url))
        add(
          "invalid_image_path",
          `Image path must match assets/figures/<name>.png: ${url}`,
          node,
        );
    }
  });
  return issues;
}

async function missingFigures(
  tree: Root,
  runDirectory: string,
): Promise<MarkdownIssue[]> {
  const urls = new Set<string>();
  visit(tree, (node) => {
    if (node.type === "image") {
      const url = (node as { url?: string }).url;
      if (url && figurePathPattern.test(url)) urls.add(url);
    }
  });
  const issues: MarkdownIssue[] = [];
  for (const url of urls) {
    const exists = await access(resolve(runDirectory, url))
      .then(() => true)
      .catch(() => false);
    if (!exists)
      issues.push({
        code: "unknown_image",
        message: `Referenced figure does not exist: ${url}`,
      });
  }
  return issues;
}

function anchorTree(tree: Root): Map<object, string> {
  const anchors = new Map<object, string>();
  let counter = 0;
  let currentBlockId: string | undefined;
  let currentBlockNode: object | undefined;
  visit(tree, (node) => {
    if (blockNodeTypes.has(node.type)) {
      currentBlockId = `hn-${String(++counter).padStart(4, "0")}`;
      currentBlockNode = node;
      node.data = {
        ...(node.data ?? {}),
        hProperties: { dataHnId: currentBlockId },
      };
    } else if (currentBlockNode && currentBlockId) {
      anchors.set(node, currentBlockId);
    }
  });
  return anchors;
}

function mathWarningsFor(
  tree: Root,
  anchors: Map<object, string>,
): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  visit(tree, (node) => {
    if (node.type !== "math" && node.type !== "inlineMath") return;
    const value = (node as { value?: string }).value ?? "";
    try {
      katex.renderToString(value, {
        throwOnError: true,
        displayMode: node.type === "math",
      });
    } catch (error) {
      warnings.push({
        code: "equation_fallback",
        message: `Invalid KaTeX rendered as text: ${
          error instanceof Error ? error.message : String(error)
        }`,
        blocking: false,
        elementId: anchors.get(node) ?? "document",
      });
    }
  });
  return warnings;
}

function countStructure(tree: Root): NoteStructure {
  const value: NoteStructure = {
    headings: 0,
    blocks: 0,
    tables: 0,
    equations: 0,
    diagrams: 0,
    figures: 0,
  };
  visit(tree, (node) => {
    if (node.type === "heading") value.headings++;
    if (blockNodeTypes.has(node.type)) value.blocks++;
    if (node.type === "table") value.tables++;
    if (node.type === "math" || node.type === "inlineMath") value.equations++;
    if (
      node.type === "code" &&
      (node as { lang?: string | null }).lang === "mermaid"
    )
      value.diagrams++;
    if (node.type === "image") value.figures++;
  });
  return value;
}

export async function parseNoteMarkdown(
  markdown: string,
  options: { runDirectory: string },
): Promise<NoteMarkdown> {
  const issues: MarkdownIssue[] = [];
  if (markdown.length > maxMarkdownLength)
    issues.push({
      code: "markdown_too_large",
      message: `Markdown exceeds ${maxMarkdownLength} characters: ${markdown.length}`,
    });
  if (markdown.trim().length === 0)
    issues.push({
      code: "empty_document",
      message: "Markdown document must contain visible content",
    });
  if (/^---\s*(\n|$)/.test(markdown))
    issues.push({
      code: "frontmatter_unsupported",
      message: "Frontmatter is not supported; start the document with content",
    });
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(markdown);
  issues.push(...validateIssues(tree));
  issues.push(...(await missingFigures(tree, options.runDirectory)));
  if (issues.length > 0) throw new MarkdownValidationError(issues);
  const anchors = anchorTree(tree);
  return {
    markdown,
    tree,
    structure: countStructure(tree),
    mathWarnings: mathWarningsFor(tree, anchors),
  };
}

async function figureDataUri(
  runDirectory: string,
  url: string,
): Promise<string> {
  const data = await Bun.file(resolve(runDirectory, url)).arrayBuffer();
  return `data:image/png;base64,${Buffer.from(data).toString("base64")}`;
}

const hastText = (node: ElementContent): string => {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(hastText).join("");
  return "";
};

const dataHnId = (properties: Record<string, unknown> | undefined) =>
  typeof properties?.dataHnId === "string" ? properties.dataHnId : undefined;

function swapMermaidBlocks(tree: HastRoot): void {
  visit(tree, (node, _index, parent) => {
    if (
      node.type !== "element" ||
      node.tagName !== "pre" ||
      node.children.length !== 1
    )
      return;
    const code = node.children[0];
    if (
      !code ||
      code.type !== "element" ||
      code.tagName !== "code" ||
      !((code.properties.className ?? []) as unknown[]).includes(
        "language-mermaid",
      )
    )
      return;
    const replacement: typeof node = {
      type: "element",
      tagName: "pre",
      properties: {
        className: ["mermaid"],
        dataHnId: dataHnId(code.properties) ?? dataHnId(node.properties),
      },
      children: [{ type: "text", value: hastText(code) }],
    };
    if (parent && typeof _index === "number")
      parent.children[_index] = replacement;
  });
}

async function inlineFigures(
  tree: HastRoot,
  runDirectory: string,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  visit(tree, (node) => {
    if (
      node.type !== "element" ||
      node.tagName !== "img" ||
      typeof node.properties.src !== "string"
    )
      return;
    const src = node.properties.src;
    jobs.push(
      figureDataUri(runDirectory, src).then((uri) => {
        node.properties.src = uri;
      }),
    );
  });
  await Promise.all(jobs);
}

function wrapStandaloneFigures(tree: HastRoot): void {
  visit(tree, (node, index, parent) => {
    if (parent === undefined || typeof index !== "number") return;
    if (node.type !== "element" || node.tagName !== "p") return;
    if (node.children.length !== 1) return;
    const only = node.children[0];
    if (!only || only.type !== "element" || only.tagName !== "img") return;
    const alt =
      typeof only.properties.alt === "string" ? only.properties.alt.trim() : "";
    const figure: typeof node = {
      type: "element",
      tagName: "figure",
      properties: {
        dataHnId: dataHnId(node.properties) ?? dataHnId(only.properties),
      },
      children: [
        only,
        ...(alt
          ? ([
              { type: "text", value: "\n" },
              {
                type: "element",
                tagName: "figcaption",
                properties: {},
                children: [{ type: "text", value: alt }],
              },
            ] as ElementContent[])
          : []),
      ],
    };
    parent.children[index] = figure;
  });
}

function inlineNoteAssets(runDirectory: string) {
  const transform = async (tree: HastRoot) => {
    swapMermaidBlocks(tree);
    await inlineFigures(tree, runDirectory);
    wrapStandaloneFigures(tree);
  };
  return () => transform;
}

export async function noteMarkdownToHtml(
  note: NoteMarkdown,
  options: { runDirectory: string },
): Promise<string> {
  const processor = unified()
    .use(remarkRehype)
    .use(inlineNoteAssets(options.runDirectory))
    .use(rehypeKatex)
    .use(rehypeStringify);
  const hast = await processor.run(note.tree);
  return processor.stringify(hast);
}

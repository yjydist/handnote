import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElementContent, Root as HastRoot } from "hast";
import katex from "katex";
import type { Root } from "mdast";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parseMarkdownTree } from "./markdown-parse.ts";
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

const mermaidLinkPatterns: RegExp[] = [
  /\[[^\]]*\]\([^)]*\)/,
  /<a\b/i,
  /href\s*=/i,
  /https?:\/\//i,
];

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--)
    slashes++;
  return slashes % 2 === 1;
}

function closingBracket(value: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < value.length; index++) {
    if (isEscaped(value, index)) continue;
    if (value[index] === "[") depth++;
    if (value[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function hasReferenceImageSyntax(markdown: string, tree: Root): boolean {
  let found = false;
  visit(tree, (node) => {
    if (found || node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "imageReference") {
      found = true;
      return;
    }
    if (node.type !== "text") return;
    const position = node.position;
    if (
      position?.start.offset === undefined ||
      position.end.offset === undefined
    )
      return;
    const source = markdown.slice(position.start.offset, position.end.offset);
    for (let index = 0; index < source.length - 1; index++) {
      if (
        source[index] !== "!" ||
        source[index + 1] !== "[" ||
        isEscaped(source, index)
      )
        continue;
      const end = closingBracket(source, index + 1);
      if (end >= 0 && source[end + 1] !== "(") {
        found = true;
        return;
      }
    }
  });
  return found;
}

function mermaidHasClickDirective(value: string): boolean {
  return value.split(/\r?\n/).some((line) => {
    const match = /^\s*click\s+(\S+)\s+(.+)$/i.exec(line);
    if (!match) return false;
    const target = match[1] ?? "";
    const action = (match[2] ?? "").trimStart();
    if (/^(?:-->|---|-.->|==>)/.test(target)) return false;
    return /^(?:["']|href\b|call\b|[A-Za-z_$][\w.$]*(?:\s|\())/i.test(action);
  });
}

function quotedKey(
  value: string,
  start: number,
): { key: string; end: number } | undefined {
  const quote = value[start];
  if (quote !== '"' && quote !== "'") return undefined;
  let key = "";
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      key += value[index + 1];
      index++;
      continue;
    }
    if (character === quote) return { key, end: index + 1 };
    key += character;
  }
  return undefined;
}

function mermaidHasImageAttribute(value: string): boolean {
  for (let blockStart = value.indexOf("@{"); blockStart >= 0; ) {
    let depth = 1;
    let quote: string | undefined;
    let blockEnd = value.length;
    for (let index = blockStart + 2; index < value.length; index++) {
      const character = value[index];
      if (quote) {
        if (character === "\\") index++;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") depth++;
      if (character === "}" && --depth === 0) {
        blockEnd = index;
        break;
      }
    }
    const body = value.slice(blockStart + 2, blockEnd);
    for (let index = 0; index < body.length; ) {
      while (/[,\s]/.test(body[index] ?? "")) index++;
      const quoted = quotedKey(body, index);
      let key = "";
      if (quoted) {
        key = quoted.key;
        index = quoted.end;
      } else {
        const match = /^[A-Za-z_][\w-]*/.exec(body.slice(index));
        if (!match) {
          index++;
          continue;
        }
        key = match[0];
        index += key.length;
      }
      while (/\s/.test(body[index] ?? "")) index++;
      if (
        key.toLowerCase() === "img" &&
        (body[index] === ":" || body[index] === undefined)
      )
        return true;
      let nestedDepth = 0;
      let valueQuote: string | undefined;
      while (index < body.length) {
        const character = body[index];
        if (valueQuote) {
          if (character === "\\") index++;
          else if (character === valueQuote) valueQuote = undefined;
        } else if (character === '"' || character === "'")
          valueQuote = character;
        else if (character === "{") nestedDepth++;
        else if (character === "}") nestedDepth--;
        else if (character === "," && nestedDepth === 0) break;
        index++;
      }
    }
    blockStart = value.indexOf("@{", blockEnd + 1);
  }
  return false;
}

const mermaidHasLink = (value: string): boolean =>
  mermaidHasClickDirective(value) ||
  mermaidHasImageAttribute(value) ||
  mermaidLinkPatterns.some((pattern) => pattern.test(value));

function validateIssues(tree: Root): MarkdownIssue[] {
  const issues: MarkdownIssue[] = [];
  const seen = new Set<string>();
  const imageDefinitions = new Set<string>();
  visit(tree, (node) => {
    if (node.type === "imageReference") imageDefinitions.add(node.identifier);
  });
  const addUnique = (code: string, message: string, node: LocatedNode) => {
    const line = startLine(node);
    const key = `${code}:${line ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ code, message, ...(line ? { line } : {}) });
  };
  visit(tree, (node) => {
    if (node.type === "html")
      addUnique(
        "raw_html",
        "Raw HTML is not allowed; express the content in GFM syntax",
        node,
      );
    if (node.type === "definition" && !imageDefinitions.has(node.identifier))
      addUnique(
        "link_not_allowed",
        "Link definitions are not allowed; write URLs as inline code instead",
        node,
      );
    if (node.type === "link")
      addUnique(
        "link_not_allowed",
        "Links are not allowed; write URLs as inline code instead",
        node,
      );
    if (node.type === "footnoteReference" || node.type === "footnoteDefinition")
      addUnique(
        "link_not_allowed",
        "Footnotes are not allowed because they render as links",
        node,
      );
    if (node.type === "code") {
      const code = node as { lang?: string | null; value?: string };
      if (code.lang?.toLowerCase() === "mermaid" && code.lang !== "mermaid")
        addUnique(
          "invalid_mermaid_fence",
          "Mermaid fences must use the exact lowercase language name `mermaid`",
          node,
        );
      if (code.lang === "mermaid" && mermaidHasLink(code.value ?? ""))
        addUnique(
          "link_not_allowed",
          "Links are not allowed in Mermaid diagrams (click directives, markdown links, HTML anchors, asset directives, or URLs); write URLs as inline code instead",
          node,
        );
    }
    if (node.type === "image") {
      const url = (node as { url?: string }).url ?? "";
      if (!figurePathPattern.test(url))
        addUnique(
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
      anchors.set(node, currentBlockId);
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
  const tree = parseMarkdownTree(markdown);
  if (hasReferenceImageSyntax(markdown, tree))
    issues.push({
      code: "invalid_image_syntax",
      message:
        "Reference-style images are not allowed; use inline local image syntax",
    });
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

function wrapDisplayMathBlocks(tree: HastRoot): void {
  visit(tree, (node, index, parent) => {
    if (
      !parent ||
      typeof index !== "number" ||
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
      !((code.properties.className ?? []) as unknown[]).includes("math-display")
    )
      return;
    const id = dataHnId(node.properties) ?? dataHnId(code.properties);
    const properties = { ...node.properties };
    delete properties.dataHnId;
    parent.children[index] = {
      type: "element",
      tagName: "div",
      properties: { ...(id ? { dataHnId: id } : {}) },
      children: [{ ...node, properties }],
    };
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
    wrapDisplayMathBlocks(tree);
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

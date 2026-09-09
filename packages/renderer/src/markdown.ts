import type { Element, ElementContent, Root } from "hast";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { parseSrcset, stringifySrcset } from "srcset";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { z } from "zod";
import type { LayoutWarning, NoteStructure } from "./render-metadata.ts";

export type { NoteStructure } from "./render-metadata.ts";

export const maxMarkdownLength = 200_000;

export interface MarkdownIssue {
  code: string;
  message: string;
  line?: number;
}

export class MarkdownValidationError extends Error {
  constructor(public issues: MarkdownIssue[]) {
    super(
      `Markdown failed validation: ${issues
        .map(
          (issue) =>
            `${issue.code}${issue.line ? ` (line ${issue.line})` : ""}: ${issue.message}`,
        )
        .join("; ")}`,
    );
    this.name = "MarkdownValidationError";
  }
}

export interface CompiledNote {
  markdown: string;
  html: string;
  hasTitle: boolean;
  structure: NoteStructure;
  warnings: LayoutWarning[];
}

const blockTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "table",
  "hr",
]);
const textContent = (node: ElementContent): string =>
  node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(textContent).join("")
      : "";
const hasClass = (node: Element, name: string): boolean =>
  Array.isArray(node.properties.className) &&
  node.properties.className.includes(name);
const isMath = (node: Element): boolean =>
  ["language-math", "math-inline", "math-display"].some((name) =>
    hasClass(node, name),
  );

const inkImageMetadataSchema = z
  .object({
    id: z.string().trim().min(1),
    width: z.number().positive(),
    height: z.number().positive(),
    referenceHeight: z.number().positive(),
    kind: z.enum(["text", "diagram"]),
  })
  .strict();

export type InkImageMetadata = z.infer<typeof inkImageMetadataSchema>;

export type ImageResource =
  | { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }
  | {
      bytes: Uint8Array;
      mimeType: "image/svg+xml";
      /** Trusted resolver output; arbitrary SVG from Markdown is never accepted. */
      ink: InkImageMetadata;
    };

export type ImageResolver = (src: string) => Promise<ImageResource>;

export class ImageResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImageResourceError";
  }
}

async function figureDataUri(
  src: unknown,
  node: Element,
  resolveImage?: ImageResolver,
): Promise<string> {
  try {
    if (typeof src !== "string" || !resolveImage)
      throw new ImageResourceError(
        "invalid_image_path",
        "An image resource resolver is required",
      );
    const resource = await resolveImage(src);
    if (resource.mimeType === "image/svg+xml") {
      const metadata = inkImageMetadataSchema.safeParse(resource.ink);
      if (!metadata.success || !resource.bytes.length)
        throw new ImageResourceError(
          "invalid_ink_image",
          "SVG images require valid ink metadata and nonempty bytes",
        );
      const { id, kind, width, height, referenceHeight } = metadata.data;
      if (
        !Number.isFinite(width / referenceHeight) ||
        !Number.isFinite(height / referenceHeight)
      )
        throw new ImageResourceError(
          "invalid_ink_image",
          "Ink scale must be finite",
        );
      node.properties.dataHnInk = id;
      node.properties.dataHnInkKind = kind;
      node.properties.dataHnReferenceHeight = referenceHeight;
      node.properties.width = width;
      node.properties.height = height;
      node.properties.style = `display:${kind === "text" ? "inline-block" : "block"};width:${width / referenceHeight}em;height:${height / referenceHeight}em;vertical-align:baseline;max-width:none;flex-shrink:0`;
    }
    return `data:${resource.mimeType};base64,${Buffer.from(resource.bytes).toString("base64")}`;
  } catch (error) {
    if (!(error instanceof ImageResourceError)) throw error;
    throw new MarkdownValidationError([
      {
        code: error.code,
        message: error.message,
        ...(node.position ? { line: node.position.start.line } : {}),
      },
    ]);
  }
}

function prepareHtml(tree: Root, structure: NoteStructure): void {
  const ids = new Set<string>();
  let inkImages = 0;
  visit(tree, "element", (node) => {
    for (const key of ["id", "name"]) {
      const id = node.properties[key];
      if (typeof id === "string") ids.add(id);
    }
  });
  visit(tree, "element", (node) => {
    const href = node.properties.href;
    if (typeof href === "string" && href.startsWith("#")) {
      let fragment = href.slice(1);
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        /* Preserve malformed fragment links. */
      }
      const target = `${defaultSchema.clobberPrefix}${fragment}`;
      if (ids.has(target))
        node.properties.href = `#${encodeURIComponent(target)}`;
    }
    if (blockTags.has(node.tagName))
      node.properties.dataHnId = `block-${++structure.blocks}`;
    if (/^h[1-6]$/.test(node.tagName)) structure.headings++;
    if (node.tagName === "table") structure.tables++;
    if (node.tagName === "img") structure.figures++;
    if (node.properties.dataHnInk !== undefined)
      node.properties.dataHnId = `ink-${++inkImages}`;
    if (isMath(node)) structure.equations++;
  });
  visit(tree, "element", (node) => {
    const only = node.children[0];
    if (node.children.length !== 1 || only?.type !== "element") return;
    if (node.tagName === "pre" && only.tagName === "code") {
      if (hasClass(only, "language-mermaid")) {
        structure.diagrams++;
        node.properties.className = ["mermaid"];
        node.children = [{ type: "text", value: textContent(only) }];
      } else if (isMath(only)) {
        // KaTeX replaces the pre; retain its layout anchor on a wrapper.
        node.tagName = "div";
        node.children = [
          { type: "element", tagName: "pre", properties: {}, children: [only] },
        ];
        return SKIP;
      }
    } else if (node.tagName === "p" && only.tagName === "img") {
      if (only.properties.dataHnInkKind === "text") return;
      node.tagName = "figure";
      if (only.properties.dataHnInkKind === "diagram") {
        node.properties.className = ["hn-ink-diagram"];
        return;
      }
      const alt =
        typeof only.properties.alt === "string"
          ? only.properties.alt.trim()
          : "";
      if (alt)
        node.children.push({
          type: "element",
          tagName: "figcaption",
          properties: {},
          children: [{ type: "text", value: alt }],
        });
    }
  });
}

export async function compileNoteMarkdown(
  markdown: string,
  options: { resolveImage?: ImageResolver } = {},
): Promise<CompiledNote> {
  if (!markdown.trim())
    throw new MarkdownValidationError([
      { code: "empty_document", message: "Markdown must not be blank" },
    ]);
  if (markdown.length > maxMarkdownLength)
    throw new MarkdownValidationError([
      {
        code: "markdown_too_large",
        message: `Markdown exceeds ${maxMarkdownLength} characters: ${markdown.length}`,
      },
    ]);
  const structure: NoteStructure = {
    headings: 0,
    blocks: 0,
    tables: 0,
    equations: 0,
    diagrams: 0,
    figures: 0,
  };
  let hasTitle = false;
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        code: [["className", /^language-./, "math-inline", "math-display"]],
      },
    })
    .use(() => async (tree: Root) => {
      const figures: Element[] = [];
      visit(tree, "element", (node) => {
        if (node.tagName === "img" || node.tagName === "source")
          figures.push(node);
        if (node.tagName === "h1") hasTitle = true;
      });
      await Promise.all(
        figures.map(async (node) => {
          if (node.tagName === "img")
            node.properties.src = await figureDataUri(
              node.properties.src,
              node,
              options.resolveImage,
            );
          if (typeof node.properties.srcSet === "string")
            node.properties.srcSet = stringifySrcset(
              await Promise.all(
                parseSrcset(node.properties.srcSet).map(async (candidate) => ({
                  ...candidate,
                  url: await figureDataUri(
                    candidate.url,
                    node,
                    options.resolveImage,
                  ),
                })),
              ),
            );
        }),
      );
      prepareHtml(tree, structure);
    })
    .use(rehypeKatex)
    .use(rehypeStringify)
    .process(markdown);
  const warnings: LayoutWarning[] = file.messages.map((message) => {
    const anchor = message.ancestors
      ?.slice()
      .reverse()
      .find(
        (node) =>
          node.type === "element" &&
          typeof (node as Element).properties.dataHnId === "string",
      ) as Element | undefined;
    return {
      code: "equation_fallback",
      message: `${message.reason}${message.line ? ` (line ${message.line})` : ""}`,
      blocking: false,
      ...(anchor ? { elementId: String(anchor.properties.dataHnId) } : {}),
    };
  });
  const note: CompiledNote = {
    markdown,
    html: String(file),
    hasTitle,
    structure,
    warnings,
  };
  return note;
}

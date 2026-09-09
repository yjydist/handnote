import { createHash } from "node:crypto";
import type { Element, Root, RootContent, Text } from "hast";
import {
  type CompiledNote,
  cloneCompiledTree,
  compileNoteMarkdown,
  type ImageResolver,
} from "./markdown.ts";

export interface TextRange {
  readonly rangeId: string;
  readonly blockId: string;
  readonly flowId: string;
  readonly kind: "heading" | "paragraph" | "list-item";
  readonly text: string;
}

export interface PreparedDocument {
  readonly documentHash: string;
  readonly textRanges: readonly TextRange[];
}

export interface DocumentTarget {
  readonly documentHash: string;
  readonly rangeId: string;
  /** UTF-16 offsets in TextRange.text; end is exclusive. */
  readonly start: number;
  readonly end: number;
}

export class TargetValidationError extends Error {
  constructor(
    readonly code:
      | "unknown_document"
      | "stale_document"
      | "unknown_range"
      | "invalid_offset"
      | "overlapping_targets",
    message: string,
  ) {
    super(message);
    this.name = "TargetValidationError";
  }
}

interface StoredRange {
  path: number[];
  blockPath: number[];
  offsets: number[];
}

interface PreparedState {
  note: CompiledNote;
  tree: Root;
  ranges: Map<string, StoredRange>;
}

const preparedStates = new WeakMap<PreparedDocument, PreparedState>();

function stateOf(document: PreparedDocument): PreparedState {
  const state = preparedStates.get(document);
  if (!state)
    throw new TargetValidationError(
      "unknown_document",
      "Use a document returned by prepareDocument",
    );
  return state;
}

interface Candidate {
  path: number[];
  blockPath: number[];
  blockId: string;
  flowId: string;
  kind: TextRange["kind"];
  pieces: Array<{ value: string; start: number; end: number }>;
}

interface Flow {
  id: string;
  hasContent: boolean;
  pending?: { candidate: Candidate; start: number; end: number };
}

const excludedTags = new Set([
  "hr",
  "pre",
  "code",
  "table",
  "math",
  "svg",
  "img",
  "picture",
  "source",
  "figure",
  "figcaption",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
  "input",
]);

function hasClass(element: Element, name: string): boolean {
  return (
    Array.isArray(element.properties.className) &&
    element.properties.className.includes(name)
  );
}

function flushSpace(flow: Flow): void {
  if (flow.hasContent && flow.pending) {
    const { candidate, start, end } = flow.pending;
    candidate.pieces.push({ value: " ", start, end });
  }
  delete flow.pending;
}

function collectRanges(tree: Root): {
  textRanges: readonly TextRange[];
  ranges: Map<string, StoredRange>;
} {
  const candidates: Candidate[] = [];
  let generatedBlocks = 0;
  let generatedFlows = 0;
  const nextFlowId = () => `flow-${++generatedFlows}`;

  const walk = (
    node: Root | RootContent,
    path: number[],
    block: { path: number[]; id: string; kind: TextRange["kind"] },
    flow: Flow,
    inList: boolean,
  ): void => {
    if (node.type === "text") {
      const candidate: Candidate = {
        path,
        blockPath: block.path,
        blockId: block.id,
        flowId: flow.id,
        kind: block.kind,
        pieces: [],
      };
      candidates.push(candidate);
      for (let start = 0; start < node.value.length; ) {
        if (/[\t\n\f\r ]/.test(node.value[start] ?? "")) {
          let end = start + 1;
          while (/[\t\n\f\r ]/.test(node.value[end] ?? "")) end++;
          if (!flow.pending) flow.pending = { candidate, start, end };
          start = end;
        } else {
          flushSpace(flow);
          candidate.pieces.push({
            value: node.value[start] ?? "",
            start,
            end: start + 1,
          });
          flow.hasContent = true;
          start++;
        }
      }
      return;
    }
    if (node.type !== "root" && node.type !== "element") return;
    const parentFlow = flow;
    let startsBlock = false;
    if (node.type === "element") {
      if (hasClass(node, "sr-only") || node.properties.hidden === true) return;
      if (
        excludedTags.has(node.tagName) ||
        ["katex", "katex-error", "math-inline", "math-display"].some((name) =>
          hasClass(node, name),
        ) ||
        node.properties.dataFootnoteRef !== undefined ||
        node.properties.dataFootnoteBackref !== undefined
      ) {
        if (
          ["pre", "table", "figure", "figcaption", "hr"].includes(node.tagName)
        ) {
          delete flow.pending;
          flow.hasContent = false;
        } else {
          flushSpace(flow);
          flow.hasContent = true;
        }
        flow.id = nextFlowId();
        return;
      }
      if (node.tagName === "br") {
        flow.id = nextFlowId();
        delete flow.pending;
        flow.hasContent = false;
        return;
      }
      inList ||= node.tagName === "li";
      if (
        /^h[1-6]$/.test(node.tagName) ||
        [
          "p",
          "li",
          "div",
          "section",
          "blockquote",
          "ul",
          "ol",
          "dl",
          "dt",
          "dd",
          "details",
          "summary",
          "address",
          "article",
          "aside",
          "footer",
          "header",
          "main",
          "nav",
        ].includes(node.tagName)
      ) {
        delete flow.pending;
        flow.hasContent = false;
        block = {
          path,
          id:
            typeof node.properties.dataHnId === "string"
              ? node.properties.dataHnId
              : `text-block-${++generatedBlocks}`,
          kind: /^h[1-6]$/.test(node.tagName)
            ? "heading"
            : inList
              ? "list-item"
              : "paragraph",
        };
        startsBlock = true;
        flow = { id: nextFlowId(), hasContent: false };
      }
    }
    node.children.forEach((child, index) => {
      if (
        node.type === "element" &&
        node.tagName === "details" &&
        node.properties.open !== true &&
        !(child.type === "element" && child.tagName === "summary")
      )
        return;
      walk(child, [...path, index], block, flow, inList);
    });
    if (startsBlock) parentFlow.id = nextFlowId();
  };

  walk(
    tree,
    [],
    { path: [], id: "document", kind: "paragraph" },
    { id: nextFlowId(), hasContent: false },
    false,
  );
  const textRanges: TextRange[] = [];
  const ranges = new Map<string, StoredRange>();
  for (const candidate of candidates) {
    const text = candidate.pieces.map((piece) => piece.value).join("");
    if (!text) continue;
    const rangeId = `text-${textRanges.length + 1}`;
    const first = candidate.pieces[0];
    if (!first) continue;
    textRanges.push(
      Object.freeze({
        rangeId,
        blockId: candidate.blockId,
        flowId: candidate.flowId,
        kind: candidate.kind,
        text,
      }),
    );
    ranges.set(rangeId, {
      path: candidate.path,
      blockPath: candidate.blockPath,
      offsets: [first.start, ...candidate.pieces.map((piece) => piece.end)],
    });
  }
  return { textRanges: Object.freeze(textRanges), ranges };
}

export async function prepareDocument(
  markdown: string,
  options: { resolveImage?: ImageResolver } = {},
): Promise<PreparedDocument> {
  const note = await compileNoteMarkdown(markdown, options);
  const tree = cloneCompiledTree(note);
  const { textRanges, ranges } = collectRanges(tree);
  const document = Object.freeze({
    documentHash: createHash("sha256").update(markdown).digest("hex"),
    textRanges,
  });
  preparedStates.set(document, { note, tree, ranges });
  return document;
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

export function validateTargets(
  document: PreparedDocument,
  targets: readonly DocumentTarget[],
): void {
  stateOf(document);
  const ranges = new Map(
    document.textRanges.map((range) => [range.rangeId, range]),
  );
  const used = new Map<string, DocumentTarget[]>();
  for (const target of targets) {
    if (target.documentHash !== document.documentHash)
      throw new TargetValidationError(
        "stale_document",
        "Target belongs to a different Markdown document",
      );
    const range = ranges.get(target.rangeId);
    if (!range)
      throw new TargetValidationError(
        "unknown_range",
        `Unknown text range: ${target.rangeId}`,
      );
    if (
      !Number.isInteger(target.start) ||
      !Number.isInteger(target.end) ||
      target.start < 0 ||
      target.end > range.text.length ||
      target.start >= target.end ||
      !range.text.slice(target.start, target.end).trim() ||
      splitsSurrogate(range.text, target.start) ||
      splitsSurrogate(range.text, target.end)
    )
      throw new TargetValidationError(
        "invalid_offset",
        `Target offsets must select nonempty whole characters in ${target.rangeId}`,
      );
    const previous = used.get(target.rangeId) ?? [];
    if (
      previous.some(
        (other) => target.start < other.end && other.start < target.end,
      )
    )
      throw new TargetValidationError(
        "overlapping_targets",
        `Targets overlap in ${target.rangeId}`,
      );
    previous.push(target);
    used.set(target.rangeId, previous);
  }
}

export interface PreparedRangeNode {
  node: Text;
  parent: Element | Root;
  block: Element | Root;
  offsets: readonly number[];
}

function atPath(tree: Root, path: readonly number[]): Root | RootContent {
  let node: Root | RootContent = tree;
  for (const index of path) {
    if (node.type !== "root" && node.type !== "element")
      throw new Error("Prepared document path is not a container");
    const child: RootContent | undefined = node.children[index];
    if (!child) throw new Error("Prepared document path is missing");
    node = child;
  }
  return node;
}

export function clonePreparedDocument(document: PreparedDocument): {
  note: CompiledNote;
  tree: Root;
  ranges: ReadonlyMap<string, PreparedRangeNode>;
} {
  const state = stateOf(document);
  const tree = structuredClone(state.tree);
  const ranges = new Map<string, PreparedRangeNode>();
  for (const [id, entry] of state.ranges) {
    const node = atPath(tree, entry.path);
    const parent = atPath(tree, entry.path.slice(0, -1));
    const block = atPath(tree, entry.blockPath);
    if (
      node.type !== "text" ||
      (parent.type !== "element" && parent.type !== "root") ||
      (block.type !== "element" && block.type !== "root")
    )
      throw new Error("Prepared text range no longer identifies a text node");
    ranges.set(id, { node, parent, block, offsets: [...entry.offsets] });
  }
  return { note: structuredClone(state.note), tree, ranges };
}

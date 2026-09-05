import type { PhrasingContent, Root, RootContent } from "mdast";

export interface AuditTextEvidence {
  mermaidTextBlocks: readonly (readonly string[])[];
  mathTextBlocks: readonly string[];
  imageCaptionBlocks: readonly string[];
}

export interface RenderedSemanticEvidence extends AuditTextEvidence {
  forbiddenMermaidContent: boolean;
  mermaidVisibleBlocks: readonly boolean[];
}

export interface MarkdownSemantics {
  blocks: string[];
  hasStaticContent: boolean;
  mermaidCount: number;
  mathCount: number;
  imageCount: number;
}

interface SemanticState {
  blocks: string[];
  evidence?: AuditTextEvidence;
  hasStaticContent: boolean;
  mermaidCount: number;
  mathCount: number;
  imageCount: number;
}

export const foldWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

function phrasingText(nodes: PhrasingContent[], state: SemanticState): string {
  return nodes
    .map((node) => {
      if (node.type === "text" || node.type === "inlineCode") {
        if (node.value.trim()) state.hasStaticContent = true;
        return node.value;
      }
      if (node.type === "inlineMath") {
        const value = state.evidence?.mathTextBlocks[state.mathCount] ?? "";
        state.mathCount++;
        return value;
      }
      if (node.type === "image" || node.type === "imageReference") {
        state.hasStaticContent = true;
        const caption =
          state.evidence?.imageCaptionBlocks[state.imageCount] ?? "";
        state.imageCount++;
        return caption;
      }
      if (node.type === "break") return " ";
      if ("children" in node) return phrasingText(node.children, state);
      return "";
    })
    .join("");
}

export function analyzeMarkdownSemantics(
  tree: Root,
  evidence?: AuditTextEvidence,
): MarkdownSemantics {
  const state: SemanticState = {
    blocks: [],
    ...(evidence ? { evidence } : {}),
    hasStaticContent: false,
    mermaidCount: 0,
    mathCount: 0,
    imageCount: 0,
  };
  const collect = (node: Root | RootContent): void => {
    if (
      node.type === "heading" ||
      node.type === "paragraph" ||
      node.type === "tableCell"
    ) {
      state.blocks.push(phrasingText(node.children, state));
      return;
    }
    if (node.type === "code") {
      if (node.lang === "mermaid") {
        state.blocks.push(
          ...(state.evidence?.mermaidTextBlocks[state.mermaidCount] ?? []),
        );
        state.mermaidCount++;
        return;
      }
      state.blocks.push(node.value);
      if (node.value.trim()) state.hasStaticContent = true;
      return;
    }
    if (node.type === "math") {
      state.blocks.push(state.evidence?.mathTextBlocks[state.mathCount] ?? "");
      state.mathCount++;
      return;
    }
    if (node.type === "listItem" && node.checked !== null)
      state.hasStaticContent = true;
    if ("children" in node)
      for (const child of node.children) collect(child as RootContent);
  };
  collect(tree);
  return {
    blocks: state.blocks.map(foldWhitespace).filter(Boolean),
    hasStaticContent: state.hasStaticContent,
    mermaidCount: state.mermaidCount,
    mathCount: state.mathCount,
    imageCount: state.imageCount,
  };
}

export function hasPotentialSemanticContent(tree: Root): boolean {
  const semantics = analyzeMarkdownSemantics(tree);
  return (
    semantics.hasStaticContent ||
    semantics.mermaidCount > 0 ||
    semantics.mathCount > 0
  );
}

export function hasRenderedSemanticContent(
  tree: Root,
  evidence: RenderedSemanticEvidence,
): boolean {
  const semantics = analyzeMarkdownSemantics(tree, evidence);
  return (
    semantics.hasStaticContent ||
    evidence.mathTextBlocks.some((value) => foldWhitespace(value).length > 0) ||
    evidence.mermaidVisibleBlocks.some(Boolean)
  );
}

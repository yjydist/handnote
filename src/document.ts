import type { PhrasingContent, Root, RootContent, TableCell } from "mdast";
import { z } from "zod";
import { parseMarkdownTree } from "./markdown-parse.ts";

export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1 && r.y + r.height <= 1,
    "Region exceeds normalized image bounds",
  );

export type Region = z.infer<typeof regionSchema>;

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const auditTargetSchema = z
  .object({
    quote: z.string().min(1).max(500),
    occurrence: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type AuditTarget = z.infer<typeof auditTargetSchema>;

export const correctionAuditSchema = z
  .object({
    id: idSchema,
    target: auditTargetSchema,
    original: z.string().min(1),
    corrected: z.string().min(1),
    basis: z.string().min(1),
    region: regionSchema,
    confidence: z.number().min(0.95).max(1),
  })
  .strict();
export const uncertaintyAuditSchema = z
  .object({
    id: idSchema,
    target: auditTargetSchema,
    bestGuess: z.string().min(1),
    candidates: z.array(z.string().min(1)).min(2),
    basis: z.string().min(1),
    region: regionSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const revisionAuditSchema = z
  .object({
    corrections: z.array(correctionAuditSchema).default([]),
    uncertainties: z.array(uncertaintyAuditSchema).default([]),
  })
  .strict()
  .superRefine((audit, ctx) => {
    const ids = new Set<string>();
    for (const item of [...audit.corrections, ...audit.uncertainties]) {
      if (ids.has(item.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate audit ID: ${item.id}`,
        });
      ids.add(item.id);
    }
  });

export type RevisionAudit = z.infer<typeof revisionAuditSchema>;

const foldWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

function phrasingText(nodes: PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (
        node.type === "text" ||
        node.type === "inlineCode" ||
        node.type === "inlineMath"
      )
        return node.value;
      if (node.type === "image" || node.type === "imageReference")
        return node.alt ?? "";
      if (node.type === "break") return " ";
      if ("children" in node) return phrasingText(node.children);
      return "";
    })
    .join("");
}

function visibleBlocks(tree: Root): string[] {
  const blocks: string[] = [];
  const collect = (node: RootContent | TableCell): void => {
    if (
      node.type === "heading" ||
      node.type === "paragraph" ||
      node.type === "tableCell"
    ) {
      blocks.push(phrasingText(node.children));
      return;
    }
    if (node.type === "code" || node.type === "math") {
      blocks.push(node.value);
      return;
    }
    if ("children" in node)
      for (const child of node.children)
        collect(child as RootContent | TableCell);
  };
  for (const child of tree.children) collect(child);
  return blocks.map(foldWhitespace).filter(Boolean);
}

const asciiWord = (value: string | undefined): boolean =>
  value !== undefined && /^[A-Za-z0-9_]$/.test(value);

function quoteOccurrences(folded: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = folded.indexOf(needle);
  while (index >= 0) {
    const before = index > 0 ? folded[index - 1] : undefined;
    const after = folded[index + needle.length];
    if (
      !(asciiWord(needle[0]) && asciiWord(before)) &&
      !(asciiWord(needle.at(-1)) && asciiWord(after))
    )
      count++;
    index = folded.indexOf(needle, index + 1);
  }
  return count;
}

export const revisionDraftSchema = z
  .object({
    markdown: z.string().min(1),
    audit: revisionAuditSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    const items = [...draft.audit.corrections, ...draft.audit.uncertainties];
    if (items.length === 0) return;

    const folded = visibleBlocks(parseMarkdownTree(draft.markdown)).join("\0");
    const occurrenceCounts = new Map<string, number>();
    for (const item of items) {
      const required = item.target.occurrence ?? 1;
      const needle = foldWhitespace(item.target.quote);
      let occurrences = occurrenceCounts.get(needle);
      if (occurrences === undefined) {
        occurrences = quoteOccurrences(folded, needle);
        occurrenceCounts.set(needle, occurrences);
      }
      if (occurrences < required)
        ctx.addIssue({
          code: "custom",
          message: `Audit ${item.id} quote not found (occurrence ${required})`,
          path: ["audit"],
        });
    }
  });

export type RevisionDraft = z.infer<typeof revisionDraftSchema>;

export function emptyRevisionAudit(): RevisionAudit {
  return { corrections: [], uncertainties: [] };
}

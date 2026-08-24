import { z } from "zod";
import {
  type Block,
  blockSchema,
  correctionAuditSchema,
  type NoteDocument,
  type RevisionDraft,
  revisionDraftSchema,
  type Section,
  uncertaintyAuditSchema,
} from "./document.ts";

const positionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }).strict(),
  z.object({ kind: z.literal("end") }).strict(),
  z.object({ kind: z.literal("before"), blockId: z.string() }).strict(),
  z.object({ kind: z.literal("after"), blockId: z.string() }).strict(),
]);

export const patchOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_document_title"),
      title: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_section_title"),
      sectionId: z.string(),
      title: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert_block"),
      sectionId: z.string(),
      position: positionSchema,
      block: blockSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("replace_block"),
      blockId: z.string(),
      block: blockSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("move_block"),
      blockId: z.string(),
      sectionId: z.string(),
      position: positionSchema,
    })
    .strict(),
  z.object({ op: z.literal("delete_block"), blockId: z.string() }).strict(),
  z
    .object({
      op: z.literal("upsert_correction"),
      value: correctionAuditSchema,
    })
    .strict(),
  z.object({ op: z.literal("remove_correction"), id: z.string() }).strict(),
  z
    .object({
      op: z.literal("upsert_uncertainty"),
      value: uncertaintyAuditSchema,
    })
    .strict(),
  z.object({ op: z.literal("remove_uncertainty"), id: z.string() }).strict(),
]);
export const patchBatchSchema = z.array(patchOperationSchema).min(1).max(100);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

function sections(document: NoteDocument): Section[] {
  const all: Section[] = [];
  const visit = (items: Section[]) => {
    for (const section of items) {
      all.push(section);
      visit(section.sections ?? []);
    }
  };
  visit(document.sections);
  return all;
}

function findSection(document: NoteDocument, id: string): Section {
  const section = sections(document).find((item) => item.id === id);
  if (!section) throw new Error(`Unknown section: ${id}`);
  return section;
}

function findBlock(
  document: NoteDocument,
  id: string,
): { section: Section; index: number; block: Block } {
  for (const section of sections(document)) {
    const index = section.blocks.findIndex((block) => block.id === id);
    const block = section.blocks[index];
    if (index >= 0 && block) return { section, index, block };
  }
  throw new Error(`Unknown block: ${id}`);
}

function insertionIndex(
  section: Section,
  position: z.infer<typeof positionSchema>,
): number {
  if (position.kind === "start") return 0;
  if (position.kind === "end") return section.blocks.length;
  const index = section.blocks.findIndex(
    (block) => block.id === position.blockId,
  );
  if (index < 0)
    throw new Error(
      `Position block ${position.blockId} is not in section ${section.id}`,
    );
  return position.kind === "before" ? index : index + 1;
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) items[index] = value;
  else items.push(value);
}

export function applyPatch(
  draft: RevisionDraft,
  operations: PatchOperation[],
): RevisionDraft {
  const clone = structuredClone(draft);
  for (const operation of operations) {
    switch (operation.op) {
      case "set_document_title":
        if (operation.title === null) delete clone.document.title;
        else clone.document.title = operation.title;
        break;
      case "set_section_title": {
        const section = findSection(clone.document, operation.sectionId);
        if (operation.title === null) delete section.title;
        else section.title = operation.title;
        break;
      }
      case "insert_block": {
        const section = findSection(clone.document, operation.sectionId);
        section.blocks.splice(
          insertionIndex(section, operation.position),
          0,
          operation.block,
        );
        break;
      }
      case "replace_block": {
        const target = findBlock(clone.document, operation.blockId);
        target.section.blocks[target.index] = {
          ...operation.block,
          id: target.block.id,
        } as Block;
        break;
      }
      case "move_block": {
        const target = findBlock(clone.document, operation.blockId);
        target.section.blocks.splice(target.index, 1);
        const destination = findSection(clone.document, operation.sectionId);
        destination.blocks.splice(
          insertionIndex(destination, operation.position),
          0,
          target.block,
        );
        break;
      }
      case "delete_block": {
        const target = findBlock(clone.document, operation.blockId);
        target.section.blocks.splice(target.index, 1);
        break;
      }
      case "upsert_correction":
        upsert(clone.audit.corrections, operation.value);
        break;
      case "remove_correction": {
        const index = clone.audit.corrections.findIndex(
          (item) => item.id === operation.id,
        );
        if (index < 0) throw new Error(`Unknown correction: ${operation.id}`);
        clone.audit.corrections.splice(index, 1);
        break;
      }
      case "upsert_uncertainty":
        upsert(clone.audit.uncertainties, operation.value);
        break;
      case "remove_uncertainty": {
        const index = clone.audit.uncertainties.findIndex(
          (item) => item.id === operation.id,
        );
        if (index < 0) throw new Error(`Unknown uncertainty: ${operation.id}`);
        clone.audit.uncertainties.splice(index, 1);
        break;
      }
    }
  }
  return revisionDraftSchema.parse(clone);
}

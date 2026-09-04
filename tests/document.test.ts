import { describe, expect, test } from "bun:test";
import { noteDocumentSchema, revisionDraftSchema } from "../src/document.ts";
import { applyPatch, type PatchOperation } from "../src/patch.ts";
import { fullRegion, simpleDocument, simpleDraft } from "./helpers.ts";

describe("NoteDocument", () => {
  test("accepts all block types and recursive sections", () => {
    const document = simpleDocument();
    const section = document.sections[0];
    if (!section) throw new Error("fixture");
    section.blocks.push(
      {
        id: "bullets",
        type: "bullet_list",
        items: [{ text: "a", children: [{ text: "b" }] }],
      },
      { id: "steps", type: "numbered_steps", steps: ["one", "two"] },
      { id: "callout", type: "callout", tone: "tip", text: "tip" },
      { id: "table", type: "table", headers: ["a", "b"], rows: [["1", "2"]] },
      { id: "eq", type: "equation", latex: "x^2" },
      {
        id: "diagram",
        type: "diagram",
        mermaid: 'flowchart TD\n  n1["one"] --> n2["two"]',
      },
      { id: "figure", type: "source_figure", region: fullRegion },
    );
    section.sections = [{ id: "child", title: "child", blocks: [] }];
    expect(
      noteDocumentSchema.parse(document).sections[0]?.sections?.[0]?.id,
    ).toBe("child");
  });

  test("accepts omitted source titles and rejects legacy visible metadata", () => {
    const untitled = simpleDocument();
    delete untitled.title;
    delete untitled.sections[0]?.title;
    expect(noteDocumentSchema.parse(untitled)).toEqual(untitled);
    expect(
      noteDocumentSchema.safeParse({ ...untitled, summary: "模型摘要" })
        .success,
    ).toBe(false);
    expect(
      noteDocumentSchema.safeParse({
        ...untitled,
        corrections: [],
        uncertainties: [],
      }).success,
    ).toBe(false);
  });

  test("validates session-only audit targets and conservative corrections", () => {
    const draft = simpleDraft();
    draft.audit.uncertainties.push({
      id: "uncertainText",
      target: { kind: "block", blockId: "paragraph-1" },
      bestGuess: "这是正文。",
      candidates: ["这是正文。", "这是证文。"],
      basis: "字形接近，结合上下文选择前者",
      region: fullRegion,
      confidence: 0.7,
    });
    draft.audit.corrections.push({
      id: "fixedText",
      target: { kind: "section_title", sectionId: "section-1" },
      original: "第—节",
      corrected: "第一节",
      basis: "明确的字符笔误",
      region: fullRegion,
      confidence: 0.95,
    });
    expect(revisionDraftSchema.parse(draft)).toEqual(draft);

    const dangling = structuredClone(draft);
    const danglingUncertainty = dangling.audit.uncertainties[0];
    if (!danglingUncertainty) throw new Error("fixture");
    danglingUncertainty.target = {
      kind: "block",
      blockId: "missing",
    };
    expect(revisionDraftSchema.safeParse(dangling).success).toBe(false);

    const lowConfidence = structuredClone(draft);
    const lowConfidenceCorrection = lowConfidence.audit.corrections[0];
    if (!lowConfidenceCorrection) throw new Error("fixture");
    lowConfidenceCorrection.confidence = 0.949;
    expect(revisionDraftSchema.safeParse(lowConfidence).success).toBe(false);

    const alternativesOnly = structuredClone(draft);
    const alternativesOnlyUncertainty = alternativesOnly.audit.uncertainties[0];
    if (!alternativesOnlyUncertainty) throw new Error("fixture");
    alternativesOnlyUncertainty.candidates = ["甲", "乙"];
    expect(revisionDraftSchema.safeParse(alternativesOnly).success).toBe(true);
  });

  test("rejects duplicate IDs, bad table width, out-of-bounds regions, and empty mermaid", () => {
    const duplicate = simpleDocument();
    duplicate.sections.push({
      id: "section-1",
      title: "duplicate",
      blocks: [],
    });
    expect(noteDocumentSchema.safeParse(duplicate).success).toBe(false);

    const badTable = simpleDocument();
    badTable.sections[0]?.blocks.push({
      id: "table",
      type: "table",
      headers: ["a", "b"],
      rows: [["x"]],
    });
    expect(noteDocumentSchema.safeParse(badTable).success).toBe(false);

    const badRegion = simpleDocument();
    badRegion.sections[0]?.blocks.push({
      id: "figure",
      type: "source_figure",
      region: { x: 0.9, y: 0, width: 0.2, height: 1 },
    });
    expect(noteDocumentSchema.safeParse(badRegion).success).toBe(false);

    const emptyMermaid = simpleDocument();
    emptyMermaid.sections[0]?.blocks.push({
      id: "map",
      type: "diagram",
      mermaid: "",
    });
    expect(noteDocumentSchema.safeParse(emptyMermaid).success).toBe(false);
  });
});

describe("patch transactions", () => {
  test("applies ordered insert, move, replace, and delete", () => {
    const source = simpleDraft();
    source.document.sections.push({
      id: "section-2",
      title: "second",
      blocks: [],
    });
    const operations: PatchOperation[] = [
      {
        op: "insert_block",
        sectionId: "section-1",
        position: { kind: "end" },
        block: { id: "p2", type: "paragraph", text: "two" },
      },
      {
        op: "move_block",
        blockId: "p2",
        sectionId: "section-2",
        position: { kind: "start" },
      },
      {
        op: "replace_block",
        blockId: "p2",
        block: {
          id: "ignored",
          type: "callout",
          tone: "info",
          text: "changed",
        },
      },
      { op: "delete_block", blockId: "paragraph-1" },
    ];
    const result = applyPatch(source, operations);
    expect(result.document.sections[1]?.blocks[0]?.id).toBe("p2");
    expect(result.document.sections[1]?.blocks[0]?.type).toBe("callout");
    expect(source.document.sections[0]?.blocks).toHaveLength(1);
  });

  test("does not mutate source when a later operation fails", () => {
    const source = simpleDraft();
    expect(() =>
      applyPatch(source, [
        {
          op: "insert_block",
          sectionId: "section-1",
          position: { kind: "end" },
          block: { id: "new", type: "paragraph", text: "new" },
        },
        { op: "delete_block", blockId: "missing" },
      ]),
    ).toThrow("Unknown block");
    expect(
      source.document.sections[0]?.blocks.map((block) => block.id),
    ).toEqual(["paragraph-1"]);
  });

  test("updates optional titles and audit atomically", () => {
    const source = simpleDraft();
    source.audit.uncertainties.push({
      id: "uncertainText",
      target: { kind: "block", blockId: "paragraph-1" },
      bestGuess: "这是正文。",
      candidates: ["这是正文。", "这是证文。"],
      basis: "字形接近",
      region: fullRegion,
      confidence: 0.7,
    });

    expect(() =>
      applyPatch(source, [{ op: "delete_block", blockId: "paragraph-1" }]),
    ).toThrow("targets an unknown block");
    expect(source.document.sections[0]?.blocks).toHaveLength(1);

    const retitled = applyPatch(source, [
      { op: "set_document_title", title: "新标题" },
      {
        op: "set_section_title",
        sectionId: "section-1",
        title: "新小节",
      },
    ]);
    expect(retitled.document.title).toBe("新标题");
    expect(retitled.document.sections[0]?.title).toBe("新小节");

    const result = applyPatch(retitled, [
      { op: "set_document_title", title: null },
      { op: "set_section_title", sectionId: "section-1", title: null },
      { op: "delete_block", blockId: "paragraph-1" },
      { op: "remove_uncertainty", id: "uncertainText" },
    ]);
    expect(result.document.title).toBeUndefined();
    expect(result.document.sections[0]?.title).toBeUndefined();
    expect(result.document.sections[0]?.blocks).toEqual([]);
    expect(result.audit.uncertainties).toEqual([]);
  });
});

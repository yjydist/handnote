import type { NoteDocument, RevisionDraft } from "../src/document.ts";

export const fullRegion = { x: 0, y: 0, width: 1, height: 1 } as const;

export function simpleDocument(): NoteDocument {
  return {
    title: "测试笔记",
    sections: [
      {
        id: "section-1",
        title: "第一节",
        blocks: [
          {
            id: "paragraph-1",
            type: "paragraph",
            text: "这是正文。",
            sources: [fullRegion],
          },
        ],
      },
    ],
  };
}

export function simpleDraft(): RevisionDraft {
  return {
    document: simpleDocument(),
    audit: { corrections: [], uncertainties: [] },
  };
}

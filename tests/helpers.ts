import type { RevisionDraft } from "../src/document.ts";

export const fullRegion = { x: 0, y: 0, width: 1, height: 1 } as const;

export const simpleMarkdown = (): string => `# 测试笔记

## 第一节

这是正文。
`;

export function simpleDraft(): RevisionDraft {
  return {
    markdown: simpleMarkdown(),
    audit: { corrections: [], uncertainties: [] },
  };
}

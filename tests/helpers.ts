import { rm } from "node:fs/promises";
import sharp from "sharp";
import type { RevisionDraft } from "../src/document.ts";
import type { RedactionOptions } from "../src/redact.ts";
import { RunStore } from "../src/store.ts";

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

export async function createStoreFixture(
  directory: string,
  options: RedactionOptions = {},
): Promise<RunStore> {
  const store = await RunStore.create(directory, {
    inputExtension: ".png",
    ...options,
  });
  const source = `${directory}/fixture-source.png`;
  await sharp({
    create: { width: 20, height: 20, channels: 3, background: "white" },
  })
    .png()
    .toFile(source);
  await store.copyInput(source);
  await rm(source);
  return store;
}

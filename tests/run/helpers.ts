import { rm } from "node:fs/promises";
import sharp from "sharp";
import type { HandnoteToolHandlers } from "../../src/agent/index.ts";
import type { RevisionDraft } from "../../src/run/document.ts";
import type { RedactionOptions } from "../../src/run/redact.ts";
import { RunStore } from "../../src/run/store.ts";
import {
  createHandnoteHandlers,
  type ToolContext,
} from "../../src/tools/index.ts";

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

export class ModelSteps {
  modelStep = 0;
  beginModelStep(): number {
    return ++this.modelStep;
  }
}

export function createTestHandlers(
  context: ToolContext & { state: ModelSteps; maxSteps: number },
) {
  const handlers = createHandnoteHandlers(context);
  const execution = () => ({
    step: context.state.modelStep,
    remainingSteps: Math.max(0, context.maxSteps - context.state.modelStep),
  });
  return {
    inspect_source: (
      input: Parameters<HandnoteToolHandlers["inspect_source"]>[0],
      _context?: unknown,
    ) => handlers.inspect_source(input, execution()),
    capture_figure: (
      input: Parameters<HandnoteToolHandlers["capture_figure"]>[0],
      _context?: unknown,
    ) => handlers.capture_figure(input, execution()),
    read_note: (
      input: Parameters<HandnoteToolHandlers["read_note"]>[0],
      _context?: unknown,
    ) => handlers.read_note(input, execution()),
    write_note: (
      input: Parameters<HandnoteToolHandlers["write_note"]>[0],
      _context?: unknown,
    ) => handlers.write_note(input, execution()),
    revise_note: (
      input: Parameters<HandnoteToolHandlers["revise_note"]>[0],
      _context?: unknown,
    ) => handlers.revise_note(input, execution()),
    review_render: (
      input: Parameters<HandnoteToolHandlers["review_render"]>[0],
      _context?: unknown,
    ) => handlers.review_render(input, execution()),
    finalize_note: (
      input: Parameters<HandnoteToolHandlers["finalize_note"]>[0],
      _context?: unknown,
    ) => handlers.finalize_note(input, execution()),
  };
}

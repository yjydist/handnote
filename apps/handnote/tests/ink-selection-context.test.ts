import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { InkToolResult } from "@handnote/agent";
import type { Bounds, InkAsset } from "@handnote/ink";
import sharp from "sharp";
import { createAgentTools } from "../../../packages/agent/src/agent-tools.ts";
import { loadInkAsset } from "../src/ink-assets.ts";
import { RunStore } from "../src/store.ts";
import { createHandnoteHandlers } from "../src/tools/index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const presentation = { kind: "text" as const, referenceHeight: 20 };
async function setup() {
  const directory = await mkdtemp(`${tmpdir()}/handnote-selection-context-`);
  directories.push(directory);
  const source = [
    [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ],
    [
      [5, 5],
      [15, 15],
    ],
    [
      [15, 10],
      [30, 10],
    ],
    [
      [50, 50],
      [55, 55],
    ],
  ];
  const store = await RunStore.create(directory, {
    inputExtension: ".png",
    inkSourceBytes: Buffer.from(
      JSON.stringify(
        source.map((points) => ({
          brush_style: "pen",
          pen_color: -16777216,
          pen_width: 2,
          points: points.map(([x, y], time) => ({ x, y, time })),
        })),
      ),
    ),
  });
  await store.copyInput(store.path("input/redraw.png"));
  const handlers = createHandnoteHandlers({
    store,
    recorder: store.recorder,
    sourcePath: store.path(store.manifest.input.path),
    width: 720,
    maxInspectCalls: 3,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  });
  const tools = createAgentTools({
    handlers,
    maxInspectCalls: 3,
    maxSteps: 10,
    currentStep: () => 1,
    onFatal: (error) => {
      throw error;
    },
    onFinalized: () => {
      throw new Error("Unexpected finalization");
    },
  });
  const select = tools.select_ink;
  if (!select?.execute || !select.toModelOutput)
    throw new Error("Missing ink tool");
  return { store, select };
}

function success(output: unknown) {
  const result = output as InkToolResult;
  if (!result.ok) throw new Error(result.summary);
  return result;
}
type SelectionItem = {
  asset: InkAsset;
  selectionContext: {
    candidateRule: string;
    detail: string;
    candidates: Array<{
      strokeIndex: number;
      sourceBounds: Bounds;
      crossesBoundary: boolean;
    }>;
  };
};

test("selection geometry exposes enclosed and crossing strokes per fragment through model media", async () => {
  const { store, select } = await setup();
  const execute = select.execute;
  if (!execute || !select.toModelOutput) throw new Error("Missing ink tool");
  const output = success(
    await execute(
      {
        selections: [0, 1, 3].map((index) => ({
          strokeIndices: [index],
          presentation,
        })),
      },
      {} as Parameters<typeof execute>[1],
    ),
  );
  const items = output.items as SelectionItem[];
  expect(items[0]?.selectionContext).toMatchObject({
    candidateRule:
      "unselected complete stroke bounds intersect this fragment's source bounds",
    candidates: [
      {
        strokeIndex: 1,
        sourceBounds: { x: 4, y: 4, width: 12, height: 12 },
        crossesBoundary: false,
      },
      {
        strokeIndex: 2,
        sourceBounds: { x: 14, y: 9, width: 17, height: 2 },
        crossesBoundary: true,
      },
    ],
  });
  expect(
    items[1]?.selectionContext.candidates.map(
      (candidate) => candidate.strokeIndex,
    ),
  ).toEqual([0, 2]);
  expect(items[2]?.selectionContext.candidates).toEqual([]);
  expect(items.map((item) => item.asset.strokeIndices)).toEqual([
    [0],
    [1],
    [3],
  ]);
  for (const item of items)
    expect(
      (await loadInkAsset(store, item.asset.id)).asset.strokeIndices,
    ).toEqual(item.asset.strokeIndices);
  expect(output.paths).toHaveLength(3);
  for (const path of output.paths)
    expect((await sharp(path).metadata()).format).toBe("png");
  const visible = await select.toModelOutput(output);
  expect(visible).toMatchObject({ type: "content" });
  const content = (visible as { value: Array<{ type: string; text?: string }> })
    .value;
  const summary = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  expect(summary).toContain(
    '"strokeIndex":1,"sourceBounds":{"x":4,"y":4,"width":12,"height":12},"crossesBoundary":false',
  );
  expect(summary).toContain(
    "These are geometric candidates, not character assignments",
  );
  expect(summary).toContain(
    "compare the actual previews for complete characters and relationships",
  );
  expect(summary).toContain("Keep the selection or reselect complete strokes");
  expect(summary).toContain(
    "Candidates are not added automatically and do not block selection",
  );
});

test("reselection updates only its own geometric candidates and preserves the earlier asset", async () => {
  const { store, select } = await setup();
  const execute = select.execute;
  if (!execute) throw new Error("Missing ink tool");
  const initial = success(
    await execute(
      { selections: [{ strokeIndices: [0], presentation }] },
      {} as Parameters<typeof execute>[1],
    ),
  );
  const revised = success(
    await execute(
      { selections: [{ strokeIndices: [0, 1], presentation }] },
      {} as Parameters<typeof execute>[1],
    ),
  );
  const before = initial.items[0] as SelectionItem;
  const after = revised.items[0] as SelectionItem;
  expect(
    after.selectionContext.candidates.map((candidate) => candidate.strokeIndex),
  ).toEqual([2]);
  expect(after.asset.id).not.toBe(before.asset.id);
  expect(after.asset.strokeIndices).toEqual([0, 1]);
  expect(
    (await loadInkAsset(store, before.asset.id)).asset.strokeIndices,
  ).toEqual([0]);
});

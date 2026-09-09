import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { InkToolResult } from "../../src/agent/index.ts";
import {
  createInkFragment,
  type InkAsset,
  renderInkAsset,
} from "../../src/ink/index.ts";
import { loadInkAsset, readInkSource } from "../../src/run/ink-assets.ts";
import { readSession } from "../../src/run/session.ts";
import { RunStore } from "../../src/run/store.ts";
import { createInkHandlers } from "../../src/tools/ink.ts";

const directories: string[] = [];
const presentation = {
  kind: "text" as const,
  referenceHeight: 20,
  transcription: "待确认",
};
const sourceBytes = Buffer.from(
  JSON.stringify(
    [
      {
        pen_width: 2,
        points: [
          { x: -10, y: 0, time: 0 },
          { x: 30, y: 0, time: 1 },
        ],
      },
      {
        pen_width: 2,
        points: [
          { x: 10, y: -20, time: 2 },
          { x: 10, y: 20, time: 3 },
        ],
      },
      { pen_width: 4, points: [{ x: 60, y: 10, time: 4 }] },
      {
        pen_width: 3,
        points: [
          { x: 80, y: 50, time: 5 },
          { x: 100, y: 65, time: 6 },
        ],
      },
    ].map((stroke) => ({
      brush_style: "pen",
      pen_color: -16777216,
      ...stroke,
    })),
  ),
);
const execution = { step: 1, remainingSteps: 10 };

async function setup() {
  const directory = await mkdtemp(`${tmpdir()}/handnote-ink-tools-`);
  directories.push(directory);
  const store = await RunStore.create(directory, {
    inputExtension: ".png",
    inkSourceBytes: sourceBytes,
  });
  await store.copyInput(store.path("input/redraw.png"));
  const tools = createInkHandlers({
    store,
    sourcePath: store.path(store.manifest.input.path),
    recorder: store.recorder,
    width: 700,
    maxInspectCalls: 3,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  });
  return { store, tools };
}
function success(output: InkToolResult) {
  if (!output.ok) throw new Error(output.summary);
  return output;
}
function assetItems(output: InkToolResult) {
  return success(output).items as Array<{
    asset: InkAsset;
    relativePath: string;
    markdown: string;
    preview: { kind: string; path: string; width: number; height: number };
    status: string;
  }>;
}
async function assetFiles(store: RunStore) {
  return (
    await readdir(store.path("assets/ink")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  ).sort();
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ink tools", () => {
  test("page reports exact coordinates and region returns complete numbered candidates", async () => {
    const { store, tools } = await setup();
    const output = success(
      await tools.inspect_ink(
        {
          views: [
            { kind: "page" },
            {
              kind: "region",
              region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            },
          ],
        },
        execution,
      ),
    );
    expect(output.paths).toHaveLength(3);
    expect(output.status).toBe("pending-human-review");
    expect(output.items[0]).toMatchObject({
      kind: "page",
      strokeCount: 4,
      strokeIndexRange: { first: 0, last: 3 },
      sourceBounds: { x: -11, y: -21, width: 112.5, height: 87.5 },
      pointsToRedraw: { scale: 1, translateX: 11, translateY: 21 },
      originalRelation: "unknown",
    });
    const region = output.items[1] as {
      strokeIndices: number[];
      candidates: Array<{
        strokeIndex: number;
        sourceBounds: unknown;
        redrawBounds: unknown;
        crossesBoundary: boolean;
      }>;
      previews: Array<{ kind: string }>;
    };
    expect(region.strokeIndices).toEqual([0, 1]);
    expect(region.candidates).toEqual([
      {
        strokeIndex: 0,
        sourceBounds: { x: -11, y: -1, width: 42, height: 2 },
        redrawBounds: { x: 0, y: 20, width: 42, height: 2 },
        crossesBoundary: true,
      },
      {
        strokeIndex: 1,
        sourceBounds: { x: 9, y: -21, width: 2, height: 42 },
        redrawBounds: { x: 20, y: 0, width: 2, height: 42 },
        crossesBoundary: true,
      },
    ]);
    expect(region.previews.map((preview) => preview.kind)).toEqual([
      "actual",
      "stroke_indices",
    ]);
    const [actual, numbered] = output.paths.slice(1);
    if (!actual || !numbered) throw new Error("Missing region previews");
    expect(await readFile(actual)).not.toEqual(await readFile(numbered));
    for (const path of output.paths) {
      const metadata = await sharp(path).metadata();
      expect(metadata.format).toBe("png");
      expect((await sharp(path).stats()).channels[0]?.min).toBeLessThan(255);
    }
    const summary = JSON.parse(
      output.summary.slice(output.summary.indexOf("\n") + 1),
    );
    expect(summary.items).toEqual(output.items);
    expect(output.summary).toContain("original photograph is unknown");
    expect(await assetFiles(store)).toEqual([]);
  });

  test("selection preserves complete strokes, allows explicit split reselection, and returns actual PNG plus metadata", async () => {
    const { store, tools } = await setup();
    const selected = success(
      await tools.select_ink(
        { selections: [{ strokeIndices: [1, 0], presentation }] },
        execution,
      ),
    );
    const first = assetItems(selected)[0];
    if (!first) throw new Error("Missing selection");
    expect(first.asset.strokeIndices).toEqual([0, 1]);
    expect(first.status).toBe("pending-human-review");
    expect(first.preview.kind).toBe("actual");
    const { document } = await readInkSource(store);
    const expected = createInkFragment(document, {
      strokeIndices: [0, 1],
      presentation,
    });
    expect(first.asset).toEqual(expected);
    expect((await loadInkAsset(store, first.asset.id)).svg).toBe(
      renderInkAsset(document, expected),
    );
    expect(selected.summary).toContain(JSON.stringify(first.asset));
    expect(await sharp(first.preview.path).metadata()).toMatchObject({
      format: "png",
      width: first.preview.width,
      height: first.preview.height,
    });
    const split = assetItems(
      await tools.select_ink(
        {
          selections: [
            { strokeIndices: [0], presentation },
            { strokeIndices: [1], presentation },
          ],
        },
        execution,
      ),
    );
    expect(split.map((item) => item.asset.strokeIndices)).toEqual([[0], [1]]);
    expect((await loadInkAsset(store, first.asset.id)).asset).toEqual(expected);
    const inspected = success(
      await tools.inspect_ink(
        { views: [{ kind: "asset", assetId: first.asset.id }] },
        execution,
      ),
    );
    expect(inspected.items[0]).toMatchObject({
      kind: "asset",
      asset: expected,
    });
    expect(inspected.paths).toEqual([first.preview.path]);
    const events = readSession(store.path("session/events.jsonl")).events;
    expect(
      events.filter((event) => event.type === "tool.select_ink.completed"),
    ).toHaveLength(2);
  });

  test("composition retains placements and complete dependencies in metadata and previews", async () => {
    const { store, tools } = await setup();
    const selected = assetItems(
      await tools.select_ink(
        {
          selections: [
            { strokeIndices: [0], presentation },
            { strokeIndices: [1], presentation },
          ],
        },
        execution,
      ),
    );
    const first = selected[0]?.asset;
    const second = selected[1]?.asset;
    if (!first || !second) throw new Error("Missing selections");
    const parts = [
      { assetId: first.id, rotation: 90, scale: 0.5, x: 0, y: 0 },
      { assetId: second.id, rotation: 0, scale: 1, x: 40, y: 0 },
    ];
    const output = success(
      await tools.compose_ink(
        {
          compositions: [
            {
              parts,
              presentation: {
                kind: "diagram",
                referenceHeight: 20,
                description: "待确认组合",
              },
            },
          ],
        },
        execution,
      ),
    );
    const composed = assetItems(output)[0];
    if (!composed) throw new Error("Missing composition");
    expect(composed.asset).toMatchObject({
      kind: "composition",
      parts,
      strokeIndices: [0, 1],
      presentation: {
        kind: "diagram",
        referenceHeight: 20,
        description: "待确认组合",
      },
    });
    const loaded = await loadInkAsset(store, composed.asset.id);
    expect(loaded.artifacts).toHaveLength(9);
    expect(output.summary).toContain(JSON.stringify(composed.asset));
    expect(
      (await sharp(composed.preview.path).stats()).channels[0]?.min,
    ).toBeLessThan(255);
  });

  test("invalid selection geometry rejects the whole batch without saving its valid prefix", async () => {
    const { store, tools } = await setup();
    const result = await tools.select_ink(
      {
        selections: [
          { strokeIndices: [0], presentation },
          { strokeIndices: [1, 1], presentation },
        ],
      },
      execution,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_ink_geometry", repairable: true },
    });
    expect(await assetFiles(store)).toEqual([]);
  });

  test("invalid composition geometry rejects its valid prefix and leaves prior selections intact", async () => {
    const { store, tools } = await setup();
    const selected = assetItems(
      await tools.select_ink(
        { selections: [{ strokeIndices: [0], presentation }] },
        execution,
      ),
    )[0];
    if (!selected) throw new Error("Missing selection");
    const part = {
      assetId: selected.asset.id,
      rotation: 0,
      scale: 1,
      x: 0,
      y: 0,
    };
    const before = await assetFiles(store);
    const output = await tools.compose_ink(
      {
        compositions: [
          { parts: [part], presentation },
          { parts: [part, part], presentation },
        ],
      },
      execution,
    );
    expect(output).toMatchObject({
      ok: false,
      error: { code: "invalid_ink_geometry", repairable: true },
    });
    expect(await assetFiles(store)).toEqual(before);
  });

  test("unknown asset IDs are repairable but existing broken assets and sources are fatal", async () => {
    const { store, tools } = await setup();
    const assetId = "f".repeat(64);
    expect(
      await tools.inspect_ink(
        { views: [{ kind: "asset", assetId }] },
        execution,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unknown_ink_asset", repairable: true },
    });
    expect(
      await tools.compose_ink(
        {
          compositions: [
            {
              parts: [{ assetId, rotation: 0, scale: 1, x: 0, y: 0 }],
              presentation,
            },
          ],
        },
        execution,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unknown_ink_asset", repairable: true },
    });
    const selected = assetItems(
      await tools.select_ink(
        { selections: [{ strokeIndices: [0], presentation }] },
        execution,
      ),
    )[0];
    if (!selected) throw new Error("Missing selection");
    await rm(store.path(`assets/ink/${selected.asset.id}.svg`));
    await expect(
      tools.inspect_ink(
        { views: [{ kind: "asset", assetId: selected.asset.id }] },
        execution,
      ),
    ).rejects.toMatchObject({ kind: "filesystem" });
    await appendFile(store.path("input/points.json"), " ");
    await expect(
      tools.select_ink(
        { selections: [{ strokeIndices: [1], presentation }] },
        execution,
      ),
    ).rejects.toMatchObject({ kind: "filesystem" });
  });

  test("asset symlinks fail fatally at the resource boundary", async () => {
    const { store, tools } = await setup();
    const selected = assetItems(
      await tools.select_ink(
        { selections: [{ strokeIndices: [0], presentation }] },
        execution,
      ),
    )[0];
    if (!selected) throw new Error("Missing selection");
    const path = store.path(`assets/ink/${selected.asset.id}.json`);
    await rm(path);
    await symlink(store.path("input/points.json"), path);
    await expect(
      tools.inspect_ink(
        { views: [{ kind: "asset", assetId: selected.asset.id }] },
        execution,
      ),
    ).rejects.toMatchObject({ kind: "filesystem" });
  });

  test("large finite composition extents are bounded before SVG rasterization", async () => {
    const { store, tools } = await setup();
    const selected = assetItems(
      await tools.select_ink(
        {
          selections: [
            { strokeIndices: [0], presentation },
            { strokeIndices: [1], presentation },
          ],
        },
        execution,
      ),
    );
    const parts = selected.map((item, index) => ({
      assetId: item.asset.id,
      rotation: 0,
      scale: 1,
      x: index * 1_000_000,
      y: index * 1_000_000,
    }));
    const output = success(
      await tools.compose_ink(
        { compositions: [{ parts, presentation }] },
        execution,
      ),
    );
    const item = assetItems(output)[0];
    if (!item) throw new Error("Missing composition");
    expect(item.asset.width).toBeGreaterThan(1_000_000);
    expect(item.preview.width * item.preview.height).toBeLessThanOrEqual(
      2048 ** 2,
    );
    expect(await sharp(item.preview.path).metadata()).toMatchObject({
      width: item.preview.width,
      height: item.preview.height,
    });
    expect((await loadInkAsset(store, item.asset.id)).asset.width).toBe(
      item.asset.width,
    );
  });
});

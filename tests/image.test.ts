import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  createModelPreviews,
  inspectSource,
  normalizeInspectInput,
  regionPixels,
} from "../src/image.ts";
import { RunState } from "../src/state.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { createStoreFixture } from "./helpers.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-media-`);
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("image inspection", () => {
  test("normalizes repeated region options and clips edge-crossing crops", () => {
    const normalized = normalizeInspectInput({
      regions: [
        {
          x: 0.9,
          y: 0.95,
          width: 0.2,
          height: 0.1,
          scale: 3,
          enhancement: "contrast",
        },
      ],
    });
    expect(normalized).toMatchObject({
      regions: [
        {
          x: 0.9,
          y: 0.95,
          scale: 3,
          enhancement: "contrast",
        },
      ],
    });
    expect(normalized.regions[0]?.width).toBeCloseTo(0.1);
    expect(normalized.regions[0]?.height).toBeCloseTo(0.05);
    const perRegion = normalizeInspectInput({
      scale: 2,
      enhancement: "original",
      regions: [
        { x: 0, y: 0, width: 0.5, height: 0.5, enhancement: "contrast" },
        { x: 0.5, y: 0.5, width: 0.5, height: 0.5, scale: 3 },
      ],
    });
    expect(perRegion.regions).toMatchObject([
      { scale: 2, enhancement: "contrast" },
      { scale: 3, enhancement: "original" },
    ]);
  });

  test("rounds normalized crop outward and produces all enhancement modes", async () => {
    expect(
      regionPixels(
        { x: 0.101, y: 0.201, width: 0.302, height: 0.304 },
        100,
        100,
      ),
    ).toEqual({ left: 10, top: 20, width: 31, height: 31 });
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 100, height: 80, channels: 3, background: "#77aacc" },
    })
      .png()
      .toFile(source);
    for (const [index, enhancement] of [
      "original",
      "grayscale",
      "contrast",
      "sharpen",
      "binarize",
    ].entries()) {
      const output = await inspectSource(
        source,
        `${directory}/out`,
        {
          regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
          scale: 2,
          enhancement: enhancement as "original",
        },
        index,
        2048,
      );
      expect(await Bun.file(output.path).exists()).toBe(true);
      expect(output.width).toBe(100);
    }
  });

  test("creates a numbered contact sheet", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 60, height: 60, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const output = await inspectSource(
      source,
      `${directory}/out`,
      {
        regions: [
          { x: 0, y: 0, width: 0.5, height: 0.5 },
          { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
        ],
        scale: 1,
        enhancement: "original",
      },
      1,
      2048,
    );
    expect(output.kind).toBe("contact_sheet");
    expect(output.width).toBeGreaterThan(60);
  });

  test("bounds enlarged crops and contact sheets without changing aspect ratio", async () => {
    const directory = await temporary();
    const source = `${directory}/bounded.png`;
    await sharp({
      create: { width: 500, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const input = {
      regions: [{ x: 0, y: 0, width: 1, height: 1 }],
      scale: 4,
      enhancement: "original" as const,
    };
    const crop = await inspectSource(
      source,
      `${directory}/single`,
      input,
      1,
      640,
    );
    expect(crop).toMatchObject({ width: 640, height: 512, kind: "crop" });
    expect(await sharp(crop.path).metadata()).toMatchObject({
      width: crop.width,
      height: crop.height,
    });

    const contact = await inspectSource(
      source,
      `${directory}/contact`,
      {
        ...input,
        regions: Array.from({ length: 8 }, () => ({
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        })),
      },
      2,
      4096,
    );
    expect(contact.kind).toBe("contact_sheet");
    expect(contact.width).toBeLessThanOrEqual(4096);
    expect(contact.width * contact.height).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    const cellWidth = contact.width / 2;
    const cellHeight = contact.height / 4;
    expect((cellWidth - 32) / (cellHeight - 56)).toBeCloseTo(1.25, 2);
  });

  test("creates deterministic bounded JPEG previews and tiles tall images", async () => {
    const directory = await temporary();
    const source = `${directory}/tall.png`;
    await sharp({
      create: { width: 900, height: 5000, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const options = { maxEdge: 2048, jpegQuality: 85 };
    const first = await createModelPreviews(source, options);
    const second = await createModelPreviews(source, options);
    expect(first).toHaveLength(3);
    expect(first.map(({ data: _data, ...item }) => item)).toEqual(
      second.map(({ data: _data, ...item }) => item),
    );
    expect(first.every((item) => item.mediaType === "image/jpeg")).toBe(true);
    expect(
      first.every(
        (item) =>
          item.width <= options.maxEdge && item.height <= options.maxEdge,
      ),
    ).toBe(true);
    expect(first.reduce((total, item) => total + item.bytes, 0)).toBeLessThan(
      Bun.file(source).size,
    );
  });

  test("reuses an identical inspection within one run", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state: new RunState(),
      recorder,
    });
    expect(tools.inspect_source.description).toContain(
      "a region may override either",
    );
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const input = {
      regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      scale: 2,
      enhancement: "original" as const,
    };
    const executionContext = {} as Parameters<typeof execute>[1];
    const first = await execute(
      {
        regions: [
          {
            x: 0,
            y: 0,
            width: 0.5,
            height: 0.5,
            scale: 2,
            enhancement: "original" as const,
          },
        ],
      },
      executionContext,
    );
    const second = await execute(input, executionContext);
    expect(first).toEqual(second);
    for (const x of [0.1, 0.2]) {
      await execute(
        {
          ...input,
          regions: [{ x, y: 0, width: 0.5, height: 0.5 }],
        },
        executionContext,
      );
    }
    const rejected = await execute(
      {
        ...input,
        regions: [{ x: 0.3, y: 0, width: 0.5, height: 0.5 }],
      },
      executionContext,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    if (!rejected.ok) expect(rejected.error.message).toContain("write_note");
    expect(await readdir(`${directory}/intermediate/inspections`)).toHaveLength(
      3,
    );
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((event) => event.type === "tool.inspect_source.completed")
        .map((event) => event.data.cacheHit),
    ).toEqual([false, true, false, false]);
    expect(
      events.filter((event) => event.type === "tool.inspect_source.rejected"),
    ).toHaveLength(1);
  });

  test("points the exhausted-budget message at write_note before a revision and revise_note after one", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const state = new RunState();
    const store = await createStoreFixture(directory);
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 1,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder: store.recorder,
    });
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const executionContext = {} as Parameters<typeof execute>[1];
    await execute(
      { regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    const before = await execute(
      { regions: [{ x: 0.2, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    expect(before).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    if (!before.ok) expect(before.error.message).toContain("write_note");
    await store.commit(
      { markdown: "正文", audit: {} },
      { kind: "write", step: 1, width: 700 },
    );
    const after = await execute(
      { regions: [{ x: 0.4, y: 0, width: 0.5, height: 0.5 }] },
      executionContext,
    );
    if (!after.ok) expect(after.error.message).toContain("revise_note");
  });

  test("shares an in-flight inspection without consuming another budget slot", async () => {
    const directory = await temporary();
    const source = `${directory}/source.png`;
    await sharp({
      create: { width: 120, height: 80, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const tools = createHandnoteTools({
      store,
      sourcePath: source,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 1,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state: new RunState(),
      recorder,
    });
    const execute = tools.inspect_source.execute;
    if (!execute) throw new Error("missing inspect_source execute");
    const input = {
      regions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
      scale: 2,
      enhancement: "original" as const,
    };
    const executionContext = {} as Parameters<typeof execute>[1];
    const [first, second] = await Promise.all([
      execute(input, executionContext),
      execute(input, executionContext),
    ]);
    if (!first.ok || !second.ok) throw new Error("inspection was rejected");
    expect(first.path).toBe(second.path);
    expect(await readdir(`${directory}/intermediate/inspections`)).toHaveLength(
      1,
    );
    const rejected = await execute(
      {
        ...input,
        regions: [{ x: 0.25, y: 0, width: 0.5, height: 0.5 }],
      },
      executionContext,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "inspection_budget_exhausted" },
    });
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events
        .filter((event) => event.type === "tool.inspect_source.completed")
        .map((event) => event.data.cacheHit)
        .sort(),
    ).toEqual([false, true]);
  });
});

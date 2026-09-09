import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  createStoreFixture,
  createTestHandlers,
  ModelSteps,
} from "./helpers.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-figure-`);
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

describe("capture_figure tool", () => {
  test("materializes a region to assets/figures and caches identical regions", async () => {
    const directory = await temporary();
    const source = `${directory}/original.png`;
    await sharp({
      create: { width: 200, height: 100, channels: 3, background: "#f2d9a6" },
    })
      .png()
      .toFile(source);
    const store = await createStoreFixture(directory);
    const recorder = store.recorder;
    const tools = createTestHandlers({
      store,
      sourcePath: source,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state: new ModelSteps(),
      recorder,
    });
    const execute = tools.capture_figure;
    if (!execute) throw new Error("missing capture_figure execute");
    const context = {} as Parameters<typeof execute>[1];
    const region = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
    const first = await execute({ region }, context);
    expect(first).toMatchObject({
      ok: true,
      relativePath: "../assets/figures/figure-001.png",
      width: 100,
      height: 25,
    });
    expect(
      await Bun.file(`${directory}/assets/figures/figure-001.png`).exists(),
    ).toBe(true);
    const second = await execute(
      { region: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      context,
    );
    expect(second).toMatchObject({
      ok: true,
      relativePath: "../assets/figures/figure-002.png",
    });
    const cached = await execute({ region }, context);
    expect(cached).toMatchObject({
      ok: true,
      relativePath: "../assets/figures/figure-001.png",
    });
    const events = (await readFile(recorder.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const completed = events.filter(
      (event) => event.type === "tool.capture_figure.completed",
    );
    expect(completed).toHaveLength(3);
    expect(completed.map((event) => event.data.cacheHit)).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      events.some((event) => event.type === "tool.model_media.prepared"),
    ).toBe(false);
  });

  test("shares failures, clears the cache, and permits retry", async () => {
    const directory = await temporary();
    const source = `${directory}/missing.png`;
    const state = new ModelSteps();
    const store = await createStoreFixture(directory);
    const tools = createTestHandlers({
      store,
      sourcePath: source,
      width: 700,
      maxSteps: 18,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      state,
      recorder: store.recorder,
    });
    const execute = tools.capture_figure;
    if (!execute) throw new Error("missing capture_figure execute");
    const context = {} as Parameters<typeof execute>[1];
    const input = { region: { x: 0, y: 0, width: 1, height: 1 } };
    const failures = await Promise.allSettled([
      execute(input, context),
      execute(input, context),
    ]);
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.status).toBe("rejected");
      if (failure.status === "rejected")
        expect(failure.reason).toBeInstanceOf(Error);
    }
    expect(failures[0]).toEqual(failures[1]);

    await sharp({
      create: { width: 20, height: 10, channels: 3, background: "white" },
    })
      .png()
      .toFile(source);
    await expect(execute(input, context)).resolves.toMatchObject({
      ok: true,
      relativePath: "../assets/figures/figure-002.png",
    });
  });
});

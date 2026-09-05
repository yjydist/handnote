import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { readSession, SessionRecorder } from "../src/session.ts";
import { RunState } from "../src/state.ts";
import { RunStore } from "../src/store.ts";
import { createHandnoteTools } from "../src/tools/index.ts";
import { createStoreFixture, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
async function setup() {
  const directory = await fs.mkdtemp(`${tmpdir()}/handnote-safety-`);
  directories.push(directory);
  return { directory, store: await createStoreFixture(`${directory}/run`) };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("recovery path safety", () => {
  test.each(["capture", "inspect"])(
    "%s refuses to write through a linked parent",
    async (tool) => {
      const { directory, store } = await setup();
      const outside = `${directory}/outside`;
      await fs.mkdir(outside);
      await fs.symlink(
        outside,
        store.path(tool === "capture" ? "assets" : "intermediate"),
      );
      const tools = createHandnoteTools({
        store,
        sourcePath: store.path("input/original.png"),
        width: 700,
        maxSteps: 8,
        maxInspectCalls: 3,
        toolMedia: { maxEdge: 2048, jpegQuality: 85 },
        state: new RunState(),
        recorder: store.recorder,
      });
      const capture = tools.capture_figure.execute;
      const inspect = tools.inspect_source.execute;
      if (!capture || !inspect) throw new Error("Missing tool executor");
      const region = { x: 0, y: 0, width: 1, height: 1 };
      await expect(
        tool === "capture"
          ? capture({ region }, {} as Parameters<typeof capture>[1])
          : inspect({ regions: [region] }, {} as Parameters<typeof inspect>[1]),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  test.each([
    "intermediate",
    "intermediate/revisions",
    "input",
    "session",
    "assets/figures",
    "output",
    "output.tmp",
    "internal-alias",
  ])(
    "rejects a linked %s before touching the log, manifest or cleanup candidates",
    async (location) => {
      const { directory, store } = await setup();
      const target =
        location === "internal-alias"
          ? `${store.directory}/kept`
          : `${directory}/outside`;
      await fs.mkdir(`${target}/0001`, { recursive: true });
      await fs.writeFile(`${target}/0001/keep.txt`, "unrelated revision");
      await fs.writeFile(`${target}/original.png.tmp-abcd`, "unrelated input");
      await fs.copyFile(
        store.path("input/original.png"),
        `${target}/original.png`,
      );
      await fs.appendFile(store.recorder.path, '{"seq":');
      await fs.copyFile(store.recorder.path, `${target}/events.jsonl`);
      const link = store.path(
        location === "internal-alias" ? "intermediate/revisions" : location,
      );
      await fs.mkdir(dirname(link), { recursive: true });
      if (existsSync(link)) await fs.rename(link, `${link}.saved`);
      await fs.symlink(target, link);
      const manifest = await fs.readFile(`${store.directory}/run.json`);
      const log = await fs.readFile(store.recorder.path);
      for (const mode of ["read", "recover"] as const)
        await expect(
          RunStore.open(store.directory, { mode }),
        ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await fs.readFile(`${store.directory}/run.json`)).toEqual(
        manifest,
      );
      expect(await fs.readFile(store.recorder.path)).toEqual(log);
      expect(await fs.readFile(`${target}/events.jsonl`)).toEqual(log);
      expect(await fs.readFile(`${target}/0001/keep.txt`, "utf8")).toBe(
        "unrelated revision",
      );
      expect(await fs.readFile(`${target}/original.png.tmp-abcd`, "utf8")).toBe(
        "unrelated input",
      );
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    },
  );

  test("validates all cleanup candidates before repairing the tail or deleting any orphan", async () => {
    const { directory, store } = await setup();
    const orphan = store.path("intermediate/revisions/0001");
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(`${orphan}/keep.txt`, "unconfirmed");
    const outside = `${directory}/outside.txt`;
    await fs.writeFile(outside, "unrelated");
    await fs.symlink(outside, store.path("input/original.png.tmp-abcd"));
    await fs.appendFile(store.recorder.path, '{"seq":');
    const manifest = await fs.readFile(store.path("run.json"));
    const log = await fs.readFile(store.recorder.path);
    await expect(
      RunStore.open(store.directory, { mode: "recover" }),
    ).rejects.toMatchObject({ kind: "filesystem" });
    expect(await fs.readFile(store.path("run.json"))).toEqual(manifest);
    expect(await fs.readFile(store.recorder.path)).toEqual(log);
    expect(await fs.readFile(`${orphan}/keep.txt`, "utf8")).toBe("unconfirmed");
    expect(await fs.readFile(outside, "utf8")).toBe("unrelated");
  });
});

async function reviewedFigure() {
  const { store } = await setup();
  await fs.mkdir(store.path("assets/figures"), { recursive: true });
  const figure = store.path("assets/figures/figure-001.png");
  const copy = store.path("assets/figures/copy.png");
  await fs.copyFile(store.path("input/original.png"), figure);
  await fs.copyFile(figure, copy);
  await store.commit(
    {
      ...simpleDraft(),
      markdown: "# Figure\n\n![](../assets/figures/figure-001.png)",
    },
    { kind: "write", step: 1, width: 700 },
  );
  await store.review(2, async () => {});
  return { store, figure, copy };
}

async function expectDamagedRevision(store: RunStore) {
  const manifest = await fs.readFile(`${store.directory}/run.json`);
  const log = await fs.readFile(store.recorder.path);
  await expect(store.readRevision()).rejects.toMatchObject({
    kind: "filesystem",
  });
  await expect(store.review(3, async () => {})).rejects.toMatchObject({
    kind: "filesystem",
  });
  await expect(store.finalize(3)).rejects.toMatchObject({ kind: "filesystem" });
  for (const mode of ["read", "recover"] as const)
    await expect(
      RunStore.open(store.directory, { mode }),
    ).rejects.toMatchObject({ kind: "filesystem" });
  expect(await fs.readFile(`${store.directory}/run.json`)).toEqual(manifest);
  expect(await fs.readFile(store.recorder.path)).toEqual(log);
  expect(existsSync(`${store.directory}/output`)).toBe(false);
}

describe("committed resource integrity", () => {
  test.each(["same-byte-link", "deleted", "retargeted-link", "parent-link"])(
    "rejects a %s after review, even if its old hashes still match",
    async (change) => {
      const { store, figure, copy } = await reviewedFigure();
      if (change === "parent-link") {
        const parent = dirname(figure);
        await fs.rename(parent, `${parent}.saved`);
        await fs.symlink(`${parent}.saved`, parent);
      } else {
        await fs.rm(figure);
        if (change !== "deleted") await fs.symlink(copy, figure);
        if (change === "retargeted-link") {
          await fs.unlink(figure);
          await fs.symlink(`${copy}.missing`, figure);
        }
      }
      await expectDamagedRevision(store);
    },
  );

  test.each(["linked-reference", "missing-reference", "omitted-index"])(
    "checks actual Markdown references against a stale resource index: %s",
    async (change) => {
      const { store, figure, copy } = await reviewedFigure();
      const manifest = store.manifest;
      const revision = manifest.revisions[0];
      if (!revision?.assets[0]) throw new Error("Missing figure index");
      if (change === "omitted-index") revision.assets = [];
      else {
        revision.assets[0].path = "assets/figures/copy.png";
        await fs.rm(figure);
        if (change === "linked-reference") await fs.symlink(copy, figure);
      }
      await fs.writeFile(store.path("run.json"), JSON.stringify(manifest));
      await expectDamagedRevision(store);
    },
  );
});

describe("session recovery boundaries", () => {
  test.each(["a", "1"])(
    "preserves manifest structure while redacting error text for key %s",
    async (secret) => {
      const { directory } = await setup();
      const store = await createStoreFixture(`${directory}/short-key`, {
        secrets: [secret],
      });
      const before = store.manifest;
      const result = await store.finish("authentication", {
        kind: "authentication",
        message: secret,
      });
      expect(result).toMatchObject({
        status: "failed",
        stopReason: "authentication",
        startedAt: before.startedAt,
        input: before.input,
        error: { kind: "authentication", message: "[REDACTED]" },
      });
      expect((await RunStore.open(store.directory)).manifest).toEqual(result);
    },
  );

  test.each(["missing", "empty", "only-tail", "wrong-creation"])(
    "preserves recorded usage when an existing log is %s",
    async (damage) => {
      const { store } = await setup();
      store.recorder.record("model.attempt.started", { step: 1, attempt: 1 });
      store.recorder.record("model.step.completed", {
        step: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      await store.updateModel({
        steps: 1,
        attempts: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      await store.finish("model_stopped_no_revision");
      const path = store.recorder.path;
      if (damage === "missing") await fs.rm(path);
      else if (damage === "empty") await fs.writeFile(path, "");
      else if (damage === "only-tail") await fs.writeFile(path, '{"seq":');
      else {
        const events = readSession(path).events;
        if (!events[0]) throw new Error("Missing creation event");
        events[0].type = "wrong";
        await fs.writeFile(
          path,
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        );
      }
      const manifest = await fs.readFile(store.path("run.json"));
      const log = damage === "missing" ? undefined : await fs.readFile(path);
      for (const mode of ["read", "recover"] as const)
        await expect(
          RunStore.open(store.directory, { mode }),
        ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await fs.readFile(store.path("run.json"))).toEqual(manifest);
      if (log === undefined) expect(existsSync(path)).toBe(false);
      else expect(await fs.readFile(path)).toEqual(log);
      expect(store.manifest.model).toMatchObject({
        steps: 1,
        attempts: 1,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  );

  test("distinguishes creation from reopening without recreating a missing log", async () => {
    const { store } = await setup();
    const log = await fs.readFile(store.recorder.path);
    expect(() => SessionRecorder.create(store.directory)).toThrow();
    expect(await fs.readFile(store.recorder.path)).toEqual(log);
    const sequence = readSession(store.recorder.path).events.length;
    expect(SessionRecorder.open(store.directory).record("reopened").seq).toBe(
      sequence + 1,
    );
    await fs.rm(store.recorder.path);
    expect(() => readSession(store.recorder.path)).toThrow(
      "Cannot read existing session log",
    );
    expect(() => SessionRecorder.open(store.directory)).toThrow(
      "Cannot read existing session log",
    );
    expect(existsSync(store.recorder.path)).toBe(false);
  });
});

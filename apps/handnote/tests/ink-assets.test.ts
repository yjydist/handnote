import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  appendFile,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  composeInkAssets,
  createInkFragment,
  inkAssetJson,
  parseInkJson,
  renderInkAsset,
} from "@handnote/ink";
import {
  dependenciesSha256,
  loadInkAsset,
  loadInkLibrary,
  readInkSource,
} from "../src/ink-assets.ts";
import { compileNoteMarkdown } from "../src/markdown.ts";
import { readSession } from "../src/session.ts";
import { RunStore } from "../src/store.ts";
import { sha256 } from "../src/utils.ts";
import { createStoreFixture, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
const sourceBytes = (offset = 0) =>
  Buffer.from(
    `${JSON.stringify(
      [0, 1, 2].map((index) => ({
        brush_style: "pen",
        pen_width: 2,
        pen_color: -16777216,
        points: [
          { x: offset + index * 30, y: 0, time: 0 },
          { x: offset + index * 30 + 10, y: 20, time: 1 },
        ],
      })),
      null,
      2,
    )}\n`,
  );
async function directory() {
  const path = await mkdtemp(`${tmpdir()}/handnote-ink-assets-`);
  directories.push(path);
  return path;
}
async function setup() {
  const store = await RunStore.create(await directory(), {
    inputExtension: ".png",
    inkSourceBytes: sourceBytes(),
  });
  await store.copyInput(store.path("input/redraw.png"));
  const { document } = await readInkSource(store);
  const first = createInkFragment(document, {
    strokeIndices: [0],
    presentation: { kind: "text", referenceHeight: 22, transcription: "一" },
  });
  const second = createInkFragment(document, {
    strokeIndices: [1],
    presentation: { kind: "text", referenceHeight: 22 },
  });
  await store.saveInkAsset(first);
  await store.saveInkAsset(second);
  const library = await loadInkLibrary(store, [first.id, second.id]);
  const composition = composeInkAssets(
    document,
    {
      parts: [first, second].map((asset, index) => ({
        assetId: asset.id,
        rotation: 0,
        scale: 1,
        x: index * 15,
        y: 0,
      })),
      presentation: { kind: "text", referenceHeight: 22 },
    },
    library.assets,
  );
  await store.saveInkAsset(composition);
  const draft = {
    ...simpleDraft(),
    markdown: `# 原笔迹\n\n![字](../assets/ink/${composition.id}.svg)`,
  };
  return { store, document, first, second, composition, draft };
}
async function reviewed() {
  const fixture = await setup();
  const revision = await fixture.store.commit(fixture.draft, {
    kind: "write",
    step: 1,
    width: 700,
  });
  expect(revision.warnings.filter((warning) => warning.blocking)).toEqual([]);
  await fixture.store.review(2, async () => {});
  return { ...fixture, revision };
}
afterEach(async () => {
  mock.restore();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("immutable ink dependency graph", () => {
  test("rolls back a new descriptor when SVG creation fails and permits retry", async () => {
    const { store, document, revision } = await reviewed();
    const asset = createInkFragment(document, {
      strokeIndices: [2],
      presentation: { kind: "text", referenceHeight: 22 },
    });
    const descriptor = store.path(`assets/ink/${asset.id}.json`);
    const originalOpen = fs.open;
    const diskFull = Object.assign(new Error("injected SVG disk full"), {
      code: "ENOSPC",
    });
    const fault = spyOn(fs, "open").mockImplementation(
      async (path, ...args) => {
        if (String(path).includes(`${asset.id}.svg.tmp-`)) throw diskFull;
        return originalOpen(path, ...args);
      },
    );
    await expect(store.saveInkAsset(asset)).rejects.toMatchObject({
      kind: "filesystem",
      cause: diskFull,
    });
    fault.mockRestore();
    await expect(readFile(descriptor)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await store.readRevision())?.assets).toEqual(revision.assets);
    expect(store.manifest.reviewedRevision?.number).toBe(1);
    expect((await store.saveInkAsset(asset)).asset).toEqual(asset);
  });

  test("rolls back both new artifacts when verification fails after publication", async () => {
    const { store, document } = await setup();
    const asset = createInkFragment(document, {
      strokeIndices: [2],
      presentation: { kind: "text", referenceHeight: 22 },
    });
    const svgPath = store.path(`assets/ink/${asset.id}.svg`);
    const originalRead = fs.readFile;
    let injected = false;
    const fault = spyOn(fs, "readFile").mockImplementation(((
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (!injected && String(args[0]) === svgPath) {
        injected = true;
        return Promise.reject(
          Object.assign(new Error("injected verification read failure"), {
            code: "EIO",
          }),
        );
      }
      return originalRead(...args);
    }) as typeof fs.readFile);
    await expect(store.saveInkAsset(asset)).rejects.toMatchObject({
      kind: "filesystem",
    });
    fault.mockRestore();
    for (const extension of ["json", "svg"])
      await expect(
        readFile(store.path(`assets/ink/${asset.id}.${extension}`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.saveInkAsset(asset)).asset).toEqual(asset);
  });

  test.each(["modified", "linked", "referenced", "cleanup-error"])(
    "preserves an unsafe rollback candidate and both failure contexts: %s",
    async (change) => {
      const { store, document } = await reviewed();
      const asset = createInkFragment(document, {
        strokeIndices: [2],
        presentation: { kind: "text", referenceHeight: 22 },
      });
      const path = `assets/ink/${asset.id}.json`;
      const descriptor = store.path(path);
      const originalOpen = fs.open;
      const originalRm = fs.rm;
      const diskFull = Object.assign(new Error("injected SVG disk full"), {
        code: "ENOSPC",
      });
      const denied = Object.assign(new Error("injected cleanup denied"), {
        code: "EACCES",
      });
      spyOn(fs, "open").mockImplementation(async (file, ...args) => {
        if (String(file).includes(`${asset.id}.svg.tmp-`)) {
          if (change === "modified") await appendFile(descriptor, " changed");
          if (change === "linked") {
            await copyFile(descriptor, store.path("input/rollback-copy.json"));
            await originalRm(descriptor);
            await symlink(store.path("input/rollback-copy.json"), descriptor);
          }
          if (change === "referenced") {
            const manifest = store.manifest;
            const revision = manifest.revisions[0];
            if (!revision) throw new Error("Missing revision");
            revision.assets.push({
              path,
              sha256: sha256(await readFile(descriptor)),
            });
            await writeFile(store.path("run.json"), JSON.stringify(manifest));
          }
          throw diskFull;
        }
        return originalOpen(file, ...args);
      });
      if (change === "cleanup-error")
        spyOn(fs, "rm").mockImplementation(async (file, ...args) => {
          if (String(file) === descriptor) throw denied;
          return originalRm(file, ...args);
        });
      const error = await store
        .saveInkAsset(asset)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        kind: "filesystem",
        message: "Ink asset save failed and rollback was incomplete",
      });
      const aggregate = (error as { cause: AggregateError }).cause;
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect(aggregate.errors[0]).toBe(diskFull);
      expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
      if (change === "cleanup-error")
        expect(aggregate.errors[1].errors[0]).toBe(denied);
      mock.restore();
      const remaining = await readFile(descriptor, "utf8");
      expect(remaining).toBe(
        inkAssetJson(asset) + (change === "modified" ? " changed" : ""),
      );
      if (change === "linked")
        expect((await fs.lstat(descriptor)).isSymbolicLink()).toBe(true);
      await expect(store.saveInkAsset(asset)).rejects.toMatchObject({
        kind: "filesystem",
      });
      expect(await readFile(descriptor, "utf8")).toBe(remaining);
    },
  );

  test("serializes simultaneous saves and validates metadata even when an ID is cached", async () => {
    const { store, document } = await setup();
    const asset = createInkFragment(document, {
      strokeIndices: [2],
      presentation: { kind: "text", referenceHeight: 22 },
    });
    const saved = await Promise.all([
      store.saveInkAsset(asset),
      store.saveInkAsset(asset),
    ]);
    expect(saved[0]).toEqual(saved[1]);
    await expect(
      store.saveInkAsset({
        ...asset,
        presentation: {
          ...asset.presentation,
          transcription: "forged under the old ID",
        },
      }),
    ).rejects.toThrow("identity or source geometry mismatch");
    expect((await loadInkAsset(store, asset.id)).asset).toEqual(asset);
  });

  test("transforms get a new immutable identity and retain their nested source assets", async () => {
    const { store, document, composition } = await setup();
    const library = await loadInkLibrary(store, [composition.id]);
    const changed = composeInkAssets(
      document,
      {
        parts: [
          { assetId: composition.id, rotation: 8, scale: 1.2, x: 3, y: 4 },
        ],
        presentation: composition.presentation,
      },
      library.assets,
    );
    const saved = await store.saveInkAsset(changed);
    expect(changed.id).not.toBe(composition.id);
    expect(saved.asset).toEqual(changed);
    expect(saved.artifacts).toHaveLength(11);
    expect((await loadInkAsset(store, composition.id)).asset).toEqual(
      composition,
    );
  });

  test("binds source preview hashes to creation evidence before the first revision", async () => {
    const { store } = await setup();
    const manifest = store.manifest;
    if (!manifest.ink) throw new Error("Missing source");
    await appendFile(store.path("input/redraw.png"), "tampered");
    manifest.ink.redraw.image.sha256 = sha256(
      await readFile(store.path("input/redraw.png")),
    );
    await writeFile(store.path("run.json"), JSON.stringify(manifest));
    await expect(RunStore.open(store.directory)).rejects.toThrow(
      "Ink source creation event mismatch",
    );
  });

  test("preserves source identity through diagnostic credential redaction", async () => {
    const store = await RunStore.create(await directory(), {
      inputExtension: ".png",
      inkSourceBytes: sourceBytes(),
      secrets: ["a", "1"],
    });
    await expect(RunStore.open(store.directory)).resolves.toBeDefined();
    const event = readSession(store.path("session/events.jsonl")).events[0];
    expect(event?.data).toEqual({
      formatVersion: 2,
      inkMetadataSha256: sha256(inkAssetJson(store.manifest.ink)),
    });
  });

  test("keeps original source bytes and verifies complete composition dependencies", async () => {
    const { store, composition, first, second } = await setup();
    expect(await readFile(store.path("input/points.json"))).toEqual(
      sourceBytes(),
    );
    const { document, metadata } = await readInkSource(store);
    expect(document.sourceHash).toBe(sha256(sourceBytes()));
    expect(metadata.originalRelation).toBe("unknown");
    expect(metadata.redraw.transform).toEqual({
      scale: 1,
      translateX: 1,
      translateY: 1,
    });
    const loaded = await loadInkAsset(store, composition.id);
    expect(loaded.asset).toEqual(composition);
    expect(loaded.artifacts.map((artifact) => artifact.path).sort()).toEqual(
      [
        "input/points.json",
        "input/redraw.svg",
        "input/redraw.png",
        ...[composition, first, second].flatMap((asset) => [
          `assets/ink/${asset.id}.json`,
          `assets/ink/${asset.id}.svg`,
        ]),
      ].sort(),
    );
    expect(
      await readFile(store.path(`assets/ink/${composition.id}.json`), "utf8"),
    ).toBe(inkAssetJson(composition));
  });

  test.each([
    "points",
    "descriptor",
    "svg",
    "dependency",
    "redraw",
    "transform",
    "symlink",
    "missing",
  ])(
    "rejects %s damage before recovery and never rewrites it",
    async (target) => {
      const { store, composition, first } = await reviewed();
      let path = `assets/ink/${composition.id}.json`;
      if (target === "points") path = "input/points.json";
      if (target === "svg") path = `assets/ink/${composition.id}.svg`;
      if (target === "dependency") path = `assets/ink/${first.id}.json`;
      if (target === "redraw") path = "input/redraw.png";
      if (target === "transform") {
        const manifest = store.manifest;
        if (!manifest.ink) throw new Error("Missing source");
        manifest.ink.redraw.transform.translateX++;
        await writeFile(store.path("run.json"), JSON.stringify(manifest));
      } else if (target === "symlink") {
        await copyFile(store.path(path), store.path("input/linked-copy.json"));
        await rm(store.path(path));
        await symlink(store.path("input/linked-copy.json"), store.path(path));
      } else if (target === "missing") {
        await rm(store.path(path));
      } else await appendFile(store.path(path), " ");
      const before = await readFile(store.path("session/events.jsonl"));
      await expect(store.finalize(3)).rejects.toMatchObject({
        kind: "filesystem",
      });
      await expect(
        RunStore.open(store.directory, { mode: "recover" }),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await readFile(store.path("session/events.jsonl"))).toEqual(
        before,
      );
      if (target === "missing")
        await expect(store.saveInkAsset(composition)).rejects.toMatchObject({
          kind: "filesystem",
        });
    },
  );

  test("new metadata creates a new revision while old assets and unreferenced changes preserve review", async () => {
    const { store, composition, first, revision, document } = await reviewed();
    const changed = createInkFragment(document, {
      strokeIndices: first.strokeIndices,
      presentation: { ...first.presentation, transcription: "改" },
    });
    await store.saveInkAsset(changed);
    expect(store.manifest.reviewedRevision?.number).toBe(1);
    const next = await store.commit(
      { ...simpleDraft(), markdown: `![字](../assets/ink/${changed.id}.svg)` },
      { kind: "revise", step: 3, width: 700 },
    );
    if (!next.dependenciesSha256 || !revision.dependenciesSha256)
      throw new Error("Missing dependency digest");
    expect(next.dependenciesSha256).not.toBe(revision.dependenciesSha256);
    expect(store.manifest.reviewedRevision).toBeUndefined();
    expect((await store.readRevision(1))?.assets).toEqual(revision.assets);
    expect((await loadInkAsset(store, composition.id)).asset).toEqual(
      composition,
    );
    await expect(store.finalize(4)).rejects.toMatchObject({
      code: "not_ready",
    });
    await store.review(4, async () => {});
    await store.finalize(5);
    const reopened = await RunStore.open(store.directory);
    expect(reopened.manifest.final?.dependenciesSha256).toBe(
      next.dependenciesSha256,
    );
    const events = readSession(store.path("session/events.jsonl")).events;
    for (const type of [
      "document.revision.committed",
      "render.reviewed",
      "note.finalized",
    ]) {
      const event = events.filter((entry) => entry.type === type).at(-1);
      expect(event?.data).toMatchObject({
        dependenciesSha256: next.dependenciesSha256,
      });
    }
  });

  test.each([
    "missing",
    "extra",
    "digest",
    "commit-event",
    "review-event",
    "finalize-event",
  ])("rejects %s dependency evidence", async (change) => {
    const { store, document } = await reviewed();
    if (change === "finalize-event") await store.finalize(3);
    const manifest = store.manifest;
    const current = manifest.revisions[0];
    if (!current) throw new Error("Missing revision");
    if (change === "missing")
      current.assets = current.assets.filter(
        (asset) => !asset.path.endsWith(".json"),
      );
    if (change === "extra") {
      const extra = createInkFragment(document, {
        strokeIndices: [2],
        presentation: { kind: "text", referenceHeight: 22 },
      });
      const saved = await store.saveInkAsset(extra);
      current.assets.push(
        ...saved.artifacts.filter((asset) => !asset.path.startsWith("input/")),
      );
    }
    if (change === "digest") {
      current.dependenciesSha256 = "0".repeat(64);
      if (manifest.reviewedRevision)
        manifest.reviewedRevision.dependenciesSha256 =
          current.dependenciesSha256;
    }
    if (change.endsWith("-event")) {
      const events = readSession(store.path("session/events.jsonl")).events;
      const eventType =
        change === "commit-event"
          ? "document.revision.committed"
          : change === "review-event"
            ? "render.reviewed"
            : "note.finalized";
      const event = events.find((event) => event.type === eventType);
      if (!event) throw new Error("Missing event");
      (event.data as { dependenciesSha256: string }).dependenciesSha256 =
        "0".repeat(64);
      await writeFile(
        store.path("session/events.jsonl"),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
    }
    await writeFile(store.path("run.json"), JSON.stringify(manifest));
    await expect(RunStore.open(store.directory)).rejects.toMatchObject({
      kind: "filesystem",
    });
  });

  test("rejects cross-source, duplicate source strokes, and escaping resources without losing the reviewed revision", async () => {
    const { store, first, composition } = await reviewed();
    const other = createInkFragment(parseInkJson(sourceBytes(1)), {
      strokeIndices: [0],
      presentation: first.presentation,
    });
    await expect(store.saveInkAsset(other)).rejects.toThrow();
    await writeFile(
      store.path(`assets/ink/${other.id}.json`),
      inkAssetJson(other),
    );
    await writeFile(
      store.path(`assets/ink/${other.id}.svg`),
      renderInkAsset(parseInkJson(sourceBytes(1)), other),
    );
    await expect(
      store.commit(
        { ...simpleDraft(), markdown: `![](../assets/ink/${other.id}.svg)` },
        { kind: "revise", step: 3, width: 700 },
      ),
    ).rejects.toMatchObject({ kind: "filesystem" });
    const duplicate = {
      ...simpleDraft(),
      markdown: `![](../assets/ink/${first.id}.svg) ![](../assets/ink/${composition.id}.svg)`,
    };
    await expect(
      store.commit(duplicate, { kind: "revise", step: 3, width: 700 }),
    ).rejects.toMatchObject({ issues: [{ code: "ink_source_overlap" }] });
    for (const path of [
      "../assets/ink/../../input/redraw.svg",
      "file:///etc/passwd",
      "../input/redraw.svg",
    ]) {
      await expect(
        store.commit(
          { ...simpleDraft(), markdown: `![](${path})` },
          { kind: "revise", step: 3, width: 700 },
        ),
      ).rejects.toThrow();
    }
    expect(store.manifest.currentRevision).toBe(1);
    expect(store.manifest.reviewedRevision?.number).toBe(1);
    await store.finalize(3);
  });

  test("a v2 note without SVG commits blocking feedback and cannot finalize", async () => {
    const { store } = await setup();
    const revision = await store.commit(simpleDraft(), {
      kind: "write",
      step: 1,
      width: 700,
    });
    expect(revision.warnings).toContainEqual({
      code: "ink_missing",
      message: "An ink note must include at least one source ink asset",
      blocking: true,
    });
    const ink = store.manifest.ink;
    if (!ink) throw new Error("Missing source");
    expect(revision.assets).toEqual([
      ink.points,
      ink.redraw.image,
      ink.redraw.svg,
    ]);
    await store.review(2, async () => {});
    await expect(store.finalize(3)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("dependency digest rejects conflicting hashes for the same path", () => {
    expect(() =>
      dependenciesSha256([
        { path: "input/points.json", sha256: "0".repeat(64) },
        { path: "input/points.json", sha256: "1".repeat(64) },
      ]),
    ).toThrow("Conflicting ink dependency");
  });

  test("v1 read and recovery preserve version 1 and reject ink additions", async () => {
    const store = await createStoreFixture(await directory());
    const revision = await store.commit(simpleDraft(), {
      kind: "write",
      step: 1,
      width: 700,
    });
    const before = await readFile(store.path("run.json"));
    await RunStore.open(store.directory);
    expect(await readFile(store.path("run.json"))).toEqual(before);
    const recovered = await RunStore.open(store.directory, { mode: "recover" });
    expect(recovered.manifest.formatVersion).toBe(1);
    expect(recovered.manifest.ink).toBeUndefined();
    expect(recovered.manifest.revisions[0]).toEqual(revision);
    const manifest = recovered.manifest;
    if (!manifest.revisions[0]) throw new Error("Missing revision");
    manifest.revisions[0].dependenciesSha256 = "0".repeat(64);
    await writeFile(store.path("run.json"), JSON.stringify(manifest));
    await expect(RunStore.open(store.directory)).rejects.toMatchObject({
      kind: "filesystem",
    });
    await expect(
      compileNoteMarkdown("![](../assets/ink/a.svg)", {
        runDirectory: store.directory,
      }),
    ).rejects.toThrow();
  });
});

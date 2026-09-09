import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { MockLanguageModelV3 } from "ai/test";
import { chromium } from "playwright";
import { runAgent } from "../../src/agent/index.ts";
import {
  composeInkAssets,
  createInkFragment,
  parseInkJson,
} from "../../src/ink/index.ts";
import { readSession } from "../../src/run/session.ts";
import { RunStore } from "../../src/run/store.ts";
import { createHandnoteHandlers } from "../../src/tools/index.ts";
import { createStoreFixture, simpleDraft } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup(wide = false) {
  const bytes = Buffer.from(
    JSON.stringify(
      [0, 1, 2].map((index) => ({
        brush_style: "pen",
        pen_width: 2,
        pen_color: -16777216,
        points: [
          { x: index * 30, y: 0, time: 0 },
          { x: index * 30 + (wide ? 400 : 10), y: 20, time: 1 },
        ],
      })),
    ),
  );
  const directory = await mkdtemp(`${tmpdir()}/handnote-ink-loop-`);
  directories.push(directory);
  const store = await RunStore.create(directory, {
    inputExtension: ".png",
    inkSourceBytes: bytes,
  });
  await store.copyInput(store.path("input/redraw.png"));
  const sourcePath = store.path(store.manifest.input.path);
  const handlers = createHandnoteHandlers({
    store,
    recorder: store.recorder,
    sourcePath,
    width: 720,
    maxInspectCalls: 3,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  });
  return { store, handlers, sourcePath, document: parseInkJson(bytes) };
}
const audit = {
  corrections: [],
  uncertainties: [],
  ink: {
    status: "pending-human-review" as const,
    omissions: [],
    electronicText: [],
    uncertainties: [],
  },
};
const execution = (step: number) => ({ step, remainingSteps: 50 - step });

test("v1 review keeps its original single-view model summary", async () => {
  const directory = await mkdtemp(`${tmpdir()}/handnote-v1-review-`);
  directories.push(directory);
  const store = await createStoreFixture(directory);
  const handlers = createHandnoteHandlers({
    store,
    recorder: store.recorder,
    sourcePath: store.path(store.manifest.input.path),
    width: 720,
    maxInspectCalls: 3,
    toolMedia: { maxEdge: 2048, jpegQuality: 85 },
  });
  expect((await handlers.write_note(simpleDraft(), execution(1))).ok).toBe(
    true,
  );
  const review = await handlers.review_render({}, execution(2));
  if (!review.ok) throw new Error("Missing review");
  expect(review.paths).toBeUndefined();
  const media = await handlers.prepareModelMedia("review_render", review);
  if (media.kind !== "previews") throw new Error("Missing review media");
  expect(media.previews).toHaveLength(1);
  expect(media.summary).toBe(
    "Review revision 1; no blocking layout warnings; 48 model step(s) remain after this one. If source comparison finds no content issue, call finalize_note in the next model step without another revision.",
  );
}, 30000);

test.each(["review.json", "360", "360/note.png"])(
  "ink review rejects linked output targets before authorizing review: %s",
  async (target) => {
    const { store, handlers, document } = await setup();
    const asset = createInkFragment(document, {
      strokeIndices: [0],
      presentation: { kind: "text", referenceHeight: 22 },
    });
    await store.saveInkAsset(asset);
    await handlers.write_note(
      { markdown: `![字](../assets/ink/${asset.id}.svg)`, audit },
      execution(1),
    );
    const outside = await mkdtemp(`${tmpdir()}/handnote-review-outside-`);
    directories.push(outside);
    const sentinel = `${outside}/sentinel`;
    await writeFile(sentinel, "untouched");
    const base = store.path("session/ink-reviews/revision-1/step-2");
    await mkdir(`${base}/360`, { recursive: true });
    if (target === "360") await rm(`${base}/360`, { recursive: true });
    await symlink(target === "360" ? outside : sentinel, `${base}/${target}`);
    await expect(
      handlers.review_render({}, execution(2)),
    ).rejects.toMatchObject({ kind: "filesystem" });
    expect(store.manifest.reviewedRevision).toBeUndefined();
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  },
  30000,
);

test("offline model sees real media and rendered table counts before and after repairing a missing GFM separator", async () => {
  const { store, handlers, sourcePath, document } = await setup();
  const presentation = { kind: "text" as const, referenceHeight: 22 };
  const fragments = [0, 1, 2].map((index) =>
    createInkFragment(document, { strokeIndices: [index], presentation }),
  );
  const parts = fragments.slice(0, 2).map((asset, index) => ({
    assetId: asset.id,
    rotation: 0,
    scale: 1,
    x: index * 15,
    y: 0,
  }));
  const composed = composeInkAssets(
    document,
    { parts, presentation },
    new Map(fragments.map((asset) => [asset.id, asset])),
  );
  const tableHeader = `| ![字](../assets/ink/${composed.id}.svg) |`;
  const script = [
    {
      name: "inspect_ink",
      input: {
        views: [
          { kind: "page" },
          { kind: "region", region: { x: 0, y: 0, width: 0.5, height: 1 } },
        ],
      },
    },
    {
      name: "select_ink",
      input: {
        selections: fragments.map((asset) => ({
          strokeIndices: asset.strokeIndices,
          presentation,
        })),
      },
    },
    { name: "compose_ink", input: { compositions: [{ parts, presentation }] } },
    {
      name: "write_note",
      input: {
        markdown: `${tableHeader}\n| |`,
        audit,
      },
    },
    { name: "review_render", input: {} },
    {
      name: "revise_note",
      input: {
        markdown: `${tableHeader}\n| --- |\n| ![补全](../assets/ink/${fragments[2]?.id}.svg) |`,
        audit,
      },
    },
    { name: "review_render", input: {} },
    { name: "finalize_note", input: {} },
  ];
  let call = 0;
  const model = new MockLanguageModelV3({
    modelId: "offline",
    doGenerate: async () => {
      const item = script[call++];
      if (!item) throw new Error("Unexpected extra call");
      if (call === 6) expect(store.manifest.reviewedRevision?.number).toBe(1);
      if (call === 7) expect(store.manifest.reviewedRevision).toBeUndefined();
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${call}`,
            toolName: item.name,
            input: JSON.stringify(item.input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const result = await runAgent({
    config: {
      model: {
        provider: "openai-compatible",
        baseUrl: "https://offline.invalid/v1",
        apiKey: "offline",
        name: "offline",
        timeoutMs: 1000,
        maxRetries: 0,
      },
      maxSteps: 10,
      maxInspectCalls: 3,
    },
    handlers,
    model: model as unknown as NonNullable<
      Parameters<typeof runAgent>[0]["model"]
    >,
    source: { data: await readFile(sourcePath), mimeType: "image/png" },
    onModelEvent: async (event) => {
      store.recorder.record(event.type, event.data);
    },
    onDiagnostic: () => undefined,
  });
  expect(result.steps).toBe(8);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [index, tables] of [0, 1].entries()) {
      const revision = store.manifest.revisions[index];
      if (!revision) throw new Error("Missing rendered revision");
      expect(revision.structure.tables).toBe(tables);
      await page.goto(`file://${store.path(revision.html.path)}`);
      expect(await page.locator("table").count()).toBe(tables);
      const modelReview = JSON.stringify(
        model.doGenerateCalls[index === 0 ? 5 : 7]?.prompt
          .filter((message) => message.role === "tool")
          .at(-1),
        (key, value) => (key === "data" ? "[media]" : value),
      );
      expect(modelReview).toContain("Rendered structure:");
      expect(modelReview).toContain(`tables=${tables}`);
      expect(modelReview).toContain('"type":"image-data"');
    }
  } finally {
    await browser.close();
  }
  expect(store.manifest.final?.revision).toBe(2);
  expect(store.manifest.final?.dependenciesSha256).toBe(
    store.manifest.revisions[1]?.dependenciesSha256 ?? "missing digest",
  );
  const seen = JSON.stringify(model.doGenerateCalls[7]?.prompt);
  expect(seen).toContain('"type":"image-data"');
  expect(seen).toContain(composed.id);
  expect(seen).toContain("pending-human-review");
  expect(seen).toContain("360×");
  const firstReview = JSON.stringify(
    model.doGenerateCalls[5]?.prompt.filter(
      (message) => message.role === "tool",
    ),
    (key, value) => (key === "data" ? "[media]" : value),
  );
  expect(firstReview).toContain(
    "Ink source coverage: 2/3 used; unusedStrokeIndices=[2]",
  );
  expect(firstReview).toContain(
    "Check every unused stroke against the source image",
  );
  expect(firstReview).toContain(
    "accurately record why it is omitted in the ink audit",
  );
  expect(firstReview).toContain("using every stroke is not required");
  expect(seen).toContain(
    "Ink source coverage: 3/3 used; unusedStrokeIndices=[]",
  );
  const events = readSession(store.path("session/events.jsonl")).events;
  const last = events
    .filter((event) => event.type === "document.revision.committed")
    .at(-1);
  expect(last?.data).toMatchObject({
    inkUsage: {
      usedStrokeIndices: [0, 1, 2],
      unusedStrokeIndices: [],
      repeatedStrokeIndices: [],
    },
    audit: { ink: { status: "pending-human-review" } },
  });
  const media = events.filter(
    (event) => event.type === "tool.model_media.prepared",
  );
  expect(media.length).toBeGreaterThanOrEqual(11);
  expect(JSON.stringify(media)).toContain("session/model-previews/");
  const measurements = events.filter(
    (event) => event.type === "tool.model_output.prepared",
  );
  expect(measurements.length).toBeGreaterThan(0);
  for (const measurement of measurements) {
    const data = measurement.data as {
      textChars: number;
      imageCount: number;
      imagePixels: number;
    };
    expect(data.textChars).toBeGreaterThan(0);
    expect(data.imageCount).toBeGreaterThan(0);
    expect(data.imagePixels).toBeGreaterThan(0);
  }
  await RunStore.open(store.directory);
}, 60000);

test("360 overflow returns actual previews and asset ID without authorizing finalization", async () => {
  const { store, handlers, document } = await setup(true);
  const asset = createInkFragment(document, {
    strokeIndices: [0],
    presentation: { kind: "text", referenceHeight: 22 },
  });
  await store.saveInkAsset(asset);
  const written = await handlers.write_note(
    { markdown: `![字](../assets/ink/${asset.id}.svg)`, audit },
    execution(1),
  );
  expect(written.ok).toBe(true);
  expect(
    store.manifest.revisions[0]?.warnings.filter((warning) => warning.blocking),
  ).toEqual([]);
  await store.review(2, async () => {});
  expect(store.manifest.reviewedRevision?.number).toBe(1);
  const review = await handlers.review_render({}, execution(3));
  expect(review).toMatchObject({
    ok: true,
    reviewed: false,
    warnings: expect.arrayContaining([
      expect.objectContaining({
        code: "ink_asset_too_wide",
        assetId: asset.id,
      }),
    ]),
  });
  if (!review.ok) throw new Error("Missing preview");
  expect(review.paths).toHaveLength(4);
  expect(review.summary).toContain(asset.id);
  expect(review.summary).toContain(
    "Ink source coverage: 1/3 used; unusedStrokeIndices=[1,2]",
  );
  expect((await handlers.prepareModelMedia("review_render", review)).kind).toBe(
    "previews",
  );
  expect(store.manifest.reviewedRevision).toBeUndefined();
  expect(await handlers.finalize_note({}, execution(4))).toMatchObject({
    ok: false,
    error: { code: "not_ready" },
  });
}, 30000);

test("ink audits reject missing declarations and invalid or used omission IDs without replacing a revision", async () => {
  const { store, handlers, document } = await setup();
  const asset = createInkFragment(document, {
    strokeIndices: [0],
    presentation: { kind: "text", referenceHeight: 22 },
  });
  await store.saveInkAsset(asset);
  const markdown = `![字](../assets/ink/${asset.id}.svg)`;
  expect(
    await handlers.write_note(
      { markdown, audit: { corrections: [], uncertainties: [] } },
      execution(1),
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid_ink_audit" } });
  expect(
    (await handlers.write_note({ markdown, audit }, execution(1))).ok,
  ).toBe(true);
  for (const index of [0, 99]) {
    expect(
      await handlers.revise_note(
        {
          markdown,
          audit: {
            ...audit,
            ink: {
              ...audit.ink,
              omissions: [{ strokeIndices: [index], reason: "excluded" }],
            },
          },
        },
        execution(2),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_ink_audit" } });
    expect(store.manifest.currentRevision).toBe(1);
  }
}, 30000);

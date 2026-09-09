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
import { runAgent } from "@handnote/agent";
import {
  composeInkAssets,
  createInkFragment,
  parseInkJson,
} from "@handnote/ink";
import { MockLanguageModelV3 } from "ai/test";
import { readSession } from "../src/session.ts";
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

test("offline model sees real media through inspect, select, compose, write, review, revise, review and finalize", async () => {
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
  const markdown = `# ![字](../assets/ink/${composed.id}.svg)`;
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
        markdown,
        audit: {
          ...audit,
          ink: {
            ...audit.ink,
            omissions: [
              { strokeIndices: [2], reason: "Awaiting source comparison" },
            ],
          },
        },
      },
    },
    { name: "review_render", input: {} },
    {
      name: "revise_note",
      input: {
        markdown: `${markdown}\n\n![补全](../assets/ink/${fragments[2]?.id}.svg)`,
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
      promptText: "Use tools.",
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
  expect(store.manifest.final?.revision).toBe(2);
  expect(store.manifest.final?.dependenciesSha256).toBe(
    store.manifest.revisions[1]?.dependenciesSha256 ?? "missing digest",
  );
  const seen = JSON.stringify(model.doGenerateCalls[7]?.prompt);
  expect(seen).toContain('"type":"image-data"');
  expect(seen).toContain(composed.id);
  expect(seen).toContain("pending-human-review");
  expect(seen).toContain("360×");
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

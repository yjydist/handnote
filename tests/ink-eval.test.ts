import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInkFragment, parseInkJson } from "@handnote/ink";
import { MockLanguageModelV3 } from "ai/test";
import { RunStore } from "../apps/handnote/src/store.ts";
import { sha256File } from "../apps/handnote/src/utils.ts";
import {
  collectContextMetrics,
  collectFullPageEvidence,
  fullPageSources,
  runFullPageExperiment,
  selectFullPages,
} from "../scripts/ink-eval.ts";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(`${tmpdir()}/handnote-full-page-`);
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

test("experiment sources contain only pinned development inputs and reject holdouts or duplicate pages", () => {
  expect(fullPageSources.map((source) => source.page)).toEqual([
    "2",
    "69",
    "70",
  ]);
  expect(
    fullPageSources.every(
      (source) =>
        Object.keys(source).sort().join() === "page,pointsSha256,stem",
    ),
  ).toBe(true);
  expect(selectFullPages(["70", "2"]).map((source) => source.page)).toEqual([
    "70",
    "2",
  ]);
  for (const pages of [[], ["2", "2"], ["3"], ["71"]])
    expect(() => selectFullPages(pages)).toThrow();
});

test("a stopped offline experiment keeps source, usage and failure evidence without claiming acceptance or overwriting", async () => {
  const directory = await temporary();
  const output = `${directory}/experiment`;
  const prompt = `${directory}/prompt.md`;
  await writeFile(prompt, "Use the tools.");
  const configPath = `${directory}/config.yaml`;
  await writeFile(
    configPath,
    `model:\n  provider: openai-compatible\n  baseUrl: https://offline.invalid/v1\n  apiKey: offline-experiment-secret\n  name: offline\nprompt:\n  file: ${prompt}\nmaxSteps: 3\n`,
  );
  const model = new MockLanguageModelV3({
    modelId: "offline",
    doGenerate: async () => ({
      content: [{ type: "text", text: "Stopped before a valid revision" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const report = await runFullPageExperiment({
    configPath,
    outputDirectory: output,
    pages: ["2"],
    model: model as unknown as NonNullable<
      Parameters<typeof runFullPageExperiment>[0]["model"]
    >,
  });
  expect(report.maxSteps).toBe(50);
  expect(report.results[0]).toMatchObject({
    page: "2",
    status: "failed",
    acceptance: "not-assessed",
    judgment: "pending-human-review",
  });
  const result = report.results[0];
  if (!result?.runDirectory || !("evidence" in result))
    throw new Error("Missing retained failed run");
  const evidence = JSON.parse(
    await readFile(resolve(output, result.evidence), "utf8"),
  );
  expect(evidence.views).toEqual([]);
  expect(evidence.materials).toEqual([]);
  expect(evidence.model.usage).toMatchObject({
    inputTokens: 10,
    outputTokens: 5,
  });
  const run = await RunStore.open(resolve(output, result.runDirectory));
  expect(await sha256File(run.path("input/points.json"))).toBe(
    fullPageSources[0].pointsSha256,
  );
  const index = await readFile(`${output}/results.json`, "utf8");
  expect(index).not.toContain("offline-experiment-secret");
  await expect(
    runFullPageExperiment({
      configPath,
      outputDirectory: output,
      pages: ["2"],
    }),
  ).rejects.toThrow("EEXIST");
  expect(await readFile(`${output}/results.json`, "utf8")).toBe(index);
}, 30000);

test("evidence export renders all widths from the last valid revision and records the full material graph", async () => {
  const directory = await temporary();
  const points = Buffer.from(
    JSON.stringify([
      {
        brush_style: "pen",
        pen_width: 2,
        pen_color: -16777216,
        points: [
          { x: 0, y: 0, time: 0 },
          { x: 10, y: 20, time: 1 },
        ],
      },
    ]),
  );
  const store = await RunStore.create(directory, {
    inputExtension: ".png",
    inkSourceBytes: points,
  });
  await store.copyInput(store.path("input/redraw.png"));
  const asset = createInkFragment(parseInkJson(points), {
    strokeIndices: [0],
    presentation: { kind: "text", referenceHeight: 22 },
  });
  await store.saveInkAsset(asset);
  await store.commit(
    {
      markdown: `![字](../assets/ink/${asset.id}.svg)`,
      audit: { corrections: [], uncertainties: [] },
    },
    { kind: "write", step: 1, width: 1200 },
  );
  const manifest = await store.finish("model_stopped");
  const evidence = await collectFullPageEvidence({
    manifest,
    runDirectory: directory,
    manifestPath: store.path("run.json"),
    exitCode: 2,
  });
  expect(evidence.runStatus).toBe("partial");
  expect(evidence.acceptance).toBe("not-assessed");
  expect(evidence.views.map((view) => view.width)).toEqual([
    360, 720, 1200, 1600,
  ]);
  for (const view of evidence.views) {
    if (!view.image || !view.warnings) throw new Error("Missing width render");
    expect(await sha256File(store.path(view.image.path))).toBe(
      view.image.sha256,
    );
    expect(view.warnings.filter((warning) => warning.blocking)).toEqual([]);
  }
  expect(evidence.materialArtifacts).toHaveLength(5);
  expect(evidence.materials).toEqual([asset]);
  expect((await RunStore.open(directory)).manifest.status).toBe("partial");
}, 30000);

test("context metrics preserve available attempt and model-output measurements", () => {
  const event = (type: string, data: unknown, seq: number) => ({
    type,
    data,
    seq,
    time: "2026-09-09",
  });
  expect(
    collectContextMetrics([
      event("model.attempt.started", { step: 1, attempt: 1 }, 1),
      event(
        "model.attempt.started",
        {
          step: 2,
          attempt: 1,
          request: { bytes: 42, imageCount: 3, textChars: 12 },
        },
        2,
      ),
      event(
        "tool.model_output.prepared",
        {
          purpose: "select_ink",
          textChars: 50,
          imageCount: 2,
          imagePixels: 200,
        },
        3,
      ),
    ]),
  ).toEqual({
    requests: [
      { step: 2, attempt: 1, bytes: 42, imageCount: 3, textChars: 12 },
    ],
    toolOutputs: [
      { purpose: "select_ink", textChars: 50, imageCount: 2, imagePixels: 200 },
    ],
  });
});

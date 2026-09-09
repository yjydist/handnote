import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";
import { AgentError } from "../../src/agent/index.ts";
import type { HandnoteConfig } from "../../src/config.ts";
import {
  createInkFragment,
  parseInkJson,
  renderInkSvg,
} from "../../src/ink/index.ts";
import { loadPrompt } from "../../src/prompt/index.ts";
import {
  executePreparedRun,
  type PreparedRunOptions,
  validateInput,
} from "../../src/run/run.ts";
import { readSession } from "../../src/run/session.ts";
import { RunStore } from "../../src/run/store.ts";
import { sha256 } from "../../src/run/utils.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each(["complete", "partial", "failed"] as const)(
  "prepared ink lifecycle preserves %s artifacts and accounting",
  async (outcome) => {
    const directory = await mkdtemp(`${tmpdir()}/handnote-prepared-run-`);
    directories.push(directory);
    const inkSourceBytes = Buffer.from(
      `${JSON.stringify(
        [
          {
            brush_style: "pen",
            pen_width: 2,
            pen_color: -16777216,
            points: [
              { x: -4, y: 0, time: 0 },
              { x: 12, y: 20, time: 1 },
            ],
          },
        ],
        null,
        2,
      )}\n`,
    );
    const document = parseInkJson(inkSourceBytes);
    const redraw = renderInkSvg(document, { background: "white" });
    const source = `${directory}/page.png`;
    await sharp(Buffer.from(redraw.svg)).png().toFile(source);
    const config: HandnoteConfig = {
      model: {
        provider: "openai-compatible",
        baseUrl: "https://offline.invalid/v1",
        apiKey: "sk-prepared-run-secret",
        name: "offline",
        timeoutMs: 1000,
        maxRetries: 0,
      },
      configPath: `${directory}/prepared.yaml`,
      maxSteps: 8,
      maxInspectCalls: 3,
      toolMedia: { maxEdge: 2048, jpegQuality: 85 },
      saveIntermediateImages: true,
    };
    const presentation = { kind: "text" as const, referenceHeight: 22 };
    const asset = createInkFragment(document, {
      strokeIndices: [0],
      presentation,
    });
    const markdown = `![笔迹](../assets/ink/${asset.id}.svg)`;
    const script = [
      { name: "inspect_ink", input: { views: [{ kind: "page" }] } },
      {
        name: "select_ink",
        input: { selections: [{ strokeIndices: [0], presentation }] },
      },
      {
        name: "write_note",
        input: {
          markdown,
          audit: {
            corrections: [],
            uncertainties: [],
            ink: {
              status: "pending-human-review",
              omissions: [],
              electronicText: [],
              uncertainties: [],
            },
          },
        },
      },
      { name: "review_render", input: {} },
      { name: "finalize_note", input: {} },
    ];
    let calls = 0;
    const completedSteps =
      outcome === "complete" ? 5 : outcome === "partial" ? 3 : 2;
    const model = new MockLanguageModelV3({
      modelId: "offline",
      doGenerate: async () => {
        if (outcome !== "complete" && calls === completedSteps)
          throw new AgentError(
            "Injected prepared lifecycle failure",
            "provider_transient",
            true,
          );
        const step = script[calls++];
        if (!step) throw new Error("Unexpected model continuation");
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `prepared-${calls}`,
              toolName: step.name,
              input: JSON.stringify(step.input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: {
              total: 10,
              noCache: 10,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const result = await executePreparedRun({
      input: await validateInput(source),
      config,
      outputRoot: `${directory}/runs`,
      startedAt,
      inkSourceBytes,
      model: model as unknown as NonNullable<PreparedRunOptions["model"]>,
    });
    expect(result.manifest).toMatchObject({
      formatVersion: 2,
      status: outcome,
      startedAt,
      model: {
        usage: {
          inputTokens: completedSteps * 10,
          outputTokens: completedSteps * 5,
          totalTokens: completedSteps * 15,
        },
      },
      ink: {
        points: { sha256: sha256(inkSourceBytes) },
        originalRelation: "unknown",
      },
    });
    expect(result.manifest.durationMs).toBeGreaterThanOrEqual(1000);
    expect(result.exitCode).toBe(
      outcome === "complete" ? 0 : outcome === "partial" ? 2 : 1,
    );
    const stored = await RunStore.open(result.runDirectory);
    expect(await readFile(stored.path("input/points.json"))).toEqual(
      inkSourceBytes,
    );
    expect(await readFile(stored.path("input/original.png"))).toEqual(
      await readFile(source),
    );
    expect(existsSync(stored.path(`assets/ink/${asset.id}.json`))).toBe(true);
    expect(existsSync(stored.path(`assets/ink/${asset.id}.svg`))).toBe(true);
    expect(
      (await readdir(stored.path("intermediate/inspections/ink"))).length,
    ).toBeGreaterThan(0);
    expect(
      (await readdir(stored.path("session/model-previews"))).length,
    ).toBeGreaterThan(0);
    const session = await readFile(stored.path("session/events.jsonl"), "utf8");
    const prompt = await loadPrompt("ink");
    expect(session).not.toContain("PROMPT_RECORDED_BY_HASH");
    expect(session).not.toContain(JSON.stringify(prompt.text));
    expect(session).not.toContain(config.model.apiKey);
    expect(session).not.toMatch(/[A-Za-z0-9+/]{512,}={0,2}/);
    const events = readSession(stored.path("session/events.jsonl")).events;
    expect(
      events.find((event) => event.type === "model.run.started")?.data,
    ).toMatchObject({
      promptSha256: prompt.sha256,
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      data: { status: outcome },
    });
    const steps = events.filter(
      (event) => event.type === "model.step.completed",
    );
    expect(steps).toHaveLength(
      completedSteps + (outcome === "complete" ? 0 : 1),
    );
    if (outcome !== "complete")
      expect(steps.at(-1)?.data).toMatchObject({
        finishReason: "error",
        usage: {},
      });
    if (outcome === "complete") {
      expect(await readFile(stored.path("output/note.md"), "utf8")).toBe(
        markdown,
      );
      expect(
        existsSync(
          stored.path("session/ink-reviews/revision-1/step-4/review.json"),
        ),
      ).toBe(true);
      expect(result.manifest.error).toBeUndefined();
      expect(model.doGenerateCalls).toHaveLength(5);
    } else {
      expect(result.manifest).toMatchObject({
        stopReason: "provider_transient",
        error: { kind: "provider_transient" },
      });
      expect(existsSync(stored.path("output"))).toBe(false);
      expect(Boolean(await stored.readRevision())).toBe(outcome === "partial");
      if (outcome === "partial")
        expect((await stored.readRevision())?.text).toBe(markdown);
    }
  },
  30000,
);

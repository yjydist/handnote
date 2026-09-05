import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  type ContractChecks,
  type EvalAttempt,
  type EvalJob,
  type EvalReport,
  inspectEvalAttempt,
  main,
  renderEvalReport,
  shouldRetryTransientRun,
  summarizeEvalJobs,
} from "../scripts/real-eval.ts";
import type { RunManifest, RunStatus } from "../src/run.ts";
import { sha256File } from "../src/utils.ts";
import { simpleMarkdown } from "./helpers.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-eval-`);
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

const allContracts = (value: boolean): ContractChecks => ({
  artifactContract: value,
  finalizedEvent: value,
  hashesValid: value,
  schemaValid: value,
  sequenceMonotonic: value,
  sessionRedacted: value,
  warningsFree: value,
  widthExact: value,
});

function attempt(
  input: string,
  status: RunStatus,
  totalTokens: number,
): EvalAttempt {
  return {
    input,
    runId: `${input}-${status}`,
    runDirectory: `/offline/${input}-${status}`,
    status,
    stopReason: status === "complete" ? "finalized" : "provider_transient",
    durationMs: totalTokens * 10,
    steps: 2,
    retries: 0,
    usage: {
      inputTokens: totalTokens - 5,
      outputTokens: 5,
      totalTokens,
      cachedInputTokens: 2,
      uncachedInputTokens: totalTokens - 7,
      reasoningTokens: 3,
      textOutputTokens: 2,
    },
    requests: {
      attempts: 2,
      bytes: totalTokens * 100,
      maxBytes: totalTokens * 60,
      maxImages: 2,
    },
    stepDurationsMs: [10, totalTokens],
    contracts: allContracts(status === "complete"),
  };
}

describe("real evaluation aggregation", () => {
  test("retries failed and partial transient runs only", () => {
    expect(
      shouldRetryTransientRun({
        status: "failed",
        stopReason: "provider_transient",
      }),
    ).toBe(true);
    expect(
      shouldRetryTransientRun({
        status: "partial",
        stopReason: "provider_transient",
      }),
    ).toBe(true);
    expect(
      shouldRetryTransientRun({
        status: "complete",
        stopReason: "provider_transient",
      }),
    ).toBe(false);
    expect(
      shouldRetryTransientRun({
        status: "partial",
        stopReason: "provider_rejected",
      }),
    ).toBe(false);
    expect(
      shouldRetryTransientRun({
        status: "failed",
        stopReason: "authentication",
      }),
    ).toBe(false);
  });

  test("separates first-pass from eventual status and retains failed usage", () => {
    const jobs: EvalJob[] = [
      {
        id: "001#1",
        inputPath: "/data/001.jpg",
        attempts: [attempt("001.jpg", "complete", 20)],
      },
      {
        id: "006#1",
        inputPath: "/data/006.jpg",
        attempts: [
          attempt("006.jpg", "failed", 30),
          attempt("006.jpg", "complete", 40),
        ],
      },
      {
        id: "012#1",
        inputPath: "/data/012.jpg",
        attempts: [
          attempt("012.jpg", "partial", 25),
          attempt("012.jpg", "complete", 35),
        ],
      },
    ];
    const summary = summarizeEvalJobs(jobs);
    expect(summary.firstPass).toEqual({
      complete: 1,
      partial: 1,
      failed: 1,
      completeRate: 1 / 3,
    });
    expect(summary.eventual).toEqual({
      complete: 3,
      partial: 0,
      failed: 0,
      completeRate: 1,
    });
    expect(summary.runAttempts).toBe(5);
    expect(summary.usage.totalTokens).toBe(150);
    expect(summary.contracts).toMatchObject({
      completeAttempts: 3,
      schemaValid: 3,
      widthExact: 3,
    });

    const report: EvalReport = {
      generatedAt: "2026-08-23T00:00:00.000Z",
      configuration: {
        baseUrlOrigin: "https://example.test",
        model: "offline",
        timeoutMs: 240_000,
        maxRetries: 1,
        maxSteps: 12,
        maxInspectCalls: 3,
        width: 1600,
        promptSha256: "a".repeat(64),
        fingerprint: "b".repeat(64),
      },
      summary,
      jobs,
    };
    const markdown = renderEvalReport(report);
    expect(markdown).toContain("First pass: 1/3 complete (33.3%)");
    expect(markdown).toContain("Eventual: 3/3 complete (100.0%)");
    expect(markdown).not.toMatch(/apiKey|authorization|base64/i);
  });

  test("audits an offline complete run fixture", async () => {
    const directory = await temporary();
    await mkdir(`${directory}/session`);
    await mkdir(`${directory}/revisions`, { recursive: true });
    const documentPath = `${directory}/note.md`;
    const revisionPath = `${directory}/revisions/revision-001.md`;
    const imagePath = `${directory}/note.png`;
    const markdown = simpleMarkdown();
    await writeFile(documentPath, markdown);
    await writeFile(revisionPath, markdown);
    await sharp({
      create: { width: 1600, height: 400, channels: 3, background: "white" },
    })
      .png()
      .toFile(imagePath);
    const events = [
      {
        seq: 1,
        time: "2026-08-23T00:00:00.000Z",
        type: "run.started",
        data: { config: { model: { apiKey: "[REDACTED]" }, width: 1600 } },
      },
      {
        seq: 2,
        time: "2026-08-23T00:00:00.010Z",
        type: "model.attempt.started",
        data: { step: 1, request: { bytes: 100, imageCount: 1 } },
      },
      {
        seq: 3,
        time: "2026-08-23T00:00:00.030Z",
        type: "model.step.completed",
        data: { step: 1 },
      },
      {
        seq: 4,
        time: "2026-08-23T00:00:00.040Z",
        type: "note.finalized",
        data: { revision: 1 },
      },
    ];
    await writeFile(
      `${directory}/session/events.jsonl`,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const manifest: RunManifest = {
      status: "complete",
      runId: "offline-complete",
      startedAt: "2026-08-23T00:00:00.000Z",
      finishedAt: "2026-08-23T00:00:00.050Z",
      durationMs: 50,
      stopReason: "finalized",
      input: { path: "/data/001.jpg", original: "original.jpg" },
      final: {
        markdown: "note.md",
        image: "note.png",
        markdownSha256: await sha256File(documentPath),
        imageSha256: await sha256File(imagePath),
        revision: 1,
      },
      model: {
        steps: 1,
        retries: 0,
        attempts: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 8,
          uncachedInputTokens: 2,
          reasoningTokens: 3,
          textOutputTokens: 2,
        },
      },
      warnings: [],
      runDirectory: directory,
      exitCode: 0,
    };
    const inspected = await inspectEvalAttempt(manifest);
    expect(inspected.contracts).toEqual(allContracts(true));
    expect(inspected.stepDurationsMs).toEqual([20]);
    expect(inspected.requests).toEqual({
      attempts: 1,
      bytes: 100,
      maxBytes: 100,
      maxImages: 1,
    });
  });

  test("refuses to create output without explicit live confirmation", async () => {
    const directory = await temporary();
    const output = `${directory}/runs`;
    const exitCode = await main([
      "bun",
      "real-eval",
      "--config",
      `${directory}/missing.yaml`,
      "--data",
      `${directory}/missing-data`,
      "--output",
      output,
    ]);
    expect(exitCode).toBe(1);
    expect(await Bun.file(output).exists()).toBe(false);
  });
});

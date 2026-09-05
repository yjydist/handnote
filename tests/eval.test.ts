import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import type { RunStatus } from "../src/run.ts";
import { createStoreFixture, simpleMarkdown } from "./helpers.ts";

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
    sessionTrailingBytes: 0,
    contracts: allContracts(status === "complete"),
  };
}

function reportForJobs(jobs: EvalJob[]): EvalReport {
  return {
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
    summary: summarizeEvalJobs(jobs),
    jobs,
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

    const report = reportForJobs(jobs);
    const markdown = renderEvalReport(report);
    expect(markdown).toContain("First pass: 1/3 complete (33.3%)");
    expect(markdown).toContain("Eventual: 3/3 complete (100.0%)");
    expect(markdown).not.toMatch(/apiKey|authorization|base64/i);
  });

  test.each(["none", "partial", "unterminated-event"])(
    "audits a complete run with session tail: %s",
    async (tailKind) => {
      const directory = await temporary();
      const store = await createStoreFixture(directory);
      store.recorder.record("run.started", {
        config: { width: 1600, model: { apiKey: "[REDACTED]" } },
      });
      store.recorder.record("model.attempt.started", {
        step: 1,
        attempt: 1,
        request: { bytes: 100, imageCount: 1 },
      });
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      store.recorder.record("model.step.completed", { step: 1, usage });
      await store.updateModel({ steps: 1, attempts: 1, usage });
      await store.commit(
        { markdown: simpleMarkdown(), audit: {} },
        { kind: "write", step: 1, width: 1600 },
      );
      await store.review(2, async () => {});
      await store.finalize(3);
      const events = (await readFile(store.recorder.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const event of events) {
        if (event.type === "model.attempt.started")
          event.time = "2026-08-23T00:00:00.010Z";
        if (event.type === "model.step.completed")
          event.time = "2026-08-23T00:00:00.030Z";
      }
      const tail =
        tailKind === "none"
          ? ""
          : tailKind === "partial"
            ? '{"seq":'
            : JSON.stringify({
                seq: events.length + 1,
                time: "2026-08-23T00:00:00.050Z",
                type: "model.attempt.started",
                data: {
                  step: 4,
                  attempt: 1,
                  request: { bytes: 999, imageCount: 9 },
                },
              });
      await writeFile(
        store.recorder.path,
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n${tail}`,
      );
      const paths = [store.path("run.json"), store.recorder.path];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      const inspected = await inspectEvalAttempt(
        {
          manifest: store.manifest,
          runDirectory: directory,
          manifestPath: store.path("run.json"),
          exitCode: 0,
        },
        "fixture.png",
      );
      expect(inspected.input).toBe("fixture.png");
      expect(inspected.status).toBe("complete");
      expect(inspected.usage).toMatchObject(usage);
      expect(inspected.sessionTrailingBytes).toBe(Buffer.byteLength(tail));
      expect(inspected.contracts).toEqual(allContracts(true));
      expect(inspected.stepDurationsMs).toEqual([20]);
      expect(inspected.requests).toEqual({
        attempts: 1,
        bytes: 100,
        maxBytes: 100,
        maxImages: 1,
      });
      const report = reportForJobs([
        {
          id: "fixture#1",
          inputPath: "/offline/fixture.png",
          attempts: [inspected],
        },
      ]);
      expect(
        JSON.parse(JSON.stringify(report)).jobs[0].attempts[0]
          .sessionTrailingBytes,
      ).toBe(Buffer.byteLength(tail));
      expect(report.summary.eventual.complete).toBe(1);
      const markdown = renderEvalReport(report);
      if (tail)
        expect(markdown).toContain(
          `${store.manifest.runId}: incomplete session tail (${Buffer.byteLength(tail)} bytes)`,
        );
      else expect(markdown).not.toContain("## Session diagnostics");
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
        before,
      );
    },
  );

  test.each(["invalid-json", "invalid-sequence"])(
    "rejects a complete session line with %s without changing the run",
    async (damage) => {
      const store = await createStoreFixture(await temporary());
      await store.finish("model_stopped_no_revision");
      const line =
        damage === "invalid-json"
          ? '{"seq":\n'
          : `${JSON.stringify({ seq: 1, time: "2026-08-23T00:00:00.050Z", type: "duplicate", data: {} })}\n`;
      await appendFile(store.recorder.path, line);
      const paths = [store.path("run.json"), store.recorder.path];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      await expect(
        inspectEvalAttempt(
          {
            manifest: store.manifest,
            runDirectory: store.directory,
            manifestPath: store.path("run.json"),
            exitCode: 1,
          },
          "fixture.png",
        ),
      ).rejects.toMatchObject({ kind: "filesystem" });
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
        before,
      );
    },
  );

  test("audits a partial run from its revision without requiring final output", async () => {
    const directory = await temporary();
    const store = await createStoreFixture(directory);
    store.recorder.record("run.started", { config: { width: 700 } });
    await store.commit(
      { markdown: simpleMarkdown(), audit: {} },
      { kind: "write", step: 1, width: 700 },
    );
    await store.finish("model_stopped");
    const result = await inspectEvalAttempt(
      {
        manifest: store.manifest,
        runDirectory: directory,
        manifestPath: store.path("run.json"),
        exitCode: 2,
      },
      "partial.png",
    );
    expect(result.contracts).toMatchObject({
      artifactContract: true,
      hashesValid: true,
      schemaValid: true,
      widthExact: true,
      finalizedEvent: false,
    });
  });

  test("refuses to create output without explicit live confirmation", async () => {
    const directory = await temporary();
    const output = `${directory}/runs`;
    let stderr = "";
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        stderr += String(chunk);
        return true;
      },
    );
    try {
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
      expect(existsSync(output)).toBe(false);
      expect(stderr).toBe(
        "failed: Refusing live evaluation without --confirm-live\n",
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

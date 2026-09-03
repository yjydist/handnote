#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Command } from "commander";
import sharp from "sharp";
import { loadConfig } from "../src/config.ts";
import { noteDocumentSchema } from "../src/document.ts";
import { executeRun, type RunManifest, type RunStatus } from "../src/run.ts";
import { atomicWrite, sha256File } from "../src/utils.ts";

export interface ContractChecks {
  artifactContract: boolean;
  finalizedEvent: boolean;
  hashesValid: boolean;
  schemaValid: boolean;
  sequenceMonotonic: boolean;
  sessionRedacted: boolean;
  warningsFree: boolean;
  widthExact: boolean;
}

export interface RequestMetrics {
  attempts: number;
  bytes: number;
  maxBytes: number;
  maxImages: number;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  reasoningTokens: number;
  textOutputTokens: number;
}

export interface EvalAttempt {
  input: string;
  runId: string;
  runDirectory: string;
  status: RunStatus;
  stopReason: string;
  durationMs: number;
  steps: number;
  retries: number;
  usage: UsageMetrics;
  requests: RequestMetrics;
  stepDurationsMs: number[];
  contracts: ContractChecks;
}

export interface EvalJob {
  id: string;
  inputPath: string;
  attempts: EvalAttempt[];
}

interface StatusCounts {
  complete: number;
  partial: number;
  failed: number;
}

export interface EvalSummary {
  jobs: number;
  runAttempts: number;
  firstPass: StatusCounts & { completeRate: number };
  eventual: StatusCounts & { completeRate: number };
  durations: {
    count: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  requests: RequestMetrics;
  usage: UsageMetrics & { cacheHitRate: number; reasoningShare: number };
  contracts: Record<keyof ContractChecks, number> & {
    completeAttempts: number;
  };
}

export interface EvalReport {
  generatedAt: string;
  configuration: {
    baseUrlOrigin: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
    maxSteps: number;
    maxInspectCalls: number;
    width: number;
    promptSha256: string;
    fingerprint: string;
  };
  summary: EvalSummary;
  jobs: EvalJob[];
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageMetrics(usage: RunManifest["model"]["usage"]): UsageMetrics {
  return {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    totalTokens: number(usage.totalTokens),
    cachedInputTokens: number(usage.cachedInputTokens),
    uncachedInputTokens: number(usage.uncachedInputTokens),
    reasoningTokens: number(usage.reasoningTokens),
    textOutputTokens: number(usage.textOutputTokens),
  };
}

function hasUnredactedApiKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnredactedApiKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (key === "apiKey" && item !== "[REDACTED]") || hasUnredactedApiKey(item),
  );
}

export async function inspectEvalAttempt(
  manifest: RunManifest,
): Promise<EvalAttempt> {
  if (!manifest.runDirectory || !manifest.runId)
    throw new Error("Run manifest is missing its directory or id");
  const eventsPath = `${manifest.runDirectory}/session/events.jsonl`;
  const eventText = await readFile(eventsPath, "utf8");
  const events = eventText
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const starts = new Map<number, number>();
  const stepDurationsMs: number[] = [];
  const requests: RequestMetrics = {
    attempts: 0,
    bytes: 0,
    maxBytes: 0,
    maxImages: 0,
  };
  let finalizedEvent = false;
  let configuredWidth = 1600;
  for (const event of events) {
    const type = event.type;
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : {};
    if (type === "run.started") {
      const config =
        data.config && typeof data.config === "object"
          ? (data.config as Record<string, unknown>)
          : {};
      configuredWidth = number(config.width) || configuredWidth;
    }
    if (type === "model.attempt.started") {
      const step = number(data.step);
      if (!starts.has(step)) starts.set(step, Date.parse(String(event.time)));
      const request =
        data.request && typeof data.request === "object"
          ? (data.request as Record<string, unknown>)
          : {};
      const bytes = number(request.bytes);
      const images = number(request.imageCount);
      requests.attempts++;
      requests.bytes += bytes;
      requests.maxBytes = Math.max(requests.maxBytes, bytes);
      requests.maxImages = Math.max(requests.maxImages, images);
    }
    if (type === "model.step.completed") {
      const started = starts.get(number(data.step));
      const finished = Date.parse(String(event.time));
      if (started !== undefined && Number.isFinite(finished))
        stepDurationsMs.push(Math.max(0, finished - started));
    }
    if (type === "note.finalized") finalizedEvent = true;
  }

  const documentPath = `${manifest.runDirectory}/note.json`;
  const imagePath = `${manifest.runDirectory}/note.png`;
  const hasDocument = await Bun.file(documentPath).exists();
  const hasImage = await Bun.file(imagePath).exists();
  const artifactContract =
    manifest.status === "complete" || manifest.status === "partial"
      ? hasDocument && hasImage
      : !hasDocument && !hasImage;
  let schemaValid = false;
  let widthExact = false;
  let hashesValid = false;
  if (hasDocument && hasImage && manifest.final) {
    try {
      noteDocumentSchema.parse(
        JSON.parse(await readFile(documentPath, "utf8")),
      );
      schemaValid = true;
      widthExact =
        (await sharp(imagePath).metadata()).width === configuredWidth;
      hashesValid =
        (await sha256File(documentPath)) === manifest.final.documentSha256 &&
        (await sha256File(imagePath)) === manifest.final.imageSha256;
    } catch {}
  }
  const sequenceMonotonic = events.every(
    (event, index) => number(event.seq) === index + 1,
  );
  const sessionRedacted =
    !hasUnredactedApiKey(events) &&
    !/data:image\/[a-z+.-]+;base64,/i.test(eventText);
  return {
    input: basename(manifest.input.path),
    runId: manifest.runId,
    runDirectory: manifest.runDirectory,
    status: manifest.status,
    stopReason: manifest.stopReason,
    durationMs: manifest.durationMs,
    steps: manifest.model.steps,
    retries: manifest.model.retries,
    usage: usageMetrics(manifest.model.usage),
    requests,
    stepDurationsMs,
    contracts: {
      artifactContract,
      finalizedEvent,
      hashesValid,
      schemaValid,
      sequenceMonotonic,
      sessionRedacted,
      warningsFree: manifest.warnings.length === 0,
      widthExact,
    },
  };
}

function counts(statuses: RunStatus[]): StatusCounts {
  return {
    complete: statuses.filter((status) => status === "complete").length,
    partial: statuses.filter((status) => status === "partial").length,
    failed: statuses.filter((status) => status === "failed").length,
  };
}

function eventualStatus(attempts: EvalAttempt[]): RunStatus {
  if (attempts.some((attempt) => attempt.status === "complete"))
    return "complete";
  if (attempts.some((attempt) => attempt.status === "partial"))
    return "partial";
  return "failed";
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return sorted[index] ?? 0;
}

export function summarizeEvalJobs(jobs: EvalJob[]): EvalSummary {
  const attempts = jobs.flatMap((job) => job.attempts);
  const firstStatuses = jobs.map((job) => job.attempts[0]?.status ?? "failed");
  const eventualStatuses = jobs.map((job) => eventualStatus(job.attempts));
  const firstPass = counts(firstStatuses);
  const eventual = counts(eventualStatuses);
  const stepDurations = attempts.flatMap((attempt) => attempt.stepDurationsMs);
  const usage = attempts.reduce<UsageMetrics>(
    (total, attempt) => ({
      inputTokens: total.inputTokens + attempt.usage.inputTokens,
      outputTokens: total.outputTokens + attempt.usage.outputTokens,
      totalTokens: total.totalTokens + attempt.usage.totalTokens,
      cachedInputTokens:
        total.cachedInputTokens + attempt.usage.cachedInputTokens,
      uncachedInputTokens:
        total.uncachedInputTokens + attempt.usage.uncachedInputTokens,
      reasoningTokens: total.reasoningTokens + attempt.usage.reasoningTokens,
      textOutputTokens: total.textOutputTokens + attempt.usage.textOutputTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      reasoningTokens: 0,
      textOutputTokens: 0,
    },
  );
  const requests = attempts.reduce<RequestMetrics>(
    (total, attempt) => ({
      attempts: total.attempts + attempt.requests.attempts,
      bytes: total.bytes + attempt.requests.bytes,
      maxBytes: Math.max(total.maxBytes, attempt.requests.maxBytes),
      maxImages: Math.max(total.maxImages, attempt.requests.maxImages),
    }),
    { attempts: 0, bytes: 0, maxBytes: 0, maxImages: 0 },
  );
  const completeAttempts = attempts.filter(
    (attempt) => attempt.status === "complete",
  );
  const contractNames = [
    "artifactContract",
    "finalizedEvent",
    "hashesValid",
    "schemaValid",
    "sequenceMonotonic",
    "sessionRedacted",
    "warningsFree",
    "widthExact",
  ] as const;
  const contracts = Object.fromEntries(
    contractNames.map((name) => [
      name,
      completeAttempts.filter((attempt) => attempt.contracts[name]).length,
    ]),
  ) as Record<keyof ContractChecks, number>;
  return {
    jobs: jobs.length,
    runAttempts: attempts.length,
    firstPass: {
      ...firstPass,
      completeRate: jobs.length === 0 ? 0 : firstPass.complete / jobs.length,
    },
    eventual: {
      ...eventual,
      completeRate: jobs.length === 0 ? 0 : eventual.complete / jobs.length,
    },
    durations: {
      count: stepDurations.length,
      p50Ms: percentile(stepDurations, 0.5),
      p90Ms: percentile(stepDurations, 0.9),
      p95Ms: percentile(stepDurations, 0.95),
      p99Ms: percentile(stepDurations, 0.99),
      maxMs: Math.max(0, ...stepDurations),
    },
    requests,
    usage: {
      ...usage,
      cacheHitRate:
        usage.inputTokens === 0
          ? 0
          : usage.cachedInputTokens / usage.inputTokens,
      reasoningShare:
        usage.outputTokens === 0
          ? 0
          : usage.reasoningTokens / usage.outputTokens,
    },
    contracts: { ...contracts, completeAttempts: completeAttempts.length },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(value: number): string {
  return `${(value / 1_000).toFixed(1)} s`;
}

export function renderEvalReport(report: EvalReport): string {
  const { summary } = report;
  const lines = [
    "# Handnote Real-model Evaluation",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Model: \`${report.configuration.model}\``,
    `- Provider origin: \`${report.configuration.baseUrlOrigin}\``,
    `- Timeout: ${report.configuration.timeoutMs} ms`,
    `- Configuration fingerprint: \`${report.configuration.fingerprint}\``,
    "",
    "## Summary",
    "",
    `- First pass: ${summary.firstPass.complete}/${summary.jobs} complete (${percent(summary.firstPass.completeRate)}), ${summary.firstPass.partial} partial, ${summary.firstPass.failed} failed`,
    `- Eventual: ${summary.eventual.complete}/${summary.jobs} complete (${percent(summary.eventual.completeRate)}), ${summary.eventual.partial} partial, ${summary.eventual.failed} failed`,
    `- Step latency: P50 ${seconds(summary.durations.p50Ms)}, P95 ${seconds(summary.durations.p95Ms)}, P99 ${seconds(summary.durations.p99Ms)}, max ${seconds(summary.durations.maxMs)}`,
    `- Tokens: ${summary.usage.totalTokens} total; cache hit ${percent(summary.usage.cacheHitRate)}; reasoning share ${percent(summary.usage.reasoningShare)}`,
    `- Requests: ${summary.requests.attempts}; ${summary.requests.bytes} bytes total; ${summary.requests.maxBytes} max bytes; ${summary.requests.maxImages} max images`,
    "",
    "## Jobs",
    "",
    "| Job | Input | First | Final | Attempts | First duration | Final run |",
    "|---|---|---|---|---:|---:|---|",
  ];
  for (const job of report.jobs) {
    const first = job.attempts[0];
    const final = job.attempts.at(-1);
    lines.push(
      `| ${job.id} | ${basename(job.inputPath)} | ${first?.status ?? "failed"} | ${final ? eventualStatus(job.attempts) : "failed"} | ${job.attempts.length} | ${first ? seconds(first.durationMs) : "-"} | ${final?.runId ?? "-"} |`,
    );
  }
  lines.push(
    "",
    "## Complete-run contracts",
    "",
    `All counts use ${summary.contracts.completeAttempts} complete attempt(s) as the denominator.`,
    "",
  );
  for (const name of [
    "artifactContract",
    "finalizedEvent",
    "hashesValid",
    "schemaValid",
    "sequenceMonotonic",
    "sessionRedacted",
    "warningsFree",
    "widthExact",
  ] as const)
    lines.push(
      `- ${name}: ${summary.contracts[name]}/${summary.contracts.completeAttempts}`,
    );
  return `${lines.join("\n")}\n`;
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

async function collectImages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return collectImages(path);
      if (
        entry.isFile() &&
        IMAGE_EXTENSIONS.includes(
          extname(
            entry.name,
          ).toLowerCase() as (typeof IMAGE_EXTENSIONS)[number],
        )
      )
        return [path];
      return [];
    }),
  );
  return paths.flat();
}

async function selectImages(
  dataDirectory: string,
  cases: string | undefined,
): Promise<string[]> {
  const images = (await collectImages(dataDirectory)).sort();
  if (!cases) return images;
  const selected: string[] = [];
  for (const token of cases
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const matches = images.filter((path) => {
      const name = basename(path);
      const stem = basename(path, extname(path));
      return name === token || stem === token || stem.startsWith(`${token}_`);
    });
    if (matches.length !== 1)
      throw new Error(
        `Case ${token} matched ${matches.length} images; expected exactly one`,
      );
    const match = matches[0];
    if (match && !selected.includes(match)) selected.push(match);
  }
  if (selected.length === 0) throw new Error("No evaluation images selected");
  return selected;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseInteger(
  name: string,
  value: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function shouldRetryTransientRun(
  manifest: Pick<RunManifest, "status" | "stopReason">,
): boolean {
  return (
    manifest.status !== "complete" &&
    manifest.stopReason === "provider_transient"
  );
}

export async function main(argv = process.argv): Promise<number> {
  const program = new Command()
    .name("real-eval")
    .description("Run an explicitly confirmed paid Handnote evaluation suite")
    .requiredOption("--config <yaml>")
    .requiredOption("--data <directory>")
    .requiredOption("--output <directory>")
    .option("--cases <comma-separated>")
    .option("--repeat <count>", "repeat every selected image", "1")
    .option("--concurrency <count>", "maximum concurrent runs", "1")
    .option(
      "--retry-transient <count>",
      "whole-run retries after provider_transient",
      "0",
    )
    .option("--confirm-live", "confirm that paid Provider calls are allowed")
    .exitOverride();
  try {
    program.parse(argv);
    const options = program.opts<{
      config: string;
      data: string;
      output: string;
      cases?: string;
      repeat: string;
      concurrency: string;
      retryTransient: string;
      confirmLive?: boolean;
    }>();
    if (!options.confirmLive)
      throw new Error("Refusing live evaluation without --confirm-live");
    const repeat = parseInteger("repeat", options.repeat, 1, 10);
    const concurrency = parseInteger("concurrency", options.concurrency, 1, 4);
    const retryTransient = parseInteger(
      "retry-transient",
      options.retryTransient,
      0,
      3,
    );
    const configPath = resolve(options.config);
    const dataDirectory = resolve(options.data);
    const outputDirectory = resolve(options.output);
    const config = await loadConfig(configPath);
    const images = await selectImages(dataDirectory, options.cases);
    const definitions = images.flatMap((inputPath) =>
      Array.from({ length: repeat }, (_, index) => ({
        id: `${basename(inputPath, extname(inputPath))}#${index + 1}`,
        inputPath,
      })),
    );
    await mkdir(outputDirectory, { recursive: true });
    const jobs = await mapConcurrent(definitions, concurrency, async (job) => {
      const attempts: EvalAttempt[] = [];
      for (let retry = 0; retry <= retryTransient; retry++) {
        const manifest = await executeRun(
          job.inputPath,
          configPath,
          outputDirectory,
        );
        attempts.push(await inspectEvalAttempt(manifest));
        if (!shouldRetryTransientRun(manifest)) break;
      }
      return { ...job, attempts };
    });
    const safeConfiguration = {
      baseUrlOrigin: new URL(config.model.baseUrl).origin,
      model: config.model.name,
      timeoutMs: config.model.timeoutMs,
      maxRetries: config.model.maxRetries,
      maxSteps: config.maxSteps,
      maxInspectCalls: config.maxInspectCalls,
      width: config.width,
      promptSha256: createHash("sha256")
        .update(config.promptText)
        .digest("hex"),
    };
    const report: EvalReport = {
      generatedAt: new Date().toISOString(),
      configuration: {
        ...safeConfiguration,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(safeConfiguration))
          .digest("hex"),
      },
      summary: summarizeEvalJobs(jobs),
      jobs,
    };
    const jsonPath = `${outputDirectory}/eval.json`;
    const markdownPath = `${outputDirectory}/EVAL_REPORT.md`;
    await Promise.all([
      atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
      atomicWrite(markdownPath, renderEvalReport(report)),
    ]);
    process.stdout.write(
      `${JSON.stringify({ jsonPath, markdownPath, summary: report.summary })}\n`,
    );
    return report.summary.eventual.failed === 0 &&
      report.summary.eventual.partial === 0
      ? 0
      : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();

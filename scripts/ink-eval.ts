import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { loadPrompt } from "../src/prompt/index.ts";
import { safeErrorMetadata } from "../src/run/errors.ts";
import { loadInkLibrary } from "../src/run/ink-assets.ts";
import type { RunResult } from "../src/run/manifest.ts";
import { compileNoteMarkdown } from "../src/run/markdown.ts";
import { redact } from "../src/run/redact.ts";
import { renderDocument } from "../src/run/renderer.ts";
import {
  executePreparedRun,
  type PreparedRunOptions,
  validateInput,
} from "../src/run/run.ts";
import { readSession, type SessionEvent } from "../src/run/session.ts";
import { RunStore } from "../src/run/store.ts";
import { atomicWrite, sha256, sha256File } from "../src/run/utils.ts";
import { inkReviewWidths } from "../src/tools/review-render.ts";

const root = resolve(import.meta.dir, "..");
// Only source identities belong here: no historical excerpts, OCR, or fragment answers.
export const fullPageSources = [
  {
    page: "2",
    stem: "data/test_data/easy_notes/page1/2",
    pointsSha256:
      "f5634c84be85fadbb5dfce69355e81a8ac446144f33c5c644c3fe65527db1322",
  },
  {
    page: "69",
    stem: "data/test_data/easy_notes/page4/69",
    pointsSha256:
      "2a47d4cae762f273247f5b5e380657aa297c3e34716c4e1a46cd0ddb8ba2cb18",
  },
  {
    page: "70",
    stem: "data/test_data/easy_notes/page5/70",
    pointsSha256:
      "65694df81c53813c18b95231679c1b60148e9f2ac51b011e4c304bfaecc86878",
  },
] as const;

export function selectFullPages(pages: readonly string[]) {
  if (!pages.length || new Set(pages).size !== pages.length)
    throw new Error("Choose distinct development pages: 2, 69, 70");
  return pages.map((page) => {
    const source = fullPageSources.find((source) => source.page === page);
    if (!source)
      throw new Error(
        `Page ${page} is outside the development set (2, 69, 70)`,
      );
    return source;
  });
}

export function collectContextMetrics(events: readonly SessionEvent[]) {
  const requests = events
    .filter((event) => event.type === "model.attempt.started")
    .flatMap((event): Record<string, unknown>[] => {
      if (!event.data || typeof event.data !== "object") return [];
      const data = event.data as {
        step?: number;
        attempt?: number;
        request?: Record<string, unknown>;
      };
      return data.request
        ? [{ step: data.step, attempt: data.attempt, ...data.request }]
        : [];
    });
  const toolOutputs = events
    .filter((event) => event.type === "tool.model_output.prepared")
    .map((event) => event.data);
  return { requests, toolOutputs };
}

export async function collectFullPageEvidence(result: RunResult) {
  const store = await RunStore.open(result.runDirectory);
  const revision = await store.readRevision();
  const events = readSession(store.path("session/events.jsonl")).events;
  const assetIds = (
    await readdir(store.path("assets/ink")).catch((error) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })
  )
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => name.slice(0, -5));
  const library = await loadInkLibrary(store, assetIds);
  const views = [];
  const media = async (path: string, mimeType: string) => ({
    path: relative(store.directory, path),
    mimeType,
    sha256: await sha256File(path),
  });
  if (revision) {
    const note = await compileNoteMarkdown(revision.text, {
      runDirectory: store.directory,
      manifest: store.manifest,
    });
    for (const width of inkReviewWidths) {
      const destination = `experiment/renders/revision-${revision.number}/${width}`;
      try {
        store.path(`${destination}/note.html`);
        store.path(`${destination}/note.png`);
        const rendered = await renderDocument(
          note,
          store.path(destination),
          width,
        );
        views.push({
          width,
          height: rendered.height,
          image: await media(rendered.imagePath, "image/png"),
          html: await media(rendered.htmlPath, "text/html"),
          warnings: rendered.warnings,
        });
      } catch (error) {
        views.push({ width, error: safeErrorMetadata(error) });
      }
    }
  }
  const counts: Record<string, number> = {};
  for (const event of events) {
    const match = /^tool\.(\w+)\.(completed|rejected)$/.exec(event.type);
    if (match?.[1]) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  }
  const evidence = {
    judgment: "pending-human-review",
    acceptance: "not-assessed",
    runDirectory: store.directory,
    runStatus: store.manifest.status,
    stopReason: store.manifest.stopReason,
    model: store.manifest.model,
    error: store.manifest.error,
    original: store.manifest.input,
    ink: store.manifest.ink,
    revisions: store.manifest.revisions,
    final: store.manifest.final,
    toolCalls: counts,
    contextMetrics: collectContextMetrics(events),
    revisionAudit: events
      .filter((event) => event.type === "document.revision.committed")
      .at(-1)?.data,
    materials: [...library.assets.values()],
    materialArtifacts: library.artifacts,
    layoutPassed:
      views.length === inkReviewWidths.length &&
      views.every(
        (view) =>
          view.warnings && !view.warnings.some((warning) => warning.blocking),
      ),
    views,
  };
  await atomicWrite(
    store.path("experiment/evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

export async function runFullPageExperiment(options: {
  configPath: string;
  outputDirectory: string;
  pages?: readonly string[];
  model?: PreparedRunOptions["model"];
}) {
  const sources = selectFullPages(options.pages ?? ["2", "69", "70"]);
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory, { recursive: false });
  const configured = await loadConfig(options.configPath);
  const config = {
    ...configured,
    maxSteps: 50,
    maxInspectCalls: 8,
    width: 1200,
    saveIntermediateImages: true,
  };
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0)
    throw new Error("Cannot record implementation revision");
  const started = Date.now();
  const specification = {
    version: 1,
    startedAt: new Date(started).toISOString(),
    judgment: "pending-human-review",
    acceptance: "not-assessed",
    pages: sources,
    widths: inkReviewWidths,
    maxSteps: config.maxSteps,
    implementationCommit: git.stdout.toString().trim(),
    runtime: {
      bun: Bun.version,
      lockSha256: await sha256File(resolve(root, "bun.lock")),
    },
    model: { provider: config.model.provider, name: config.model.name },
    promptSha256: (await loadPrompt("ink")).sha256,
    configPath: configured.configPath,
  };
  await writeFile(
    `${outputDirectory}/experiment.json`,
    `${JSON.stringify(specification, null, 2)}\n`,
    { flag: "wx" },
  );
  const results = [];
  for (const source of sources) {
    const start = Date.now();
    process.stderr.write(
      `Starting development page ${source.page}; evidence root ${outputDirectory}\n`,
    );
    let result: RunResult | undefined;
    try {
      const points = await readFile(resolve(root, `${source.stem}.json`));
      if (sha256(points) !== source.pointsSha256)
        throw new Error(`Source identity changed for page ${source.page}`);
      const input = await validateInput(resolve(root, `${source.stem}.png`));
      result = await executePreparedRun({
        input,
        config,
        outputRoot: `${outputDirectory}/page-${source.page}`,
        inkSourceBytes: points,
        ...(options.model ? { model: options.model } : {}),
      });
      const evidence = await collectFullPageEvidence(result);
      results.push({
        page: source.page,
        runDirectory: relative(outputDirectory, result.runDirectory),
        status:
          result.manifest.status === "complete" && !evidence.layoutPassed
            ? "failed"
            : result.manifest.status,
        runStatus: result.manifest.status,
        stopReason: result.manifest.stopReason,
        elapsedMs: Date.now() - start,
        model: result.manifest.model,
        evidence: relative(
          outputDirectory,
          `${result.runDirectory}/experiment/evidence.json`,
        ),
        views: evidence.views,
        contextMetrics: evidence.contextMetrics,
        judgment: "pending-human-review",
        acceptance: "not-assessed",
      });
    } catch (error) {
      results.push({
        page: source.page,
        status: "failed",
        elapsedMs: Date.now() - start,
        ...(result
          ? {
              runDirectory: relative(outputDirectory, result.runDirectory),
              model: result.manifest.model,
            }
          : {}),
        error: redact(safeErrorMetadata(error), {
          secrets: [config.model.apiKey],
        }),
        judgment: "pending-human-review",
        acceptance: "not-assessed",
      });
    }
    await atomicWrite(
      `${outputDirectory}/results.json`,
      `${JSON.stringify({ ...specification, elapsedMs: Date.now() - started, results }, null, 2)}\n`,
    );
    process.stderr.write(
      `Page ${source.page}: ${results.at(-1)?.status}; ${Date.now() - start}ms\n`,
    );
  }
  return { ...specification, elapsedMs: Date.now() - started, results };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      output: { type: "string" },
      config: { type: "string" },
      pages: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const outputDirectory = values.output;
  if (!outputDirectory)
    throw new Error(
      "Usage: bun run eval:ink:full -- --output <new-directory> [--config config.yaml] [--pages 2,69,70]",
    );
  const result = await runFullPageExperiment({
    configPath: values.config ?? resolve(root, "config.yaml"),
    outputDirectory,
    ...(values.pages ? { pages: values.pages.split(",") } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.results.every((page) => page.status === "complete")
    ? 0
    : 2;
}

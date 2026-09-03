import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createAgentRunStats, runAgent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { asError, HandnoteError, safeErrorMetadata } from "./errors.ts";
import { displayMetadata } from "./image.ts";
import { createModel, type ProviderStats } from "./provider/index.ts";
import { SessionRecorder } from "./session.ts";
import { RunState } from "./state.ts";
import { createHandnoteTools } from "./tools/index.ts";
import {
  atomicWrite,
  createUniqueDirectory,
  isoWithOffset,
  mimeForExtension,
  sha256File,
} from "./utils.ts";

export type RunStatus = "complete" | "partial" | "failed";

export interface RunManifest {
  status: RunStatus;
  runId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: string;
  input: { path: string; sha256?: string; original?: string };
  final?: {
    document: string;
    image: string;
    documentSha256: string;
    imageSha256: string;
    revision: number;
  };
  model: {
    steps: number;
    retries: number;
    attempts: number;
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      uncachedInputTokens?: number;
      cacheHitRate?: number;
      reasoningTokens?: number;
      textOutputTokens?: number;
    };
  };
  warnings: unknown[];
  error?: { kind: string; message: string };
  runDirectory?: string;
  exitCode: 0 | 1 | 2;
}

export async function validateInput(
  input: string,
): Promise<{ path: string; extension: string; mimeType: string }> {
  const path = resolve(input);
  const extension = extname(path).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension))
    throw new HandnoteError("Input must be PNG, JPEG, or WebP", "validation");
  let metadata: Awaited<ReturnType<typeof displayMetadata>>;
  try {
    await access(path, constants.R_OK);
    metadata = await displayMetadata(path);
  } catch (error) {
    if (error instanceof HandnoteError) throw error;
    throw new HandnoteError(
      `Input is not a readable image: ${path}`,
      "validation",
      false,
      { cause: error },
    );
  }
  const expectedMimeType = mimeForExtension(extension);
  if (metadata.mimeType !== expectedMimeType)
    throw new HandnoteError(
      `Input extension ${extension} does not match decoded ${metadata.mimeType} content`,
      "validation",
    );
  return { path, extension, mimeType: metadata.mimeType };
}

async function cleanupIntermediate(
  runDirectory: string,
  recorder: SessionRecorder,
): Promise<void> {
  const directory = `${runDirectory}/intermediate`;
  const collect = async (path: string): Promise<string[]> => {
    const output: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true }).catch(
      () => [],
    )) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) output.push(...(await collect(child)));
      else output.push(child);
    }
    return output;
  };
  for (const path of await collect(directory)) {
    recorder.record(
      "media.removed",
      await recorder.media(
        path,
        path.endsWith(".html") ? "text/html" : "image/png",
        false,
      ),
    );
  }
  await rm(directory, { recursive: true, force: true });
}

function summarizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  textOutputTokens?: number;
}): RunManifest["model"]["usage"] {
  const inputTokens = usage.inputTokens;
  const cachedInputTokens = usage.cachedInputTokens;
  const uncachedInputTokens =
    inputTokens === undefined || cachedInputTokens === undefined
      ? undefined
      : Math.max(0, inputTokens - cachedInputTokens);
  const cacheHitRate =
    inputTokens && cachedInputTokens !== undefined
      ? Number((cachedInputTokens / inputTokens).toFixed(6))
      : undefined;
  return {
    ...(usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage.totalTokens !== undefined
      ? { totalTokens: usage.totalTokens }
      : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(uncachedInputTokens !== undefined ? { uncachedInputTokens } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(usage.textOutputTokens !== undefined
      ? { textOutputTokens: usage.textOutputTokens }
      : {}),
  };
}

export async function executeRun(
  inputArgument: string,
  configArgument: string,
  outputArgument: string,
): Promise<RunManifest> {
  const started = new Date();
  const input = await validateInput(inputArgument);
  const config = await loadConfig(configArgument);
  const outputRoot = resolve(outputArgument);
  let allocated: Awaited<ReturnType<typeof createUniqueDirectory>>;
  let recorder: SessionRecorder;
  try {
    await mkdir(outputRoot, { recursive: true });
    await access(outputRoot, constants.R_OK | constants.W_OK);
    allocated = await createUniqueDirectory(
      outputRoot,
      basename(input.path, input.extension),
    );
    recorder = new SessionRecorder(allocated.path, {
      secrets: [config.model.apiKey],
    });
    recorder.record("run.started", {
      runId: allocated.id,
      input: input.path,
      config: {
        ...config,
        promptText: "[PROMPT_RECORDED_BY_HASH]",
      },
    });
  } catch (error) {
    if (error instanceof HandnoteError) throw error;
    throw new HandnoteError(
      `Cannot initialize output directory: ${outputRoot}`,
      "filesystem",
      false,
      { cause: error },
    );
  }
  const stats: ProviderStats = { retries: 0, attempts: 0 };
  const agentStats = createAgentRunStats();
  const state = new RunState();
  let originalSha256: string | undefined;
  let modelSteps = 0;
  let status: RunStatus = "failed";
  let stopReason = "internal_error";
  let terminalError: HandnoteError | undefined;
  const originalPath = `${allocated.path}/original${input.extension}`;
  try {
    await copyFile(input.path, originalPath);
    originalSha256 = await sha256File(originalPath);
    if (originalSha256 !== (await sha256File(input.path)))
      throw new HandnoteError(
        "Original image copy hash mismatch",
        "filesystem",
      );
    recorder.record("input.copied", {
      path: basename(originalPath),
      sha256: originalSha256,
      mimeType: input.mimeType,
    });
    const tools = createHandnoteTools({
      sourcePath: originalPath,
      runDirectory: allocated.path,
      width: config.width,
      maxSteps: config.maxSteps,
      maxInspectCalls: config.maxInspectCalls,
      toolMedia: config.toolMedia,
      state,
      recorder,
    });
    const model = createModel({ config, recorder, state, stats });
    const result = await runAgent({
      config,
      model,
      tools,
      sourcePath: originalPath,
      sourceMimeType: input.mimeType,
      recorder,
      state,
      stats: agentStats,
    });
    modelSteps = result.steps;
    if (state.revision && state.finalizedRevision === state.revision.number) {
      status = "complete";
      stopReason = "finalized";
    } else if (state.revision) {
      status = "partial";
      stopReason =
        result.steps >= config.maxSteps ? "max_steps" : "model_stopped";
    } else {
      stopReason =
        result.steps >= config.maxSteps
          ? "max_steps_no_revision"
          : "model_stopped_no_revision";
    }
  } catch (error) {
    terminalError =
      error instanceof HandnoteError
        ? error
        : new HandnoteError(asError(error).message, "internal", false, {
            cause: error,
          });
    stopReason = terminalError.kind;
    if (state.revision) status = "partial";
    recorder.record("run.error", {
      kind: terminalError.kind,
      message: terminalError.message,
      error: safeErrorMetadata(terminalError.cause ?? terminalError),
    });
  }

  let final: RunManifest["final"];
  try {
    if ((status === "complete" || status === "partial") && state.revision) {
      const documentPath = `${allocated.path}/note.json`;
      const imagePath = `${allocated.path}/note.png`;
      await atomicWrite(
        documentPath,
        `${JSON.stringify(state.revision.document, null, 2)}\n`,
      );
      await atomicWrite(
        imagePath,
        new Uint8Array(
          await Bun.file(state.revision.render.imagePath).arrayBuffer(),
        ),
      );
      final = {
        document: "note.json",
        image: "note.png",
        documentSha256: await sha256File(documentPath),
        imageSha256: await sha256File(imagePath),
        revision: state.revision.number,
      };
      recorder.record("output.committed", final);
    }
    if (!config.saveIntermediateImages)
      await cleanupIntermediate(allocated.path, recorder);
  } catch (error) {
    terminalError = new HandnoteError(
      "Failed to commit or clean up run artifacts",
      "filesystem",
      false,
      { cause: error },
    );
    status = "failed";
    stopReason = terminalError.kind;
    final = undefined;
    await Promise.all([
      rm(`${allocated.path}/note.json`, { force: true }),
      rm(`${allocated.path}/note.png`, { force: true }),
    ]);
    recorder.record("run.error", {
      kind: terminalError.kind,
      message: terminalError.message,
      error: safeErrorMetadata(error),
    });
  }
  const finished = new Date();
  const manifest: RunManifest = {
    status,
    runId: allocated.id,
    startedAt: isoWithOffset(started),
    finishedAt: isoWithOffset(finished),
    durationMs: finished.getTime() - started.getTime(),
    stopReason,
    input: {
      path: input.path,
      ...(originalSha256 ? { sha256: originalSha256 } : {}),
      original: basename(originalPath),
    },
    ...(final ? { final } : {}),
    model: {
      steps: modelSteps || state.modelStep,
      retries: stats.retries,
      attempts: stats.attempts,
      usage: summarizeUsage(agentStats.usage),
    },
    warnings: state.revision?.render.warnings ?? [],
    ...(terminalError
      ? { error: { kind: terminalError.kind, message: terminalError.message } }
      : {}),
    runDirectory: allocated.path,
    exitCode: status === "complete" ? 0 : status === "partial" ? 2 : 1,
  };
  recorder.record("run.finished", manifest);
  await atomicWrite(
    `${allocated.path}/run.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

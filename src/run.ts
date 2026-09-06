import { constants } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import sharp from "sharp";
import { runAgent } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { asError, HandnoteError, safeErrorMetadata } from "./errors.ts";
import { displayMetadata } from "./image.ts";
import type { RunResult } from "./manifest.ts";
import { createModel } from "./provider/index.ts";
import { checkedRunPath } from "./run-path.ts";
import type { SessionRecorder } from "./session.ts";
import { RunState } from "./state.ts";
import { RunStore } from "./store.ts";
import { createHandnoteTools } from "./tools/index.ts";
import {
  createUniqueDirectory,
  isoWithOffset,
  mimeForExtension,
} from "./utils.ts";

export type { RunManifest, RunResult, RunStatus } from "./manifest.ts";

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
    // A readable header does not establish that the pixel data is complete.
    await sharp(path, { failOn: "error" }).raw().toBuffer();
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
  const directory = checkedRunPath(runDirectory, "intermediate/inspections", {
    kind: "directory",
  });
  const collect = async (path: string): Promise<string[]> => {
    const output: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    )) {
      const child = checkedRunPath(
        runDirectory,
        relative(runDirectory, `${path}/${entry.name}`),
        {
          kind: entry.isDirectory() ? "directory" : "file",
          allowMissing: false,
        },
      );
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

export async function executeRun(
  inputArgument: string,
  configArgument: string,
  outputArgument: string,
): Promise<RunResult> {
  const startedAt = isoWithOffset();
  const input = await validateInput(inputArgument);
  const config = await loadConfig(configArgument);
  let store: RunStore;
  try {
    const allocated = await createUniqueDirectory(
      resolve(outputArgument),
      basename(input.path, input.extension),
    );
    store = await RunStore.create(allocated.path, {
      inputExtension: input.extension,
      runId: allocated.id,
      startedAt,
      secrets: [config.model.apiKey],
    });
  } catch (error) {
    throw new HandnoteError(
      "Cannot initialize output directory",
      "filesystem",
      false,
      { cause: error },
    );
  }
  const recorder = store.recorder;
  const state = new RunState();
  let stopReason = "internal_error";
  let terminalError: HandnoteError | undefined;
  try {
    recorder.record("run.started", {
      runId: store.manifest.runId,
      input: input.path,
      config: { ...config, promptText: "[PROMPT_RECORDED_BY_HASH]" },
    });
    try {
      await store.copyInput(input.path);
      const sourcePath = store.path(store.manifest.input.path);
      const tools = createHandnoteTools({
        store,
        sourcePath,
        width: config.width,
        maxSteps: config.maxSteps,
        maxInspectCalls: config.maxInspectCalls,
        toolMedia: config.toolMedia,
        state,
        recorder,
      });
      const model = createModel({ config, recorder, state, store });
      const result = await runAgent({
        config,
        model,
        tools,
        sourcePath,
        sourceMimeType: input.mimeType,
        recorder,
        state,
        store,
      });
      const hasRevision = Boolean(store.manifest.currentRevision);
      stopReason =
        result.steps >= config.maxSteps
          ? hasRevision
            ? "max_steps"
            : "max_steps_no_revision"
          : hasRevision
            ? "model_stopped"
            : "model_stopped_no_revision";
    } catch (error) {
      terminalError =
        error instanceof HandnoteError
          ? error
          : new HandnoteError(asError(error).message, "internal", false, {
              cause: error,
            });
      stopReason = terminalError.kind;
      recorder.record("run.error", {
        kind: terminalError.kind,
        message: terminalError.message,
        error: safeErrorMetadata(terminalError.cause ?? terminalError),
      });
    }
    if (!config.saveIntermediateImages) {
      try {
        await cleanupIntermediate(store.directory, recorder);
      } catch (error) {
        recorder.record("cleanup.failed", { error: safeErrorMetadata(error) });
      }
    }
    await store.updateModel(state.modelAccounting);
    const manifest = await store.finish(
      stopReason,
      terminalError
        ? { kind: terminalError.kind, message: terminalError.message }
        : undefined,
    );
    return {
      manifest,
      runDirectory: store.directory,
      manifestPath: store.path("run.json"),
      exitCode:
        manifest.status === "complete"
          ? 0
          : manifest.status === "partial"
            ? 2
            : 1,
    };
  } catch (error) {
    const manifest = store.manifest;
    if (manifest.status === "complete") {
      console.error(
        "Final output is complete; post-finalization work failed",
        safeErrorMetadata(error),
      );
      return {
        manifest,
        runDirectory: store.directory,
        manifestPath: store.path("run.json"),
        exitCode: 0,
      };
    }
    throw new HandnoteError(
      "Cannot persist final run state",
      "filesystem",
      false,
      { cause: error },
    );
  }
}

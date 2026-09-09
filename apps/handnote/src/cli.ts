#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { asError, HandnoteError } from "./errors.ts";
import { executeRun, type RunResult } from "./run.ts";

export interface CliResult {
  status: "complete" | "partial" | "failed";
  exitCode: number;
  runDirectory?: string;
  runId?: string;
  manifestPath?: string;
  currentRevision?: number;
  artifacts?: { markdown: string; image: string };
  stopReason: string;
  error?: { kind: string; message: string };
}

function publicResult(result: RunResult): CliResult {
  const manifest = result.manifest;
  if (manifest.status === "running")
    throw new Error("Run returned without a terminal status");
  const current = manifest.revisions.at(-1);
  return {
    status: manifest.status,
    exitCode: result.exitCode,
    runDirectory: result.runDirectory,
    runId: manifest.runId,
    manifestPath: result.manifestPath,
    stopReason: manifest.stopReason ?? "internal_error",
    ...(manifest.currentRevision
      ? { currentRevision: manifest.currentRevision }
      : {}),
    ...(manifest.final
      ? {
          artifacts: {
            markdown: manifest.final.markdown.path,
            image: manifest.final.image.path,
          },
        }
      : current
        ? {
            artifacts: {
              markdown: current.markdown.path,
              image: current.image.path,
            },
          }
        : {}),
    ...(manifest.error ? { error: manifest.error } : {}),
  };
}

export async function main(argv = process.argv): Promise<number> {
  let json = argv.includes("--json");
  const program = new Command()
    .name("handnote")
    .description(
      "Turn a single handwritten-note image into a reviewed semantic note",
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => process.stderr.write(value),
      writeErr: (value) => process.stderr.write(value),
    });
  program
    .command("run")
    .argument("<input-image>")
    .requiredOption("--config <yaml>")
    .requiredOption("--output <runs-root>")
    .option("--json")
    .action(
      async (
        input: string,
        options: { config: string; output: string; json?: boolean },
      ) => {
        json = Boolean(options.json);
        const manifest = await executeRun(
          input,
          options.config,
          options.output,
        );
        const result = publicResult(manifest);
        if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else
          process.stdout.write(
            `${result.status}: ${result.runDirectory ?? "no run directory"}\n`,
          );
        process.exitCode = manifest.exitCode;
      },
    );
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const base = asError(error);
    const validation =
      error instanceof HandnoteError
        ? error
        : new HandnoteError(base.message, "validation");
    const result: CliResult = {
      status: "failed",
      exitCode: 1,
      stopReason: validation.kind,
      error: { kind: validation.kind, message: validation.message },
    };
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (!(error instanceof CommanderError))
      process.stderr.write(`failed: ${validation.message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();

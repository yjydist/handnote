import { mkdir, readFile } from "node:fs/promises";
import type { HandnoteToolHandlers } from "../agent/index.ts";
import { toolError } from "../agent/index.ts";
import { createModelPreviews } from "../run/image.ts";
import { compileNoteMarkdown } from "../run/markdown.ts";
import { NoteStateError } from "../run/store.ts";
import { atomicWrite } from "../run/utils.ts";
import { layoutSummary, remainingSteps } from "./shared.ts";
import type { ToolContext } from "./types.ts";

type ReviewOutput = Awaited<ReturnType<HandnoteToolHandlers["review_render"]>>;
class BlockedInkReview extends Error {
  constructor(readonly output: ReviewOutput) {
    super("Ink review requires layout repairs");
  }
}

export function createReviewRenderHandler(
  context: ToolContext,
): HandnoteToolHandlers["review_render"] {
  return async (_input, execution) => {
    let inkOutput: ReviewOutput | undefined;
    try {
      const revision = await context.store.review(
        execution.step,
        async (revision) => {
          if (context.store.manifest.formatVersion === 2) {
            const note = await compileNoteMarkdown(
              await readFile(
                context.store.path(revision.markdown.path),
                "utf8",
              ),
              {
                runDirectory: context.store.directory,
                manifest: context.store.manifest,
              },
            );
            const relativeDirectory = `session/ink-reviews/revision-${revision.number}/step-${execution.step}`;
            const directory = context.store.path(relativeDirectory);
            context.store.path(`${relativeDirectory}/review.json`);
            await mkdir(directory, { recursive: true });
            const imagePath = context.store.path(revision.image.path);
            await createModelPreviews(imagePath, context.toolMedia);
            const views = [
              {
                width: revision.width,
                height: revision.height,
                image: await context.recorder.media(imagePath, "image/png"),
                warnings: revision.warnings,
              },
            ];
            const warnings = revision.warnings;
            const reviewed = !warnings.some((warning) => warning.blocking);
            const structure = Object.entries(revision.structure)
              .map(([name, count]) => `${name}=${count}`)
              .join(", ");
            const usage = note.inkUsage;
            const coverage = usage
              ? `Ink source coverage: ${usage.usedStrokeIndices.length}/${usage.usedStrokeIndices.length + usage.unusedStrokeIndices.length} used; unusedStrokeIndices=${JSON.stringify(usage.unusedStrokeIndices)}. Check every unused stroke against the source image; select meaningful content that is missing or accurately record why it is omitted in the ink audit. Unused strokes are coverage facts, not automatic defects; using every stroke is not required.`
              : "";
            const evidence = {
              revision: revision.number,
              dependenciesSha256: revision.dependenciesSha256,
              status: "pending-human-review",
              reviewed,
              views,
            };
            await atomicWrite(
              context.store.path(`${relativeDirectory}/review.json`),
              `${JSON.stringify(evidence, null, 2)}\n`,
            );
            context.recorder.record("ink.layout.reviewed", evidence);
            inkOutput = {
              ok: true,
              revision: revision.number,
              markdownSha256: revision.markdown.sha256,
              path: context.store.path(revision.image.path),
              paths: views.map((view) => context.store.path(view.image.path)),
              mimeType: "image/png",
              warnings,
              structure: revision.structure,
              reviewed,
              summary: `Review revision ${revision.number}; A4 output: ${views.map((view) => `${view.width}×${view.height}`).join(", ")}; ${layoutSummary(warnings)}; ${remainingSteps(execution)}. Rendered structure: ${structure}. ${reviewed ? "Compare the complete A4 output with the source; if faithful and readable, finalize in the next model step." : "NOT marked reviewed: repair all blocking assets using reselect/compose and revise_note, then review again. Do not finalize."} ${coverage} Judgment: pending-human-review.`,
            };
            if (!reviewed) throw new BlockedInkReview(inkOutput);
            return;
          }
          await createModelPreviews(
            context.store.path(revision.image.path),
            context.toolMedia,
          );
        },
      );
      if (inkOutput) return inkOutput;
      return {
        ok: true as const,
        revision: revision.number,
        markdownSha256: revision.markdown.sha256,
        path: context.store.path(revision.image.path),
        mimeType: "image/png" as const,
        warnings: revision.warnings,
        structure: revision.structure,
        summary: `Review revision ${revision.number}; ${layoutSummary(revision.warnings)}; ${remainingSteps(execution)}. If source comparison finds no content issue, call finalize_note in the next model step without another revision.`,
      };
    } catch (error) {
      if (error instanceof BlockedInkReview) return error.output;
      if (error instanceof NoteStateError)
        return toolError(error.code, error.message);
      throw error;
    }
  };
}

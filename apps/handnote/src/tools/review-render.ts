import { mkdir, readFile } from "node:fs/promises";
import type { HandnoteToolHandlers } from "@handnote/agent";
import { toolError } from "@handnote/agent";
import { createModelPreviews } from "../image.ts";
import { compileNoteMarkdown } from "../markdown.ts";
import { renderDocument } from "../renderer.ts";
import { NoteStateError } from "../store.ts";
import { atomicWrite } from "../utils.ts";
import { layoutSummary, remainingSteps } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export const inkReviewWidths = [360, 720, 1200, 1600] as const;
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
            for (const width of inkReviewWidths) {
              if (width === revision.width) continue;
              context.store.path(`${relativeDirectory}/${width}/note.html`);
              context.store.path(`${relativeDirectory}/${width}/note.png`);
            }
            await mkdir(directory, { recursive: true });
            const views = [];
            for (const width of inkReviewWidths) {
              const render =
                width === revision.width
                  ? {
                      imagePath: context.store.path(revision.image.path),
                      width,
                      height: revision.height,
                      warnings: revision.warnings,
                    }
                  : await renderDocument(
                      note,
                      context.store.path(`${relativeDirectory}/${width}`),
                      width,
                    );
              await createModelPreviews(render.imagePath, context.toolMedia);
              views.push({
                width,
                height: render.height,
                image: await context.recorder.media(
                  render.imagePath,
                  "image/png",
                ),
                warnings: render.warnings,
              });
            }
            const warnings = views.flatMap((view) =>
              view.warnings.map((warning) => ({
                ...warning,
                message: `${view.width}px: ${warning.message}`,
              })),
            );
            const reviewed = !warnings.some((warning) => warning.blocking);
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
              summary: `Review revision ${revision.number}; views in order: ${views.map((view) => `${view.width}×${view.height}`).join(", ")}; ${layoutSummary(warnings)}; ${remainingSteps(execution)}. ${reviewed ? "Compare every view with the complete source; if faithful and readable, finalize in the next model step." : "NOT marked reviewed: repair all blocking assets using reselect/compose and revise_note, then review again. Do not finalize."} ${coverage} Judgment: pending-human-review.`,
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

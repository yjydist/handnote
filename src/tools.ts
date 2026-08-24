import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { revisionDraftSchema } from "./document.ts";
import { asError, HandnoteError } from "./errors.ts";
import {
  createModelPreviews,
  inspectInputSchema,
  inspectSource,
  type ModelMediaOptions,
  type ModelPreview,
  normalizeInspectInput,
} from "./image.ts";
import { applyPatch, patchBatchSchema } from "./patch.ts";
import { type LayoutWarning, renderDocument } from "./renderer.ts";
import type { SessionRecorder } from "./session.ts";
import type { RunState } from "./state.ts";

export interface ToolContext {
  sourcePath: string;
  runDirectory: string;
  width: number;
  maxSteps: number;
  maxInspectCalls: number;
  toolMedia: ModelMediaOptions;
  state: RunState;
  recorder: SessionRecorder;
}

const toolError = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message, repairable: true as const },
});

function remainingSteps(context: ToolContext): string {
  const remaining = Math.max(0, context.maxSteps - context.state.modelStep);
  return `${remaining} model step(s) remain after this one`;
}

function layoutSummary(warnings: LayoutWarning[]): string {
  const blocking = warnings.filter((warning) => warning.blocking);
  if (blocking.length === 0) return "no blocking layout warnings";
  return `${blocking.length} blocking layout warning(s): ${blocking
    .map(
      (warning) =>
        `${warning.code}${warning.elementId ? `/${warning.elementId}` : ""}: ${warning.message}`,
    )
    .join("; ")}`;
}

export function createHandnoteTools(context: ToolContext) {
  let inspectSequence = 0;
  type InspectionOutput = Awaited<ReturnType<typeof inspectSource>> & {
    ok: true;
    mimeType: "image/png";
    summary: string;
  };
  const inspections = new Map<string, Promise<InspectionOutput>>();
  const modelMedia = new Map<string, Promise<ModelPreview[]>>();
  const fatal = (error: unknown): never => {
    const value =
      error instanceof HandnoteError
        ? error
        : new HandnoteError(asError(error).message, "internal", false, {
            cause: error,
          });
    context.state.fail(value);
    throw value;
  };
  const mediaOutputWithFatal = async (
    purpose: "inspect_source" | "review_render",
    output: {
      ok: boolean;
      path?: string | undefined;
      mimeType?: string | undefined;
      summary?: string | undefined;
    },
  ) => {
    try {
      if (!output.ok || !output.path)
        return { type: "text", value: output.summary ?? "Tool failed" };
      const existing = modelMedia.get(output.path);
      const pending =
        existing ?? createModelPreviews(output.path, context.toolMedia);
      if (!existing) modelMedia.set(output.path, pending);
      const previews = await pending;
      context.recorder.record("tool.model_media.prepared", {
        purpose,
        cacheHit: Boolean(existing),
        source: await context.recorder.media(
          output.path,
          output.mimeType ?? "image/png",
        ),
        previews: previews.map(({ data: _data, ...preview }) => preview),
      });
      return {
        type: "content",
        value: [
          { type: "text", text: output.summary ?? "Image result" },
          ...previews.flatMap((preview, index) => [
            {
              type: "text" as const,
              text: `Preview ${index + 1}/${previews.length} ${preview.width}×${preview.height}`,
            },
            {
              type: "image-data" as const,
              data: preview.data,
              mediaType: preview.mediaType,
            },
          ]),
        ],
      };
    } catch (error) {
      return fatal(error);
    }
  };
  const inspectSourceTool = createTool({
    id: "inspect_source",
    description: `Inspect one to eight normalized regions from the source image. Input: { regions: [{ x, y, width, height, scale?, enhancement? }], scale?, enhancement? }. Top-level scale/enhancement are batch defaults; a region may override either for its own crop. Regions crossing the right or bottom edge are clipped to the image. Multiple regions return a numbered contact sheet. At most ${context.maxInspectCalls} unique inspection calls are allowed; batch regions and then write the document.`,
    inputSchema: inspectInputSchema,
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        path: z.string(),
        mimeType: z.literal("image/png"),
        width: z.number(),
        height: z.number(),
        kind: z.enum(["crop", "contact_sheet"]),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.literal("inspection_budget_exhausted"),
          message: z.string(),
          repairable: z.literal(true),
        }),
        summary: z.string(),
      }),
    ]),
    execute: async (input) => {
      try {
        const normalized = normalizeInspectInput(input);
        const key = JSON.stringify(normalized);
        const cached = inspections.get(key);
        if (cached) {
          const output = await cached;
          context.recorder.record("tool.inspect_source.completed", {
            input: normalized,
            output,
            cacheHit: true,
          });
          return output;
        }
        if (inspectSequence >= context.maxInspectCalls) {
          const message = `Inspection budget exhausted after ${context.maxInspectCalls} unique call(s). Do not call inspect_source again. Use the source and existing inspections, then call write_document now.`;
          const output = {
            ...toolError("inspection_budget_exhausted", message),
            summary: message,
          };
          context.recorder.record("tool.inspect_source.rejected", {
            input: normalized,
            output,
          });
          return output;
        }
        const sequence = ++inspectSequence;
        const pending = (async (): Promise<InspectionOutput> => {
          const result = await inspectSource(
            context.sourcePath,
            `${context.runDirectory}/intermediate/inspections`,
            normalized,
            sequence,
            context.toolMedia.maxEdge,
          );
          return {
            ok: true as const,
            ...result,
            mimeType: "image/png" as const,
            summary: `${result.kind} ${result.width}×${result.height}; ${context.maxInspectCalls - sequence} unique inspection call(s) remaining`,
          };
        })();
        inspections.set(key, pending);
        const output = await pending;
        context.recorder.record("tool.inspect_source.completed", {
          input: normalized,
          output,
          cacheHit: false,
        });
        return output;
      } catch (error) {
        try {
          inspections.delete(JSON.stringify(normalizeInspectInput(input)));
        } catch {}
        return fatal(error);
      }
    },
    toModelOutput: (output) => mediaOutputWithFatal("inspect_source", output),
  });

  const writeDocumentTool = createTool({
    id: "write_document",
    description:
      "Validate, render, and commit the first complete source-faithful digital note plus session-only revision audit. The audit never appears in the rendered note. Source and audit regions record provenance only and do not control layout.",
    inputSchema: revisionDraftSchema,
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        warnings: z.array(z.unknown()),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
      }),
    ]),
    execute: async (input) =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return toolError(
            "already_finalized",
            "The note is already finalized and cannot be changed",
          );
        try {
          const draft = revisionDraftSchema.parse(input);
          const number = (context.state.revision?.number ?? 0) + 1;
          const render = await renderDocument(
            draft.document,
            context.sourcePath,
            context.runDirectory,
            number,
            context.width,
          );
          const revision = context.state.commit(
            draft.document,
            draft.audit,
            render,
          );
          context.recorder.record("document.revision.committed", {
            revision: number,
            audit: draft.audit,
            render,
          });
          return {
            ok: true as const,
            revision: revision.number,
            warnings: render.warnings,
            summary: `Revision ${revision.number} rendered; ${layoutSummary(render.warnings)}; ${remainingSteps(context)}. Review this exact revision in a later model step.`,
          };
        } catch (error) {
          if (error instanceof z.ZodError)
            return toolError("invalid_document", z.prettifyError(error));
          return fatal(error);
        }
      }),
  });

  const patchDocumentTool = createTool({
    id: "patch_document",
    description:
      'Atomically apply one flat, ordered operations array, validate audit targets, render the note, and commit a revision. Batch every known edit. Exact replace example: {"operations":[{"op":"replace_block","blockId":"eq1","block":{"id":"eq1","type":"equation","latex":"x=1"}}]}. Do not nest an operation inside block. Source/audit regions are provenance only and never change rendered layout.',
    inputSchema: z.object({ operations: patchBatchSchema }).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        warnings: z.array(z.unknown()),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
      }),
    ]),
    execute: async ({ operations }) =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return toolError(
            "already_finalized",
            "The note is already finalized and cannot be changed",
          );
        if (!context.state.revision)
          return toolError(
            "no_revision",
            "write_document must create the first revision",
          );
        try {
          const draft = applyPatch(
            {
              document: context.state.revision.document,
              audit: context.state.revision.audit,
            },
            operations,
          );
          const number = context.state.revision.number + 1;
          const render = await renderDocument(
            draft.document,
            context.sourcePath,
            context.runDirectory,
            number,
            context.width,
          );
          const revision = context.state.commit(
            draft.document,
            draft.audit,
            render,
          );
          context.recorder.record("document.revision.committed", {
            revision: number,
            operations,
            audit: draft.audit,
            render,
          });
          return {
            ok: true as const,
            revision: revision.number,
            warnings: render.warnings,
            summary: `Revision ${revision.number} rendered; ${layoutSummary(render.warnings)}; ${remainingSteps(context)}. Review this exact revision in a later model step.`,
          };
        } catch (error) {
          if (
            error instanceof z.ZodError ||
            (error instanceof Error && /Unknown|Position/.test(error.message))
          ) {
            return toolError(
              "invalid_patch",
              error instanceof z.ZodError
                ? z.prettifyError(error)
                : error.message,
            );
          }
          return fatal(error);
        }
      }),
  });

  const reviewRenderTool = createTool({
    id: "review_render",
    description:
      "Return the current revision render and precise layout warnings. Compare it with the source for completeness, source-only titles, faithful wording, and absence of summaries, observer commentary, or visible audit material. Batch all discovered fixes into one patch; source regions cannot fix layout.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        path: z.string(),
        mimeType: z.literal("image/png"),
        warnings: z.array(z.unknown()),
        structure: z.record(z.string(), z.number()),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
        summary: z.string().optional(),
      }),
    ]),
    execute: async () =>
      context.state.transaction(async () => {
        if (context.state.finalized)
          return {
            ...toolError(
              "already_finalized",
              "The note is already finalized and cannot be reviewed again",
            ),
            summary: "Note already finalized",
          };
        if (!context.state.revision)
          return {
            ...toolError("no_revision", "No revision exists to review"),
            summary: "No render",
          };
        try {
          const revision = context.state.review();
          const output = {
            ok: true as const,
            revision: revision.number,
            path: revision.render.imagePath,
            mimeType: "image/png" as const,
            warnings: revision.render.warnings,
            structure: revision.render.structure,
            summary: `Review revision ${revision.number}; ${layoutSummary(revision.render.warnings)}; ${remainingSteps(context)}. If source comparison finds no content issue, call finalize_note in the next model step without another patch.`,
          };
          context.recorder.record("render.reviewed", output);
          return output;
        } catch (error) {
          return fatal(error);
        }
      }),
    toModelOutput: (output) => mediaOutputWithFatal("review_render", output),
  });

  const finalizeNoteTool = createTool({
    id: "finalize_note",
    description:
      "Finalize only after the current revision was reviewed in an earlier model step and has no blocking warnings.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        revision: z.number(),
        summary: z.string(),
      }),
      z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
          repairable: z.literal(true),
        }),
      }),
    ]),
    execute: async () =>
      context.state.transaction(async () => {
        const eligibility = context.state.canFinalize();
        if (!eligibility.ok) return toolError("not_ready", eligibility.reason);
        try {
          context.recorder.record("note.finalized", {
            revision: eligibility.revision.number,
          });
          context.state.markFinalized(eligibility.revision);
        } catch (error) {
          return fatal(error);
        }
        return {
          ok: true as const,
          revision: eligibility.revision.number,
          summary: "Note finalized",
        };
      }),
  });

  return {
    inspect_source: inspectSourceTool,
    write_document: writeDocumentTool,
    patch_document: patchDocumentTool,
    review_render: reviewRenderTool,
    finalize_note: finalizeNoteTool,
  };
}

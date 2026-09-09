import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  captureFigureInputSchema,
  captureFigureOutputSchema,
  finalizeNoteOutputSchema,
  type HandnoteToolHandlers,
  inspectInputSchema,
  inspectSourceOutputSchema,
  type MediaToolName,
  type ModelMediaResult,
  noteDraftInputSchema,
  noteRevisionOutputSchema,
  readNoteOutputSchema,
  reviewRenderOutputSchema,
  type ToolExecutionContext,
} from "./agent-protocol.ts";
import {
  composeInkInputSchema,
  inkToolOutputSchema,
  inspectInkInputSchema,
  selectInkInputSchema,
} from "./ink-protocol.ts";

function isRuntimeValidationError(
  output: unknown,
): output is { error: true; message: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in output &&
    output.error === true &&
    "message" in output &&
    typeof output.message === "string"
  );
}

export function createAgentTools(options: {
  handlers: HandnoteToolHandlers;
  maxInspectCalls: number;
  maxSteps: number;
  currentStep: () => number;
  onFatal: (error: unknown) => never;
  onFinalized: () => void;
}) {
  const executionContext = (): ToolExecutionContext => {
    const step = options.currentStep();
    return { step, remainingSteps: Math.max(0, options.maxSteps - step) };
  };
  const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      return options.onFatal(error);
    }
  };
  const modelMediaOutput = (
    purpose: MediaToolName,
    output: ModelMediaResult | { error: true; message: string },
  ) =>
    execute(async () => {
      // Mastra can return validation errors before the business handler runs.
      if (isRuntimeValidationError(output)) {
        return {
          type: "text" as const,
          value:
            output.message +
            (purpose.endsWith("_ink")
              ? "\nUse a smaller batch and valid JSON."
              : ""),
        };
      }
      const media = await options.handlers.prepareModelMedia(purpose, output);
      if (media.kind === "text")
        return { type: "text" as const, value: media.text };
      return {
        type: "content" as const,
        value: [
          { type: "text" as const, text: media.summary },
          ...media.previews.flatMap((preview, index) => [
            {
              type: "text" as const,
              text: `Preview ${index + 1}/${media.previews.length} ${preview.width}×${preview.height}${preview.label ? ` (${preview.label})` : ""}`,
            },
            {
              type: "image-data" as const,
              data: preview.data,
              mediaType: preview.mediaType,
            },
          ]),
        ],
      };
    });
  const ink = options.handlers.ink;
  const inkTools = ink
    ? {
        inspect_ink: createTool({
          id: "inspect_ink",
          description:
            "View original trajectories, never OCR. Batch 1–8 views: {kind:'page'}, {kind:'region',region:{x,y,width,height}} in normalized REDRAW coordinates, or {kind:'asset',assetId}. Returns actual numbered previews, complete stroke IDs and bounds. Original-image mapping is unknown: do not transfer image coordinates by size ratios. Inspect the page, then batch regions to identify all meaningful strokes before selection.",
          inputSchema: inspectInkInputSchema,
          outputSchema: inkToolOutputSchema,
          execute: (input) =>
            execute(() => ink.inspect_ink(input, executionContext())),
          toModelOutput: (output) => modelMediaOutput("inspect_ink", output),
        }),
        select_ink: createTool({
          id: "select_ink",
          description:
            "Batch 1–32 selections of complete original strokeIndices with presentation {kind:'text'|'diagram',referenceHeight,transcription?,description?}. referenceHeight is a representative handwritten CHARACTER body height in source coordinate units, not the bounding height of a paragraph or diagram. Choose every stroke belonging to the content, including dots and accents. Returns immutable asset IDs, exact Markdown paths, geometry and previews. Split long text by reselecting complete strokes into smaller fragments; never cut connected strokes. No points or SVG input is accepted.",
          inputSchema: selectInkInputSchema,
          outputSchema: inkToolOutputSchema,
          execute: (input) =>
            execute(() => ink.select_ink(input, executionContext())),
          toModelOutput: (output) => modelMediaOutput("select_ink", output),
        }),
        compose_ink: createTool({
          id: "compose_ink",
          description:
            "Batch 1–32 compositions of EXISTING same-page assets. Each part is {assetId,rotation,scale,x,y}: clockwise degrees about the asset's top-left local origin, then uniform scale, then translation in composition coordinates (y down). Scale and cumulative scale must stay 0.01–100. No duplicate source strokes within a composition. Supply presentation with representative character referenceHeight in resulting coordinates. One part rotates/rescales an asset; multiple parts arrange it. New ID does not change old assets or notes: use revise_note and review again. Inspect returned previews for omissions, crossings and wrong relationships.",
          inputSchema: composeInkInputSchema,
          outputSchema: inkToolOutputSchema,
          execute: (input) =>
            execute(() => ink.compose_ink(input, executionContext())),
          toModelOutput: (output) => modelMediaOutput("compose_ink", output),
        }),
      }
    : {};
  return {
    ...inkTools,
    inspect_source: createTool({
      id: "inspect_source",
      description: `Inspect one to eight normalized regions from the source image. Input: { regions: [{ x, y, width, height, scale?, enhancement? }], scale?, enhancement? }. Top-level scale/enhancement are batch defaults; a region may override either for its own crop. Regions crossing the right or bottom edge are clipped to the image. Multiple regions return a numbered contact sheet. At most ${options.maxInspectCalls} unique inspection calls are allowed; batch regions and then write the note.`,
      inputSchema: inspectInputSchema,
      outputSchema: inspectSourceOutputSchema,
      execute: (input) =>
        execute(() =>
          options.handlers.inspect_source(input, executionContext()),
        ),
      toModelOutput: (output) => modelMediaOutput("inspect_source", output),
    }),
    capture_figure: createTool({
      id: "capture_figure",
      description:
        "Materialize one source region as a local figure asset for the note. Input: { region: { x, y, width, height } } in normalized EXIF-rotated source coordinates. Returns the relative path (../assets/figures/figure-NNN.png) to reference with standard image syntax ![caption](../assets/figures/figure-NNN.png). Repeated identical regions are cached and return the same path. Use only for figures whose visual form the note must preserve; recreated diagrams and tables do not need a crop.",
      inputSchema: captureFigureInputSchema,
      outputSchema: captureFigureOutputSchema,
      execute: (input) =>
        execute(() =>
          options.handlers.capture_figure(input, executionContext()),
        ),
      toModelOutput: (output) => modelMediaOutput("capture_figure", output),
    }),
    read_note: createTool({
      id: "read_note",
      description:
        "Return the current committed note revision: its full GFM markdown, its sha256, and a layout summary. Use it to recover exact current content before a full-document revise_note.",
      inputSchema: z.object({}).strict(),
      outputSchema: readNoteOutputSchema,
      execute: (input) =>
        execute(() => options.handlers.read_note(input, executionContext())),
    }),
    write_note: createTool({
      id: "write_note",
      description:
        "Validate, render, and commit the first complete source-faithful GFM note plus session-only revision audit. Input: { markdown, audit }. Audit quotes locate exact Markdown source fragments before rendering. The markdown is the whole note in GFM; the audit never appears in the rendered note. Source and audit regions record provenance only and do not control layout.",
      inputSchema: noteDraftInputSchema,
      outputSchema: noteRevisionOutputSchema,
      execute: (input) =>
        execute(() => options.handlers.write_note(input, executionContext())),
    }),
    revise_note: createTool({
      id: "revise_note",
      description:
        "Replace the committed note with a new full GFM markdown revision in one atomic step. Input: { markdown, audit }. Copy unchanged content verbatim from the current revision (read_note recovers it exactly); never retype it from memory. The audit is session-only and never appears in the note. When deleting or rewording audited content, drop or retarget its audit item in the same revision.",
      inputSchema: noteDraftInputSchema,
      outputSchema: noteRevisionOutputSchema,
      execute: (input) =>
        execute(() => options.handlers.revise_note(input, executionContext())),
    }),
    review_render: createTool({
      id: "review_render",
      description:
        "Return the current revision render and precise layout warnings. Source audit matches do not establish visual presence. Compare it with the source for visible content, completeness, source-only titles, faithful wording, and absence of summaries, observer commentary, or visible audit material. Batch all discovered fixes into one full-document revision; source regions cannot fix layout.",
      inputSchema: z.object({}).strict(),
      outputSchema: reviewRenderOutputSchema,
      execute: (input) =>
        execute(() =>
          options.handlers.review_render(input, executionContext()),
        ),
      toModelOutput: (output) => modelMediaOutput("review_render", output),
    }),
    finalize_note: createTool({
      id: "finalize_note",
      description:
        "Finalize only after the current revision was reviewed in an earlier model step and has no blocking warnings. All revision files and referenced assets must still match their recorded hashes on disk.",
      inputSchema: z.object({}).strict(),
      outputSchema: finalizeNoteOutputSchema,
      execute: (input) =>
        execute(async () => {
          const result = await options.handlers.finalize_note(
            input,
            executionContext(),
          );
          if (result.ok) options.onFinalized();
          return result;
        }),
    }),
  };
}

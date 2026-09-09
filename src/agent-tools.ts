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
  const modelMediaOutput = (purpose: MediaToolName, output: ModelMediaResult) =>
    execute(async () => {
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
              text: `Preview ${index + 1}/${media.previews.length} ${preview.width}×${preview.height}`,
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
  return {
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

import { z } from "zod";
import { layoutWarningSchema, noteStructureSchema } from "./render-metadata.ts";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes(":") &&
      path
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== ""),
    "Artifact paths must be relative to the run directory",
  );
const artifactSchema = z
  .object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;
const revisionSchema = z
  .object({
    number: z.int().positive(),
    markdown: artifactSchema,
    html: artifactSchema,
    image: artifactSchema,
    assets: z.array(artifactSchema),
    width: z.int().positive(),
    height: z.int().positive(),
    warnings: z.array(layoutWarningSchema),
    structure: noteStructureSchema,
    renderedAtStep: z.int().nonnegative(),
    commitEventSeq: z.int().positive(),
  })
  .strict();
export type StoredRevision = z.infer<typeof revisionSchema>;
const usageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    uncachedInputTokens: z.number().optional(),
    cacheHitRate: z.number().optional(),
    reasoningTokens: z.number().optional(),
    textOutputTokens: z.number().optional(),
  })
  .strict();
export const runManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    runId: z.string(),
    status: z.enum(["running", "complete", "partial", "failed"]),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    durationMs: z.number().nonnegative(),
    stopReason: z.string().optional(),
    input: z
      .object({
        path: relativePath,
        sha256: artifactSchema.shape.sha256.optional(),
      })
      .strict(),
    session: z.literal("session/events.jsonl"),
    revisions: z.array(revisionSchema),
    currentRevision: z.int().positive().optional(),
    reviewedRevision: z
      .object({
        number: z.int().positive(),
        markdownSha256: artifactSchema.shape.sha256,
        imageSha256: artifactSchema.shape.sha256,
        reviewedAtStep: z.int().nonnegative(),
        eventSeq: z.int().positive(),
      })
      .strict()
      .optional(),
    final: z
      .object({
        revision: z.int().positive(),
        markdown: artifactSchema,
        image: artifactSchema,
        eventSeq: z.int().positive(),
      })
      .strict()
      .optional(),
    model: z
      .object({
        steps: z.int().nonnegative(),
        retries: z.int().nonnegative(),
        attempts: z.int().nonnegative(),
        usage: usageSchema,
      })
      .strict(),
    error: z
      .object({ kind: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      manifest.status !== "running" &&
      (!manifest.finishedAt || !manifest.stopReason)
    )
      issue("Terminal runs require a finish time and stop reason");
    if (manifest.status === "partial" && !manifest.currentRevision)
      issue("Partial runs require a committed revision");
    const revisions = manifest.revisions;
    if (manifest.currentRevision !== revisions.at(-1)?.number)
      issue("Current revision must reference the last committed revision");
    for (const [index, revision] of revisions.entries()) {
      if (revision.number !== index + 1)
        issue("Committed revisions must be consecutive");
      const directory = `intermediate/revisions/${String(revision.number).padStart(4, "0")}`;
      if (
        revision.markdown.path !== `${directory}/note.md` ||
        revision.html.path !== `${directory}/note.html` ||
        revision.image.path !== `${directory}/note.png`
      )
        issue("Revision artifact paths do not match its number");
      if (
        revision.assets.some(
          (asset) => !asset.path.startsWith("assets/figures/"),
        )
      )
        issue("Revision assets must be captured figures");
    }
    const revision = revisions.at(-1);
    const review = manifest.reviewedRevision;
    if (
      review &&
      (!revision ||
        review.number !== revision.number ||
        review.markdownSha256 !== revision.markdown.sha256 ||
        review.imageSha256 !== revision.image.sha256 ||
        review.reviewedAtStep <= revision.renderedAtStep)
    )
      issue("Review does not match the current revision");
    if (manifest.status === "complete" && !manifest.input.sha256)
      issue("Complete runs require a copied input hash");
    if ((manifest.status === "complete") !== Boolean(manifest.final))
      issue("Only complete runs have final output");
    if (
      manifest.final &&
      (!revision ||
        !review ||
        revision.warnings.some((warning) => warning.blocking) ||
        manifest.final.revision !== revision.number ||
        manifest.final.markdown.path !== "output/note.md" ||
        manifest.final.image.path !== "output/note.png" ||
        manifest.final.markdown.sha256 !== revision.markdown.sha256 ||
        manifest.final.image.sha256 !== revision.image.sha256)
    )
      issue("Final output must match the reviewed revision");
    if (!/^input\/original\.(png|jpe?g|webp)$/.test(manifest.input.path))
      issue("Invalid original input path");
  });
export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunStatus = Exclude<RunManifest["status"], "running">;
export interface RunResult {
  manifest: RunManifest;
  runDirectory: string;
  manifestPath: string;
  exitCode: 0 | 1 | 2;
}

export function summarizeUsage(
  usage: z.infer<typeof usageSchema>,
): z.infer<typeof usageSchema> {
  return {
    ...usage,
    ...(usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined
      ? {
          uncachedInputTokens: Math.max(
            0,
            usage.inputTokens - usage.cachedInputTokens,
          ),
          ...(usage.inputTokens > 0
            ? {
                cacheHitRate: Number(
                  (usage.cachedInputTokens / usage.inputTokens).toFixed(6),
                ),
              }
            : {}),
        }
      : {}),
  };
}

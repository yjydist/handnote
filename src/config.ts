import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { modelConfigSchema } from "./agent/index.ts";
import { HandnoteError } from "./run/errors.ts";

const rawConfigSchema = z
  .object({
    model: modelConfigSchema,
    maxSteps: z.int().min(2).max(50).default(18),
    maxInspectCalls: z.int().min(1).max(8).default(3),
    toolMedia: z
      .object({
        maxEdge: z.int().min(640).max(4096).default(2048),
        jpegQuality: z.int().min(50).max(100).default(85),
      })
      .strict()
      .default({ maxEdge: 2048, jpegQuality: 85 }),
    saveIntermediateImages: z.boolean().default(true),
  })
  .strict();

export type HandnoteConfig = z.infer<typeof rawConfigSchema> & {
  configPath: string;
};

export async function loadConfig(path: string): Promise<HandnoteConfig> {
  const configPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new HandnoteError(
      `Cannot read configuration: ${configPath}`,
      "validation",
      false,
      { cause: error },
    );
  }
  const result = rawConfigSchema.safeParse(parsed);
  if (!result.success) {
    const retiredFields = result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" && issue.path.length === 0
        ? issue.keys.filter((key) =>
            ["prompt", "theme", "fontFamily", "width"].includes(key),
          )
        : [],
    );
    throw new HandnoteError(
      `Invalid configuration: ${z.prettifyError(result.error)}${retiredFields.length ? `\nRemove ${retiredFields.join(", ")}; prompts and presentation are managed by Handnote.` : ""}`,
      "validation",
    );
  }
  return { ...result.data, configPath };
}

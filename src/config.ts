import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { HandnoteError } from "./errors.ts";

const rawConfigSchema = z
  .object({
    model: z
      .object({
        provider: z.enum(["openai-compatible"]).default("openai-compatible"),
        baseUrl: z.url(),
        apiKey: z.string().min(1),
        name: z.string().min(1),
        timeoutMs: z.int().min(1_000).max(600_000).default(240_000),
        maxRetries: z.int().min(0).max(5).default(1),
      })
      .strict(),
    prompt: z.object({ file: z.string().min(1) }).strict(),
    maxSteps: z.int().min(2).max(50).default(18),
    maxInspectCalls: z.int().min(1).max(8).default(3),
    width: z.int().min(640).max(4096).default(1600),
    toolMedia: z
      .object({
        maxEdge: z.int().min(640).max(4096).default(2048),
        jpegQuality: z.int().min(50).max(100).default(85),
      })
      .strict()
      .default({ maxEdge: 2048, jpegQuality: 85 }),
    theme: z.literal("clean").default("clean"),
    fontFamily: z.literal("sans-serif").default("sans-serif"),
    saveIntermediateImages: z.boolean().default(true),
  })
  .strict();

export type HandnoteConfig = z.infer<typeof rawConfigSchema> & {
  configPath: string;
  promptPath: string;
  promptText: string;
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
    throw new HandnoteError(
      `Invalid configuration: ${z.prettifyError(result.error)}`,
      "validation",
    );
  }
  const promptPath = isAbsolute(result.data.prompt.file)
    ? result.data.prompt.file
    : resolve(dirname(configPath), result.data.prompt.file);
  let promptText: string;
  try {
    promptText = await readFile(promptPath, "utf8");
  } catch (error) {
    throw new HandnoteError(
      `Cannot read prompt: ${promptPath}`,
      "validation",
      false,
      { cause: error },
    );
  }
  if (!promptText.trim())
    throw new HandnoteError("Prompt file is empty", "validation");
  return { ...result.data, configPath, promptPath, promptText };
}

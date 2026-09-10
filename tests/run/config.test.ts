import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.ts";
import { loadPrompt } from "../../src/prompt/index.ts";
import {
  createUniqueDirectory,
  safeStem,
  sha256File,
} from "../../src/run/utils.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/handnote-config-`);
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  test("loads defaults and direct API key without an external prompt", async () => {
    const directory = await temporary();
    await writeFile(
      `${directory}/handnote.yaml`,
      "model:\n  baseUrl: https://example.test/v1\n  apiKey: secret\n  name: vision\n",
    );
    const config = await loadConfig(`${directory}/handnote.yaml`);
    expect(config.maxSteps).toBe(18);
    expect(config.maxInspectCalls).toBe(3);
    expect(config).not.toHaveProperty("width");
    expect(config.model.maxRetries).toBe(1);
    expect(config.model.timeoutMs).toBe(240_000);
    expect(config.toolMedia).toEqual({ maxEdge: 2048, jpegQuality: 85 });
    expect(config).not.toHaveProperty("prompt");
    expect(config).not.toHaveProperty("promptText");
    expect(config.model.apiKey).toBe("secret");
  });

  test.each([
    "version: 1",
    "prompt:\n  file: prompt.md",
    "theme: clean",
    "width: 1600",
    "fontFamily: sans-serif",
  ])("rejects unsupported configuration: %s", async (field) => {
    const directory = await temporary();
    await writeFile(
      `${directory}/bad.yaml`,
      `model:\n  baseUrl: https://example.test/v1\n  apiKey: secret\n  name: v\n${field}\n`,
    );
    expect(loadConfig(`${directory}/bad.yaml`)).rejects.toThrow(
      "Unrecognized key",
    );
    if (!field.startsWith("version"))
      expect(loadConfig(`${directory}/bad.yaml`)).rejects.toThrow(
        "prompts and presentation are managed by Handnote",
      );
  });

  test("production prompt enforces faithful content and session-only audit", async () => {
    const { text: prompt } = await loadPrompt("transcription");
    expect(prompt).toContain("never summarize, compress, omit, evaluate");
    expect(prompt).toContain("only when that title is explicitly written");
    expect(prompt).toContain("Never use a callout to hold omitted");
    expect(prompt).toContain("Audit data is session-only");
    expect(prompt).toContain("exact substring of the Markdown source");
    expect(prompt).toContain("overlapping matches count");
    expect(prompt).toContain("does not prove the content is visible");
    expect(prompt).toContain("confidence is at least 0.95");
    expect(prompt).toContain("Compare the render with the original source");
    expect(prompt).toContain("visible uncertainty/correction material");
    expect(prompt).toContain("provenance metadata");
    expect(prompt).toContain("Put every currently known edit into one flat");
    expect(prompt).toContain("immediately following model step");
  });

  test("ink prompt requires Markdown structure before materials and reviews both", async () => {
    const { text: prompt } = await loadPrompt("ink");
    const phases = [
      "### 1. Identify the Markdown structure",
      "### 2. Select materials for those positions",
      "### 3. Write the structured note",
      "### 4. Review structure and appearance",
    ].map((phase) => prompt.indexOf(phase));
    expect(phases.every((position) => position >= 0)).toBe(true);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
    expect(prompt).toContain(
      "ordered and unordered lists, nested list levels, and table rows and columns",
    );
    expect(prompt).toContain(
      "multiple list items or multiple table cells in one text or diagram asset",
    );
    expect(prompt).toContain(
      "One Markdown position may contain several complete word-group SVGs",
    );
    expect(prompt).toContain(
      "record their IDs and the preserved item relationship in audit.ink.omissions",
    );
    expect(prompt).toContain("preserve the smallest affected group");
    expect(prompt).toContain(
      "Explain that necessity in presentation.description",
    );
    expect(prompt).toContain(
      "ink_text_block observation measures geometry, not semantic correctness",
    );
    expect(prompt).toContain(
      "Never inflate referenceHeight or relabel ordinary text as diagram",
    );
    expect(prompt).toContain("Missing Markdown structure");
  });
});

describe("run naming and hashes", () => {
  test("normalizes unicode and creates collision-safe directories", async () => {
    const directory = await temporary();
    expect(safeStem("Ａ  note///一.png")).toBe("A-note-一");
    const first = await createUniqueDirectory(directory, "same.png");
    const second = await createUniqueDirectory(directory, "same.png");
    expect(first.path).not.toBe(second.path);
    expect(second.id).toMatch(/-[0-9a-f]{4}$/);
  });

  test("hashes exact bytes", async () => {
    const directory = await temporary();
    await writeFile(`${directory}/data`, new Uint8Array([0, 1, 2, 255]));
    expect(await sha256File(`${directory}/data`)).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
  });
});

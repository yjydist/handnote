import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { loadPrompt } from "../src/prompt/index.ts";

test("internal prompts preserve exact resource text and hash the chosen mode", async () => {
  const base = await readFile(
    new URL("../src/prompt/handnote.md", import.meta.url),
    "utf8",
  );
  const ink = await readFile(
    new URL("../src/prompt/ink.md", import.meta.url),
    "utf8",
  );
  for (const [mode, expected] of [
    ["transcription", base],
    ["ink", base + ink],
  ] as const) {
    expect(await loadPrompt(mode)).toEqual({
      text: expected,
      sha256: createHash("sha256").update(expected).digest("hex"),
    });
  }
  expect(ink).toContain("COMPLETE source strokes");
  expect(ink).toContain("pending-human-review");
});

test("missing or empty installed prompt resources are non-retryable internal failures", async () => {
  const directory = await mkdtemp(`${tmpdir()}/handnote-prompt-`);
  try {
    await mkdir(`${directory}/prompt`);
    await mkdir(`${directory}/agent`);
    await copyFile(
      new URL("../src/prompt/index.ts", import.meta.url),
      `${directory}/prompt/index.ts`,
    );
    await copyFile(
      new URL("../src/agent/agent-errors.ts", import.meta.url),
      `${directory}/agent/agent-errors.ts`,
    );
    const installed: typeof import("../src/prompt/index.ts") = await import(
      pathToFileURL(`${directory}/prompt/index.ts`).href
    );
    await expect(installed.loadPrompt("transcription")).rejects.toMatchObject({
      name: "AgentError",
      kind: "internal",
      recoverable: false,
    });
    await writeFile(`${directory}/prompt/handnote.md`, " \n");
    await expect(installed.loadPrompt("transcription")).rejects.toMatchObject({
      kind: "internal",
      recoverable: false,
    });
    await writeFile(`${directory}/prompt/handnote.md`, "source protocol\n");
    await expect(installed.loadPrompt("ink")).rejects.toMatchObject({
      kind: "internal",
      recoverable: false,
    });
    expect((await installed.loadPrompt("transcription")).text).toBe(
      "source protocol\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

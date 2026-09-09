import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AgentError } from "../agent/agent-errors.ts";

export async function loadPrompt(mode: "transcription" | "ink") {
  const resources = [new URL("./handnote.md", import.meta.url)];
  if (mode === "ink") resources.push(new URL("./ink.md", import.meta.url));
  const parts = await Promise.all(
    resources.map(async (resource) => {
      try {
        const text = await readFile(resource, "utf8");
        if (!text.trim()) throw new Error("Prompt resource is empty");
        return text;
      } catch (cause) {
        throw new AgentError(
          `Cannot load internal prompt resource: ${resource.pathname}`,
          "internal",
          false,
          { cause },
        );
      }
    }),
  );
  const text = parts.join("");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

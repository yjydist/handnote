import type { HandnoteToolHandlers } from "../agent-protocol.ts";
import { toolError } from "../agent-protocol.ts";
import { layoutSummary } from "./shared.ts";
import type { ToolContext } from "./types.ts";

export function createReadNoteHandler(
  context: ToolContext,
): HandnoteToolHandlers["read_note"] {
  return async () => {
    const revision = await context.store.readRevision();
    if (!revision)
      return toolError("no_revision", "No revision exists; use write_note");
    return {
      ok: true as const,
      revision: revision.number,
      markdown: revision.text,
      markdownSha256: revision.markdown.sha256,
      summary: `Revision ${revision.number} (${revision.text.length} characters); ${layoutSummary(revision.warnings)}`,
    };
  };
}

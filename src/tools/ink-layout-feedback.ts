import type { LayoutWarning, NoteStructure } from "../renderer/index.ts";

export function inkLayoutFeedback(
  structure: NoteStructure,
  warnings: readonly LayoutWarning[],
): string {
  const counts = Object.entries(structure)
    .filter(([, count]) => typeof count === "number")
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  const candidates = warnings
    .filter((warning) => warning.code === "ink_text_block")
    .map((warning) => warning.assetId);
  return `Rendered structure: ${counts}. ${candidates.length ? `Material boundaries to inspect: ${candidates.join(", ")} (see ink_text_block warnings). ` : ""}Compare the source hierarchy with the Markdown headings, individual list items and table cells. Split SVGs that hide independent structural items; preserve complete characters and necessary annotation relationships. Counts and geometry do not establish semantic acceptance.`;
}

import { expect, test } from "bun:test";
import { noteStructureSchema } from "../../src/renderer/index.ts";
import { runManifestSchema } from "../../src/run/manifest.ts";

const legacyStructure = {
  headings: 1,
  blocks: 3,
  tables: 0,
  equations: 0,
  diagrams: 0,
  figures: 1,
};

test.each([1, 2])(
  "version %i manifests retain absent structure counts instead of inventing zeroes",
  (formatVersion) => {
    const sha256 = "a".repeat(64);
    const artifact = (path: string) => ({ path, sha256 });
    const manifest = runManifestSchema.parse({
      formatVersion,
      ...(formatVersion === 2
        ? {
            ink: {
              points: artifact("input/points.json"),
              originalRelation: "unknown",
              redraw: {
                svg: artifact("input/redraw.svg"),
                image: artifact("input/redraw.png"),
                width: 100,
                height: 100,
                transform: { scale: 1, translateX: 0, translateY: 0 },
              },
            },
          }
        : {}),
      runId: "legacy",
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      durationMs: 0,
      input: { path: "input/original.png" },
      session: "session/events.jsonl",
      currentRevision: 1,
      revisions: [
        {
          number: 1,
          markdown: artifact("intermediate/revisions/0001/note.md"),
          html: artifact("intermediate/revisions/0001/note.html"),
          image: artifact("intermediate/revisions/0001/note.png"),
          assets: [],
          ...(formatVersion === 2 ? { dependenciesSha256: sha256 } : {}),
          width: 1200,
          height: 900,
          warnings: [],
          structure: legacyStructure,
          renderedAtStep: 1,
          commitEventSeq: 2,
        },
      ],
      model: { steps: 1, retries: 0, attempts: 1, usage: {} },
    });
    expect(manifest.revisions[0]?.structure).toEqual(legacyStructure);
    expect(manifest.revisions[0]?.structure).not.toHaveProperty("listItems");
    expect(manifest.revisions[0]?.structure).not.toHaveProperty("tableCells");
  },
);

test("structure metadata preserves all newly recorded counts", () => {
  const structure = {
    ...legacyStructure,
    orderedLists: 2,
    unorderedLists: 3,
    listItems: 7,
    tableRows: 0,
    tableCells: 0,
  };
  expect(noteStructureSchema.parse(structure)).toEqual(structure);
});

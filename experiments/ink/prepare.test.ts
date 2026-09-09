import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInkJson } from "@handnote/ink";
import sharp from "sharp";
import development from "./development.json";
import { prepareExperiment } from "./prepare.ts";

test("development fixtures reference unique complete strokes and distinct repeated text occurrences", () => {
  expect(development.pages.map((page) => page.page)).toEqual(["2", "69", "70"]);
  for (const page of development.pages) {
    const seen = new Set<number>();
    for (const fragment of page.fragments) {
      expect(page.markdown.split(fragment.text).length - 1).toBeGreaterThan(
        fragment.occurrence,
      );
      for (const index of fragment.strokeIndices) {
        expect(seen.has(index)).toBe(false);
        seen.add(index);
      }
    }
  }
  const weather = development.pages.find((page) => page.page === "69");
  expect(
    weather?.fragments
      .filter((fragment) => fragment.text === "天气")
      .map((fragment) => fragment.occurrence),
  ).toEqual([0, 1, 2]);
});

test("preparation preserves source identity, transparent fragments and refuses overwrite", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "handnote-ink-"));
  const output = join(temporary, "experiment");
  try {
    await prepareExperiment(output);
    const manifest = JSON.parse(
      await readFile(join(output, "ocr-input.json"), "utf8"),
    );
    expect(manifest.pages.length).toBe(3);
    for (const page of manifest.pages) {
      const source = parseInkJson(await readFile(join(output, page.source)));
      expect(source.sourceHash).toBe(page.sourceHash);
      const pixels = await sharp(join(output, page.image)).metadata();
      expect(pixels.width).toBeGreaterThan(1000);
      expect(pixels.height).toBeGreaterThan(800);
    }
    const fragment = await sharp(
      join(output, "page-69/fragments/69-1.png"),
    ).metadata();
    expect(fragment.hasAlpha).toBe(true);
    const lines = JSON.parse(
      await readFile(join(output, "page-69/lines.json"), "utf8"),
    );
    const forecast = lines.find(
      (line: { lineId: string }) => line.lineId === "69-forecast",
    );
    expect(forecast.unresolvedStrokeIndices).toEqual([883]);
    expect(forecast.metrics).toEqual({
      status: "unavailable",
      reason: "incomplete-line-metrics",
    });
    const candidates = JSON.parse(
      await readFile(join(output, "page-2/candidates.json"), "utf8"),
    ).candidates;
    const ending = candidates.filter(
      (candidate: { lineId: string }) => candidate.lineId === "2-ending",
    );
    expect(ending).toHaveLength(3);
    expect(ending[0].metrics).toEqual(ending[1].metrics);
    expect(ending[1].metrics).toEqual(ending[2].metrics);
    expect(ending[0].metrics.strokeIndices).toContain(271);
    const note = await readFile(join(output, "page-69/note.md"), "utf8");
    await expect(prepareExperiment(output)).rejects.toThrow("EEXIST");
    expect(await readFile(join(output, "page-69/note.md"), "utf8")).toBe(note);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

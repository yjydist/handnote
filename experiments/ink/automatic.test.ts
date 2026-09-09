import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { associateInk, parseInkJson, renderInkSvg } from "@handnote/ink";
import sharp from "sharp";
import { renderAssociatedPage, renderAutomatic } from "./automatic.ts";
import { auditCharacterHeights } from "./character-height-audit.ts";
import development from "./development.json";
import { reassessExteriorStrokes } from "./exterior-strokes.ts";
import baselineRaw from "./fixtures/ocr-page-2-baseline.json";
import { loadOcrEvidence } from "./ocr-evidence.ts";
import { compareReadability } from "./readability.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "handnote-ocr-evidence-"));
  const input = join(directory, "prepared");
  const ocr = join(directory, "ocr");
  await mkdir(input);
  await mkdir(ocr);
  const records = [];
  for (const page of development.pages) {
    const pageDirectory = join(input, `page-${page.page}`);
    await mkdir(pageDirectory);
    const sourceBytes = await readFile(join(repository, page.source));
    const source = parseInkJson(sourceBytes);
    await writeFile(join(pageDirectory, "source.json"), sourceBytes);
    await writeFile(join(pageDirectory, "note.md"), page.markdown);
    const redraw = renderInkSvg(source, { background: "white", padding: 10 });
    const pixels = await sharp(Buffer.from(redraw.svg)).png().toBuffer();
    const image = join(pageDirectory, "redraw.png");
    await writeFile(image, pixels);
    const rawResult = `page-${page.page}.raw.json`;
    await writeFile(
      join(ocr, rawResult),
      JSON.stringify({ input_path: image, rec_texts: [] }),
    );
    records.push({
      page: page.page,
      image,
      imageHash: hash(pixels),
      sourceHash: source.sourceHash,
      transform: { ...redraw.transform },
      rawResult,
      seconds: 1,
    });
  }
  const run = {
    status: "complete",
    modelLockHash: "a".repeat(64),
    packages: { paddleocr: "3.3.1" },
    pages: records,
  };
  return {
    directory,
    input,
    ocr,
    run,
    output: join(directory, "output"),
    async save() {
      await writeFile(join(ocr, "run.json"), JSON.stringify(run));
    },
  };
}

test("valid fixed OCR redraw evidence reaches output reservation", async () => {
  const data = await fixture();
  try {
    await data.save();
    await mkdir(data.output);
    // EEXIST is reached only after all source, redraw, and raw-result checks pass.
    await expect(
      renderAutomatic(data.input, data.ocr, data.output),
    ).rejects.toThrow("EEXIST");
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

for (const mutation of ["frozen-report", "baseline-run"] as const) {
  test(`readability refuses stale ${mutation} before reserving output`, async () => {
    const data = await fixture();
    try {
      await data.save();
      const frozen = join(data.directory, "frozen");
      await mkdir(frozen);
      const bytes = Buffer.from(
        JSON.stringify({
          annotationStatus: "pending-human-review",
          pages: [],
          baselineRunHash:
            mutation === "baseline-run"
              ? "b".repeat(64)
              : hash(await readFile(join(data.ocr, "run.json"))),
        }),
      );
      await writeFile(join(frozen, "report.json"), bytes);
      await writeFile(
        join(frozen, "verification.json"),
        JSON.stringify({
          reportHash:
            mutation === "frozen-report" ? "c".repeat(64) : hash(bytes),
        }),
      );
      await expect(
        compareReadability(data.input, data.ocr, frozen, data.output),
      ).rejects.toThrow(
        mutation === "frozen-report"
          ? "Frozen comparison report changed"
          : "Baseline OCR differs",
      );
      await expect(stat(data.output)).rejects.toThrow("ENOENT");
    } finally {
      await rm(data.directory, { recursive: true, force: true });
    }
  });
}

test("character-height hypothesis preserves fixed bindings and never repairs unavailable line metrics", async () => {
  const data = await fixture();
  try {
    const record = data.run.pages[0];
    if (!record) throw new Error("Missing fixed development record");
    await writeFile(
      join(data.ocr, record.rawResult),
      JSON.stringify({ ...baselineRaw, input_path: record.image }),
    );
    await data.save();
    const evidence = await loadOcrEvidence(data.input, data.ocr);
    const input = evidence.inputs[0];
    if (!input) throw new Error("Missing validated page");
    const original = associateInk(input.source, {
      raw: input.raw,
      transform: input.record.transform,
      ocr: {
        version: "paddleocr-3.3.1",
        resultHash: hash(input.rawBytes),
        modelHash: data.run.modelLockHash,
      },
    });
    const association = reassessExteriorStrokes(
      input.source,
      original,
    ).association;
    const audit = auditCharacterHeights(input.source, association);
    const references = new Map(
      audit.lines.flatMap((line) =>
        line.metrics.status === "available" && line.medianHeight !== null
          ? [[line.lineId, line.medianHeight] as const]
          : [],
      ),
    );
    const options = {
      width: 360,
      variant: "readability-test",
      context: "boundary-edits" as const,
      fragmentLayout: "source-spacing" as const,
    };
    const baseline = await renderAssociatedPage(input, association, {
      ...options,
      directory: join(data.directory, "baseline"),
    });
    const hypothesis = await renderAssociatedPage(input, association, {
      ...options,
      directory: join(data.directory, "hypothesis"),
      characterHeightReferences: references,
    });
    const blocked = await renderAssociatedPage(input, original, {
      ...options,
      directory: join(data.directory, "blocked"),
      characterHeightReferences: references,
    });
    expect(baseline.inkCharacters).toBe(18);
    expect(hypothesis.inkCharacters).toBe(18);
    expect(hypothesis.bindingsHash).toBe(baseline.bindingsHash);
    expect(hypothesis.sourcesHash).toBe(baseline.sourcesHash);
    expect(hypothesis.markdownHash).toBe(baseline.markdownHash);
    expect(
      hypothesis.renderFragments.flatMap((fragment) => fragment.strokeIndices),
    ).toEqual(Array.from({ length: 85 }, (_, i) => i + 211));
    expect(hypothesis.replacements[0]?.bounds?.width).toBeGreaterThan(
      baseline.replacements[0]?.bounds?.width ?? Infinity,
    );
    const baselineLayout = baseline.replacements[0]?.resolvedLayout;
    const hypothesisLayout = hypothesis.replacements[0]?.resolvedLayout;
    if (!baselineLayout || !hypothesisLayout)
      throw new Error("Missing shared line typography");
    expect(hypothesisLayout.fontSize).toBe(baselineLayout.fontSize);
    expect(hypothesis.warnings).toEqual([]);
    expect(blocked.inkCharacters).toBe(0);
    expect(blocked.metricFallbacks.length).toBeGreaterThan(0);
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
}, 30_000);

for (const mutation of [
  "transform",
  "image",
  "source",
  "raw-input-path",
] as const) {
  test(`rejects altered ${mutation} before creating any output`, async () => {
    const data = await fixture();
    try {
      const page = data.run.pages[0];
      const other = data.run.pages[1];
      if (!page || !other) throw new Error("Missing development fixture");
      let reason: string;
      switch (mutation) {
        case "transform":
          page.transform.translateX += 100;
          reason = "Mismatched OCR redraw evidence";
          break;
        case "image":
          page.image = other.image;
          page.imageHash = other.imageHash;
          reason = "Mismatched OCR redraw evidence";
          break;
        case "source": {
          const path = join(data.input, `page-${page.page}/source.json`);
          const changed = Buffer.concat([
            await readFile(path),
            Buffer.from("\n"),
          ]);
          await writeFile(path, changed);
          page.sourceHash = hash(changed);
          reason = "Stale input evidence";
          break;
        }
        case "raw-input-path":
          await writeFile(
            join(data.ocr, page.rawResult),
            JSON.stringify({ input_path: other.image, rec_texts: [] }),
          );
          reason = "Mismatched OCR result image";
          break;
      }
      await data.save();
      await expect(
        renderAutomatic(data.input, data.ocr, data.output),
      ).rejects.toThrow(reason);
      await expect(stat(data.output)).rejects.toThrow("ENOENT");
    } finally {
      await rm(data.directory, { recursive: true, force: true });
    }
  });
}

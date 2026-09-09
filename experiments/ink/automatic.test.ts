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
import { parseInkJson, renderInkSvg } from "@handnote/ink";
import sharp from "sharp";
import { renderAutomatic } from "./automatic.ts";
import development from "./development.json";

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

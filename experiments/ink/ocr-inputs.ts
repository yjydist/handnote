import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderInkSvg } from "@handnote/ink";
import sharp from "sharp";
import {
  cropTransform,
  hash,
  lineBoxesSchema,
  lineCrop,
  loadOcrEvidence,
} from "./ocr-evidence.ts";

export async function prepareOcrInputs(
  prepared: string,
  baselineOcr: string,
  output: string,
) {
  const baseline = await loadOcrEvidence(prepared, baselineOcr);
  if (
    baseline.inputs.length !== 3 ||
    baseline.inputs.some((entry) => entry.record.variant !== "baseline")
  )
    throw new Error("Expected exactly the three fixed baseline pages");
  const destination = resolve(output);
  const jobs = [];
  for (const input of baseline.inputs) {
    const redraw = renderInkSvg(input.source, {
      background: "white",
      scale: 2,
      padding: 20,
    });
    const original = renderInkSvg(input.source, {
      background: "white",
      padding: 10,
    });
    const fullPixels = await sharp(Buffer.from(redraw.svg)).png().toBuffer();
    const raw = lineBoxesSchema.parse(input.raw);
    if (raw.rec_boxes.length !== raw.rec_texts.length)
      throw new Error("Inconsistent baseline lines");
    const common = {
      page: input.page.page,
      sourceHash: input.source.sourceHash,
      baselineOcrHash: hash(input.rawBytes),
      baselineOcrFile: join(
        destination,
        `page-${input.page.page}.baseline.raw.json`,
      ),
    };
    const wholeId = `page-${input.page.page}-2x`;
    jobs.push({
      record: {
        ...common,
        inputId: wholeId,
        variant: "page-2x",
        image: `${wholeId}.png`,
        imageHash: hash(fullPixels),
        transform: redraw.transform,
      },
      pixels: fullPixels,
    });
    for (const [baselineLineId, box] of raw.rec_boxes.entries()) {
      const crop = lineCrop(box, original.transform, redraw.transform, redraw);
      const pixels = await sharp(fullPixels).extract(crop).png().toBuffer();
      const inputId = `page-${input.page.page}-line-${baselineLineId}-2x`;
      jobs.push({
        record: {
          ...common,
          inputId,
          variant: "line-2x",
          baselineLineId,
          crop,
          image: `${inputId}.png`,
          imageHash: hash(pixels),
          transform: cropTransform(redraw.transform, crop),
        },
        pixels,
      });
    }
  }
  await mkdir(destination);
  for (const input of baseline.inputs)
    await writeFile(
      join(destination, `page-${input.page.page}.baseline.raw.json`),
      input.rawBytes,
      { flag: "wx" },
    );
  for (const job of jobs)
    await writeFile(join(destination, job.record.image), job.pixels, {
      flag: "wx",
    });
  await writeFile(
    join(destination, "ocr-input.json"),
    `${JSON.stringify({ annotationStatus: "pending-human-review", baselineRunHash: hash(baseline.bytes), pages: jobs.map((job) => job.record) }, null, 2)}\n`,
    { flag: "wx" },
  );
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--prepared" ||
    args[2] !== "--baseline-ocr" ||
    args[4] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5]
  )
    throw new Error(
      "Usage: bun experiments/ink/ocr-inputs.ts --prepared <directory> --baseline-ocr <directory> --output <new-directory>",
    );
  console.log(await prepareOcrInputs(args[1], args[3], args[5]));
}

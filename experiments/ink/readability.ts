import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type InkAssociationReport, renderInkSvg } from "@handnote/ink";
import { chromium } from "playwright";
import sharp from "sharp";
import { z } from "zod";
import { renderAssociatedPage } from "./automatic.ts";
import { auditCharacterHeights } from "./character-height-audit.ts";
import { hash, loadOcrEvidence } from "./ocr-evidence.ts";

const save = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const frozenSchema = z.object({
  annotationStatus: z.literal("pending-human-review"),
  baselineRunHash: z.string(),
  pages: z.array(
    z.object({
      page: z.string(),
      width: z.number(),
      variant: z.string(),
      sourceHash: z.string(),
      sourcesHash: z.string(),
      markdownHash: z.string(),
      imageHash: z.string(),
    }),
  ),
});
const widths = [360, 720, 1200, 1600] as const;
const codeFiles = [
  "readability.ts",
  "automatic.ts",
  "character-height-audit.ts",
  "source-runs.ts",
  "ocr-evidence.ts",
  "../../packages/ink/src/trajectory.ts",
  "../../packages/renderer/src/ink-renderer.ts",
  "../../packages/renderer/src/renderer.ts",
  "../../apps/handnote/src/ink-matching.ts",
];
async function codeHashes() {
  return Object.fromEntries(
    await Promise.all(
      codeFiles.map(async (file) => [
        file,
        hash(await readFile(new URL(file, import.meta.url))),
      ]),
    ),
  );
}

type PageReport = Awaited<ReturnType<typeof renderAssociatedPage>>;
type RasterRow = Pick<
  PageReport,
  "page" | "width" | "inkCharacters" | "eligibleCharacters" | "warnings"
> & {
  heightReference: "line-envelope" | "character-median-hypothesis";
  sourceHash: string;
  associationHash: string;
  bindingsHash: string;
  report: string;
  strokeIndices: number[];
  sourcePenWidths: number[];
  displayedPenWidths: number[];
  heightReferenceTargets: string[];
  raster: "png" | "native-svg";
  image: string;
  imageHash: string;
  pixels: Awaited<ReturnType<typeof inkPixelEvidence>>;
  geometryMatchesPng?: boolean;
};
async function inkPixelEvidence(image: Buffer, report: PageReport) {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = new Set<number>();
  for (const replacement of report.replacements) {
    if (replacement.mode !== "ink" || !replacement.bounds) continue;
    const b = replacement.bounds;
    for (
      let y = Math.max(0, Math.floor(b.y));
      y < Math.min(info.height, Math.ceil(b.y + b.height));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(b.x));
        x < Math.min(info.width, Math.ceil(b.x + b.width));
        x++
      )
        pixels.add(y * info.width + x);
  }
  let darknessSum = 0,
    pixelsBelow128 = 0;
  for (const pixel of pixels) {
    const at = pixel * info.channels;
    const brightness =
      ((data[at] ?? 255) + (data[at + 1] ?? 255) + (data[at + 2] ?? 255)) / 3;
    darknessSum += (255 - brightness) / 255;
    if (brightness < 128) pixelsBelow128++;
  }
  return {
    sampledPixels: pixels.size,
    darknessSum,
    pixelsBelow128,
    interpretation:
      "Pixel darkness only; not readability or recognition accuracy",
  };
}

/** Native SVG is confined to this controlled browser diagnostic; the renderer still accepts PNG only. */
export async function compareReadability(
  prepared: string,
  baselineOcr: string,
  frozenInput: string,
  output: string,
) {
  const hashes = await codeHashes();
  const baseline = await loadOcrEvidence(prepared, baselineOcr);
  assert.equal(
    baseline.inputs.length,
    3,
    "Readability requires the three whole-page baseline inputs",
  );
  assert(baseline.inputs.every((input) => input.record.variant === "baseline"));
  const frozenRoot = resolve(frozenInput);
  const frozenBytes = await readFile(join(frozenRoot, "report.json"));
  const frozen = frozenSchema.parse(JSON.parse(frozenBytes.toString()));
  const verification = z
    .object({ reportHash: z.string() })
    .parse(
      JSON.parse(await readFile(join(frozenRoot, "verification.json"), "utf8")),
    );
  assert.equal(
    hash(frozenBytes),
    verification.reportHash,
    "Frozen comparison report changed",
  );
  assert.equal(
    frozen.baselineRunHash,
    hash(baseline.bytes),
    "Baseline OCR differs from frozen comparison",
  );
  const cases = await Promise.all(
    baseline.inputs.map(async (input) => {
      const page = input.page.page;
      const folder = join(frozenRoot, "720/source-spacing", `page-${page}`);
      const associated: InkAssociationReport = JSON.parse(
        await readFile(join(folder, "sources.json"), "utf8"),
      );
      assert.equal(associated.sourceHash, input.source.sourceHash);
      const expected = new Map<number, string>();
      for (const width of widths) {
        const matches = frozen.pages.filter(
          (item) =>
            item.page === page &&
            item.width === width &&
            item.variant === "source-spacing",
        );
        assert.equal(
          matches.length,
          1,
          "Expected exactly one frozen source-spacing page",
        );
        const entry = matches[0];
        if (!entry) throw new Error("Missing frozen page");
        assert.equal(entry.sourceHash, input.source.sourceHash);
        assert.equal(entry.markdownHash, hash(input.markdown));
        assert.equal(entry.sourcesHash, hash(JSON.stringify(associated)));
        assert.equal(
          hash(
            await readFile(
              join(
                frozenRoot,
                String(width),
                "source-spacing",
                `page-${page}/note.png`,
              ),
            ),
          ),
          entry.imageHash,
        );
        expected.set(width, entry.imageHash);
      }
      const audit = auditCharacterHeights(input.source, associated);
      const references = new Map(
        audit.lines.flatMap((line) =>
          line.metrics.status === "available" && line.medianHeight !== null
            ? [[line.lineId, line.medianHeight] as const]
            : [],
        ),
      );
      return { input, associated, audit, references, expected };
    }),
  );
  const destination = resolve(output);
  await mkdir(destination);
  await writeFile(join(destination, "frozen-report.json"), frozenBytes, {
    flag: "wx",
  });
  const rows: RasterRow[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of cases) {
      const pageId = item.input.page.page;
      await save(
        join(destination, `page-${pageId}-height-audit.json`),
        item.audit,
      );
      for (const width of widths)
        for (const heightReference of [
          "line-envelope",
          "character-median-hypothesis",
        ] as const) {
          const relative = `${width}/${heightReference}/page-${pageId}`;
          const directory = join(destination, relative);
          const report = await renderAssociatedPage(
            item.input,
            item.associated,
            {
              directory,
              width,
              variant: heightReference,
              context: "boundary-edits",
              fragmentLayout: "source-spacing",
              ...(heightReference === "character-median-hypothesis"
                ? { characterHeightReferences: item.references }
                : {}),
            },
          );
          const pngBytes = await readFile(join(directory, "note.png"));
          if (heightReference === "line-envelope")
            assert.equal(
              hash(pngBytes),
              item.expected.get(width),
              "Baseline layout changed before readability comparison",
            );
          const strokes = new Set(
            report.renderFragments.flatMap(
              (fragment) => fragment.strokeIndices,
            ),
          );
          const strokeWidths = [...strokes].map((index) => {
            const stroke = item.input.source.strokes[index];
            if (!stroke) throw new Error("Missing readability source stroke");
            return stroke.penWidth;
          });
          const displayedPenWidths = report.replacements.flatMap(
            (replacement) => {
              if (replacement.mode !== "ink" || !replacement.resolvedLayout)
                return [];
              const layout = replacement.resolvedLayout;
              const fragment = report.renderFragments.find(
                (fragment) => fragment.targetId === replacement.targetId,
              );
              if (!fragment) throw new Error("Missing readability fragment");
              return fragment.strokeIndices.map((index) => {
                const stroke = item.input.source.strokes[index];
                if (!stroke)
                  throw new Error("Missing readability stroke width");
                return (stroke.penWidth * layout.fontSize) / layout.emSize;
              });
            },
          );
          const common = {
            page: pageId,
            width,
            heightReference,
            inkCharacters: report.inkCharacters,
            eligibleCharacters: report.eligibleCharacters,
            sourceHash: item.input.source.sourceHash,
            associationHash: report.sourcesHash,
            bindingsHash: report.bindingsHash,
            report: `${relative}/report.json`,
            strokeIndices: [...strokes].sort((a, b) => a - b),
            sourcePenWidths: [...new Set(strokeWidths)],
            displayedPenWidths: [...new Set(displayedPenWidths)],
            heightReferenceTargets: report.renderFragments
              .filter(
                (fragment) =>
                  fragment.layoutReference.method ===
                  "observed-character-median-hypothesis",
              )
              .map((fragment) => fragment.targetId),
            warnings: report.warnings,
          };
          rows.push({
            ...common,
            raster: "png",
            image: `${relative}/note.png`,
            imageHash: hash(pngBytes),
            pixels: await inkPixelEvidence(pngBytes, report),
          });

          const context = await browser.newContext({
            viewport: { width, height: 900 },
            deviceScaleFactor: 1,
          });
          try {
            const url = pathToFileURL(join(directory, "note.html")).href;
            const blocked: string[] = [];
            await context.route("**/*", (route) => {
              if (
                route.request().url() === url ||
                route.request().url().startsWith("data:")
              )
                return route.continue();
              blocked.push(route.request().url());
              return route.abort();
            });
            const page = await context.newPage();
            await page.goto(url);
            await page.waitForFunction(
              () =>
                (
                  globalThis as typeof globalThis & {
                    __handnoteReady?: boolean;
                  }
                ).__handnoteReady === true,
            );
            const geometry = () =>
              page.locator(".hn-ink-fragment").evaluateAll((nodes) =>
                nodes.map((node) => {
                  const b = node.getBoundingClientRect();
                  return {
                    targetId: (node as HTMLElement).dataset.hnTarget,
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                  };
                }),
              );
            const before = await geometry();
            const svgInputs = await Promise.all(
              report.renderFragments
                .filter((fragment) =>
                  report.replacements.some(
                    (replacement) =>
                      replacement.targetId === fragment.targetId &&
                      replacement.mode === "ink",
                  ),
                )
                .map(async (fragment) => {
                  const image = renderInkSvg(item.input.source, {
                    strokeIndices: fragment.strokeIndices,
                  });
                  assert.deepEqual(image.bounds, fragment.sourceBounds);
                  return {
                    targetId: fragment.targetId,
                    png: Buffer.from(
                      await sharp(Buffer.from(image.svg)).png().toBuffer(),
                    ).toString("base64"),
                    svg: Buffer.from(image.svg).toString("base64"),
                  };
                }),
            );
            await page.evaluate(async (inputs) => {
              for (const input of inputs) {
                const element = Array.from(
                  document.querySelectorAll<HTMLElement>(".hn-ink-fragment"),
                ).find(
                  (element) => element.dataset.hnTarget === input.targetId,
                );
                const image = element?.querySelector("img");
                if (
                  !image ||
                  image.src !== `data:image/png;base64,${input.png}`
                )
                  throw new Error(
                    "Frozen fragment pixels do not match original strokes",
                  );
                image.src = `data:image/svg+xml;base64,${input.svg}`;
                await image.decode();
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
            }, svgInputs);
            assert.deepEqual(
              await geometry(),
              before,
              "Raster comparison changed layout",
            );
            assert.deepEqual(blocked, [], "Unexpected external resource");
            const size = await sharp(pngBytes).metadata();
            const svgPng = await page.screenshot({
              fullPage: true,
              clip: { x: 0, y: 0, width, height: size.height ?? 900 },
            });
            await writeFile(join(directory, "native-svg.png"), svgPng, {
              flag: "wx",
            });
            await writeFile(
              join(directory, "native-svg.html"),
              await page.content(),
              { flag: "wx" },
            );
            rows.push({
              ...common,
              raster: "native-svg",
              image: `${relative}/native-svg.png`,
              imageHash: hash(svgPng),
              pixels: await inkPixelEvidence(svgPng, report),
              geometryMatchesPng: true,
            });
          } finally {
            await context.close();
          }
        }
    }
  } finally {
    await browser.close();
  }
  assert.deepEqual(
    await codeHashes(),
    hashes,
    "Readability code changed during comparison",
  );
  await save(join(destination, "report.json"), {
    annotationStatus: "pending-human-review",
    accuracy: null,
    method: "frozen-bindings-readability-diagnostics",
    frozenReportHash: hash(frozenBytes),
    codeHashes: hashes,
    rows,
  });
  const sections = cases.flatMap(({ input }) =>
    widths.map(
      (width) =>
        `<section><h2>第 ${input.page.page} 页 · ${width}px</h2><a href="page-${input.page.page}-height-audit.json">整页字高证据</a><div>${rows
          .filter((row) => row.page === input.page.page && row.width === width)
          .map(
            (row) =>
              `<figure><figcaption>${row.heightReference} / ${row.raster} · ${row.inkCharacters}/${row.eligibleCharacters}</figcaption><a href="${row.image}"><img src="${row.image}" alt="第${row.page}页 ${row.heightReference} ${row.raster}"></a></figure>`,
          )
          .join("")}</div></section>`,
    ),
  );
  await writeFile(
    join(destination, "index.html"),
    `<!doctype html><html lang="zh"><meta charset="utf-8"><title>笔迹字高与栅格对照</title><style>body{font:16px system-ui;margin:24px;background:#f4f4f4}section{margin-bottom:32px}section>div{display:flex;gap:16px}figure{width:25%;min-width:0;margin:0}img{width:100%}figcaption{margin:10px 0}</style><h1>笔迹字高与栅格对照</h1><p>待人工核验。绑定、原始笔画和共享行规则固定；字高中位数只是假设，不作为默认规则。原生SVG仅用于本地显示诊断，不改变正式渲染器的PNG输入边界。</p>${sections.join("")}</html>`,
    { flag: "wx" },
  );
  return destination;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length !== 8 ||
    args[0] !== "--prepared" ||
    args[2] !== "--baseline-ocr" ||
    args[4] !== "--frozen" ||
    args[6] !== "--output" ||
    !args[1] ||
    !args[3] ||
    !args[5] ||
    !args[7]
  )
    throw new Error(
      "Usage: bun experiments/ink/readability.ts --prepared <directory> --baseline-ocr <directory> --frozen <round5-directory> --output <new-directory>",
    );
  console.log(await compareReadability(args[1], args[3], args[5], args[7]));
}

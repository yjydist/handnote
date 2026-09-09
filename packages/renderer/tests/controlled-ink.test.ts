import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  compileNoteMarkdown,
  type ImageResource,
  type InkImageMetadata,
  renderDocument,
} from "@handnote/renderer";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(`${tmpdir()}/handnote-controlled-ink-`);
  directories.push(path);
  return path;
}
function ink(
  id: string,
  overrides: Partial<InkImageMetadata> = {},
): ImageResource {
  const metadata: InkImageMetadata = {
    id,
    width: 80,
    height: 20,
    referenceHeight: 20,
    kind: "text",
    ...overrides,
  };
  return {
    mimeType: "image/svg+xml",
    ink: metadata,
    bytes: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${metadata.width} ${metadata.height}" width="${metadata.width}" height="${metadata.height}"><path d="M0 0H${metadata.width}V${metadata.height}H0Z" fill="#000"/></svg>`,
    ),
  };
}
async function inspect<T>(
  htmlPath: string,
  width: number,
  read: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction(
      () =>
        (globalThis as typeof globalThis & { __handnoteReady?: boolean })
          .__handnoteReady,
    );
    return await read(page);
  } finally {
    await browser.close();
  }
}

const geometry = (page: Page) =>
  page.locator("img[data-hn-ink]").evaluateAll((images) =>
    images.map((image) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return {
        id: image.getAttribute("data-hn-ink"),
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        display: style.display,
        maxWidth: style.maxWidth,
        verticalAlign: style.verticalAlign,
        loaded:
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      };
    }),
  );

test("controlled SVG images use heading, inline, list and diagram scale without captions", async () => {
  const note = await compileNoteMarkdown(
    "# ![title](title)\n\nBefore ![inline](inline) after.\n\n- ![list](list)\n\n![diagram alt](diagram)",
    {
      resolveImage: async (id) =>
        ink(
          id,
          id === "diagram" ? { kind: "diagram", width: 160, height: 80 } : {},
        ),
    },
  );
  expect(note.html).not.toContain("figcaption");
  expect(note.html).toContain('data-hn-reference-height="20"');
  const result = await renderDocument(note, await temporary(), 720);
  expect(result.warnings).toEqual([]);
  const images = await inspect(result.htmlPath, 720, geometry);
  expect(images.map(({ width, height }) => [width, height])).toEqual([
    [192, 48],
    [80, 20],
    [80, 20],
    [160, 80],
  ]);
  expect(
    images.every(
      (image) =>
        image.loaded &&
        image.maxWidth === "none" &&
        image.verticalAlign === "baseline",
    ),
  ).toBe(true);
  expect(images[3]?.display).toBe("block");
  const title = images[0];
  if (!title) throw new Error("Missing title image");
  const pixel = await sharp(result.imagePath)
    .extract({
      left: Math.round(title.x + 5),
      top: Math.round(title.y + 5),
      width: 1,
      height: 1,
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  expect([...pixel]).toEqual([0, 0, 0]);
});

test("mobile layout wraps between whole assets while preserving their explicit geometry", async () => {
  const note = await compileNoteMarkdown("![first](first) ![second](second)", {
    resolveImage: async (id) => ink(id, { width: 180 }),
  });
  const directory = await temporary();
  const wide = await renderDocument(note, `${directory}/wide`, 720);
  const narrow = await renderDocument(note, `${directory}/narrow`, 360);
  expect(wide.warnings).toEqual([]);
  expect(narrow.warnings).toEqual([]);
  const wideImages = await inspect(wide.htmlPath, 720, geometry);
  const narrowImages = await inspect(narrow.htmlPath, 360, geometry);
  expect(wideImages[0]?.y).toBe(wideImages[1]?.y ?? -1);
  expect(narrowImages[1]?.y).toBeGreaterThan(narrowImages[0]?.y ?? 0);
  expect(narrowImages.map(({ width, height }) => [width, height])).toEqual([
    [180, 20],
    [180, 20],
  ]);
  expect(narrowImages[0]?.x).toBe(36);
});

test("oversized assets block using the nearest content box and duplicates identify the asset", async () => {
  const note = await compileNoteMarkdown(
    "![paragraph](paragraph)\n\n- ![list](list)\n\n| A | B |\n| - | - |\n| ![cell](cell) | text |\n\n![again](paragraph)",
    {
      resolveImage: async (id) => ink(id, { width: 400 }),
    },
  );
  const result = await renderDocument(note, await temporary(), 360);
  const oversized = result.warnings.filter(
    (warning) => warning.code === "ink_asset_too_wide",
  );
  expect(oversized).toHaveLength(4);
  expect(
    oversized.every(
      (warning) =>
        warning.blocking &&
        warning.assetId &&
        warning.elementId &&
        warning.contentPx === 400,
    ),
  ).toBe(true);
  expect(oversized[0]?.containerPx).toBe(288);
  expect(oversized[1]?.containerPx).toBe(248);
  expect(oversized[2]?.containerPx).toBeLessThan(144);
  expect(
    result.warnings.find((warning) => warning.code === "duplicate_ink_asset"),
  ).toMatchObject({ blocking: true, assetId: "paragraph", elementId: "ink-4" });
  const images = await inspect(result.htmlPath, 360, geometry);
  expect(
    images.every(
      (image) => image.width === 400 && image.height === 20 && image.loaded,
    ),
  ).toBe(true);
});

test("invalid controlled metadata is rejected and Markdown cannot forge ink or SVG markup", async () => {
  for (const metadata of [
    undefined,
    { id: "" },
    { width: 0 },
    { height: Infinity },
    { referenceHeight: -1 },
    { kind: "unknown" },
  ]) {
    const resource = ink("invalid");
    Object.assign(resource, {
      ink:
        metadata === undefined
          ? undefined
          : {
              ...(resource.mimeType === "image/svg+xml" ? resource.ink : {}),
              ...metadata,
            },
    });
    await expect(
      compileNoteMarkdown("![bad](bad)", {
        resolveImage: async () => resource,
      }),
    ).rejects.toThrow("invalid_ink_image");
  }
  const singleSource = await compileNoteMarkdown(
    '<img src="asset" srcset="other 2x">',
    {
      resolveImage: async (id) => ink(id),
    },
  );
  expect(singleSource.html).not.toContain("srcset");
  const png = await sharp({
    create: { width: 8, height: 4, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const note = await compileNoteMarkdown(
    '<svg><path d="M0 0"/></svg><img src="raster" data-hn-ink="forged" data-hn-ink-kind="diagram" style="width:500em">',
    {
      resolveImage: async () => ({ mimeType: "image/png", bytes: png }),
    },
  );
  expect(note.html).not.toMatch(/<svg|<path|data-hn-ink|style=/);
});

test("raster image bytes, caption and established width styles are unchanged", async () => {
  const png = await sharp({
    create: { width: 8, height: 4, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const note = await compileNoteMarkdown("![caption](raster)", {
    resolveImage: async () => ({ mimeType: "image/png", bytes: png }),
  });
  expect(note.html).toBe(
    `<figure data-hn-id="block-1"><img src="data:image/png;base64,${png.toString("base64")}" alt="caption"><figcaption>caption</figcaption></figure>`,
  );
  const result = await renderDocument(note, await temporary(), 720);
  expect(result.warnings).toEqual([]);
  const html = await readFile(result.htmlPath, "utf8");
  expect(html).toContain("body{padding:48px}.page{width:624px");
  expect(html).not.toContain(".hn-ink-diagram");
  expect(html).not.toContain("body{padding:16px}");
});

test("collapsed ink blocks acceptance while visible summary and sanitized hidden attributes remain valid", async () => {
  const note = await compileNoteMarkdown(
    '<details><summary><img src="summary" alt="summary"></summary><p><img src="collapsed" alt="collapsed"></p></details><p hidden><img src="hidden" alt="hidden"></p>',
    {
      resolveImage: async (id) => ink(id),
    },
  );
  const result = await renderDocument(note, await temporary(), 360);
  const invisible = result.warnings.filter(
    (warning) => warning.code === "ink_asset_not_visible",
  );
  expect(note.html).not.toContain(" hidden");
  expect(invisible.map((warning) => warning.assetId)).toEqual(["collapsed"]);
  expect(
    invisible.every((warning) => warning.blocking && warning.elementId),
  ).toBe(true);
  expect(result.warnings.some((warning) => warning.assetId === "summary")).toBe(
    false,
  );
});

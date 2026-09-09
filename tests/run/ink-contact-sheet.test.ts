import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createInkContactSheets } from "../../src/tools/ink-contact-sheet.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function previews(dimensions: Array<[number, number]>) {
  const directory = await mkdtemp(`${tmpdir()}/handnote-contact-sheet-`);
  directories.push(directory);
  const paths: string[] = [];
  for (const [index, [width, height]] of dimensions.entries()) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      pixels[pixel * 4] = (pixel + index * 41) % 256;
      pixels[pixel * 4 + 1] = (pixel * 7) % 256;
      pixels[pixel * 4 + 2] = (pixel * 13) % 256;
      pixels[pixel * 4 + 3] = pixel % 2 ? 127 : 255;
    }
    const path = `${directory}/${index + 1}.png`;
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(path);
    paths.push(path);
  }
  return paths;
}

async function expectOriginalPixels(
  paths: string[],
  sheets: Awaited<ReturnType<typeof createInkContactSheets>>,
  maxEdge: number,
) {
  expect(
    sheets.flatMap((sheet) => sheet.placements.map(({ view }) => view)),
  ).toEqual(paths.map((_, index) => index + 1));
  for (const sheet of sheets) {
    expect(sheet.width).toBeLessThanOrEqual(maxEdge);
    expect(sheet.height).toBeLessThanOrEqual(maxEdge);
    expect(await sharp(sheet.bytes).metadata()).toMatchObject({
      format: "png",
      width: sheet.width,
      height: sheet.height,
    });
    for (const { view, ...crop } of sheet.placements) {
      const source = paths[view - 1];
      if (!source) throw new Error("Missing source preview");
      const expected = await sharp(source).ensureAlpha().raw().toBuffer();
      const actual = await sharp(sheet.bytes)
        .extract(crop)
        .ensureAlpha()
        .raw()
        .toBuffer();
      expect(actual.equals(expected)).toBe(true);
      if (sheet.kind === "sheet") {
        expect(crop.top).toBeGreaterThan(0);
        const label = await sharp(sheet.bytes)
          .extract({
            left: crop.left,
            top: crop.top - 24,
            width: Math.min(crop.width, 26),
            height: 24,
          })
          .removeAlpha()
          .raw()
          .toBuffer();
        expect(label.some((value) => value < 100)).toBe(true);
      }
    }
  }
}

test("sheets keep every source pixel and put visible labels outside all placements", async () => {
  const paths = await previews([
    [40, 20],
    [40, 30],
    [50, 20],
  ]);
  const sheets = await createInkContactSheets(paths, 128);
  expect(sheets).toHaveLength(1);
  expect(sheets[0]?.kind).toBe("sheet");
  await expectOriginalPixels(paths, sheets, 128);
  const first = sheets[0]?.placements[0];
  const second = sheets[0]?.placements[1];
  if (!first || !second) throw new Error("Missing placements");
  expect(second.left).toBeGreaterThan(first.left + first.width);
  expect(sheets[0]?.placements[2]?.top).toBeGreaterThan(
    second.top + second.height,
  );
});

test("pagination and source view numbers remain stable across multiple sheets", async () => {
  const paths = await previews(Array.from({ length: 5 }, () => [50, 20]));
  const first = await createInkContactSheets(paths, 100);
  const repeated = await createInkContactSheets(paths, 100);
  expect(
    first.map((sheet) => sheet.placements.map(({ view }) => view)),
  ).toEqual([[1, 2], [3, 4], [5]]);
  expect(first).toEqual(repeated);
  await expectOriginalPixels(paths, first, 100);
});

test("full-width previews stack without horizontal margins reducing their size", async () => {
  const paths = await previews([
    [128, 16],
    [128, 16],
  ]);
  const sheets = await createInkContactSheets(paths, 128);
  expect(sheets).toHaveLength(1);
  expect(sheets[0]?.width).toBe(128);
  expect(sheets[0]?.placements.map(({ left }) => left)).toEqual([0, 0]);
  await expectOriginalPixels(paths, sheets, 128);
});

test("tall previews remain individual between sheets without losing input order", async () => {
  const paths = await previews([
    [40, 20],
    [80, 81],
    [40, 20],
    [100, 100],
  ]);
  const sheets = await createInkContactSheets(paths, 100);
  expect(sheets.map(({ kind }) => kind)).toEqual([
    "sheet",
    "individual",
    "sheet",
    "individual",
  ]);
  for (const index of [1, 3]) {
    const path = paths[index];
    if (!path) throw new Error("Missing tall source");
    expect(sheets[index]?.bytes.equals(await readFile(path))).toBe(true);
  }
  await expectOriginalPixels(paths, sheets, 100);
});

test("the exact label-height boundary fits, and a single input is returned unchanged", async () => {
  const paths = await previews([
    [40, 76],
    [40, 77],
  ]);
  const sheets = await createInkContactSheets(paths, 100);
  expect(sheets.map(({ kind }) => kind)).toEqual(["sheet", "individual"]);
  expect(sheets[0]?.height).toBe(100);
  await expectOriginalPixels(paths, sheets, 100);
  const path = paths[0];
  if (!path) throw new Error("Missing source");
  const single = await createInkContactSheets([path], 100);
  expect(single[0]).toMatchObject({
    kind: "individual",
    width: 40,
    height: 76,
    placements: [{ view: 1, left: 0, top: 0, width: 40, height: 76 }],
  });
  expect(single[0]?.bytes.equals(await readFile(path))).toBe(true);
  expect(await createInkContactSheets([], 100)).toEqual([]);
});

test("invalid limits and oversized or non-PNG input fail without implicit resizing", async () => {
  const paths = await previews([[101, 20]]);
  for (const limit of [0, -1, 100.5, Infinity, NaN])
    await expect(createInkContactSheets(paths, limit)).rejects.toThrow(
      "positive integer",
    );
  await expect(createInkContactSheets(paths, 100)).rejects.toThrow(
    "bounded PNG",
  );
  const png = paths[0];
  if (!png) throw new Error("Missing source");
  const jpeg = `${png}.jpg`;
  await sharp(png).jpeg().toFile(jpeg);
  await expect(createInkContactSheets([jpeg], 120)).rejects.toThrow(
    "bounded PNG",
  );
});

test("grayscale PNGs decode to the same complete RGBA pixels as other previews", async () => {
  const paths = await previews([
    [40, 20],
    [40, 20],
  ]);
  const grayscale = paths[0];
  if (!grayscale) throw new Error("Missing grayscale preview path");
  const gray = Buffer.from(
    Array.from({ length: 40 * 20 }, (_, index) => index % 256),
  );
  await sharp(gray, { raw: { width: 40, height: 20, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toFile(grayscale);
  expect(await sharp(grayscale).metadata()).toMatchObject({
    space: "b-w",
    channels: 1,
  });
  const sheets = await createInkContactSheets(paths, 128);
  expect(sheets).toHaveLength(1);
  await expectOriginalPixels(paths, sheets, 128);
  const placement = sheets[0]?.placements[0];
  const sheet = sheets[0];
  if (!placement || !sheet) throw new Error("Missing grayscale placement");
  const { view: _view, ...crop } = placement;
  const rgba = await sharp(sheet.bytes)
    .extract(crop)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const expected = Buffer.alloc(gray.length * 4);
  for (const [index, value] of gray.entries()) {
    expected.fill(value, index * 4, index * 4 + 3);
    expected[index * 4 + 3] = 255;
  }
  expect(rgba.equals(expected)).toBe(true);
});

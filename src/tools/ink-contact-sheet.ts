import { readFile } from "node:fs/promises";
import sharp from "sharp";

interface Placement {
  view: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ContactSheet {
  bytes: Buffer;
  width: number;
  height: number;
  placements: Placement[];
  kind: "sheet" | "individual";
}

interface Source {
  bytes: Buffer;
  width: number;
  height: number;
  view: number;
}

const labelHeight = 24;
const gap = 8;

export async function createInkContactSheets(
  paths: readonly string[],
  maxEdge: number,
): Promise<ContactSheet[]> {
  if (!Number.isInteger(maxEdge) || maxEdge <= 0)
    throw new Error("Contact sheet maxEdge must be a positive integer");
  const sources: Source[] = [];
  for (const [index, path] of paths.entries()) {
    const bytes = await readFile(path);
    const metadata = await sharp(bytes).metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > maxEdge ||
      metadata.height > maxEdge
    )
      throw new Error(`Ink preview ${index + 1} must be a bounded PNG`);
    sources.push({
      bytes,
      width: metadata.width,
      height: metadata.height,
      view: index + 1,
    });
  }

  const output: ContactSheet[] = [];
  let pending: Array<{
    source: Source;
    placement: Placement;
    cellWidth: number;
  }> = [];
  let width = 0;
  let height = 0;
  let left = 0;
  let rowTop = 0;
  let rowHeight = 0;

  const flush = async () => {
    if (!pending.length) return;
    const pixels = Buffer.alloc(width * height * 4, 255);
    const copyPixels = (
      bytes: Buffer,
      sourceWidth: number,
      sourceHeight: number,
      x: number,
      y: number,
    ) => {
      for (let row = 0; row < sourceHeight; row++)
        bytes.copy(
          pixels,
          ((y + row) * width + x) * 4,
          row * sourceWidth * 4,
          (row + 1) * sourceWidth * 4,
        );
    };
    for (const { source, placement, cellWidth } of pending) {
      const label = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#eef1f5"/><text x="8" y="17" font-family="sans-serif" font-size="14" fill="#17212b">${source.view}</text></svg>`,
      );
      copyPixels(
        await sharp(label).toColourspace("srgb").ensureAlpha().raw().toBuffer(),
        cellWidth,
        labelHeight,
        placement.left,
        placement.top - labelHeight,
      );
      // Copy decoded pixels directly so even translucent strokes retain their original RGBA values.
      copyPixels(
        await sharp(source.bytes)
          .toColourspace("srgb")
          .ensureAlpha()
          .raw()
          .toBuffer(),
        source.width,
        source.height,
        placement.left,
        placement.top,
      );
    }
    output.push({
      bytes: await sharp(pixels, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
      width,
      height,
      placements: pending.map(({ placement }) => placement),
      kind: "sheet",
    });
    pending = [];
    width = height = left = rowTop = rowHeight = 0;
  };

  for (const source of sources) {
    const cellWidth = Math.max(
      source.width,
      16 + String(source.view).length * 10,
    );
    const cellHeight = source.height + labelHeight;
    if (sources.length === 1 || cellHeight > maxEdge || cellWidth > maxEdge) {
      await flush();
      output.push({
        bytes: source.bytes,
        width: source.width,
        height: source.height,
        placements: [
          {
            view: source.view,
            left: 0,
            top: 0,
            width: source.width,
            height: source.height,
          },
        ],
        kind: "individual",
      });
      continue;
    }
    if (left + cellWidth > maxEdge) {
      left = 0;
      rowTop += rowHeight + gap;
      rowHeight = 0;
    }
    if (rowTop + cellHeight > maxEdge) await flush();
    const placement = {
      view: source.view,
      left,
      top: rowTop + labelHeight,
      width: source.width,
      height: source.height,
    };
    pending.push({ source, placement, cellWidth });
    width = Math.max(width, left + cellWidth);
    height = Math.max(height, rowTop + cellHeight);
    rowHeight = Math.max(rowHeight, cellHeight);
    left += cellWidth + gap;
  }
  await flush();
  return output;
}

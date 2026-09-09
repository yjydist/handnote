import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";

export async function sha256File(path: string): Promise<string> {
  const file = Bun.file(path);
  return createHash("sha256")
    .update(new Uint8Array(await file.arrayBuffer()))
    .digest("hex");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function safeStem(filename: string): string {
  const extension = extname(filename);
  const raw = filename.slice(0, extension ? -extension.length : undefined);
  const value = raw
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 64);
  return value || "image";
}

export function localTimestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export async function createUniqueDirectory(
  root: string,
  stem: string,
): Promise<{ id: string; path: string }> {
  await mkdir(root, { recursive: true });
  const base = `${localTimestamp()}-${safeStem(stem)}`;
  for (let i = 0; i < 256; i++) {
    const id = i === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const path = `${root}/${id}`;
    try {
      await mkdir(path);
      return { id, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a unique run directory");
}

export async function atomicWrite(
  path: string,
  value: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    await rename(temp, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, { force: true });
    throw error;
  }
}

export function isoWithOffset(date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}${sign}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`;
}

export function mimeForExtension(ext: string): string {
  const value = ext.toLowerCase();
  if (value === ".png") return "image/png";
  if (value === ".jpg" || value === ".jpeg") return "image/jpeg";
  if (value === ".webp") return "image/webp";
  throw new Error(`Unsupported image extension: ${ext}`);
}

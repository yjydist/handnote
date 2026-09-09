import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

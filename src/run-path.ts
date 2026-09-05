import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HandnoteError } from "./errors.ts";

// The run root may itself be reached through an OS alias (for example /tmp).
// Within that root, never follow links, including aliases to another run path.
export function checkedRunPath(
  directory: string,
  path: string,
  options: { kind?: "file" | "directory"; allowMissing?: boolean } = {},
): string {
  let root: string;
  try {
    root = realpathSync(directory);
  } catch (error) {
    throw new HandnoteError(
      "Cannot access run directory",
      "filesystem",
      false,
      { cause: error },
    );
  }
  const target = resolve(root, path);
  const result = resolve(directory, path);
  if (isAbsolute(path) || !target.startsWith(`${root}${sep}`))
    throw new HandnoteError("Path escapes run directory", "filesystem");
  const parts = relative(root, target).split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (
        options.allowMissing !== false &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return result;
      throw error;
    }
    if (entry.isSymbolicLink())
      throw new HandnoteError(
        "Run paths must not contain symbolic links",
        "filesystem",
      );
    const kind = index < parts.length - 1 ? "directory" : options.kind;
    if (
      (kind === "directory" && !entry.isDirectory()) ||
      (kind === "file" && !entry.isFile())
    )
      throw new HandnoteError(
        `Run path must be a regular ${kind}`,
        "filesystem",
      );
  }
  return result;
}

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CompiledNote,
  compileNoteMarkdown as compile,
  type ImageResource,
  ImageResourceError,
} from "@handnote/renderer";
import { HandnoteError } from "./errors.ts";
import type { Artifact } from "./manifest.ts";
import { checkedRunPath } from "./run-path.ts";
import { sha256 } from "./utils.ts";

export type { CompiledNote, NoteStructure } from "@handnote/renderer";
export {
  MarkdownValidationError,
  maxMarkdownLength,
} from "@handnote/renderer";

async function readFigureResource(
  src: string,
  runDirectory: string,
  assets: Map<string, Artifact>,
): Promise<ImageResource> {
  const fail = (code: string, message: string): never => {
    throw new ImageResourceError(code, message);
  };
  if (isAbsolute(src))
    return fail(
      "invalid_image_path",
      "Images must reference captured files in assets/figures/",
    );
  const root = await realpath(runDirectory);
  const figures = `${resolve(root, "assets/figures")}${sep}`;
  const path = resolve(root, "output", src);
  if (!path.startsWith(figures))
    fail("invalid_image_path", `Image is outside assets/figures/: ${src}`);
  try {
    const actual = checkedRunPath(root, relative(root, path), {
      kind: "file",
      allowMissing: false,
    });
    const data = await readFile(actual);
    const assetPath = relative(root, actual).split(sep).join("/");
    assets.set(assetPath, { path: assetPath, sha256: sha256(data) });
    return { bytes: data, mimeType: "image/png" };
  } catch (error) {
    if (error instanceof HandnoteError)
      fail(
        "invalid_image_path",
        `Images must be regular files without symbolic links: ${src}`,
      );
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      fail("missing_figure", `Captured figure does not exist: ${src}`);
    throw error;
  }
}

export async function compileNoteMarkdown(
  markdown: string,
  options: { runDirectory: string },
): Promise<CompiledNote & { assets: Artifact[] }> {
  const assets = new Map<string, Artifact>();
  const note = await compile(markdown, {
    resolveImage: (src) =>
      readFigureResource(src, options.runDirectory, assets),
  });
  return {
    ...note,
    assets: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

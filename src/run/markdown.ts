import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CompiledNote,
  compileNoteMarkdown as compile,
  type ImageResource,
  ImageResourceError,
  MarkdownValidationError,
} from "../renderer/index.ts";
import { HandnoteError } from "./errors.ts";
import { inkDependencies, loadInkAsset, readInkSource } from "./ink-assets.ts";
import type { Artifact, RunManifest } from "./manifest.ts";
import { checkedRunPath } from "./run-path.ts";
import { sha256 } from "./utils.ts";

export type { CompiledNote, NoteStructure } from "../renderer/index.ts";
export {
  MarkdownValidationError,
  maxMarkdownLength,
} from "../renderer/index.ts";

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
    const hash = sha256(data);
    if (assets.has(assetPath) && assets.get(assetPath)?.sha256 !== hash)
      throw new HandnoteError(
        `Conflicting resource bytes: ${assetPath}`,
        "filesystem",
      );
    assets.set(assetPath, { path: assetPath, sha256: hash });
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

export interface InkUsage {
  sourceHash: string;
  assetIds: string[];
  usedStrokeIndices: number[];
  unusedStrokeIndices: number[];
  repeatedStrokeIndices: number[];
}

export async function compileNoteMarkdown(
  markdown: string,
  options: { runDirectory: string; manifest?: RunManifest },
): Promise<CompiledNote & { assets: Artifact[]; inkUsage?: InkUsage }> {
  const assets = new Map<string, Artifact>();
  const inkRun =
    options.manifest?.formatVersion === 2
      ? { directory: options.runDirectory, manifest: options.manifest }
      : undefined;
  const usedStrokes = new Set<number>();
  const dependencies: Artifact[] = [];
  let inkUsage: InkUsage | undefined;
  if (inkRun) {
    const source = await readInkSource(inkRun);
    inkUsage = {
      sourceHash: source.document.sourceHash,
      assetIds: [],
      usedStrokeIndices: [],
      unusedStrokeIndices: source.document.strokes.map(
        (stroke) => stroke.index,
      ),
      repeatedStrokeIndices: [],
    };
    dependencies.push(
      source.metadata.points,
      source.metadata.redraw.svg,
      source.metadata.redraw.image,
    );
  }
  let inkCount = 0;
  const note = await compile(markdown, {
    resolveImage: async (src) => {
      const match = /^\.\.\/assets\/ink\/([a-f0-9]{64})\.svg$/.exec(src);
      if (match?.[1] && inkRun) {
        const loaded = await loadInkAsset(inkRun, match[1]);
        for (const index of loaded.asset.strokeIndices) {
          if (usedStrokes.has(index))
            throw new MarkdownValidationError([
              {
                code: "ink_source_overlap",
                message: "Top-level ink assets repeat a complete source stroke",
              },
            ]);
          usedStrokes.add(index);
        }
        inkCount++;
        inkUsage?.assetIds.push(loaded.asset.id);
        dependencies.push(...loaded.artifacts);
        return {
          bytes: Buffer.from(loaded.svg),
          mimeType: "image/svg+xml",
          ink: {
            id: loaded.asset.id,
            width: loaded.asset.width,
            height: loaded.asset.height,
            referenceHeight: loaded.asset.presentation.referenceHeight,
            kind: loaded.asset.presentation.kind,
          },
        };
      }
      return readFigureResource(src, options.runDirectory, assets);
    },
  });
  if (inkRun && inkCount === 0)
    note.warnings.push({
      code: "ink_missing",
      message: "An ink note must include at least one source ink asset",
      blocking: true,
    });
  if (inkUsage) {
    inkUsage.usedStrokeIndices = [...usedStrokes].sort((a, b) => a - b);
    inkUsage.unusedStrokeIndices = inkUsage.unusedStrokeIndices.filter(
      (index) => !usedStrokes.has(index),
    );
  }
  return {
    ...note,
    assets: inkDependencies([...assets.values(), ...dependencies]),
    ...(inkUsage ? { inkUsage } : {}),
  };
}

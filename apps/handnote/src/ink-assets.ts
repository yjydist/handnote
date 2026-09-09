import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type InkAsset,
  type InkDocument,
  inkAssetJson,
  parseInkJson,
  renderInkAsset,
  renderInkSvg,
} from "@handnote/ink";
import sharp from "sharp";
import { HandnoteError } from "./errors.ts";
import type { Artifact, InkSource, RunManifest } from "./manifest.ts";
import { checkedRunPath } from "./run-path.ts";
import { sha256 } from "./utils.ts";

export interface InkRun {
  directory: string;
  manifest: RunManifest;
}

function failure(message: string, cause?: unknown): HandnoteError {
  return new HandnoteError(message, "filesystem", false, { cause });
}

async function readArtifact(directory: string, artifact: Artifact) {
  const bytes = await readFile(
    checkedRunPath(directory, artifact.path, {
      kind: "file",
      allowMissing: false,
    }),
  );
  if (sha256(bytes) !== artifact.sha256)
    throw failure(`Ink artifact hash mismatch: ${artifact.path}`);
  return bytes;
}

async function writeImmutable(
  directory: string,
  path: string,
  bytes: Uint8Array,
  created?: Artifact[],
) {
  const artifact = { path, sha256: sha256(bytes) };
  const target = checkedRunPath(directory, path, { kind: "file" });
  await mkdir(dirname(target), { recursive: true });
  checkedRunPath(directory, path, { kind: "file" });
  const temporary = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    try {
      await link(temporary, target);
      created?.push(artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(
        checkedRunPath(directory, path, { kind: "file", allowMissing: false }),
      );
      if (!existing.equals(bytes))
        throw failure(`Immutable ink artifact changed: ${path}`);
    }
  } finally {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
  return artifact;
}

async function rollbackInkArtifacts(run: InkRun, created: readonly Artifact[]) {
  const referenced = new Set(
    run.manifest.revisions.flatMap((revision) =>
      revision.assets.map((asset) => asset.path),
    ),
  );
  const errors: unknown[] = [];
  for (const artifact of [...created].reverse()) {
    try {
      if (referenced.has(artifact.path))
        throw failure(
          `Cannot roll back referenced ink artifact: ${artifact.path}`,
        );
      await readArtifact(run.directory, artifact);
      await rm(
        checkedRunPath(run.directory, artifact.path, {
          kind: "file",
          allowMissing: false,
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Ink artifact rollback could not safely remove every new file",
    );
}

export async function prepareInkSource(
  directory: string,
  bytes: Uint8Array,
): Promise<InkSource> {
  const original = Buffer.from(bytes);
  const document = parseInkJson(original);
  const redraw = renderInkSvg(document, { background: "white" });
  const svg = Buffer.from(redraw.svg);
  const image = await sharp(svg).png().toBuffer();
  return {
    points: await writeImmutable(directory, "input/points.json", original),
    originalRelation: "unknown",
    redraw: {
      svg: await writeImmutable(directory, "input/redraw.svg", svg),
      image: await writeImmutable(directory, "input/redraw.png", image),
      width: redraw.width,
      height: redraw.height,
      transform: redraw.transform,
    },
  };
}

export async function readInkSource(
  run: InkRun,
): Promise<{ document: InkDocument; metadata: InkSource }> {
  try {
    const metadata = run.manifest.ink;
    if (run.manifest.formatVersion !== 2 || !metadata)
      throw failure("Run has no version 2 ink source");
    const bytes = await readArtifact(run.directory, metadata.points);
    const document = parseInkJson(bytes);
    const redraw = renderInkSvg(document, { background: "white" });
    const svg = await readArtifact(run.directory, metadata.redraw.svg);
    await readArtifact(run.directory, metadata.redraw.image);
    if (
      !svg.equals(Buffer.from(redraw.svg)) ||
      redraw.width !== metadata.redraw.width ||
      redraw.height !== metadata.redraw.height ||
      inkAssetJson(redraw.transform) !== inkAssetJson(metadata.redraw.transform)
    )
      throw failure("Ink redraw does not match source geometry");
    return { document, metadata };
  } catch (error) {
    throw failure("Cannot verify ink source", error);
  }
}

export function inkDependencies(artifacts: readonly Artifact[]): Artifact[] {
  const byPath = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const existing = byPath.get(artifact.path);
    if (existing && existing.sha256 !== artifact.sha256)
      throw failure(`Conflicting ink dependency: ${artifact.path}`);
    byPath.set(artifact.path, artifact);
  }
  return [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export function dependenciesSha256(artifacts: readonly Artifact[]): string {
  return sha256(
    JSON.stringify(
      inkDependencies(artifacts).map(({ path, sha256 }) => [path, sha256]),
    ),
  );
}

export async function loadInkLibrary(run: InkRun, ids: readonly string[]) {
  try {
    const { document, metadata } = await readInkSource(run);
    const assets = new Map<string, InkAsset>();
    const artifacts: Artifact[] = [
      metadata.points,
      metadata.redraw.svg,
      metadata.redraw.image,
    ];
    const svgById = new Map<string, string>();
    const active = new Set<string>();
    const load = async (id: string): Promise<void> => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw failure("Invalid ink asset ID");
      if (assets.has(id)) return;
      if (active.has(id)) throw failure("Cyclic ink asset dependency");
      active.add(id);
      const path = `assets/ink/${id}.json`;
      const bytes = await readFile(
        checkedRunPath(run.directory, path, {
          kind: "file",
          allowMissing: false,
        }),
      );
      const asset = JSON.parse(bytes.toString("utf8")) as InkAsset;
      if (!asset || asset.id !== id || asset.sourceHash !== document.sourceHash)
        throw failure("Ink asset has a different identity or source");
      if (asset.kind === "composition") {
        if (!Array.isArray(asset.parts))
          throw failure("Invalid ink composition parts");
        for (const part of asset.parts) await load(part.assetId);
      }
      const svg = renderInkAsset(document, asset, assets);
      if (!bytes.equals(Buffer.from(inkAssetJson(asset))))
        throw failure("Ink descriptor is not its canonical representation");
      const svgPath = `assets/ink/${id}.svg`;
      const svgBytes = await readFile(
        checkedRunPath(run.directory, svgPath, {
          kind: "file",
          allowMissing: false,
        }),
      );
      if (!svgBytes.equals(Buffer.from(svg)))
        throw failure("Ink SVG differs from its source and descriptor");
      artifacts.push(
        { path, sha256: sha256(bytes) },
        { path: svgPath, sha256: sha256(svgBytes) },
      );
      assets.set(id, asset);
      svgById.set(id, svg);
      active.delete(id);
    };
    for (const id of ids) await load(id);
    return { document, assets, artifacts: inkDependencies(artifacts), svgById };
  } catch (error) {
    throw failure("Cannot verify ink asset dependency graph", error);
  }
}

export async function loadInkAsset(run: InkRun, id: string) {
  const library = await loadInkLibrary(run, [id]);
  const asset = library.assets.get(id);
  const svg = library.svgById.get(id);
  if (!asset || svg === undefined) throw failure("Missing loaded ink asset");
  return {
    asset,
    svg,
    artifacts: library.artifacts,
    relativePath: `../assets/ink/${id}.svg`,
  };
}

export async function persistInkAsset(run: InkRun, asset: InkAsset) {
  if (!/^[a-f0-9]{64}$/.test(asset.id)) throw failure("Invalid ink asset ID");
  const library = await loadInkLibrary(
    run,
    asset.kind === "composition" ? asset.parts.map((part) => part.assetId) : [],
  );
  const svg = renderInkAsset(library.document, asset, library.assets);
  const paths = [`assets/ink/${asset.id}.json`, `assets/ink/${asset.id}.svg`];
  for (const path of paths) {
    const present = await lstat(
      checkedRunPath(run.directory, path, { kind: "file" }),
    ).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (
      present ||
      run.manifest.revisions.some((revision) =>
        revision.assets.some((artifact) => artifact.path === path),
      )
    )
      return loadInkAsset(run, asset.id);
  }
  const created: Artifact[] = [];
  try {
    await writeImmutable(
      run.directory,
      `assets/ink/${asset.id}.json`,
      Buffer.from(inkAssetJson(asset)),
      created,
    );
    await writeImmutable(
      run.directory,
      `assets/ink/${asset.id}.svg`,
      Buffer.from(svg),
      created,
    );
    return await loadInkAsset(run, asset.id);
  } catch (error) {
    try {
      await rollbackInkArtifacts(run, created);
    } catch (rollbackError) {
      throw failure(
        "Ink asset save failed and rollback was incomplete",
        new AggregateError([error, rollbackError]),
      );
    }
    throw error;
  }
}

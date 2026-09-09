import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeStringify from "rehype-stringify";
import sharp from "sharp";
import { unified } from "unified";
import {
  clonePreparedDocument,
  type DocumentTarget,
  type PreparedDocument,
  validateTargets,
} from "./prepared.ts";
import {
  type RenderResult,
  renderCompiledDocument,
  renderDocument,
} from "./renderer.ts";

export interface InkReplacement {
  readonly target: DocumentTarget;
  readonly sourceId: string;
  readonly text: string;
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  /** Baseline relative to the PNG top edge, in the same units as lineHeight. */
  readonly baseline: number;
}

export interface InkReplacementResult {
  readonly target: DocumentTarget;
  readonly targetId: string;
  readonly sourceId: string;
  readonly text: string;
  readonly mode: "ink" | "font";
  readonly reason?: "too_wide" | "punctuation_group_too_wide";
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export class InkReplacementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InkReplacementError";
  }
}

interface Atom {
  node: ElementContent;
  text: string;
  wrappers: Element[];
  ink: boolean;
  barrier: boolean;
}

const inlineTags = new Set([
  "a",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "s",
  "del",
  "u",
  "sub",
  "sup",
  "mark",
]);
const opening = new Set(Array.from("（《「『【〔〈〖〘〚“‘([{｛［"));
const closing = new Set(
  Array.from("，。、；：？！）》」』】〕〉〗〙〛”’…,.!?;:)]}｝］"),
);

function isMath(node: Element): boolean {
  const classes = node.properties.className;
  return (
    Array.isArray(classes) &&
    classes.some((name) => String(name).startsWith("katex"))
  );
}

function fragmentElement(
  replacement: InkReplacement,
  targetId: string,
): Element {
  const { width, height, lineHeight, baseline } = replacement;
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["hn-ink-fragment"],
      dataHnTarget: targetId,
      dataHnSource: replacement.sourceId,
      style: `display:inline-block;line-height:0;width:${width / lineHeight}em;height:${height / lineHeight}em;vertical-align:${(baseline - height) / lineHeight}em`,
    },
    children: [
      {
        type: "element",
        tagName: "img",
        properties: {
          src: `data:image/png;base64,${Buffer.from(replacement.png).toString("base64")}`,
          alt: replacement.text,
          width,
          height,
          style: "display:block;width:100%;height:100%;max-width:none",
        },
        children: [],
      },
    ],
  };
}

function groupPunctuation(block: Element | Root): void {
  const atoms: Atom[] = [];
  const flatten = (node: RootContent, wrappers: Element[]): void => {
    if (node.type === "text") {
      for (const text of node.value)
        atoms.push({
          node: { type: "text", value: text },
          text,
          wrappers,
          ink: false,
          barrier: false,
        });
    } else if (node.type === "element") {
      if (typeof node.properties.dataHnTarget === "string") {
        const image = node.children[0];
        atoms.push({
          node,
          text:
            image?.type === "element" ? String(image.properties.alt ?? "") : "",
          wrappers,
          ink: true,
          barrier: false,
        });
      } else if (
        inlineTags.has(node.tagName) &&
        node.children.length > 0 &&
        !isMath(node) &&
        node.properties.dataFootnoteRef === undefined &&
        node.properties.dataFootnoteBackref === undefined
      ) {
        for (const child of node.children) flatten(child, [...wrappers, node]);
      } else {
        atoms.push({ node, text: "", wrappers, ink: false, barrier: true });
      }
    } else if (node.type === "comment") {
      atoms.push({ node, text: "", wrappers, ink: false, barrier: true });
    }
  };
  for (const child of block.children) flatten(child, []);
  const joins = new Set<number>();
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index];
    if (!atom || atom.barrier || !atom.text.trim()) continue;
    if (closing.has(Array.from(atom.text.trim())[0] ?? "")) {
      let previous = index - 1;
      while (
        previous >= 0 &&
        !atoms[previous]?.barrier &&
        !atoms[previous]?.text.trim()
      )
        previous--;
      if (previous >= 0 && !atoms[previous]?.barrier)
        for (let boundary = previous + 1; boundary <= index; boundary++)
          joins.add(boundary);
    }
    if (opening.has(Array.from(atom.text.trim()).at(-1) ?? "")) {
      let next = index + 1;
      while (
        next < atoms.length &&
        !atoms[next]?.barrier &&
        !atoms[next]?.text.trim()
      )
        next++;
      if (next < atoms.length && !atoms[next]?.barrier)
        for (let boundary = index + 1; boundary <= next; boundary++)
          joins.add(boundary);
    }
  }

  const emittedWrappers = new Set<Element>();
  const materialize = (items: Atom[]): ElementContent[] => {
    const children: ElementContent[] = [];
    let active: Element[] = [];
    let containers: ElementContent[][] = [children];
    for (const item of items) {
      let shared = 0;
      while (
        shared < Math.min(active.length, item.wrappers.length) &&
        active[shared] === item.wrappers[shared]
      )
        shared++;
      active = active.slice(0, shared);
      containers = containers.slice(0, shared + 1);
      for (const wrapper of item.wrappers.slice(shared)) {
        const properties = { ...wrapper.properties };
        if (emittedWrappers.has(wrapper)) {
          delete properties.id;
          delete properties.name;
        }
        emittedWrappers.add(wrapper);
        const copy: Element = { ...wrapper, properties, children: [] };
        containers.at(-1)?.push(copy);
        containers.push(copy.children);
        active.push(wrapper);
      }
      const target = containers.at(-1);
      const previous = target?.at(-1);
      if (previous?.type === "text" && item.node.type === "text")
        previous.value += item.node.value;
      else target?.push(item.node);
    }
    return children;
  };

  const children: ElementContent[] = [];
  let ordinary: Atom[] = [];
  for (let start = 0; start < atoms.length; ) {
    let end = start + 1;
    while (joins.has(end)) end++;
    const group = atoms.slice(start, end);
    if (group.some((atom) => atom.ink)) {
      children.push(...materialize(ordinary));
      ordinary = [];
      children.push({
        type: "element",
        tagName: "span",
        properties: {
          className: ["hn-ink-group"],
          dataHnPunctuation: group.length > 1 ? "true" : "false",
          style:
            "display:inline-block;white-space:nowrap;overflow-wrap:normal;word-break:normal",
        },
        children: materialize(group),
      });
    } else ordinary.push(...group);
    start = end;
  }
  children.push(...materialize(ordinary));
  block.children = children;
}

async function validateReplacement(
  document: PreparedDocument,
  replacement: InkReplacement,
): Promise<void> {
  const range = document.textRanges.find(
    ({ rangeId }) => rangeId === replacement.target.rangeId,
  );
  if (
    !replacement.sourceId.trim() ||
    range?.text.slice(replacement.target.start, replacement.target.end) !==
      replacement.text
  )
    throw new InkReplacementError(
      "Replacement text must exactly match its target and sourceId must be nonempty",
    );
  if (
    ![replacement.width, replacement.height, replacement.lineHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !Number.isFinite(replacement.baseline) ||
    ![
      replacement.width / replacement.lineHeight,
      replacement.height / replacement.lineHeight,
      (replacement.baseline - replacement.height) / replacement.lineHeight,
    ].every(Number.isFinite)
  )
    throw new InkReplacementError(
      "Replacement geometry must be finite with positive dimensions and lineHeight",
    );
  try {
    if (
      !(replacement.png instanceof Uint8Array) ||
      !Buffer.from(replacement.png.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    )
      throw new Error("Expected a PNG signature");
    const image = sharp(replacement.png);
    const metadata = await image.metadata();
    if (
      metadata.format !== "png" ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width !== replacement.width ||
      metadata.height !== replacement.height
    )
      throw new Error(
        "Expected a single PNG matching the declared pixel dimensions",
      );
    await image.stats();
  } catch (cause) {
    throw new InkReplacementError(
      "Replacement must contain a valid PNG matching its dimensions",
      { cause },
    );
  }
}

export async function renderPreparedDocument(
  prepared: PreparedDocument,
  options: {
    directory: string;
    width: number;
    replacements: readonly InkReplacement[];
  },
): Promise<RenderResult & { replacements: InkReplacementResult[] }> {
  validateTargets(
    prepared,
    options.replacements.map(({ target }) => target),
  );
  const { note, tree, ranges } = clonePreparedDocument(prepared);
  if (options.replacements.length === 0)
    return {
      ...(await renderDocument(note, options.directory, options.width)),
      replacements: [],
    };
  await Promise.all(
    options.replacements.map((replacement) =>
      validateReplacement(prepared, replacement),
    ),
  );
  const reports: InkReplacementResult[] = options.replacements.map(
    (replacement) => ({
      target: { ...replacement.target },
      targetId: `${replacement.target.rangeId}:${replacement.target.start}-${replacement.target.end}`,
      sourceId: replacement.sourceId,
      text: replacement.text,
      mode: "ink",
    }),
  );
  const byRange = new Map<
    string,
    Array<{ replacement: InkReplacement; report: InkReplacementResult }>
  >();
  for (const [index, replacement] of options.replacements.entries()) {
    const report = reports[index];
    if (!report) throw new Error("Missing replacement report");
    const entries = byRange.get(replacement.target.rangeId) ?? [];
    entries.push({ replacement, report });
    byRange.set(replacement.target.rangeId, entries);
  }
  const blocks = new Set<Element | Root>();
  for (const [rangeId, entries] of byRange) {
    const range = ranges.get(rangeId);
    if (!range) throw new Error("Missing prepared range");
    const children: ElementContent[] = [];
    let cursor = 0;
    for (const { replacement, report } of entries.sort(
      (a, b) => a.replacement.target.start - b.replacement.target.start,
    )) {
      const start = range.offsets[replacement.target.start];
      const end = range.offsets[replacement.target.end];
      if (start === undefined || end === undefined)
        throw new Error("Missing prepared offset");
      if (start > cursor)
        children.push({
          type: "text",
          value: range.node.value.slice(cursor, start),
        });
      children.push(fragmentElement(replacement, report.targetId));
      cursor = end;
    }
    if (cursor < range.node.value.length)
      children.push({ type: "text", value: range.node.value.slice(cursor) });
    const index = range.parent.children.indexOf(range.node);
    range.parent.children.splice(index, 1, ...children);
    blocks.add(range.block);
  }
  for (const block of blocks) {
    if (block.type === "element") block.properties.dataHnInkContainer = true;
    groupPunctuation(block);
  }
  note.html = String(unified().use(rehypeStringify).stringify(tree));
  let finalReports = reports;
  const rendered = await renderCompiledDocument(
    note,
    options.directory,
    options.width,
    async (page) => {
      const fallbackEntries = await page.evaluate(() => {
        const fallbacks = new Map<
          string,
          "too_wide" | "punctuation_group_too_wide"
        >();
        for (const group of document.querySelectorAll<HTMLElement>(
          ".hn-ink-group",
        )) {
          const container =
            group.closest<HTMLElement>("[data-hn-ink-container]") ??
            document.querySelector<HTMLElement>("main.page");
          if (!container) throw new Error("Ink group has no layout container");
          const style = getComputedStyle(container);
          const available =
            container.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight);
          if (group.getBoundingClientRect().width <= available + 0.01) continue;
          const reason =
            group.dataset.hnPunctuation === "true"
              ? "punctuation_group_too_wide"
              : "too_wide";
          for (const fragment of group.querySelectorAll<HTMLElement>(
            ".hn-ink-fragment",
          )) {
            const id = fragment.dataset.hnTarget;
            if (!id) throw new Error("Ink fragment has no target identity");
            const text = fragment.querySelector("img")?.alt;
            if (text === undefined)
              throw new Error("Ink fragment has no fallback text");
            fragment.textContent = text;
            fragment.classList.remove("hn-ink-fragment");
            fragment.removeAttribute("style");
            fallbacks.set(id, reason);
          }
          group.replaceWith(...group.childNodes);
        }
        return [...fallbacks];
      });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      finalReports = await page.evaluate(
        ({ entries, fallbackEntries }) => {
          const fallbacks = new Map(fallbackEntries);
          return entries.map((entry) => {
            const fragment = Array.from(
              document.querySelectorAll<HTMLElement>("[data-hn-target]"),
            ).find((element) => element.dataset.hnTarget === entry.targetId);
            if (!fragment) throw new Error("Rendered target is missing");
            const { x, y, width, height } = fragment.getBoundingClientRect();
            const reason = fallbacks.get(entry.targetId);
            return {
              ...entry,
              mode: reason ? ("font" as const) : ("ink" as const),
              ...(reason ? { reason } : {}),
              bounds: { x, y, width, height },
            };
          });
        },
        { entries: reports, fallbackEntries },
      );
    },
  );
  return { ...rendered, replacements: finalReports };
}

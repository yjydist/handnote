import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  compileNoteMarkdown,
  type InkReplacement,
  InkReplacementError,
  type PreparedDocument,
  prepareDocument,
  renderDocument,
  renderPreparedDocument,
} from "@handnote/renderer";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(`${tmpdir()}/handnote-ink-render-`);
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function replacement(
  document: PreparedDocument,
  text: string,
  width = 80,
  height = 20,
): Promise<InkReplacement> {
  const range = document.textRanges.find((range) => range.text.includes(text));
  if (!range) throw new Error(`Missing range for ${text}`);
  const png = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0.8 },
    },
  })
    .png()
    .toBuffer();
  return {
    target: {
      documentHash: document.documentHash,
      rangeId: range.rangeId,
      start: range.text.indexOf(text),
      end: range.text.indexOf(text) + text.length,
    },
    sourceId: `source-${text}`,
    text,
    png,
    width,
    height,
    lineHeight: 20,
    baseline: 20,
  };
}

async function inspectHtml<T>(
  htmlPath: string,
  width: number,
  inspect: (page: Page) => Promise<T>,
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
    return await inspect(page);
  } finally {
    await browser.close();
  }
}

describe("prepared ink rendering", () => {
  test("shared metrics remain fixed when another fragment is omitted or source coordinates are rescaled", async () => {
    const document = await prepareDocument("甲乙");
    const first = {
      ...(await replacement(document, "甲", 30, 40)),
      layout: {
        mode: "shared-line" as const,
        lineId: "source:0",
        sourceTop: 10,
        bodyHeight: 40,
        bodyBottom: 50,
      },
    };
    const second = {
      ...(await replacement(document, "乙", 15, 20)),
      layout: {
        ...first.layout,
        sourceTop: 25,
      },
    };
    const directory = await temporary();
    const together = await renderPreparedDocument(document, {
      directory: `${directory}/together`,
      width: 720,
      replacements: [first, second],
    });
    const alone = await renderPreparedDocument(document, {
      directory: `${directory}/alone`,
      width: 720,
      replacements: [first],
    });
    const scaled = {
      ...(await replacement(document, "甲", 90, 120)),
      layout: {
        mode: "shared-line" as const,
        lineId: "shifted:0",
        sourceTop: 19,
        bodyHeight: 120,
        bodyBottom: 139,
      },
    };
    const transformed = await renderPreparedDocument(document, {
      directory: `${directory}/scaled`,
      width: 720,
      replacements: [scaled],
    });
    const togetherLayout = together.replacements[0]?.resolvedLayout;
    if (!togetherLayout) throw new Error("Missing shared layout");
    expect(alone.replacements[0]?.resolvedLayout).toEqual(togetherLayout);
    expect(transformed.replacements[0]?.bounds?.width).toBeCloseTo(
      alone.replacements[0]?.bounds?.width ?? -1,
      1,
    );
    expect(transformed.replacements[0]?.bounds?.height).toBeCloseTo(
      alone.replacements[0]?.bounds?.height ?? -1,
      1,
    );
    expect(transformed.replacements[0]?.bounds?.y).toBeCloseTo(
      alone.replacements[0]?.bounds?.y ?? -1,
      1,
    );
  }, 30_000);
  test("rejects conflicting metrics for fragments of the same source line", async () => {
    const document = await prepareDocument("甲乙");
    const first = await replacement(document, "甲");
    const second = await replacement(document, "乙");
    await expect(
      renderPreparedDocument(document, {
        directory: await temporary(),
        width: 720,
        replacements: [
          {
            ...first,
            layout: {
              mode: "shared-line",
              lineId: "source:0",
              sourceTop: 10,
              bodyHeight: 40,
              bodyBottom: 50,
            },
          },
          {
            ...second,
            layout: {
              mode: "shared-line",
              lineId: "source:0",
              sourceTop: 25,
              bodyHeight: 20,
              bodyBottom: 50,
            },
          },
        ],
      }),
    ).rejects.toThrow("same source line must share body metrics");
  });

  test("shared source line metrics preserve size and vertical variation using loaded font ink metrics", async () => {
    const document = await prepareDocument("甲乙");
    const first = await replacement(document, "甲", 30, 40);
    const second = await replacement(document, "乙", 15, 20);
    const directory = await temporary();
    const result = await renderPreparedDocument(document, {
      directory,
      width: 720,
      replacements: [
        {
          ...first,
          layout: {
            mode: "shared-line",
            lineId: "source:0",
            sourceTop: 10,
            bodyHeight: 40,
            bodyBottom: 50,
          },
        },
        {
          ...second,
          layout: {
            mode: "shared-line",
            lineId: "source:0",
            sourceTop: 25,
            bodyHeight: 40,
            bodyBottom: 50,
          },
        },
      ],
    });
    const measured = await inspectHtml(result.htmlPath, 720, (page) =>
      page.evaluate(async () => {
        const paragraph = globalThis.document.querySelector("p");
        if (!paragraph) throw new Error("Missing paragraph");
        const style = getComputedStyle(paragraph);
        const ctx = globalThis.document
          .createElement("canvas")
          .getContext("2d");
        if (!ctx) throw new Error("Missing canvas context");
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        await globalThis.document.fonts.load(ctx.font, "国田目中");
        const metrics = Array.from("国田目中", (text) => ctx.measureText(text));
        const heights = metrics
          .map((m) => m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)
          .sort((a, b) => a - b);
        const descents = metrics
          .map((m) => m.actualBoundingBoxDescent)
          .sort((a, b) => a - b);
        const marker = globalThis.document.createElement("span");
        marker.style.cssText =
          "display:inline-block;width:0;height:0;vertical-align:baseline";
        paragraph.append(marker);
        return {
          height:
            heights.slice(1, 3).reduce((sum, value) => sum + value, 0) / 2,
          descent:
            descents.slice(1, 3).reduce((sum, value) => sum + value, 0) / 2,
          baseline: marker.getBoundingClientRect().bottom,
        };
      }),
    );
    const a = result.replacements[0]?.bounds;
    const b = result.replacements[1]?.bounds;
    if (!a || !b) throw new Error("Missing rendered bounds");
    expect(a.height).toBeCloseTo(measured.height, 1);
    expect(a.height / b.height).toBeCloseTo(2, 1);
    expect(a.width / b.width).toBeCloseTo(2, 1);
    expect((b.y - a.y) / a.height).toBeCloseTo(15 / 40, 1);
    expect(a.y + a.height - measured.baseline).toBeCloseTo(measured.descent, 1);
  }, 30_000);

  test("empty replacements retain ordinary HTML and PNG bytes", async () => {
    const directory = await temporary();
    const markdown = "# 标题\n\n普通 **正文** &amp; 列表。\n\n- 第一项";
    const document = await prepareDocument(markdown);
    const ordinary = await renderDocument(
      await compileNoteMarkdown(markdown),
      `${directory}/ordinary`,
      700,
    );
    const prepared = await renderPreparedDocument(document, {
      directory: `${directory}/prepared`,
      width: 700,
      replacements: [],
    });
    expect(prepared.replacements).toEqual([]);
    expect(await readFile(prepared.htmlPath, "utf8")).toBe(
      await readFile(ordinary.htmlPath, "utf8"),
    );
    expect(
      (await readFile(prepared.imagePath)).equals(
        await readFile(ordinary.imagePath),
      ),
    ).toBe(true);
  }, 30_000);

  test("uses natural dimensions and the actual paragraph or list container width", async () => {
    const directory = await temporary();
    const document = await prepareDocument("# 标题\n\n段落\n\n- 列表");
    const replacements = await Promise.all([
      replacement(document, "标题", 40),
      replacement(document, "段落", 240),
      replacement(document, "列表", 240),
    ]);
    const result = await renderPreparedDocument(document, {
      directory,
      width: 500,
      replacements,
    });
    expect(
      result.replacements.map(({ mode, reason }) => ({ mode, reason })),
    ).toEqual([
      { mode: "ink", reason: undefined },
      { mode: "ink", reason: undefined },
      { mode: "font", reason: "too_wide" },
    ]);
    expect(result.replacements[0]?.bounds?.width).toBeCloseTo(96, 1);
    expect(result.replacements[0]?.bounds?.height).toBeCloseTo(48, 1);
    expect(result.replacements[1]?.bounds?.width).toBeCloseTo(240, 1);
    expect(result.warnings).toEqual([]);
    expect((await sharp(result.imagePath).metadata()).width).toBe(500);
    const state = await inspectHtml(result.htmlPath, 500, async (page) => ({
      paragraphImages: await page.locator("p img").count(),
      listText: await page.locator("li").textContent(),
      listImages: await page.locator("li img").count(),
    }));
    expect(state).toEqual({
      paragraphImages: 1,
      listText: "列表",
      listImages: 0,
    });
  }, 30_000);

  test("groups punctuation across font, image, strong and link boundaries without changing text", async () => {
    const directory = await temporary();
    const document = await prepareDocument(
      "甲（**乙**）丁[戊](https://example.test)，己 &amp; 庚。",
    );
    const result = await renderPreparedDocument(document, {
      directory,
      width: 500,
      replacements: await Promise.all([
        replacement(document, "乙", 200),
        replacement(document, "戊", 80),
      ]),
    });
    expect(result.replacements.every(({ mode }) => mode === "ink")).toBe(true);
    expect(result.warnings).toEqual([]);
    const state = await inspectHtml(result.htmlPath, 500, (page) =>
      page.evaluate(() => {
        const paragraph = globalThis.document.querySelector("p");
        if (!paragraph) throw new Error("Missing paragraph");
        const groups = Array.from(
          paragraph.querySelectorAll<HTMLElement>(".hn-ink-group"),
        );
        const summary = groups.map((group) => {
          const copy = group.cloneNode(true) as HTMLElement;
          for (const image of copy.querySelectorAll("img"))
            image.replaceWith(globalThis.document.createTextNode(image.alt));
          const image = group.querySelector("img");
          if (!image) throw new Error("Missing fragment");
          return {
            text: copy.textContent,
            width: group.getBoundingClientRect().width,
            weight: getComputedStyle(image).fontWeight,
            link: image.closest("a")?.getAttribute("href") ?? null,
          };
        });
        const copy = paragraph.cloneNode(true) as HTMLElement;
        for (const image of copy.querySelectorAll("img"))
          image.replaceWith(globalThis.document.createTextNode(image.alt));
        return { text: copy.textContent, groups: summary };
      }),
    );
    expect(state.text).toBe("甲（乙）丁戊，己 & 庚。");
    expect(state.groups[0]).toMatchObject({
      text: "（乙）",
      weight: "700",
      link: null,
    });
    expect(state.groups[0]?.width).toBeCloseTo(240, 0);
    expect(state.groups[1]).toMatchObject({
      text: "戊，",
      link: "https://example.test",
    });
  }, 30_000);

  test("falls back an entire overwide punctuation group at narrower widths", async () => {
    const directory = await temporary();
    const document = await prepareDocument("甲，乙");
    const ink = await replacement(document, "甲", 240);
    const wide = await renderPreparedDocument(document, {
      directory: `${directory}/wide`,
      width: 500,
      replacements: [ink],
    });
    const narrow = await renderPreparedDocument(document, {
      directory: `${directory}/narrow`,
      width: 490,
      replacements: [ink],
    });
    expect(wide.replacements[0]?.mode).toBe("ink");
    expect(narrow.replacements[0]).toMatchObject({
      mode: "font",
      reason: "punctuation_group_too_wide",
    });
    expect(narrow.warnings).toEqual([]);
    const state = await inspectHtml(narrow.htmlPath, 490, async (page) => ({
      text: await page.locator("p").textContent(),
      images: await page.locator("p img").count(),
      groups: await page.locator(".hn-ink-group").count(),
    }));
    expect(state).toEqual({ text: "甲，乙", images: 0, groups: 0 });
  }, 30_000);

  test("respects a baseline outside the fragment rectangle without distorting the image", async () => {
    const directory = await temporary();
    const document = await prepareDocument("甲乙");
    const ink = {
      ...(await replacement(document, "甲", 80, 20)),
      baseline: 30,
    };
    const result = await renderPreparedDocument(document, {
      directory,
      width: 700,
      replacements: [ink],
    });
    const metrics = await inspectHtml(result.htmlPath, 700, (page) =>
      page.evaluate(() => {
        const fragment =
          globalThis.document.querySelector<HTMLElement>(".hn-ink-fragment");
        if (!fragment) throw new Error("Missing fragment");
        const marker = globalThis.document.createElement("span");
        marker.style.cssText =
          "display:inline-block;width:0;height:0;vertical-align:baseline";
        fragment.after(marker);
        const rect = fragment.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          baselineGap: marker.getBoundingClientRect().top - rect.bottom,
        };
      }),
    );
    expect(metrics.width).toBeCloseTo(80, 1);
    expect(metrics.height).toBeCloseTo(20, 1);
    expect(metrics.baselineGap).toBeCloseTo(10, 1);
  }, 30_000);

  test("falls back every ink member of an overwide group and preserves empty fragment anchors", async () => {
    const directory = await temporary();
    const document = await prepareDocument(
      '[跳转](#anchor) 甲，<a id="anchor"></a>乙',
    );
    const result = await renderPreparedDocument(document, {
      directory,
      width: 490,
      replacements: await Promise.all([
        replacement(document, "甲", 130),
        replacement(document, "，", 130),
      ]),
    });
    expect(
      result.replacements.map(({ mode, reason }) => ({ mode, reason })),
    ).toEqual([
      { mode: "font", reason: "punctuation_group_too_wide" },
      { mode: "font", reason: "punctuation_group_too_wide" },
    ]);
    const state = await inspectHtml(result.htmlPath, 490, async (page) => ({
      text: await page.locator("p").textContent(),
      anchors: await page.locator("#user-content-anchor").count(),
      href: await page.getByRole("link", { name: "跳转" }).getAttribute("href"),
      widths: await page
        .locator("[data-hn-target]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().width),
        ),
    }));
    expect(state.text).toBe("跳转 甲，乙");
    expect(state.anchors).toBe(1);
    expect(state.href).toBe("#user-content-anchor");
    expect(state.widths).toEqual(
      result.replacements.map(({ bounds }) => bounds?.width ?? -1),
    );
    expect(result.warnings).toEqual([]);
  }, 30_000);

  test("rejects disguised SVG, invalid PNG dimensions, geometry, text and target identity", async () => {
    const document = await prepareDocument("甲乙");
    const ink = await replacement(document, "甲");
    const directory = await temporary();
    for (const changed of [
      {
        png: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><script>alert(1)</script></svg>',
        ),
      },
      { png: Buffer.from("not an image") },
      { width: 79 },
      { height: 0 },
      { lineHeight: 0 },
      { baseline: Number.NaN },
      { sourceId: " " },
      { text: "改写" },
    ])
      await expect(
        renderPreparedDocument(document, {
          directory,
          width: 700,
          replacements: [{ ...ink, ...changed }],
        }),
      ).rejects.toBeInstanceOf(InkReplacementError);
    await expect(
      renderPreparedDocument(document, {
        directory,
        width: 700,
        replacements: [
          { ...ink, target: { ...ink.target, documentHash: "stale" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "stale_document" });
    await expect(
      renderPreparedDocument(document, {
        directory,
        width: 700,
        replacements: [ink, ink],
      }),
    ).rejects.toMatchObject({ code: "overlapping_targets" });
    expect(await Bun.file(`${directory}/note.html`).exists()).toBe(false);
  });
});

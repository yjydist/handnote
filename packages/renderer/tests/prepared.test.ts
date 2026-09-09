import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  compileNoteMarkdown,
  type DocumentTarget,
  prepareDocument,
  TargetValidationError,
  validateTargets,
} from "@handnote/renderer";
import { clonePreparedDocument } from "../src/prepared.ts";

describe("prepared Markdown documents", () => {
  test("keeps inline formatting continuous but separates non-text and hard-break flows", async () => {
    for (const separator of ["`代码`", "$x$", "<br>", "![图](image.png)"]) {
      const document = await prepareDocument(`甲${separator}乙`, {
        resolveImage: async () => ({
          bytes: new Uint8Array([1]),
          mimeType: "image/png",
        }),
      });
      const first = document.textRanges.find((range) => range.text === "甲");
      const last = document.textRanges.find((range) => range.text === "乙");
      expect(first?.flowId).toBeDefined();
      expect(last?.flowId).toBeDefined();
      expect(first?.flowId).not.toBe(last?.flowId);
    }
    const formatted = await prepareDocument(
      "甲**乙**[丙](https://example.test)丁",
    );
    expect(
      new Set(formatted.textRanges.map((range) => range.flowId)).size,
    ).toBe(1);
    const nested = await prepareDocument("<div>甲<p>乙</p>丙</div>");
    expect(new Set(nested.textRanges.map((range) => range.flowId)).size).toBe(
      3,
    );
  });
  test("exposes decoded visible text with distinct formatting and block boundaries", async () => {
    const document = await prepareDocument(
      "# 标题\n\n正文 &amp; **加粗**与[链接](https://example.test)。\n\n3. 列表\n4. 重复\n\n重复",
    );
    expect(document.textRanges.map(({ text }) => text)).toEqual([
      "标题",
      "正文 & ",
      "加粗",
      "与",
      "链接",
      "。",
      "列表",
      "重复",
      "重复",
    ]);
    expect(document.textRanges[0]?.kind).toBe("heading");
    expect(document.textRanges[1]?.kind).toBe("paragraph");
    expect(document.textRanges[6]?.kind).toBe("list-item");
    expect(
      new Set(document.textRanges.map(({ rangeId }) => rangeId)).size,
    ).toBe(document.textRanges.length);
    expect(document.textRanges[1]?.blockId).toEqual(
      document.textRanges[5]?.blockId ?? "missing",
    );
    expect(document.textRanges[6]?.blockId).not.toBe(
      document.textRanges[7]?.blockId,
    );
    expect(document.textRanges[7]?.blockId).not.toBe(
      document.textRanges[8]?.blockId,
    );
  });

  test("collapses HTML whitespace across inline boundaries while preserving source offsets", async () => {
    const markdown =
      "<p>  甲  \n <strong> \t乙  </strong>  丙<br>  丁  </p>\n\n**戊** **己**";
    const document = await prepareDocument(markdown);
    expect(document.textRanges.map(({ text }) => text)).toEqual([
      "甲 ",
      "乙 ",
      "丙",
      "丁",
      "戊",
      " ",
      "己",
    ]);
    const clone = clonePreparedDocument(document);
    const range = document.textRanges.find(({ text }) => text === "乙 ");
    if (!range) throw new Error("Missing bold text range");
    const location = clone.ranges.get(range.rangeId);
    if (!location) throw new Error("Missing text location");
    const start = location.offsets[0];
    const end = location.offsets[1];
    expect(location.node.value.slice(start, end)).toBe("乙");
    const ordinary = await compileNoteMarkdown(markdown);
    expect(clone.note.html).toBe(ordinary.html);
    expect(clone.note.markdown).toBe(markdown);
  });

  test("excludes non-text structures and generated footnote labels without losing prose", async () => {
    const document = await prepareDocument(
      [
        "正文 `代码` $x$ 后文[^1]。",
        "$$\ny^2\n$$",
        "$$\n\\notACommand{\n$$",
        "| 表头 |\n| --- |\n| 表格 |",
        "```mermaid\nflowchart TD\n 图示 --> 不替换\n```",
        "```text\n代码块\n```",
        "![图片说明](figure.png)",
        "[^1]: 脚注正文。",
      ].join("\n\n"),
      {
        resolveImage: async () => ({
          bytes: new Uint8Array([1]),
          mimeType: "image/png",
        }),
      },
    );
    expect(document.textRanges.map(({ text }) => text).join("")).toBe(
      "正文   后文。脚注正文。 ",
    );
    expect(document.textRanges.every(({ kind }) => kind !== "heading")).toBe(
      true,
    );
  });

  test("uses sanitized structure when unsupported HTML tags become ordinary text", async () => {
    const markdown = "<figure>图内容<figcaption>图注</figcaption></figure>";
    expect((await compileNoteMarkdown(markdown)).html).toBe("图内容图注");
    const document = await prepareDocument(markdown);
    expect(document.textRanges.map(({ text }) => text).join("")).toBe(
      "图内容图注",
    );
  });

  test("keeps immutable document identity, stable range ids and isolated rendering copies", async () => {
    const markdown = "中文 **正文**。\n";
    const document = await prepareDocument(markdown);
    const repeated = await prepareDocument(markdown);
    expect(document.documentHash).toBe(
      createHash("sha256").update(markdown).digest("hex"),
    );
    expect(repeated).toEqual(document);
    expect((await prepareDocument(`${markdown}\n`)).documentHash).not.toBe(
      document.documentHash,
    );
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.textRanges)).toBe(true);
    expect(document.textRanges.every(Object.isFrozen)).toBe(true);
    expect(Object.keys(document).sort()).toEqual([
      "documentHash",
      "textRanges",
    ]);
    const first = clonePreparedDocument(document);
    const originalHtml = first.note.html;
    const location = first.ranges.values().next().value;
    if (!location) throw new Error("Missing rendering range");
    location.node.value = "changed";
    first.note.html = "changed";
    first.note.structure.blocks = -1;
    const second = clonePreparedDocument(document);
    expect(second.note.html).toBe(originalHtml);
    expect(second.note.structure.blocks).toBeGreaterThan(0);
    expect(second.ranges.values().next().value?.node.value).toBe("中文 ");
    expect(document.textRanges[0]?.text).toBe("中文 ");
  });
});

describe("document target validation", () => {
  test("accepts adjacent whole-character ranges, including supplementary characters", async () => {
    const document = await prepareDocument("甲𠮷乙");
    const rangeId = document.textRanges[0]?.rangeId ?? "missing";
    const target = (start: number, end: number): DocumentTarget => ({
      documentHash: document.documentHash,
      rangeId,
      start,
      end,
    });
    expect(() => validateTargets(document, [])).not.toThrow();
    expect(() =>
      validateTargets(document, [target(3, 4), target(0, 1), target(1, 3)]),
    ).not.toThrow();
  });

  test("rejects stale, missing, empty, fractional, out-of-bounds and split-character targets", async () => {
    const document = await prepareDocument("甲𠮷乙");
    const valid: DocumentTarget = {
      documentHash: document.documentHash,
      rangeId: document.textRanges[0]?.rangeId ?? "missing",
      start: 0,
      end: 1,
    };
    for (const [changes, code] of [
      [{ documentHash: "old" }, "stale_document"],
      [{ rangeId: "absent" }, "unknown_range"],
      [{ start: 1, end: 1 }, "invalid_offset"],
      [{ start: 2, end: 1 }, "invalid_offset"],
      [{ start: -1 }, "invalid_offset"],
      [{ start: 0.5 }, "invalid_offset"],
      [{ start: Number.NaN }, "invalid_offset"],
      [{ end: Number.POSITIVE_INFINITY }, "invalid_offset"],
      [{ end: 5 }, "invalid_offset"],
      [{ start: 2, end: 3 }, "invalid_offset"],
      [{ start: 1, end: 2 }, "invalid_offset"],
    ] as const) {
      expect(() =>
        validateTargets(document, [{ ...valid, ...changes }]),
      ).toThrow(TargetValidationError);
      try {
        validateTargets(document, [{ ...valid, ...changes }]);
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
    expect(() => validateTargets({ ...document }, [valid])).toThrow(
      "Use a document returned by prepareDocument",
    );
    const spaced = await prepareDocument("甲 乙");
    expect(() =>
      validateTargets(spaced, [
        {
          documentHash: spaced.documentHash,
          rangeId: spaced.textRanges[0]?.rangeId ?? "missing",
          start: 1,
          end: 2,
        },
      ]),
    ).toThrow("Target offsets must select nonempty whole characters");
  });

  test("rejects overlapping targets regardless of ordering without conflating repeated text", async () => {
    const document = await prepareDocument("重复文字\n\n重复文字");
    const target = (
      range: number,
      start: number,
      end: number,
    ): DocumentTarget => ({
      documentHash: document.documentHash,
      rangeId: document.textRanges[range]?.rangeId ?? "missing",
      start,
      end,
    });
    expect(() =>
      validateTargets(document, [target(0, 1, 3), target(0, 0, 2)]),
    ).toThrow("Targets overlap");
    expect(() =>
      validateTargets(document, [target(0, 0, 1), target(0, 0, 1)]),
    ).toThrow("Targets overlap");
    expect(() =>
      validateTargets(document, [target(0, 0, 4), target(1, 0, 4)]),
    ).not.toThrow();
  });
});

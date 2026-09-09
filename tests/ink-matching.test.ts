import { expect, test } from "bun:test";
import { prepareDocument } from "@handnote/renderer";
import { type MatchingSource, matchInkSources } from "../src/ink-matching.ts";

function source(id: number, text: string, lineText = text): MatchingSource {
  return {
    id: `source-${id}`,
    sourceHash: "source",
    strokeIndices: [id],
    text,
    lineId: `line-${id}`,
    lineText,
    occurrence: {
      start: lineText.indexOf(text),
      end: lineText.indexOf(text) + text.length,
    },
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    lineHeight: 20,
    baseline: 18,
    status: "pending-human-review",
  };
}

test("matches exact excerpts after paragraph movement and leaves added text in font", async () => {
  const document = await prepareDocument("乙段\n\n甲段新增");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "甲段"), source(2, "乙段")],
    ["甲段", "乙段"],
  );
  expect(report.bindings.map((b) => b.text).sort()).toEqual(
    ["乙段", "甲段"].sort(),
  );
  expect(report.fontRanges.map((r) => r.text)).toEqual(["新增"]);
});

test("uses unique occurrence context for repeated words without relying on document order", async () => {
  const document = await prepareDocument("夏天的天气\n\n冬天的天气");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气", "冬天的天气"), source(2, "天气", "夏天的天气")],
    ["冬天的天气", "夏天的天气"],
  );
  expect(report.bindings).toHaveLength(2);
  expect(
    report.bindings.find((b) => b.sourceId === "source-1")?.target.rangeId,
  ).toBe(document.textRanges[1]?.rangeId ?? "missing");
});

test("does not borrow one reliable instance when another identical occurrence lacks usable ink", async () => {
  const document = await prepareDocument("天气");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气")],
    ["天气", "天气"],
  );
  expect(report.bindings).toEqual([]);
  expect(report.unusedSources[0]?.reason).toBe("ambiguous-occurrence");
});

test("rejects semantic rewrites and complete fragments spanning format boundaries", async () => {
  const document = await prepareDocument("可得\n\n天气**晴朗**");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "可以得到"), source(2, "天气晴朗")],
    ["可以得到", "天气晴朗"],
  );
  expect(report.bindings).toEqual([]);
  expect(report.unusedSources.map((r) => r.reason)).toEqual([
    "no-exact-target",
    "format-boundary",
  ]);
});

test("conflicting source strokes fall back independently of candidate order", async () => {
  const document = await prepareDocument("甲段\n\n乙段");
  const sources = [
    source(1, "甲段"),
    { ...source(2, "乙段"), strokeIndices: [1] },
  ];
  for (const values of [sources, [...sources].reverse()])
    expect(
      matchInkSources(document, "source", values, ["甲段", "乙段"]).bindings,
    ).toEqual([]);
  expect(() =>
    matchInkSources(document, "changed", sources, ["甲段", "乙段"]),
  ).toThrow("stale");
});

test("does not borrow unique fragments from unrelated source sentences for added text", async () => {
  for (const [text, line, target] of [
    ["新", "旧物换新", "这里增加新的定义。"],
    ["天气", "今天的天气不错", "新增天气预报栏目。"],
  ] as const) {
    const document = await prepareDocument(target);
    const report = matchInkSources(
      document,
      "source",
      [source(1, text, line)],
      [line],
    );
    expect(report.bindings).toEqual([]);
    expect(report.unusedSources[0]?.reason).toBe("no-exact-context");
    expect(report.fontRanges.map((range) => range.text)).toEqual([target]);
  }
});

test("does not invent continuous source context across excluded inline content or a hard break", async () => {
  for (const separator of ["`代码`", "$x$", "<br>", "![图](image.png)"]) {
    const document = await prepareDocument(`甲${separator}乙`, {
      resolveImage: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
      }),
    });
    const report = matchInkSources(
      document,
      "source",
      [source(1, "甲", "甲乙")],
      ["甲乙"],
    );
    expect(report.bindings).toEqual([]);
  }
});

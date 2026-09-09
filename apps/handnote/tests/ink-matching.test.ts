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

function lines(...texts: string[]) {
  return texts.map((text, index) => ({
    lineId: `line-${index + 1}`,
    text,
    bounds: { x: 0, y: index * 30, width: 200, height: 20 },
  }));
}

test("matches complete sentences after paragraph movement and leaves added sentences in font", async () => {
  const document = await prepareDocument("乙段。\n\n甲段。新增。");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "甲段", "甲段。"), source(2, "乙段", "乙段。")],
    lines("甲段。", "乙段。"),
  );
  expect(report.bindings.map((b) => b.text).sort()).toEqual(
    ["乙段", "甲段"].sort(),
  );
  expect(report.fontRanges.map((r) => r.text)).toEqual(["。", "。新增。"]);
});

test("uses unique occurrence context for repeated words without relying on document order", async () => {
  const document = await prepareDocument("夏天的天气\n\n冬天的天气");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气", "冬天的天气"), source(2, "天气", "夏天的天气")],
    lines("冬天的天气", "夏天的天气"),
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
    lines("天气", "天气"),
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
    lines("可以得到", "天气晴朗"),
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
      matchInkSources(document, "source", values, lines("甲段", "乙段"))
        .bindings,
    ).toEqual([]);
  expect(() =>
    matchInkSources(document, "changed", sources, lines("甲段", "乙段")),
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
      lines(line),
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
      lines("甲乙"),
    );
    expect(report.bindings).toEqual([]);
  }
});

test("does not bind standalone source lines into longer rewritten targets", async () => {
  for (const [original, target] of [
    ["聚落", "聚落类型"],
    ["甲段", "甲段新增"],
  ] as const) {
    const document = await prepareDocument(target);
    const report = matchInkSources(
      document,
      "source",
      [source(1, original)],
      lines(original),
    );
    expect(report.bindings).toEqual([]);
    expect(report.unusedSources[0]?.reason).toBe("no-exact-context");
  }
});

test("does not borrow context across HTML block separators or collapsed content", async () => {
  for (const markdown of [
    "<div>甲<hr>乙</div>",
    "<dl><dt>甲</dt><dd>乙</dd></dl>",
    "<details><summary>甲</summary>乙</details>",
  ]) {
    const document = await prepareDocument(markdown);
    expect(
      matchInkSources(
        document,
        "source",
        [source(1, "甲", "甲乙")],
        lines("甲乙"),
      ).bindings,
    ).toEqual([]);
  }
});

test("retains sentence punctuation and formatting boundaries in passage evidence", async () => {
  const document = await prepareDocument("新增。\n\n他说：“天气**晴朗**。”");
  const original = "他说：“天气晴朗。”";
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气", original)],
    lines(original),
  );
  expect(report.bindings.map((binding) => binding.text)).toEqual(["天气"]);
  expect(report.alignments[0]).toMatchObject({
    sourceLineId: "line-1",
    text: original,
    sourceStart: 0,
    sourceEnd: original.length,
  });
  const changed = await prepareDocument("他说天气晴朗");
  expect(
    matchInkSources(
      changed,
      "source",
      [source(1, "天气", original)],
      lines(original),
    ).bindings,
  ).toEqual([]);
});

test("validates source line identity and positions and counts unusable repeated source lines", async () => {
  const document = await prepareDocument("天气");
  const record = source(1, "天气");
  const line = lines("天气")[0];
  if (!line) throw new Error("Missing line");
  expect(() =>
    matchInkSources(document, "source", [record], [line, line]),
  ).toThrow("identity");
  expect(() =>
    matchInkSources(
      document,
      "source",
      [{ ...record, lineId: "missing" }],
      lines("天气"),
    ),
  ).toThrow("stale");
  expect(
    matchInkSources(document, "source", [record], lines("天气", "天气"))
      .bindings,
  ).toEqual([]);
});

test("boundary edits are opt-in and retain real offsets after a circled marker and added punctuation", async () => {
  for (const marker of ["①", "④"]) {
    const original = `${marker} 结尾方式：悲剧式、喜剧式`;
    const text = "悲剧式、喜剧式";
    const document = await prepareDocument("结尾方式：悲剧式、喜剧式。");
    const records = [source(1, text, original)];
    const sourceLines = lines(original);
    const exact = matchInkSources(document, "source", records, sourceLines);
    expect(exact.bindings).toEqual([]);
    expect(
      matchInkSources(document, "source", records, sourceLines, {
        context: "exact",
      }),
    ).toEqual(exact);
    const report = matchInkSources(document, "source", records, sourceLines, {
      context: "boundary-edits",
    });
    expect(report.bindings.map((binding) => binding.text)).toEqual([text]);
    expect(report.alignments).toEqual([
      {
        sourceLineId: "line-1",
        sourceStart: 2,
        sourceEnd: original.length,
        targetFlowId: document.textRanges[0]?.flowId ?? "missing",
        targetStart: 0,
        targetEnd: original.length - 2,
        text: original.slice(2),
      },
    ]);
    expect(report.fontRanges.map((range) => range.text)).toEqual([
      "结尾方式：",
      "。",
    ]);
    const binding = report.bindings[0];
    const targetRange = document.textRanges.find(
      (range) => range.rangeId === binding?.target.rangeId,
    );
    expect(
      targetRange?.text.slice(binding?.target.start, binding?.target.end),
    ).toBe(text);
  }
});

test("boundary edits leave changed markers and terminal punctuation in font without cutting source fragments", async () => {
  const document = await prepareDocument("① 天气！");
  const original = "④ 天气。";
  const records = [
    source(1, "天气", original),
    { ...source(2, "④", original), lineId: "line-1" },
    { ...source(3, "。", original), lineId: "line-1" },
  ];
  const report = matchInkSources(document, "source", records, lines(original), {
    context: "boundary-edits",
  });
  expect(report.bindings.map((binding) => binding.text)).toEqual(["天气"]);
  expect(report.fontRanges.map((range) => range.text)).toEqual(["① ", "！"]);
  expect(report.unusedSources.map((item) => item.sourceId)).toEqual([
    "source-2",
    "source-3",
  ]);
  expect(
    matchInkSources(
      document,
      "source",
      [source(1, original)],
      lines(original),
      { context: "boundary-edits" },
    ).bindings,
  ).toEqual([]);
});

test("boundary edits count duplicate bodies from unavailable source lines and repeated target bodies", async () => {
  for (const sourceTexts of [
    ["①天气", "④天气"],
    ["①天气", "天气。"],
  ]) {
    const document = await prepareDocument("天气。");
    const original = sourceTexts[0];
    if (!original) throw new Error("Missing original");
    const report = matchInkSources(
      document,
      "source",
      [source(1, "天气", original)],
      lines(...sourceTexts),
      { context: "boundary-edits" },
    );
    expect(report.bindings).toEqual([]);
    expect(report.unusedSources[0]?.reason).toBe("ambiguous-occurrence");
  }
  const document = await prepareDocument("天气。\n\n天气！");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气", "①天气")],
    lines("①天气"),
    { context: "boundary-edits" },
  );
  expect(report.bindings).toEqual([]);
  expect(report.unusedSources[0]?.reason).toBe("ambiguous-occurrence");
});

test("boundary variants never create empty passages or ignore internal edits and other boundary characters", async () => {
  for (const [original, target, fragment] of [
    ["④。！？", "①!", "。"],
    ["①聚落", "聚落类型。", "聚落"],
    ["①天气晴朗", "天气变晴朗。", "天气"],
    ["①天气，晴朗", "天气晴朗。", "天气"],
    ["1.天气", "天气。", "天气"],
    ["①天气，", "天气。", "天气"],
  ] as const) {
    const document = await prepareDocument(target);
    const report = matchInkSources(
      document,
      "source",
      [source(1, fragment, original)],
      lines(original),
      { context: "boundary-edits" },
    );
    expect(report.bindings).toEqual([]);
    expect(
      report.alignments.every((alignment) => alignment.text.length > 0),
    ).toBe(true);
  }
});

test("boundary edits retain formatting boundaries and decimal points", async () => {
  const document = await prepareDocument("天气**晴朗**。");
  const report = matchInkSources(
    document,
    "source",
    [source(1, "天气晴朗", "①天气晴朗")],
    lines("①天气晴朗"),
    { context: "boundary-edits" },
  );
  expect(report.bindings).toEqual([]);
  expect(report.unusedSources[0]?.reason).toBe("format-boundary");
  const decimal = await prepareDocument("3.14。");
  const decimalReport = matchInkSources(
    decimal,
    "source",
    [source(1, "3.14", "①3.14")],
    lines("①3.14"),
    { context: "boundary-edits" },
  );
  expect(decimalReport.bindings.map((binding) => binding.text)).toEqual([
    "3.14",
  ]);
  expect(decimalReport.fontRanges.map((range) => range.text)).toEqual(["。"]);
  expect(
    matchInkSources(
      await prepareDocument("3.14"),
      "source",
      [source(1, "3.14", "3.14.")],
      lines("3.14."),
      { context: "boundary-edits" },
    ).bindings,
  ).toEqual([]);
});

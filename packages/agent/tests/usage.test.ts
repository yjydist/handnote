import { expect, test } from "bun:test";
import { accumulateStepUsage } from "../src/usage.ts";

test("accumulates a step without changing the previous snapshot", () => {
  const total = Object.freeze({
    outputTokens: 10,
    reasoningTokens: 4,
    textOutputTokens: 6,
  });
  const step = Object.freeze({ outputTokens: 8 });
  expect(accumulateStepUsage(total, step)).toEqual({
    outputTokens: 18,
    reasoningTokens: 4,
    textOutputTokens: 6,
  });
  expect(total).toEqual({
    outputTokens: 10,
    reasoningTokens: 4,
    textOutputTokens: 6,
  });
  expect(step).toEqual({ outputTokens: 8 });
});

test.each([
  { name: "missing", value: undefined },
  { name: "null", value: null },
  { name: "string", value: "4" },
  { name: "NaN", value: Number.NaN },
  { name: "positive infinity", value: Number.POSITIVE_INFINITY },
  { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
])("does not derive text tokens from $name usage", ({ value }) => {
  expect(
    accumulateStepUsage({}, { outputTokens: 10, reasoningTokens: value }),
  ).toEqual({ outputTokens: 10 });
  expect(
    accumulateStepUsage({}, { outputTokens: value, reasoningTokens: 4 }),
  ).toEqual({ reasoningTokens: 4 });
  expect(
    accumulateStepUsage(
      {},
      { inputTokens: value, cachedInputTokens: value, totalTokens: value },
    ),
  ).toEqual({});
});

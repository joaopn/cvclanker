// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeTokensPerSec, computeTotalTokens, extractUsage } from "./usage";

describe("extractUsage", () => {
  it("reads OpenAI / OpenRouter chat-completions usage", () => {
    expect(
      extractUsage({
        choices: [{}],
        usage: { prompt_tokens: 1234, completion_tokens: 56 },
      }),
    ).toEqual({ promptTokens: 1234, completionTokens: 56 });
  });

  it("reads OpenAI Responses API usage (input_tokens / output_tokens)", () => {
    expect(
      extractUsage({
        usage: { input_tokens: 100, output_tokens: 25 },
      }),
    ).toEqual({ promptTokens: 100, completionTokens: 25 });
  });

  it("reads Gemini usageMetadata", () => {
    expect(
      extractUsage({
        usageMetadata: {
          promptTokenCount: 80,
          candidatesTokenCount: 12,
          totalTokenCount: 92,
        },
      }),
    ).toEqual({ promptTokens: 80, completionTokens: 12 });
  });

  it("returns nulls when neither key shape is present", () => {
    expect(extractUsage({ choices: [{ message: {} }] })).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("returns nulls for non-object inputs", () => {
    expect(extractUsage(null)).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
    expect(extractUsage("string")).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
    expect(extractUsage([])).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("ignores non-numeric token values", () => {
    expect(
      extractUsage({
        usage: { prompt_tokens: "garbage", completion_tokens: NaN },
      }),
    ).toEqual({ promptTokens: null, completionTokens: null });
  });

  it("returns one half when only one side is present", () => {
    expect(
      extractUsage({ usage: { prompt_tokens: 50 } }),
    ).toEqual({ promptTokens: 50, completionTokens: null });
  });
});

describe("computeTotalTokens", () => {
  it("sums both provider-reported halves", () => {
    expect(
      computeTotalTokens({ promptTokens: 1234, completionTokens: 56 }),
    ).toBe(1290);
  });

  it("returns the known half when the other is missing", () => {
    expect(
      computeTotalTokens({ promptTokens: 50, completionTokens: null }),
    ).toBe(50);
    expect(
      computeTotalTokens({ promptTokens: null, completionTokens: 7 }),
    ).toBe(7);
  });

  it("returns null when the provider reported no usage", () => {
    expect(
      computeTotalTokens({ promptTokens: null, completionTokens: null }),
    ).toBeNull();
    expect(computeTotalTokens(null)).toBeNull();
    expect(computeTotalTokens(undefined)).toBeNull();
  });

  it("treats a zeroed usage block as no usage", () => {
    expect(
      computeTotalTokens({ promptTokens: 0, completionTokens: 0 }),
    ).toBeNull();
    expect(
      computeTotalTokens({ promptTokens: 0, completionTokens: null }),
    ).toBeNull();
  });

  it("keeps a non-zero total when only one half is zero", () => {
    expect(
      computeTotalTokens({ promptTokens: 1234, completionTokens: 0 }),
    ).toBe(1234);
  });
});

describe("computeTokensPerSec", () => {
  it("returns the rate rounded to one decimal", () => {
    expect(computeTokensPerSec(100, 1000)).toBe(100);
    expect(computeTokensPerSec(123, 1000)).toBe(123);
    expect(computeTokensPerSec(50, 250)).toBe(200);
    expect(computeTokensPerSec(33, 1000)).toBe(33);
    expect(computeTokensPerSec(7, 333)).toBe(21); // ~21.02 rounded to 21
  });

  it("returns null when completion tokens are unknown", () => {
    expect(computeTokensPerSec(null, 1000)).toBeNull();
  });

  it("returns null for non-positive duration", () => {
    expect(computeTokensPerSec(100, 0)).toBeNull();
    expect(computeTokensPerSec(100, -5)).toBeNull();
  });
});

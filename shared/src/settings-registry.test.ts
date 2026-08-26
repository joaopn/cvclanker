import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  getDefaultModelForProvider,
  MAX_LATEX_COMPILE_TIMEOUT_MS,
  MAX_LLM_REQUEST_TIMEOUT_MS,
  MAX_POOL_CONCURRENCY,
  MIN_LATEX_COMPILE_TIMEOUT_MS,
  MIN_LLM_REQUEST_TIMEOUT_MS,
  settingsRegistry,
} from "./settings-registry";

describe("settingsRegistry helpers", () => {
  describe("string parsing (parseNonEmptyStringOrNull)", () => {
    it("returns null for undefined", () => {
      expect(settingsRegistry.model.parse(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(settingsRegistry.model.parse("")).toBeNull();
    });

    it("returns the string for non-empty string", () => {
      expect(settingsRegistry.model.parse("gpt-test")).toBe("gpt-test");
    });
  });

  describe("number parsing and clamping", () => {
    it("returns null for empty/invalid values", () => {
      expect(settingsRegistry.missingSalaryPenalty.parse("")).toBeNull();
      expect(settingsRegistry.missingSalaryPenalty.parse("abc")).toBeNull();
      expect(settingsRegistry.missingSalaryPenalty.parse(undefined)).toBeNull();
    });

    it("parses valid numbers", () => {
      expect(settingsRegistry.missingSalaryPenalty.parse("42")).toBe(42);
    });

    it("clamps missingSalaryPenalty to 0-100", () => {
      expect(settingsRegistry.missingSalaryPenalty.parse("150")).toBe(100);
      expect(settingsRegistry.missingSalaryPenalty.parse("-10")).toBe(0);
      expect(settingsRegistry.missingSalaryPenalty.parse("50")).toBe(50);
    });
  });

  describe("concurrency limits", () => {
    const keys = [
      "discoveryConcurrency",
      "scoringConcurrency",
      "tailoringConcurrency",
      "bulkActionConcurrency",
      "batchUrlImportConcurrency",
    ] as const;

    it("carries the pre-settings hardcoded values as defaults", () => {
      expect(settingsRegistry.discoveryConcurrency.default()).toBe(3);
      expect(settingsRegistry.scoringConcurrency.default()).toBe(4);
      expect(settingsRegistry.tailoringConcurrency.default()).toBe(3);
      expect(settingsRegistry.bulkActionConcurrency.default()).toBe(4);
      expect(settingsRegistry.batchUrlImportConcurrency.default()).toBe(3);
    });

    // The max mirrors asyncPool's hard clamp (MAX_POOL_CONCURRENCY) — a
    // larger stored value would silently not apply, so the schema must
    // refuse it at save time.
    it("accepts 1 through the shared ceiling and rejects out-of-range or fractional values", () => {
      for (const key of keys) {
        const schema = settingsRegistry[key].schema;
        expect(schema.safeParse(1).success).toBe(true);
        expect(schema.safeParse(MAX_POOL_CONCURRENCY).success).toBe(true);
        expect(schema.safeParse(0).success).toBe(false);
        expect(schema.safeParse(MAX_POOL_CONCURRENCY + 1).success).toBe(false);
        expect(schema.safeParse(2.5).success).toBe(false);
      }
    });

    // The background-tailor FIFO consumes the value with no downstream
    // asyncPool clamp, so the read path must clamp out-of-band stored values
    // itself — a raw 0 would stall the queue forever.
    it("clamps out-of-band stored values to the shared ceiling on read", () => {
      for (const key of keys) {
        expect(settingsRegistry[key].parse("0")).toBe(1);
        expect(settingsRegistry[key].parse("-3")).toBe(1);
        expect(settingsRegistry[key].parse("100000")).toBe(
          MAX_POOL_CONCURRENCY,
        );
        expect(settingsRegistry[key].parse("5")).toBe(5);
        expect(settingsRegistry[key].parse("abc")).toBeNull();
        expect(settingsRegistry[key].parse(undefined)).toBeNull();
      }
    });
  });

  // Both timeout keys are built from one clamping parser factory. The two
  // windows happen to be identical today, so asserting bounds alone would NOT
  // catch a key wired to the other key's parser — the wiring is pinned
  // structurally instead, and the bounds are pinned so a future divergence of
  // the two windows stays honest.
  describe("timeout limits", () => {
    const cases = [
      {
        key: "llmRequestTimeoutMs",
        min: MIN_LLM_REQUEST_TIMEOUT_MS,
        max: MAX_LLM_REQUEST_TIMEOUT_MS,
        expectedDefault: DEFAULT_LLM_REQUEST_TIMEOUT_MS,
      },
      {
        key: "latexCompileTimeoutMs",
        min: MIN_LATEX_COMPILE_TIMEOUT_MS,
        max: MAX_LATEX_COMPILE_TIMEOUT_MS,
        expectedDefault: DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
      },
    ] as const;

    it("carries the documented defaults", () => {
      expect(settingsRegistry.llmRequestTimeoutMs.default()).toBe(300_000);
      expect(settingsRegistry.latexCompileTimeoutMs.default()).toBe(600_000);
    });

    // timeoutMsParser builds a new closure on every call, so sharing one
    // exported parser between the two keys is the mis-wiring this catches. It
    // cannot catch a factory called with the wrong constants: while the two
    // windows are numerically identical, nothing here can.
    it("gives each key its own parser rather than sharing one closure", () => {
      expect(settingsRegistry.latexCompileTimeoutMs.parse).not.toBe(
        settingsRegistry.llmRequestTimeoutMs.parse,
      );
    });

    it("accepts its own window and rejects out-of-range or fractional values", () => {
      for (const { key, min, max } of cases) {
        const schema = settingsRegistry[key].schema;
        expect(schema.safeParse(min).success).toBe(true);
        expect(schema.safeParse(max).success).toBe(true);
        expect(schema.safeParse(min - 1).success).toBe(false);
        expect(schema.safeParse(max + 1).success).toBe(false);
        expect(schema.safeParse(min + 0.5).success).toBe(false);
      }
    });

    // A 0 stored out of band would disable the deadline entirely, which is
    // the failure both settings exist to prevent.
    it("clamps out-of-band stored values to its own bounds on read", () => {
      for (const { key, min, max, expectedDefault } of cases) {
        expect(settingsRegistry[key].parse("0")).toBe(min);
        expect(settingsRegistry[key].parse("-3")).toBe(min);
        expect(settingsRegistry[key].parse("99999999")).toBe(max);
        expect(settingsRegistry[key].parse(String(expectedDefault))).toBe(
          expectedDefault,
        );
        expect(settingsRegistry[key].parse("abc")).toBeNull();
        expect(settingsRegistry[key].parse(undefined)).toBeNull();
      }
    });

    // The envKey trap: an env-reading default() echoes a stored override back
    // as the default, and the client's nullIfSame then drops an unchanged save.
    it("does not read process.env in default()", () => {
      const previous = process.env.LATEX_COMPILE_TIMEOUT_MS;
      process.env.LATEX_COMPILE_TIMEOUT_MS = "123456";
      try {
        expect(settingsRegistry.latexCompileTimeoutMs.default()).toBe(
          DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
        );
      } finally {
        if (previous === undefined) {
          delete process.env.LATEX_COMPILE_TIMEOUT_MS;
        } else {
          process.env.LATEX_COMPILE_TIMEOUT_MS = previous;
        }
      }
    });
  });

  describe("boolean (bit-bool) parsing and serialization", () => {
    it("parses bit bools correctly", () => {
      expect(settingsRegistry.showSponsorInfo.parse("1")).toBe(true);
      expect(settingsRegistry.showSponsorInfo.parse("true")).toBe(true);
      expect(settingsRegistry.showSponsorInfo.parse("0")).toBe(false);
      expect(settingsRegistry.showSponsorInfo.parse("false")).toBe(false);
      expect(settingsRegistry.showSponsorInfo.parse("")).toBeNull();
      expect(settingsRegistry.showSponsorInfo.parse(undefined)).toBeNull();
      expect(settingsRegistry.renderMarkdownInJobDescriptions.parse("1")).toBe(
        true,
      );
      expect(settingsRegistry.renderMarkdownInJobDescriptions.parse("0")).toBe(
        false,
      );
    });

    it("serializes bit bools correctly", () => {
      expect(settingsRegistry.showSponsorInfo.serialize(true)).toBe("1");
      expect(settingsRegistry.showSponsorInfo.serialize(false)).toBe("0");
      expect(settingsRegistry.showSponsorInfo.serialize(null)).toBeNull();
      expect(settingsRegistry.showSponsorInfo.serialize(undefined)).toBeNull();
      expect(
        settingsRegistry.renderMarkdownInJobDescriptions.serialize(true),
      ).toBe("1");
      expect(
        settingsRegistry.renderMarkdownInJobDescriptions.serialize(false),
      ).toBe("0");
    });
  });

  describe("writing-style language settings", () => {
    it("defaults to manual english", () => {
      const previousLanguageMode = process.env.CHAT_STYLE_LANGUAGE_MODE;
      const previousManualLanguage = process.env.CHAT_STYLE_MANUAL_LANGUAGE;

      delete process.env.CHAT_STYLE_LANGUAGE_MODE;
      delete process.env.CHAT_STYLE_MANUAL_LANGUAGE;

      try {
        expect(settingsRegistry.chatStyleLanguageMode.default()).toBe("manual");
        expect(settingsRegistry.chatStyleManualLanguage.default()).toBe(
          "english",
        );
      } finally {
        if (previousLanguageMode === undefined) {
          delete process.env.CHAT_STYLE_LANGUAGE_MODE;
        } else {
          process.env.CHAT_STYLE_LANGUAGE_MODE = previousLanguageMode;
        }

        if (previousManualLanguage === undefined) {
          delete process.env.CHAT_STYLE_MANUAL_LANGUAGE;
        } else {
          process.env.CHAT_STYLE_MANUAL_LANGUAGE = previousManualLanguage;
        }
      }
    });

    it("parses and serializes supported language settings", () => {
      expect(settingsRegistry.chatStyleLanguageMode.parse("manual")).toBe(
        "manual",
      );
      expect(settingsRegistry.chatStyleLanguageMode.parse("match-resume")).toBe(
        "match-resume",
      );
      expect(settingsRegistry.chatStyleLanguageMode.parse("auto")).toBeNull();
      expect(settingsRegistry.chatStyleLanguageMode.parse("")).toBeNull();
      expect(
        settingsRegistry.chatStyleLanguageMode.serialize("match-resume"),
      ).toBe("match-resume");
      expect(settingsRegistry.chatStyleLanguageMode.serialize(null)).toBeNull();

      expect(settingsRegistry.chatStyleManualLanguage.parse("english")).toBe(
        "english",
      );
      expect(settingsRegistry.chatStyleManualLanguage.parse("german")).toBe(
        "german",
      );
      expect(
        settingsRegistry.chatStyleManualLanguage.parse("italian"),
      ).toBeNull();
      expect(settingsRegistry.chatStyleManualLanguage.parse("")).toBeNull();
      expect(
        settingsRegistry.chatStyleManualLanguage.serialize("spanish"),
      ).toBe("spanish");
      expect(
        settingsRegistry.chatStyleManualLanguage.serialize(null),
      ).toBeNull();
    });
  });

  describe("LLM provider parsing", () => {
    it("normalizes the documented openai-compatible alias", () => {
      expect(settingsRegistry.llmProvider.parse("openai-compatible")).toBe(
        "openai_compatible",
      );
      expect(settingsRegistry.llmProvider.parse("OPENAI-COMPATIBLE")).toBe(
        "openai_compatible",
      );
    });

    it("uses provider-specific default models", () => {
      expect(getDefaultModelForProvider("openai")).toBe("gpt-5.4-mini");
      expect(getDefaultModelForProvider("gemini")).toBe(
        "google/gemini-3-flash-preview",
      );
      expect(getDefaultModelForProvider("codex")).toBe("");
      // Empty means "let the Claude Code CLI choose", same contract as codex.
      expect(getDefaultModelForProvider("claude_code")).toBe("");
      expect(getDefaultModelForProvider("openrouter")).toBe(
        "google/gemini-3-flash-preview",
      );
    });

    it("accepts claude_code as an llmProvider value", () => {
      expect(settingsRegistry.llmProvider.parse("claude-code")).toBe(
        "claude_code",
      );
      expect(
        settingsRegistry.llmProvider.schema.safeParse("claude_code").success,
      ).toBe(true);
    });

    it("pins claudeCodeEffort to the CLI's accepted levels and its envKey", () => {
      expect(settingsRegistry.claudeCodeEffort.envKey).toBe(
        "CLAUDE_CODE_EFFORT",
      );
      for (const level of CLAUDE_CODE_EFFORT_LEVELS) {
        expect(
          settingsRegistry.claudeCodeEffort.schema.safeParse(level).success,
        ).toBe(true);
      }
      expect(
        settingsRegistry.claudeCodeEffort.schema.safeParse("turbo").success,
      ).toBe(false);
      expect(
        settingsRegistry.claudeCodeEffort.schema.safeParse("").success,
      ).toBe(false);
    });
  });
});

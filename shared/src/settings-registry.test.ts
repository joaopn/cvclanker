import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  getDefaultModelForProvider,
  MAX_POOL_CONCURRENCY,
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

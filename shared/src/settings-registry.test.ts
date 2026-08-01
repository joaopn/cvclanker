import { describe, expect, it } from "vitest";
import {
  getDefaultModelForProvider,
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
  });
});

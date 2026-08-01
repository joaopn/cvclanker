import { describe, expect, it } from "vitest";
import {
  getLlmProviderConfig,
  normalizeLlmProvider,
  supportsLlmModelSuggestions,
} from "./utils";

describe("settings utils", () => {
  it("treats openai-compatible as a dedicated configurable provider", () => {
    const config = getLlmProviderConfig("openai_compatible");

    expect(config.label).toBe("OpenAI-compatible");
    expect(config.showApiKey).toBe(true);
    expect(config.showBaseUrl).toBe(true);
    expect(config.baseUrlPlaceholder).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("exposes provider key links for hosted providers", () => {
    expect(getLlmProviderConfig("openrouter").keyHelperHref).toBe(
      "https://openrouter.ai/keys",
    );
    expect(getLlmProviderConfig("openai").keyHelperHref).toBe(
      "https://platform.openai.com/api-keys",
    );
    expect(getLlmProviderConfig("gemini").keyHelperHref).toBe(
      "https://aistudio.google.com/app/apikey",
    );
    expect(getLlmProviderConfig("ollama").keyHelperHref).toBeNull();
    expect(getLlmProviderConfig("codex").keyHelperHref).toBeNull();
  });

  it("treats codex as a local provider without API key and base URL inputs", () => {
    const config = getLlmProviderConfig("codex");
    expect(config.showApiKey).toBe(false);
    expect(config.showBaseUrl).toBe(false);
  });

  // Claude Code authenticates with its own CLAUDE_CODE_OAUTH_TOKEN secret, not
  // the shared llmApiKey — sharing that field let a stale key from a previously
  // configured provider shadow a working token.
  it("does not offer the shared API key field for claude code", () => {
    const config = getLlmProviderConfig("claude_code");

    expect(config.label).toBe("Claude Code");
    expect(config.showApiKey).toBe(false);
    expect(config.showBaseUrl).toBe(false);
  });

  it("keeps key-bearing providers required", () => {
    expect(getLlmProviderConfig("openai").requiresApiKey).toBe(true);
    expect(getLlmProviderConfig("openrouter").requiresApiKey).toBe(true);
    expect(getLlmProviderConfig("gemini").requiresApiKey).toBe(true);
    expect(getLlmProviderConfig("openai_compatible").requiresApiKey).toBe(true);
    expect(getLlmProviderConfig("codex").requiresApiKey).toBe(false);
    expect(getLlmProviderConfig("claude_code").requiresApiKey).toBe(false);
  });

  it("normalizes the hyphenated claude-code alias", () => {
    expect(normalizeLlmProvider("claude-code")).toBe("claude_code");
  });

  it("offers curated model suggestions for claude code", () => {
    expect(supportsLlmModelSuggestions("claude_code")).toBe(true);
  });

  it("normalizes the hyphenated openai-compatible alias", () => {
    expect(normalizeLlmProvider("openai-compatible")).toBe("openai_compatible");
  });

  it("defaults unknown providers to openrouter", () => {
    expect(normalizeLlmProvider("unknown-provider")).toBe("openrouter");
  });

  it("only enables model suggestions for supported providers", () => {
    expect(supportsLlmModelSuggestions("openai")).toBe(true);
    expect(supportsLlmModelSuggestions("gemini")).toBe(true);
    expect(supportsLlmModelSuggestions("ollama")).toBe(true);
    expect(supportsLlmModelSuggestions("openrouter")).toBe(false);
  });
});

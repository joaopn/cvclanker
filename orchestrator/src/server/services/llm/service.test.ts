import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeClient } from "./claude-code/client";
import { CodexClient } from "./codex/client";
import { strategies } from "./providers";
import {
  consumeRateLimitRetry,
  isRateLimitStopped,
  resetRateLimitBudget,
} from "./rate-limit-budget";
import { LlmService } from "./service";
import type { JsonSchemaDefinition } from "./types";

const SCHEMA: JsonSchemaDefinition = {
  name: "stub",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

beforeEach(() => {
  // Module-global and order-sensitive: a latched budget short-circuits every
  // callJson in the file.
  resetRateLimitBudget(0);
});

describe("LlmService provider normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps legacy localhost openai_compatible configs on LM Studio", () => {
    const llm = new LlmService({
      provider: "openai_compatible",
      baseUrl: "http://localhost:1234",
    });

    expect(llm.getProvider()).toBe("lmstudio");
    expect(llm.getBaseUrl()).toBe("http://localhost:1234");
  });

  it("uses the dedicated provider for non-local OpenAI-compatible endpoints", () => {
    const llm = new LlmService({
      provider: "openai_compatible",
      baseUrl: "https://llm.example.com",
    });

    expect(llm.getProvider()).toBe("openai_compatible");
    expect(llm.getBaseUrl()).toBe("https://llm.example.com");
  });

  it("normalizes the hyphenated openai-compatible alias", () => {
    const llm = new LlmService({
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com",
    });

    expect(llm.getProvider()).toBe("openai_compatible");
    expect(llm.getBaseUrl()).toBe("https://llm.example.com");
  });

  it("supports codex provider normalization", () => {
    const llm = new LlmService({
      provider: "codex",
    });

    expect(llm.getProvider()).toBe("codex");
    expect(llm.getBaseUrl()).toBe("");
  });

  describe("ambient credentials belong to the configured provider", () => {
    const saved = {
      provider: process.env.LLM_PROVIDER,
      apiKey: process.env.LLM_API_KEY,
      baseUrl: process.env.LLM_BASE_URL,
    };

    beforeEach(() => {
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_API_KEY = "openai-ambient-key";
      process.env.LLM_BASE_URL = "https://ambient.example.test";
    });

    afterEach(() => {
      for (const [key, value] of Object.entries({
        LLM_PROVIDER: saved.provider,
        LLM_API_KEY: saved.apiKey,
        LLM_BASE_URL: saved.baseUrl,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("inherits them when no provider is named", () => {
      const llm = new LlmService();

      expect(llm.getProvider()).toBe("openai");
      expect(llm.getBaseUrl()).toBe("https://ambient.example.test");
    });

    it("inherits them when the named provider IS the configured one", async () => {
      const llm = new LlmService({ provider: "openai" });

      // A missing key is reported without any request; getting past that is
      // how the inherited key makes itself visible.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      await llm.validateCredentials();

      expect(fetchSpy).toHaveBeenCalled();
      const headers = (fetchSpy.mock.calls[0]?.[1]?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(JSON.stringify(headers)).toContain("openai-ambient-key");
    });

    it("withholds the key from a DIFFERENT provider instead of substituting it", async () => {
      const llm = new LlmService({ provider: "openrouter" });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await llm.validateCredentials();

      expect(result.valid).toBe(false);
      expect(result.message).toBe("LLM API key is missing.");
      // Nothing was sent anywhere — which is the whole point.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("withholds the base URL from a different provider too", () => {
      const llm = new LlmService({ provider: "ollama" });

      expect(llm.getProvider()).toBe("ollama");
      expect(llm.getBaseUrl()).toBe(strategies.ollama.defaultBaseUrl);
      expect(llm.getBaseUrl()).not.toBe("https://ambient.example.test");
    });

    it("still takes an explicitly supplied key for another provider", () => {
      const llm = new LlmService({
        provider: "openrouter",
        apiKey: "or-explicit",
        baseUrl: "https://openrouter.example.test",
      });

      expect(llm.getBaseUrl()).toBe("https://openrouter.example.test");
    });
  });

  it("retries codex JSON parsing failures and succeeds on a later attempt", async () => {
    const codexCallSpy = vi
      .spyOn(CodexClient.prototype, "callJson")
      .mockResolvedValueOnce({ text: "not-json", turnId: "turn-1" })
      .mockResolvedValueOnce({
        text: '{"value":"ok"}',
        turnId: "turn-2",
      });

    const llm = new LlmService({ provider: "codex" });
    const result = await llm.callJson<{ value: string }>({
      model: "",
      messages: [{ role: "user", content: "Return JSON." }],
      jsonSchema: {
        name: "test",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      maxRetries: 1,
      retryDelayMs: 1,
    });

    expect(result).toEqual({
      success: true,
      data: { value: "ok" },
      usage: { promptTokens: null, completionTokens: null },
    });
    expect(codexCallSpy).toHaveBeenCalledTimes(2);
  });

  it("delegates codex credential validation to the codex client", async () => {
    const validateSpy = vi
      .spyOn(CodexClient.prototype, "validateCredentials")
      .mockResolvedValue({ valid: true, message: null });

    const llm = new LlmService({ provider: "codex" });
    const result = await llm.validateCredentials();

    expect(result).toEqual({ valid: true, message: null });
    expect(validateSpy).toHaveBeenCalledOnce();
  });

  it("delegates codex model discovery to the codex client", async () => {
    const listSpy = vi
      .spyOn(CodexClient.prototype, "listModels")
      .mockResolvedValue(["gpt-5", "o4-mini"]);

    const llm = new LlmService({ provider: "codex" });
    const models = await llm.listModels();

    expect(models).toEqual(["gpt-5", "o4-mini"]);
    expect(listSpy).toHaveBeenCalledOnce();
  });

  it("supports claude_code provider normalization", () => {
    const llm = new LlmService({ provider: "claude_code" });

    expect(llm.getProvider()).toBe("claude_code");
    expect(llm.getBaseUrl()).toBe("");
  });

  it("normalizes the hyphenated claude-code alias", () => {
    const llm = new LlmService({ provider: "claude-code" });

    expect(llm.getProvider()).toBe("claude_code");
  });

  // A key left over from a previously configured provider must never reach the
  // CLI: it would override a working ambient CLAUDE_CODE_OAUTH_TOKEN and 401
  // every call, while `auth status` still reported the profile as valid.
  it("never forwards the shared LLM api key to the claude code client", async () => {
    const callSpy = vi
      .spyOn(ClaudeCodeClient.prototype, "callJson")
      .mockResolvedValue({
        text: '{"value":"ok"}',
        usage: { promptTokens: 10, completionTokens: 20 },
      });

    const llm = new LlmService({
      provider: "claude_code",
      apiKey: "sk-or-v1-stale-openrouter-key",
    });
    await llm.callJson<{ value: string }>({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "Return JSON." }],
      jsonSchema: {
        name: "test",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy.mock.calls[0][1]).toBeUndefined();
  });

  it("reports claude code token usage instead of nulling it", async () => {
    vi.spyOn(ClaudeCodeClient.prototype, "callJson").mockResolvedValue({
      text: '{"value":"ok"}',
      usage: { promptTokens: 2131, completionTokens: 903 },
    });

    const llm = new LlmService({ provider: "claude_code" });
    const result = await llm.callJson<{ value: string }>({
      model: "",
      messages: [{ role: "user", content: "Return JSON." }],
      jsonSchema: {
        name: "test",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });

    expect(result).toEqual({
      success: true,
      data: { value: "ok" },
      usage: { promptTokens: 2131, completionTokens: 903 },
    });
  });

  it("retries claude code JSON parsing failures and succeeds on a later attempt", async () => {
    const callSpy = vi
      .spyOn(ClaudeCodeClient.prototype, "callJson")
      .mockResolvedValueOnce({
        text: "not-json",
        usage: { promptTokens: null, completionTokens: null },
      })
      .mockResolvedValueOnce({
        text: '{"value":"ok"}',
        usage: { promptTokens: 1, completionTokens: 2 },
      });

    const llm = new LlmService({ provider: "claude_code" });
    const result = await llm.callJson<{ value: string }>({
      model: "",
      messages: [{ role: "user", content: "Return JSON." }],
      jsonSchema: {
        name: "test",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      maxRetries: 1,
      retryDelayMs: 1,
    });

    expect(result.success).toBe(true);
    expect(callSpy).toHaveBeenCalledTimes(2);
  });

  it("delegates claude code credential validation to the claude code client", async () => {
    const validateSpy = vi
      .spyOn(ClaudeCodeClient.prototype, "validateCredentials")
      .mockResolvedValue({ valid: true, message: null, username: "a@b.c" });

    const llm = new LlmService({ provider: "claude_code", apiKey: "oat" });
    const result = await llm.validateCredentials();

    expect(result.valid).toBe(true);
    expect(validateSpy).toHaveBeenCalledWith();
  });

  it("delegates claude code model discovery to the claude code client", async () => {
    const listSpy = vi
      .spyOn(ClaudeCodeClient.prototype, "listModels")
      .mockResolvedValue(["claude-sonnet-5"]);

    const llm = new LlmService({ provider: "claude_code" });
    const models = await llm.listModels();

    expect(models).toEqual(["claude-sonnet-5"]);
    expect(listSpy).toHaveBeenCalledOnce();
  });
});

describe("LlmService rate-limit budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRateLimitBudget(0);
  });

  it("fails immediately, without calling the provider, once stopped", async () => {
    // The whole point of the latch: N queued jobs must not each discover the
    // wall for themselves.
    const callSpy = vi.spyOn(ClaudeCodeClient.prototype, "callJson");
    resetRateLimitBudget(0);
    consumeRateLimitRetry("You've hit your session limit");

    const llm = new LlmService({ provider: "claude_code" });
    const result = await llm.callJson({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: SCHEMA,
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("rate_limited");
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("retries a rate-limited call from the global budget, then stops", async () => {
    resetRateLimitBudget(2);
    const callSpy = vi
      .spyOn(ClaudeCodeClient.prototype, "callJson")
      .mockRejectedValue(new Error("HTTP 429 — you've hit your session limit"));

    const llm = new LlmService({ provider: "claude_code" });
    const result = await llm.callJson({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: SCHEMA,
    });

    expect(result.success).toBe(false);
    // Initial attempt + 2 budgeted retries, then the budget is spent.
    expect(callSpy).toHaveBeenCalledTimes(3);
    expect(isRateLimitStopped()).toBe(true);
  });
});

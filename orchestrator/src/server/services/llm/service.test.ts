import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeClient } from "./claude-code/client";
import { CodexClient } from "./codex/client";
import { LlmService } from "./service";

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

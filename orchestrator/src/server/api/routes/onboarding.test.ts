import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const { capturedOptions } = vi.hoisted(() => ({
  capturedOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@server/services/onboarding-search-terms", () => ({
  suggestOnboardingSearchTerms: vi.fn(),
}));

vi.mock("@server/services/llm/service", () => ({
  LlmService: vi.fn(function MockLlmService(options: Record<string, unknown>) {
    capturedOptions.push(options ?? {});
    return {
      validateCredentials: vi.fn().mockResolvedValue({
        valid: true,
        message: null,
      }),
    };
  }),
}));

import { suggestOnboardingSearchTerms } from "@server/services/onboarding-search-terms";

describe.sequential("Onboarding API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOptions.length = 0;
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  describe("POST /api/onboarding/search-terms/suggest", () => {
    it("returns AI-generated terms in the standard API wrapper", async () => {
      vi.mocked(suggestOnboardingSearchTerms).mockResolvedValue({
        terms: ["Platform Engineer", "Backend Engineer"],
        source: "ai",
      });

      const res = await fetch(
        `${baseUrl}/api/onboarding/search-terms/suggest`,
        {
          method: "POST",
        },
      );
      const body = await res.json();

      expect(res.ok).toBe(true);
      expect(body).toMatchObject({
        ok: true,
        data: {
          terms: ["Platform Engineer", "Backend Engineer"],
          source: "ai",
        },
        meta: {
          requestId: expect.any(String),
        },
      });
    });

    it("returns a conflict response when no usable resume is configured", async () => {
      const { AppError } = await import("@infra/errors");
      vi.mocked(suggestOnboardingSearchTerms).mockRejectedValue(
        new AppError({
          status: 409,
          code: "CONFLICT",
          message: "Resume must be configured before suggesting search terms.",
        }),
      );

      const res = await fetch(
        `${baseUrl}/api/onboarding/search-terms/suggest`,
        {
          method: "POST",
        },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toMatchObject({
        ok: false,
        error: {
          code: "CONFLICT",
          message: "Resume must be configured before suggesting search terms.",
        },
        meta: {
          requestId: expect.any(String),
        },
      });
    });
  });

  describe("POST /api/onboarding/validate/llm", () => {
    async function patchSettings(input: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(res.status).toBe(200);
    }

    async function validate(input: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/onboarding/validate/llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(res.status).toBe(200);
      return capturedOptions.at(-1) ?? {};
    }

    it("never lends the configured provider's stored key to another provider (B99)", async () => {
      await patchSettings({
        llmProvider: "openai",
        llmApiKey: "sk-openai-stored",
      });

      for (const input of [
        { provider: "gemini" },
        { provider: "openrouter", apiKey: "" },
        { provider: "ollama", baseUrl: "http://ollama.example.test:11434" },
        { provider: "lmstudio" },
      ]) {
        const options = await validate(input);
        expect(options.provider).toBe(input.provider);
        expect(options.apiKey).toBeNull();
        expect(JSON.stringify(options)).not.toContain("sk-openai-stored");
      }
    });

    it("never lends the stored base URL to another base-URL provider", async () => {
      await patchSettings({
        llmProvider: "openai_compatible",
        llmApiKey: "sk-compat-stored",
        llmBaseUrl: "https://stored.example.test/v1",
      });

      const options = await validate({ provider: "ollama" });

      expect(options.baseUrl).toBeNull();
      expect(JSON.stringify(options)).not.toContain("stored.example.test");
    });

    it("checks another provider with its own credentials row", async () => {
      await patchSettings({
        llmProvider: "openai",
        llmApiKey: "sk-openai-stored",
      });
      await fetch(`${baseUrl}/api/settings/llm-credentials/gemini`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "gemini-row-key" }),
      });

      const options = await validate({ provider: "gemini" });

      expect(options.apiKey).toBe("gemini-row-key");
    });

    it("checks the configured provider with its own stored key, through the environment", async () => {
      await patchSettings({
        llmProvider: "openai",
        llmApiKey: "sk-openai-stored",
      });

      const options = await validate({ provider: "openai" });

      // No explicit key: LlmService inherits the environment the settings
      // save writes, which holds this provider's key.
      expect(options).toEqual({ provider: "openai" });
      expect("apiKey" in options).toBe(false);
      expect(process.env.LLM_PROVIDER).toBe("openai");
      expect(process.env.LLM_API_KEY).toBe("sk-openai-stored");
    });

    it("lets a typed key and base URL override, an empty URL meaning the provider's default", async () => {
      await patchSettings({
        llmProvider: "openai",
        llmApiKey: "sk-openai-stored",
      });

      expect(
        await validate({ provider: "gemini", apiKey: "  typed-key  " }),
      ).toMatchObject({ provider: "gemini", apiKey: "typed-key" });
      expect(await validate({ provider: "ollama", baseUrl: "" })).toMatchObject(
        { provider: "ollama", baseUrl: "http://localhost:11434" },
      );
      expect(
        await validate({
          provider: "lmstudio",
          baseUrl: " http://lmstudio.example.test:1234 ",
        }),
      ).toMatchObject({
        provider: "lmstudio",
        baseUrl: "http://lmstudio.example.test:1234",
      });
      // A fixed-endpoint provider takes no base URL from the caller.
      const gemini = await validate({
        provider: "gemini",
        apiKey: "k",
        baseUrl: "https://elsewhere.example.test",
      });
      expect(JSON.stringify(gemini)).not.toContain("elsewhere.example.test");
    });
  });
});

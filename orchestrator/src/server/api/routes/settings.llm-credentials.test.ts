import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listModelsMock, capturedOptions } = vi.hoisted(() => ({
  listModelsMock: vi.fn(),
  capturedOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@server/services/llm/service", () => ({
  LlmService: vi.fn(function MockLlmService(options: Record<string, unknown>) {
    capturedOptions.push(options ?? {});
    return {
      validateCredentials: vi.fn().mockResolvedValue({ valid: true }),
      listModels: listModelsMock,
    };
  }),
}));

import { startServer, stopServer } from "./test-utils";

describe.sequential("Per-provider LLM credentials", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOptions.length = 0;
    listModelsMock.mockResolvedValue([]);
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        // The app is configured for openai, so this key belongs to openai and
        // to nothing else.
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "openai-key-value",
      },
    }));
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function saveCredential(
    provider: string,
    input: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/settings/llm-credentials/${provider}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  it("stores a key and returns only a hint, never the key", async () => {
    const res = await saveCredential("openrouter", {
      apiKey: "sk-or-abcdef123456",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    const entry = body.data.credentials.find(
      (row: { provider: string }) => row.provider === "openrouter",
    );
    expect(entry.apiKeyHint).toBe("sk-o");
    expect(JSON.stringify(body)).not.toContain("abcdef123456");

    // And the same on a plain read.
    const listed = await (
      await fetch(`${baseUrl}/api/settings/llm-credentials`)
    ).json();
    expect(JSON.stringify(listed)).not.toContain("abcdef123456");
  });

  it("leaves an omitted key alone and clears it only when explicitly nulled", async () => {
    await saveCredential("openrouter", { apiKey: "sk-or-original" });

    // A base-URL-only save must not wipe the key the form never displayed.
    // Uses openai_compatible because openrouter's endpoint is fixed and a base
    // URL for it is refused outright — see the guard tests below.
    await saveCredential("openai_compatible", { apiKey: "sk-compat-key" });
    await saveCredential("openai_compatible", {
      baseUrl: "https://proxy.example.test",
    });
    let listed = await (
      await fetch(`${baseUrl}/api/settings/llm-credentials`)
    ).json();
    let entry = listed.data.credentials.find(
      (row: { provider: string }) => row.provider === "openai_compatible",
    );
    expect(entry.apiKeyHint).toBe("sk-c");
    expect(entry.baseUrl).toBe("https://proxy.example.test");

    await saveCredential("openrouter", { apiKey: null });
    listed = await (
      await fetch(`${baseUrl}/api/settings/llm-credentials`)
    ).json();
    entry = listed.data.credentials.find(
      (row: { provider: string }) => row.provider === "openrouter",
    );
    expect(entry.apiKeyHint).toBeNull();
  });

  it("refuses a base URL for a provider whose endpoint is fixed", async () => {
    // Otherwise a stored base URL would become the host that provider's API
    // key is sent to. The UI never offers the field for these, but the API is
    // what has to enforce it.
    for (const provider of ["openrouter", "openai", "gemini"]) {
      const res = await saveCredential(provider, {
        apiKey: "sk-x",
        baseUrl: "https://attacker.example.test",
      });
      expect(res.status).toBe(400);
    }

    // ...and nothing was stored on the way to being refused.
    const listed = await (
      await fetch(`${baseUrl}/api/settings/llm-credentials`)
    ).json();
    expect(listed.data.credentials).toEqual([]);
  });

  it("refuses a base URL that is not a URL", async () => {
    const res = await saveCredential("openai_compatible", {
      baseUrl: "not-a-url",
    });
    expect(res.status).toBe(400);
  });

  it("refuses providers that authenticate through their own login", async () => {
    for (const provider of ["claude_code", "codex"]) {
      const res = await saveCredential(provider, { apiKey: "nope" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects an unknown provider rather than storing a row for it", async () => {
    const res = await saveCredential("not-a-provider", { apiKey: "x" });
    expect(res.status).toBe(400);

    const listed = await (
      await fetch(`${baseUrl}/api/settings/llm-credentials`)
    ).json();
    expect(listed.data.credentials).toEqual([]);
  });

  it("deletes a credential", async () => {
    await saveCredential("gemini", { apiKey: "gem-key" });
    const res = await fetch(`${baseUrl}/api/settings/llm-credentials/gemini`, {
      method: "DELETE",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.credentials).toEqual([]);
  });

  /** Saves the configured provider's key the way the Models form does. */
  async function saveConfiguredKey(value: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmApiKey: value }),
    });
    expect(res.status).toBe(200);
    capturedOptions.length = 0;
  }

  it("never lends the configured provider's key to a different provider", async () => {
    // B19: probing models for a provider the user has just selected used to
    // fall back to the stored key, sending an OpenAI key to openrouter.ai.
    await saveConfiguredKey("openai-db-key");

    await fetch(`${baseUrl}/api/settings/llm-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter" }),
    });

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].provider).toBe("openrouter");
    expect(capturedOptions[0].apiKey).toBeNull();
  });

  it("uses the key recorded for that provider when there is one", async () => {
    await saveCredential("openrouter", { apiKey: "sk-or-recorded" });
    capturedOptions.length = 0;

    await fetch(`${baseUrl}/api/settings/llm-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter" }),
    });

    expect(capturedOptions[0].apiKey).toBe("sk-or-recorded");
  });

  it("still lends the stored key to the configured provider, env-configured included", async () => {
    // No `llmProvider` override is saved here: the provider comes from the
    // environment, and the install must still be able to use its own key.
    await saveConfiguredKey("openai-db-key");

    await fetch(`${baseUrl}/api/settings/llm-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai" }),
    });

    expect(capturedOptions[0].apiKey).toBe("openai-db-key");
  });
});

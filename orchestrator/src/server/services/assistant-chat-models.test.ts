// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("listChatModels", () => {
  let tempDir: string;
  let models: Awaited<typeof import("./assistant-chat-models")>;
  let settingsRepo: Awaited<typeof import("../repositories/settings")>;
  let credentialsRepo: Awaited<
    typeof import("../repositories/llm-provider-credentials")
  >;
  let dbModule: Awaited<typeof import("../db/index")>;

  async function configure(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      await settingsRepo.setSetting(
        key as Parameters<typeof settingsRepo.setSetting>[0],
        value,
      );
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-chat-models-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    dbModule = await import("../db/index");
    settingsRepo = await import("../repositories/settings");
    credentialsRepo = await import("../repositories/llm-provider-credentials");
    models = await import("./assistant-chat-models");
    await configure({ llmProvider: "openrouter", model: "acme/base" });
  });

  afterEach(async () => {
    dbModule.closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("merges the tasks that share a model into one option, in task order", async () => {
    const result = await models.listChatModels();

    expect(result).toEqual({
      providers: [
        {
          provider: "openrouter",
          models: [
            { model: "acme/base", tasks: ["default", "scoring", "tailoring"] },
          ],
        },
      ],
      current: { provider: "openrouter", model: "acme/base", effort: null },
      supportsEffort: ["claude_code"],
    });
  });

  it("lists distinct Scoring and Tailoring models under the main provider", async () => {
    await configure({
      modelScorer: "acme/score",
      modelTailoring: "acme/tailor",
    });

    const { providers } = await models.listChatModels();

    expect(providers).toEqual([
      {
        provider: "openrouter",
        models: [
          { model: "acme/base", tasks: ["default"] },
          { model: "acme/score", tasks: ["scoring"] },
          { model: "acme/tailor", tasks: ["tailoring"] },
        ],
      },
    ]);
  });

  it("lists the pre-filter model under its own provider, after the main one", async () => {
    await credentialsRepo.upsertProviderCredential({
      provider: "openai",
      apiKey: "sk-acme-example",
    });
    await configure({
      scorerPrefilterProvider: "openai",
      scorerPrefilterModel: "acme-screen",
    });

    const { providers } = await models.listChatModels();

    expect(providers.map((option) => option.provider)).toEqual([
      "openrouter",
      "openai",
    ]);
    expect(providers[1].models).toEqual([
      { model: "acme-screen", tasks: ["prefilter"] },
    ]);
  });

  it("merges a pre-filter model equal to one already listed on its provider", async () => {
    await configure({
      modelTailoring: "acme/tailor",
      scorerPrefilterModel: "acme/base",
    });

    const { providers } = await models.listChatModels();

    expect(providers).toEqual([
      {
        provider: "openrouter",
        models: [
          { model: "acme/base", tasks: ["default", "scoring", "prefilter"] },
          { model: "acme/tailor", tasks: ["tailoring"] },
        ],
      },
    ]);
  });

  it("leaves out a provider that has no usable credential", async () => {
    await configure({
      scorerPrefilterProvider: "openai",
      scorerPrefilterModel: "acme-screen",
    });

    const { providers } = await models.listChatModels();

    expect(providers.map((option) => option.provider)).toEqual(["openrouter"]);
  });

  it("returns the stored choice, effort included, when it is listed", async () => {
    await configure({
      scorerPrefilterProvider: "claude_code",
      scorerPrefilterModel: "claude-acme",
      chatProvider: "claude_code",
      chatModel: "claude-acme",
      chatEffort: "high",
    });

    const { current } = await models.listChatModels();

    expect(current).toEqual({
      provider: "claude_code",
      model: "claude-acme",
      effort: "high",
    });
  });

  it("returns a provider's CLI default model for a stored choice with no model", async () => {
    await configure({
      llmProvider: "claude_code",
      model: "",
      modelTailoring: "claude-acme",
      chatProvider: "claude_code",
    });

    const { response, stored } = await models.resolveChatModels();

    expect(response.providers[0].models).toEqual([
      { model: "", tasks: ["default", "scoring"] },
      { model: "claude-acme", tasks: ["tailoring"] },
    ]);
    expect(stored).toBe(true);
    expect(response.current).toEqual({
      provider: "claude_code",
      model: "",
      effort: null,
    });
  });

  it("falls back to the Tailoring model on the main provider for a stale choice, keeping the effort", async () => {
    await configure({
      llmProvider: "claude_code",
      model: "claude-acme",
      modelTailoring: "claude-acme-tailor",
      chatProvider: "claude_code",
      chatModel: "claude-gone",
      chatEffort: "high",
    });

    const { current } = await models.listChatModels();

    expect(current).toEqual({
      provider: "claude_code",
      model: "claude-acme-tailor",
      effort: "high",
    });
  });

  it("drops the effort of the fallback on a main provider that takes none", async () => {
    await configure({ modelTailoring: "acme/tailor", chatEffort: "high" });

    const { current } = await models.listChatModels();

    expect(current).toEqual({
      provider: "openrouter",
      model: "acme/tailor",
      effort: null,
    });
  });

  it("drops the effort of a stored choice on a provider that takes none", async () => {
    await configure({
      modelTailoring: "acme/tailor",
      chatProvider: "openrouter",
      chatModel: "acme/base",
      chatEffort: "high",
    });

    const { current } = await models.listChatModels();

    expect(current).toEqual({
      provider: "openrouter",
      model: "acme/base",
      effort: null,
    });
  });
});

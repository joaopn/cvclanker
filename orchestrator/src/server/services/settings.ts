import * as settingsRepo from "@server/repositories/settings";
import {
  getDefaultModelForProvider,
  settingsRegistry,
} from "@shared/settings-registry";
import type { AppSettings } from "@shared/types";
import { getEnvSettingsData } from "./envSettings";

function resolveDefaultLlmBaseUrl(provider: string): string {
  const normalized = provider.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "ollama") return "http://localhost:11434";
  if (normalized === "lmstudio") return "http://localhost:1234";
  if (normalized === "openai") {
    return "https://api.openai.com";
  }
  if (normalized === "openai_compatible") {
    return "https://api.openai.com";
  }
  if (normalized === "gemini") {
    return "https://generativelanguage.googleapis.com";
  }
  if (normalized === "codex") {
    return "";
  }
  if (normalized === "claude_code") {
    return "";
  }
  return "https://openrouter.ai";
}

function normalizeModelForProviderCompatibility(
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const trimmedModel = model?.trim();
  if (!trimmedModel) return null;

  const normalizedProvider = provider?.trim().toLowerCase().replace(/-/g, "_");
  const normalizedModel = trimmedModel.toLowerCase();

  if (normalizedProvider === "openai") {
    if (
      normalizedModel.startsWith("google/") ||
      normalizedModel.startsWith("models/") ||
      normalizedModel.startsWith("gemini")
    ) {
      return null;
    }
  }

  if (normalizedProvider === "gemini") {
    const isGeminiModel =
      normalizedModel.startsWith("google/") ||
      normalizedModel.startsWith("models/") ||
      normalizedModel.startsWith("gemini");
    if (!isGeminiModel) {
      return null;
    }
  }

  if (normalizedProvider === "claude_code") {
    // The CLI takes either a full id (`claude-sonnet-5`) or a family alias
    // (`sonnet`, `opus`, `haiku`, `fable`). Anything else is a leftover from
    // another provider and must fall back to the CLI's own default.
    const isClaudeModel =
      ["sonnet", "opus", "haiku", "fable"].includes(normalizedModel) ||
      normalizedModel.startsWith("claude-");
    if (!isClaudeModel) {
      return null;
    }
  }

  return trimmedModel;
}

/**
 * Get the effective app settings, combining environment variables and database overrides.
 */
export async function getEffectiveSettings(): Promise<AppSettings> {
  const getAllSettings =
    "getAllSettings" in settingsRepo ? settingsRepo.getAllSettings : null;
  const overrides =
    (typeof getAllSettings === "function" ? await getAllSettings() : null) ??
    {};
  const providerOverride = settingsRegistry.llmProvider.parse(
    overrides.llmProvider,
  );
  const effectiveLlmProvider =
    providerOverride ?? settingsRegistry.llmProvider.default();
  const resolvedModelDefault =
    normalizeModelForProviderCompatibility(
      effectiveLlmProvider,
      getDefaultModelForProvider(effectiveLlmProvider, process.env.MODEL),
    ) ?? getDefaultModelForProvider(effectiveLlmProvider);

  const envSettings = await getEnvSettingsData(overrides);

  const result: Partial<AppSettings> = {
    ...envSettings,
  };

  const rawModel = overrides.model;
  const modelDef = settingsRegistry.model;
  const overrideModel = normalizeModelForProviderCompatibility(
    effectiveLlmProvider,
    modelDef.parse(rawModel),
  );
  const modelValue = overrideModel ?? resolvedModelDefault;

  for (const [key, def] of Object.entries(settingsRegistry)) {
    if (def.kind === "typed") {
      const rawOverride = overrides[key as settingsRepo.SettingKey];

      let override = def.parse(rawOverride);
      let defaultValue = def.default();

      if (key === "model") {
        defaultValue = resolvedModelDefault;
        override = overrideModel;
      }

      if (key === "llmBaseUrl") {
        const provider =
          effectiveLlmProvider ?? settingsRegistry.llmProvider.default();
        defaultValue =
          process.env.LLM_BASE_URL || resolveDefaultLlmBaseUrl(provider);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // biome-ignore lint/suspicious/noExplicitAny: dynamic assignment for settings building
      (result as any)[key] = {
        value: override ?? defaultValue,
        default: defaultValue,
        override,
      };
    } else if (def.kind === "model") {
      const override =
        normalizeModelForProviderCompatibility(
          effectiveLlmProvider,
          overrides[key as settingsRepo.SettingKey] ?? null,
        ) ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // biome-ignore lint/suspicious/noExplicitAny: dynamic assignment for settings building
      (result as any)[key] = { value: override || modelValue, override };
    } else if (def.kind === "string") {
      if (!("envKey" in def) || !def.envKey) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // biome-ignore lint/suspicious/noExplicitAny: dynamic assignment for settings building
        (result as any)[key] =
          overrides[key as settingsRepo.SettingKey] ?? null;
      }
    }
  }

  return result as AppSettings;
}

/**
 * Works out what to hand `LlmService` for a named provider.
 *
 * The one rule that matters: the ambient `LLM_API_KEY` / `LLM_BASE_URL` (and
 * their settings overrides, which are written into the environment) belong to
 * the CONFIGURED provider. They are never lent to a different one — that is how
 * an OpenAI key ends up being sent to openrouter.ai. A provider that is not the
 * configured one is called with the credential recorded for it, or not at all.
 */

import { getProviderCredential } from "@server/repositories/llm-provider-credentials";
import { getSetting } from "@server/repositories/settings";
import { strategies } from "./providers";
import type { LlmProvider, LlmServiceOptions } from "./types";

const PROVIDER_IDS = Object.keys(strategies) as LlmProvider[];

export function normalizeProviderId(
  value: string | null | undefined,
): LlmProvider | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (!normalized) return null;
  return (PROVIDER_IDS as string[]).includes(normalized)
    ? (normalized as LlmProvider)
    : null;
}

export interface ResolvedProviderCall {
  provider: LlmProvider;
  /** Pass straight to `new LlmService(...)`. */
  options: LlmServiceOptions;
  /**
   * Why this provider cannot be called, or null when it can. Callers should
   * refuse up front rather than letting every request fail identically.
   */
  missingReason: string | null;
}

/**
 * Resolve a provider to the options an `LlmService` needs. Omitting the
 * provider yields today's behaviour exactly — an empty option set, resolved
 * from the environment by the service itself.
 */
export async function resolveProviderCall(
  rawProvider: string | null | undefined,
): Promise<ResolvedProviderCall> {
  const configured = normalizeProviderId(await getSetting("llmProvider"));
  const envProvider = normalizeProviderId(process.env.LLM_PROVIDER);
  const activeProvider = configured ?? envProvider ?? "openrouter";

  const provider = normalizeProviderId(rawProvider) ?? activeProvider;
  const isActive = provider === activeProvider;

  // claude_code and codex authenticate themselves — an OAuth token setting and
  // a local login respectively — so they need no row here and must never be
  // asked for one.
  if (provider === "claude_code" || provider === "codex") {
    return { provider, options: { provider }, missingReason: null };
  }

  const stored = await getProviderCredential(provider);

  if (isActive) {
    // The configured provider keeps resolving through the environment, so a key
    // that was set before this table existed still works. A row for it wins,
    // which is what makes an explicitly recorded credential authoritative.
    return {
      provider,
      options: {
        provider,
        ...(stored?.apiKey ? { apiKey: stored.apiKey } : {}),
        ...(stored?.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      },
      missingReason: null,
    };
  }

  // Explicit nulls, not omissions: `LlmService` only falls back to the ambient
  // variables when the provider it resolves to is the environment's own, and
  // spelling them out here says the same thing at this layer.
  const options: LlmServiceOptions = {
    provider,
    apiKey: stored?.apiKey ?? null,
    baseUrl: stored?.baseUrl ?? null,
  };

  const needsKey = strategies[provider].requiresApiKey;
  const missingReason =
    needsKey && !stored?.apiKey
      ? `No API key is saved for ${provider}. Add one under Settings → AI → Provider Credentials.`
      : null;

  return { provider, options, missingReason };
}

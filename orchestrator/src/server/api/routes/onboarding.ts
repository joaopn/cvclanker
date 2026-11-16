import { asyncRoute, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { resolveProviderCall } from "@server/services/llm/provider-credentials";
import { LlmService } from "@server/services/llm/service";
import { suggestOnboardingSearchTerms } from "@server/services/onboarding-search-terms";
import { providerUsesBaseUrl } from "@shared/settings-registry";
import { type Request, type Response, Router } from "express";

export const onboardingRouter = Router();

type ValidationResponse = {
  valid: boolean;
  message: string | null;
  status?: number | null;
};

function getDefaultValidationBaseUrl(
  provider: string | undefined,
): string | undefined {
  if (provider === "lmstudio") return "http://localhost:1234";
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openai_compatible") return "https://api.openai.com";
  return undefined;
}

/**
 * Check a provider's connection. The stored key and base URL belong to the
 * configured provider and are never lent to another: `resolveProviderCall`
 * hands the configured provider its own (from the environment the settings
 * save writes) and any other provider only its own credentials row. A key or
 * a base URL the caller typed overrides that. The base URL is taken only for
 * the providers whose endpoint the user chooses; an empty one means that
 * provider's default.
 */
async function validateLlm(options: {
  apiKey?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
}): Promise<ValidationResponse> {
  const resolved = await resolveProviderCall(options.provider);
  const provider = resolved.provider;
  const typedApiKey = options.apiKey?.trim() || null;
  const typedBaseUrl =
    providerUsesBaseUrl(provider) &&
    options.baseUrl !== undefined &&
    options.baseUrl !== null
      ? options.baseUrl.trim() || getDefaultValidationBaseUrl(provider)
      : undefined;

  logger.debug("LLM onboarding validation resolved config", {
    provider,
    hasTypedBaseUrl: Boolean(typedBaseUrl),
    hasTypedApiKey: Boolean(typedApiKey),
  });

  const llm = new LlmService({
    ...resolved.options,
    ...(typedApiKey ? { apiKey: typedApiKey } : {}),
    ...(typedBaseUrl ? { baseUrl: typedBaseUrl } : {}),
  });
  return llm.validateCredentials();
}

onboardingRouter.post(
  "/validate/openrouter",
  async (req: Request, res: Response) => {
    const apiKey =
      typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;
    const result = await validateLlm({ apiKey, provider: "openrouter" });
    ok(res, result);
  },
);

onboardingRouter.post("/validate/llm", async (req: Request, res: Response) => {
  const apiKey =
    typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;
  const provider =
    typeof req.body?.provider === "string" ? req.body.provider : undefined;
  const baseUrl =
    typeof req.body?.baseUrl === "string" ? req.body.baseUrl : undefined;
  const result = await validateLlm({ apiKey, provider, baseUrl });
  ok(res, result);
});

onboardingRouter.post(
  "/search-terms/suggest",
  asyncRoute(async (_req: Request, res: Response) => {
    const result = await suggestOnboardingSearchTerms();
    ok(res, result);
  }),
);

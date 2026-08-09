import {
  badRequest,
  conflict,
  serviceUnavailable,
  upstreamError,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { getRequestId } from "@infra/request-context";
import { getPipelineStatus } from "@server/pipeline/index";
import { getSetting } from "@server/repositories/settings";
import {
  getClaudeCodeCliStatus,
  InvalidClaudeCodeVersionError,
  updateClaudeCodeCli,
} from "@server/services/llm/claude-code/manage";
import {
  getCodexInstallStatus,
  InvalidCodexCliVersionError,
  installCodexCli,
} from "@server/services/llm/codex/install";
import {
  disconnectCodexAuth,
  getCodexDeviceAuthSnapshot,
  startCodexDeviceAuth,
} from "@server/services/llm/codex/login";
import { LlmService } from "@server/services/llm/service";
import { getEffectiveSettings } from "@server/services/settings";
import { applySettingsUpdates } from "@server/services/settings-update";
import { updateSettingsSchema } from "@shared/settings-schema";
import { type Request, type Response, Router } from "express";

export const settingsRouter = Router();

function normalizeLlmProviderValue(
  provider: string | null | undefined,
): string | undefined {
  if (!provider) return undefined;
  return provider.trim().toLowerCase().replace(/-/g, "_");
}

function getDefaultValidationBaseUrl(
  provider: string | undefined,
): string | undefined {
  if (provider === "lmstudio") return "http://localhost:1234";
  if (provider === "ollama") return "http://localhost:11434";
  if (provider === "openai_compatible") return "https://api.openai.com";
  return undefined;
}

const CODEX_AUTH_VALIDATION_TTL_MS = 5_000;
let codexValidationCache: {
  value: { valid: boolean; message: string | null; username?: string | null };
  expiresAtMs: number;
} | null = null;
let codexValidationInFlight: Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> | null = null;

function clearCodexValidationCache(): void {
  codexValidationCache = null;
  codexValidationInFlight = null;
}

async function validateCodexCredentials(): Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> {
  return await new LlmService({ provider: "codex" }).validateCredentials();
}

async function getCachedCodexValidation(): Promise<{
  valid: boolean;
  message: string | null;
  username?: string | null;
}> {
  const now = Date.now();
  if (codexValidationCache && codexValidationCache.expiresAtMs > now) {
    return codexValidationCache.value;
  }

  if (codexValidationInFlight) {
    return await codexValidationInFlight;
  }

  codexValidationInFlight = (async () => {
    const validation = await validateCodexCredentials();
    codexValidationCache = {
      value: validation,
      expiresAtMs: Date.now() + CODEX_AUTH_VALIDATION_TTL_MS,
    };
    return validation;
  })();

  try {
    return await codexValidationInFlight;
  } finally {
    codexValidationInFlight = null;
  }
}

async function resolveLlmConfig(input: {
  provider?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
}): Promise<{
  provider: string | undefined;
  apiKey: string | null;
  baseUrl: string | undefined;
}> {
  const [storedApiKey, storedProvider, storedBaseUrl] = await Promise.all([
    getSetting("llmApiKey"),
    getSetting("llmProvider"),
    getSetting("llmBaseUrl"),
  ]);

  const provider = normalizeLlmProviderValue(
    input.provider?.trim() || storedProvider?.trim() || undefined,
  );
  const usesBaseUrl =
    provider === "lmstudio" ||
    provider === "ollama" ||
    provider === "openai_compatible";
  const hasExplicitBaseUrlOverride =
    input.baseUrl !== undefined && input.baseUrl !== null;
  const baseUrl = usesBaseUrl
    ? hasExplicitBaseUrlOverride
      ? input.baseUrl?.trim() || getDefaultValidationBaseUrl(provider)
      : storedBaseUrl?.trim() || getDefaultValidationBaseUrl(provider)
    : undefined;

  return {
    provider,
    apiKey: input.apiKey?.trim() || storedApiKey?.trim() || null,
    baseUrl,
  };
}

async function getCodexAuthResponseData(): Promise<{
  authenticated: boolean;
  username: string | null;
  validationMessage: string | null;
  flowStatus: string;
  loginInProgress: boolean;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  flowMessage: string | null;
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string | null;
}> {
  const flow = getCodexDeviceAuthSnapshot();
  const validation = flow.loginInProgress
    ? await getCachedCodexValidation()
    : await validateCodexCredentials();
  if (!flow.loginInProgress) {
    clearCodexValidationCache();
  }

  // `installed` comes from the same path predicate the spawn resolver uses —
  // never inferred from `authenticated`, which spawns the CLI and therefore
  // cannot tell installed-but-unauthed apart from not-installed.
  const install = getCodexInstallStatus();

  return {
    authenticated: validation.valid,
    username: validation.username ?? null,
    validationMessage: validation.message,
    flowStatus: flow.status,
    loginInProgress: flow.loginInProgress,
    verificationUrl: flow.verificationUrl,
    userCode: flow.userCode,
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
    flowMessage: flow.message,
    installed: install.installed,
    installedVersion: install.installedVersion,
    pinnedVersion: install.pinnedVersion,
  };
}

/**
 * GET /api/settings - Get app settings (effective + defaults)
 */
settingsRouter.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await getEffectiveSettings();
    ok(res, data);
  }),
);

/**
 * PATCH /api/settings - Update settings overrides
 */
settingsRouter.patch(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const input = updateSettingsSchema.parse(req.body);
    await applySettingsUpdates(input);
    const data = await getEffectiveSettings();
    ok(res, data);
  }),
);

settingsRouter.post(
  "/llm-models",
  asyncRoute(async (req: Request, res: Response) => {
    const provider =
      typeof req.body?.provider === "string" ? req.body.provider : undefined;
    const apiKey =
      typeof req.body?.apiKey === "string" ? req.body.apiKey : undefined;
    const baseUrl =
      typeof req.body?.baseUrl === "string" ? req.body.baseUrl : undefined;
    const resolved = await resolveLlmConfig({ provider, apiKey, baseUrl });

    const llm = new LlmService({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
    });

    try {
      const models = await llm.listModels();
      ok(res, { models });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to fetch available LLM models.";
      logger.warn("LLM model discovery failed", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/llm-models",
        provider: resolved.provider ?? null,
        hasBaseUrl: Boolean(resolved.baseUrl),
        hasApiKey: Boolean(resolved.apiKey),
        message,
      });
      fail(
        res,
        /api key is missing/i.test(message)
          ? badRequest(message)
          : upstreamError(message),
      );
    }
  }),
);

settingsRouter.get(
  "/codex-auth",
  asyncRoute(async (_req: Request, res: Response) => {
    const data = await getCodexAuthResponseData();
    ok(res, data);
  }),
);

settingsRouter.post(
  "/codex-auth/start",
  asyncRoute(async (req: Request, res: Response) => {
    const forceRestart = req.body?.forceRestart === true;

    try {
      clearCodexValidationCache();
      await startCodexDeviceAuth(forceRestart);
      const data = await getCodexAuthResponseData();
      ok(res, data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start Codex sign-in.";
      logger.warn("Codex sign-in flow failed to start", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/codex-auth/start",
        message,
      });
      fail(res, serviceUnavailable(message));
    }
  }),
);

settingsRouter.get(
  "/claude-code-cli",
  asyncRoute(async (_req: Request, res: Response) => {
    ok(res, await getClaudeCodeCliStatus());
  }),
);

settingsRouter.post(
  "/claude-code-cli/update",
  asyncRoute(async (req: Request, res: Response) => {
    if (getPipelineStatus().isRunning) {
      fail(
        res,
        conflict(
          "A pipeline run is in progress. Update the CLI after it finishes.",
        ),
      );
      return;
    }

    // Absent version means latest; a PRESENT non-string is malformed and must
    // 400 rather than silently install latest — "" fails version validation.
    const rawVersion = req.body?.version;
    const version =
      rawVersion === undefined
        ? "latest"
        : typeof rawVersion === "string"
          ? rawVersion.trim()
          : "";

    try {
      ok(res, await updateClaudeCodeCli(version));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to update the Claude Code CLI.";
      logger.warn("Claude Code CLI update failed", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/claude-code-cli/update",
        message,
      });
      fail(
        res,
        error instanceof InvalidClaudeCodeVersionError
          ? badRequest(message)
          : upstreamError(message),
      );
    }
  }),
);

/**
 * POST /api/settings/codex-install — synchronous npm install of the Codex CLI
 * into the data volume. The version comes from CODEX_CLI_VERSION (or latest),
 * never from the request. Overlapping requests join the in-flight install.
 */
settingsRouter.post(
  "/codex-install",
  asyncRoute(async (_req: Request, res: Response) => {
    try {
      await installCodexCli();
      // A successful install flips the codex spawn from ENOENT to runnable —
      // a state change, so clear the validation cache exactly like
      // /codex-auth/start and /disconnect do.
      clearCodexValidationCache();
      const data = await getCodexAuthResponseData();
      ok(res, data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to install the Codex CLI.";
      logger.warn("Codex CLI install failed", {
        requestId: getRequestId() ?? null,
        route: "POST /api/settings/codex-install",
        message,
      });
      fail(
        res,
        error instanceof InvalidCodexCliVersionError
          ? badRequest(message)
          : serviceUnavailable(message),
      );
    }
  }),
);

settingsRouter.post(
  "/codex-auth/disconnect",
  asyncRoute(async (_req: Request, res: Response) => {
    try {
      await disconnectCodexAuth();
      clearCodexValidationCache();
      const data = await getCodexAuthResponseData();
      ok(res, data);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to disconnect Codex right now.";
      logger.warn("Codex sign-out failed", {
        requestId: getRequestId(),
        route: "POST /api/settings/codex-auth/disconnect",
        message,
      });
      fail(res, serviceUnavailable(message));
    }
  }),
);

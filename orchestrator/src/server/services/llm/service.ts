import { logger } from "@infra/logger";
import { toStringOrNull } from "@shared/utils/type-conversion";
import { ClaudeCodeClient } from "./claude-code/client";
import { CodexClient } from "./codex/client";
import { classifyLlmError } from "./errors";
import { llmCallObserver } from "./observer";
import {
  buildModeCacheKey,
  getOrderedModes,
  rememberSuccessfulMode,
} from "./policies/mode-selection";
import { getRetryDelayMs, shouldRetryAttempt } from "./policies/retry-policy";
import { strategies } from "./providers";
import {
  consumeRateLimitRetry,
  ensureRateLimitBudget,
  getRateLimitStopReason,
  isRateLimitStopped,
} from "./rate-limit-budget";
import type {
  JsonSchemaDefinition,
  LlmApiError,
  LlmProvider,
  LlmRequestOptions,
  LlmResponse,
  LlmServiceOptions,
  LlmValidationResult,
  ResponseMode,
} from "./types";
import {
  addQueryParam,
  buildHeaders,
  getResponseDetail,
  joinUrl,
} from "./utils/http";
import { parseJsonContent } from "./utils/json";
import { parseErrorMessage, truncate } from "./utils/string";
import { computeTokensPerSec, extractUsage } from "./utils/usage";

export class LlmService {
  private readonly provider: LlmProvider;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly strategy: (typeof strategies)[LlmProvider];
  private readonly codexClient: CodexClient;
  private readonly claudeCodeClient: ClaudeCodeClient;

  constructor(options: LlmServiceOptions = {}) {
    const explicitBaseUrl = toStringOrNull(options.baseUrl);
    const envBaseUrl = toStringOrNull(process.env.LLM_BASE_URL);
    const envProvider = normalizeProvider(
      toStringOrNull(process.env.LLM_PROVIDER),
      envBaseUrl,
    );
    // LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY describe ONE provider — the
    // configured one, since the settings save path writes the overrides into
    // them. A caller naming a different provider (a benchmark column, a cheap
    // pre-filter) must not inherit them: that is how one vendor's key gets sent
    // to another's endpoint. Callers that name no provider are asking for the
    // configured one, so nothing changes for them.
    const resolvedProvider = options.provider
      ? normalizeProvider(options.provider, explicitBaseUrl ?? envBaseUrl)
      : envProvider;
    const inheritsEnv = resolvedProvider === envProvider;

    const normalizedBaseUrl =
      explicitBaseUrl || (inheritsEnv ? envBaseUrl : null) || null;

    const strategy = strategies[resolvedProvider];
    const baseUrl = normalizedBaseUrl || strategy.defaultBaseUrl;

    let apiKey =
      toStringOrNull(options.apiKey) ||
      (inheritsEnv ? toStringOrNull(process.env.LLM_API_KEY) : null) ||
      null;

    // Backwards-compat migration: OPENROUTER_API_KEY -> LLM_API_KEY.
    // This prevents users from losing access when upgrading (keys are often only shown once).
    if (
      !apiKey &&
      inheritsEnv &&
      resolvedProvider === "openrouter" &&
      toStringOrNull(process.env.OPENROUTER_API_KEY)
    ) {
      logger.warn(
        "[DEPRECATED] OPENROUTER_API_KEY is deprecated. Copying to LLM_API_KEY; please update your environment.",
      );
      const migrated = toStringOrNull(process.env.OPENROUTER_API_KEY);
      if (migrated) {
        process.env.LLM_API_KEY = migrated;
        apiKey = migrated;
      }
    }

    this.provider = resolvedProvider;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.strategy = strategy;
    this.codexClient = new CodexClient();
    this.claudeCodeClient = new ClaudeCodeClient();
  }

  async callJson<T>(options: LlmRequestOptions<T>): Promise<LlmResponse<T>> {
    await ensureRateLimitBudget(async () => {
      const { getEffectiveSettings } = await import("../settings");
      return (await getEffectiveSettings()).llmRateLimitRetries.value;
    });

    // Once the global rate-limit budget is spent, every further call fails here
    // without touching the provider. That is what turns "this job hit a session
    // limit" into "stop classifying", instead of each queued job discovering
    // the wall on its own and degrading however its caller sees fit.
    if (isRateLimitStopped()) {
      return {
        success: false,
        error:
          getRateLimitStopReason() ??
          "LLM stopped: provider rate limit reached",
        code: "rate_limited",
      };
    }

    const handle = llmCallObserver.register({
      label: options.label?.trim() || "llm call",
      subject: options.subject?.trim() || null,
      model: options.model,
      jobId: options.jobId ?? null,
    });
    try {
      // Retrying the WHOLE call, spending from the shared budget: the per-call
      // `maxRetries` is a local nicety, but a rate limit is account-wide, so
      // the number of attempts that matters is the one counted across every
      // call in flight.
      let result = await this.callJsonInner<T>(options);
      while (
        !result.success &&
        result.code === "rate_limited" &&
        consumeRateLimitRetry(result.error)
      ) {
        result = await this.callJsonInner<T>(options);
      }
      if (result.success) handle.succeed(result.usage);
      else handle.fail(result.error);
      return result;
    } catch (error) {
      handle.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async callJsonInner<T>(
    options: LlmRequestOptions<T>,
  ): Promise<LlmResponse<T>> {
    if (this.provider === "codex") {
      return this.callCodexJson(options);
    }

    if (this.provider === "claude_code") {
      return this.callClaudeCodeJson(options);
    }

    if (this.strategy.requiresApiKey && !this.apiKey) {
      return {
        success: false,
        error: "LLM API key not configured",
        code: "auth",
      };
    }

    const {
      model,
      messages,
      jsonSchema,
      maxRetries = 0,
      retryDelayMs = 500,
      signal,
    } = options;
    const jobId = options.jobId;

    const cacheKey = buildModeCacheKey(this.provider, this.baseUrl);
    const modes = getOrderedModes(cacheKey, this.strategy.modes);

    for (const mode of modes) {
      const result = await this.tryMode<T>({
        mode,
        model,
        messages,
        jsonSchema,
        maxRetries,
        retryDelayMs,
        jobId,
        signal,
      });

      if (result.success) {
        rememberSuccessfulMode(cacheKey, mode);
        return result;
      }

      if (!result.success && result.error.startsWith("CAPABILITY:")) {
        continue;
      }

      return result;
    }

    return {
      success: false,
      error: "All provider modes failed",
      code: "unknown",
    };
  }

  getProvider(): LlmProvider {
    return this.provider;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async validateCredentials(): Promise<LlmValidationResult> {
    if (this.provider === "codex") {
      return this.codexClient.validateCredentials();
    }

    if (this.provider === "claude_code") {
      return this.claudeCodeClient.validateCredentials();
    }

    if (this.strategy.requiresApiKey && !this.apiKey) {
      return { valid: false, message: "LLM API key is missing." };
    }

    const urls = this.strategy.getValidationUrls({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
    });
    let lastMessage: string | null = null;

    for (const url of urls) {
      try {
        const validationApiKey =
          this.provider === "gemini" ? null : this.apiKey;
        const response = await fetch(url, {
          method: "GET",
          headers: buildHeaders({
            apiKey: validationApiKey,
            provider: this.provider,
          }),
        });

        if (response.ok) {
          return { valid: true, message: null };
        }

        const detail = await getResponseDetail(response);
        if (response.status === 401 || response.status === 403) {
          return {
            valid: false,
            message: "Invalid LLM API key. Check the key and try again.",
          };
        }
        logger.warn("LLM credential validation request failed", {
          provider: this.provider,
          status: response.status,
          detail: detail || null,
        });

        lastMessage = detail || `LLM provider returned ${response.status}`;
      } catch (error) {
        logger.warn("LLM credential validation request errored", {
          provider: this.provider,
          error: error instanceof Error ? error.message : String(error),
        });
        lastMessage =
          error instanceof Error ? error.message : "LLM validation failed.";
      }
    }

    return {
      valid: false,
      message: lastMessage || "LLM provider validation failed.",
    };
  }

  async listModels(): Promise<string[]> {
    if (this.provider === "codex") {
      return this.codexClient.listModels();
    }

    if (this.provider === "claude_code") {
      return this.claudeCodeClient.listModels();
    }

    if (this.strategy.requiresApiKey && !this.apiKey) {
      throw new Error("LLM API key is missing.");
    }

    if (
      this.provider !== "openai" &&
      this.provider !== "gemini" &&
      this.provider !== "ollama"
    ) {
      return [];
    }

    const models = await (async () => {
      if (this.provider === "openai") {
        return this.listOpenAiModels();
      }
      if (this.provider === "gemini") {
        return this.listGeminiModels();
      }
      return this.listOllamaModels();
    })();

    return sortModels(models, getPreferredModel(this.provider));
  }

  private async callCodexJson<T>(
    options: LlmRequestOptions<T>,
  ): Promise<LlmResponse<T>> {
    const { maxRetries = 0, retryDelayMs = 500, signal, jobId } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        if (attempt > 0) {
          logger.info("LLM retry attempt", {
            jobId: jobId ?? "unknown",
            attempt,
            maxRetries,
          });
          await sleep(getRetryDelayMs(retryDelayMs, attempt));
        }

        const result = await this.codexClient.callJson({
          ...options,
          signal,
        });
        const parsed = parseJsonContent<T>(result.text, jobId);
        // Codex app-server protocol doesn't expose token usage today, so
        // promptTokens / completionTokens / tokensPerSec are omitted.
        this.logCallCompleted({
          mode: "codex",
          model: options.model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: true,
        });
        return {
          success: true,
          data: parsed,
          usage: { promptTokens: null, completionTokens: null },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (attempt < maxRetries && shouldRetryAttempt({ message })) {
          logger.warn("Codex attempt failed, retrying", {
            jobId: jobId ?? "unknown",
            attempt: attempt + 1,
            maxRetries,
            message,
          });
          continue;
        }

        this.logCallCompleted({
          mode: "codex",
          model: options.model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: false,
          errorMessage: message,
        });
        return {
          success: false,
          error: message,
          code: classifyLlmError({ message }),
        };
      }
    }

    return {
      success: false,
      error: "All retry attempts failed",
      code: "unknown",
    };
  }

  /**
   * Mirrors `callCodexJson`, but the Claude Code CLI's `--output-format json`
   * envelope carries real token counts, so usage is populated rather than
   * nulled.
   *
   * No credential is passed explicitly: the CLI reads CLAUDE_CODE_OAUTH_TOKEN
   * from the environment, and the `claudeCodeOauthToken` registry secret keeps
   * process.env in sync at boot and on save. Handing it `this.apiKey` instead
   * would let a stale key left over from a previously configured provider
   * (LLM_API_KEY) silently shadow a working ambient token.
   */

  private async callClaudeCodeJson<T>(
    options: LlmRequestOptions<T>,
  ): Promise<LlmResponse<T>> {
    const { maxRetries = 0, retryDelayMs = 500, jobId } = options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        if (attempt > 0) {
          logger.info("LLM retry attempt", {
            jobId: jobId ?? "unknown",
            attempt,
            maxRetries,
          });
          await sleep(getRetryDelayMs(retryDelayMs, attempt));
        }

        const result = await this.claudeCodeClient.callJson(options);

        const parsed = parseJsonContent<T>(result.text, jobId);
        this.logCallCompleted({
          mode: "claude_code",
          model: options.model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: true,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
        });
        return { success: true, data: parsed, usage: result.usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The CLI reports its own api_error_status; trusting that beats
        // pattern-matching model-authored prose.
        const status = (error as LlmApiError).status;

        if (attempt < maxRetries && shouldRetryAttempt({ message, status })) {
          logger.warn("Claude Code attempt failed, retrying", {
            jobId: jobId ?? "unknown",
            attempt: attempt + 1,
            maxRetries,
            message,
          });
          continue;
        }

        this.logCallCompleted({
          mode: "claude_code",
          model: options.model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: false,
          errorStatus: status ?? null,
          errorMessage: message,
        });
        return {
          success: false,
          error: message,
          code: classifyLlmError({ status, message }),
        };
      }
    }

    return {
      success: false,
      error: "All retry attempts failed",
      code: "unknown",
    };
  }

  private async tryMode<T>(args: {
    mode: ResponseMode;
    model: string;
    messages: LlmRequestOptions<T>["messages"];
    jsonSchema: JsonSchemaDefinition;
    maxRetries: number;
    retryDelayMs: number;
    jobId?: string;
    signal?: AbortSignal;
  }): Promise<LlmResponse<T>> {
    const {
      mode,
      model: rawModel,
      messages,
      jsonSchema,
      maxRetries,
      retryDelayMs,
      signal,
    } = args;
    const jobId = args.jobId;
    const model = normalizeModelForProvider(this.provider, rawModel);

    const promptChars = messages.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartedAt = Date.now();
      let bodyBytes: number | null = null;
      try {
        if (attempt > 0) {
          logger.info("LLM retry attempt", {
            jobId: jobId ?? "unknown",
            attempt,
            maxRetries,
          });
          await sleep(getRetryDelayMs(retryDelayMs, attempt));
        }

        const { url, headers, body } = this.strategy.buildRequest({
          mode,
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
          model,
          messages,
          jsonSchema,
        });

        const serializedBody = JSON.stringify(body);
        bodyBytes = Buffer.byteLength(serializedBody, "utf8");

        // Loud warning when the body is large enough that undici can choke
        // (synchronous TLS write path). Not a block — just visibility.
        const HEFTY_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB
        if (bodyBytes >= HEFTY_BODY_BYTES) {
          logger.warn("LLM request body is large; fetch may fail", {
            provider: this.provider,
            model,
            mode,
            jobId: jobId ?? null,
            promptChars,
            bodyBytes,
          });
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: serializedBody,
          signal,
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "No error body");
          const parsedError = parseErrorMessage(errorBody);
          const detail = parsedError ? ` - ${truncate(parsedError, 400)}` : "";
          const err = new Error(
            `LLM API error: ${response.status}${detail}`,
          ) as LlmApiError;
          err.status = response.status;
          err.body = truncate(errorBody, 600);
          throw err;
        }

        const data = await response.json();
        const content = this.strategy.extractText(data);

        if (!content) {
          throw new Error("No content in response");
        }

        const parsed = parseJsonContent<T>(content, jobId);
        const usage = extractUsage(data);
        this.logCallCompleted({
          mode,
          model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: true,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          promptChars,
          bodyBytes,
        });
        return {
          success: true,
          data: parsed,
          usage: {
            promptTokens: usage.promptTokens ?? null,
            completionTokens: usage.completionTokens ?? null,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = (error as LlmApiError).status;
        const body = (error as LlmApiError).body;

        if (
          this.strategy.isCapabilityError({
            mode,
            status,
            body,
          })
        ) {
          // Capability errors signal "try the next mode" — they're not a
          // call failure. Skip the call-completed log; the next mode (or
          // the final exhaustion path in callJson) will emit one.
          return {
            success: false,
            error: `CAPABILITY:${message}`,
            code: "unknown",
          };
        }

        if (attempt < maxRetries && shouldRetryAttempt({ message, status })) {
          logger.warn("LLM attempt failed, retrying", {
            jobId: jobId ?? "unknown",
            attempt: attempt + 1,
            maxRetries,
            status: status ?? "no-status",
            message,
          });
          continue;
        }

        this.logCallCompleted({
          mode,
          model,
          jobId,
          startedAt: attemptStartedAt,
          attemptNumber: attempt + 1,
          success: false,
          errorStatus: status ?? null,
          errorMessage: message,
          promptChars,
          bodyBytes,
        });
        return {
          success: false,
          error: message,
          code: classifyLlmError({ status, message }),
        };
      }
    }

    return {
      success: false,
      error: "All retry attempts failed",
      code: "unknown",
    };
  }

  /**
   * Emit a single structured `LLM call completed` log line per HTTP-level
   * call (final attempt of a mode — successful or finally-failed). Token
   * counts are best-effort: providers that don't surface usage produce a
   * log without `promptTokens` / `completionTokens` / `tokensPerSec`.
   * Capability-error paths are excluded — they'll be retried on the next
   * mode and are accounted for there.
   */
  private logCallCompleted(args: {
    mode: ResponseMode | "codex" | "claude_code";
    model: string;
    jobId: string | undefined;
    startedAt: number;
    attemptNumber: number;
    success: boolean;
    promptTokens?: number | null;
    completionTokens?: number | null;
    errorStatus?: number | string | null;
    errorMessage?: string;
    promptChars?: number | null;
    bodyBytes?: number | null;
  }): void {
    const durationMs = Date.now() - args.startedAt;
    const completionTokens = args.completionTokens ?? null;
    const tokensPerSec = computeTokensPerSec(completionTokens, durationMs);
    const meta: Record<string, unknown> = {
      provider: this.provider,
      model: args.model,
      mode: args.mode,
      jobId: args.jobId ?? null,
      durationMs,
      attemptNumber: args.attemptNumber,
      success: args.success,
    };
    if (args.promptTokens !== null && args.promptTokens !== undefined) {
      meta.promptTokens = args.promptTokens;
    }
    if (completionTokens !== null) {
      meta.completionTokens = completionTokens;
    }
    if (tokensPerSec !== null) {
      meta.tokensPerSec = tokensPerSec;
    }
    if (args.promptChars !== null && args.promptChars !== undefined) {
      meta.promptChars = args.promptChars;
    }
    if (args.bodyBytes !== null && args.bodyBytes !== undefined) {
      meta.bodyBytes = args.bodyBytes;
    }
    if (!args.success) {
      if (args.errorStatus !== null && args.errorStatus !== undefined) {
        meta.errorStatus = args.errorStatus;
      }
      if (args.errorMessage) meta.errorMessage = args.errorMessage;
    }
    logger.info("LLM call completed", meta);
  }

  private async listOpenAiModels(): Promise<string[]> {
    const response = await fetch(joinUrl(this.baseUrl, "/v1/models"), {
      method: "GET",
      headers: buildHeaders({
        apiKey: this.apiKey,
        provider: this.provider,
      }),
    });

    if (!response.ok) {
      const detail = await getResponseDetail(response);
      throw new Error(detail || `OpenAI returned ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string | null }>;
    };
    return (payload.data ?? [])
      .map((entry) => entry.id?.trim() ?? "")
      .filter(isOpenAiTextGenerationModel)
      .filter(Boolean);
  }

  private async listGeminiModels(): Promise<string[]> {
    const url = addQueryParam(
      joinUrl(this.baseUrl, "/v1beta/models"),
      "key",
      this.apiKey ?? "",
    );
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders({
        apiKey: null,
        provider: this.provider,
      }),
    });

    if (!response.ok) {
      const detail = await getResponseDetail(response);
      throw new Error(detail || `Gemini returned ${response.status}.`);
    }

    const payload = (await response.json()) as {
      models?: Array<{
        name?: string | null;
        supportedGenerationMethods?: string[] | null;
      }>;
    };
    return (payload.models ?? [])
      .filter((entry) =>
        entry.supportedGenerationMethods?.includes("generateContent"),
      )
      .map((entry) => {
        const normalized = normalizeGeminiModelName(entry.name ?? "");
        return normalized ? `google/${normalized}` : "";
      })
      .filter(isGeminiTextGenerationModel)
      .filter(Boolean);
  }

  private async listOllamaModels(): Promise<string[]> {
    const response = await fetch(joinUrl(this.baseUrl, "/api/tags"), {
      method: "GET",
      headers: buildHeaders({
        apiKey: null,
        provider: this.provider,
      }),
    });

    if (!response.ok) {
      const detail = await getResponseDetail(response);
      throw new Error(detail || `Ollama returned ${response.status}.`);
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string | null; model?: string | null }>;
    };
    return (payload.models ?? [])
      .map((entry) => entry.name?.trim() || entry.model?.trim() || "")
      .filter(Boolean);
  }
}

function normalizeProvider(
  raw: string | null,
  baseUrl: string | null,
): LlmProvider {
  const normalized = raw?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "openai_compatible") {
    if (
      baseUrl?.includes("localhost:1234") ||
      baseUrl?.includes("127.0.0.1:1234")
    ) {
      return "lmstudio";
    }
    return "openai_compatible";
  }
  if (normalized === "openai") return "openai";
  if (normalized === "gemini") return "gemini";
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  if (normalized === "codex") return "codex";
  if (normalized === "claude_code") return "claude_code";
  if (normalized && normalized !== "openrouter") {
    logger.warn("Unknown LLM provider, defaulting to openrouter", {
      normalized,
    });
  }
  return "openrouter";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelForProvider(
  provider: LlmProvider,
  model: string,
): string {
  if (provider !== "gemini") return model;
  return normalizeGeminiModelName(model) || model;
}

function normalizeGeminiModelName(value: string): string {
  return value
    .trim()
    .replace(/^models\//, "")
    .replace(/^google\//, "");
}

function getPreferredModel(provider: LlmProvider): string | null {
  if (provider === "openai") return "gpt-5.4-mini";
  if (provider === "gemini") return "google/gemini-3-flash-preview";
  return null;
}

function isOpenAiTextGenerationModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;

  const blockedPatterns = [
    "audio",
    "embedding",
    "image",
    "moderation",
    "realtime",
    "search",
    "similarity",
    "transcribe",
    "transcription",
    "tts",
    "vision",
    "whisper",
    "computer-use",
    "dall-e",
    "babbage",
    "davinci",
    "omni-moderation",
  ];
  if (blockedPatterns.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  return /^(gpt|o1|o3|o4|chatgpt|codex)/.test(normalized);
}

function isGeminiTextGenerationModel(model: string): boolean {
  const normalized = normalizeGeminiModelName(model).toLowerCase();
  if (!normalized) return false;
  if (!normalized.startsWith("gemini")) return false;

  const blockedPatterns = ["embedding", "aqa", "vision", "image", "tts"];
  return !blockedPatterns.some((pattern) => normalized.includes(pattern));
}

function sortModels(models: string[], preferredModel: string | null): string[] {
  const unique = Array.from(
    new Set(models.map((model) => model.trim())),
  ).filter(Boolean);
  unique.sort((left, right) => left.localeCompare(right));
  if (!preferredModel) return unique;

  const preferredIndex = unique.indexOf(preferredModel);
  if (preferredIndex <= 0) return unique;

  const [preferred] = unique.splice(preferredIndex, 1);
  return [preferred, ...unique];
}

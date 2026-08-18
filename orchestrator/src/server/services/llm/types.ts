import type { ClaudeCodeEffortLevel } from "@shared/settings-registry";
import type { LlmErrorCode } from "./errors";

export type LlmProvider =
  | "openrouter"
  | "lmstudio"
  | "ollama"
  | "openai"
  | "openai_compatible"
  | "gemini"
  | "codex"
  | "claude_code";

export type ResponseMode = "json_schema" | "json_object" | "text" | "none";

export interface JsonSchemaDefinition {
  name: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

export interface LlmRequestOptions<_T> {
  /** The model to use (e.g., 'google/gemini-3-flash-preview') */
  model: string;
  /** The prompt messages to send */
  messages: Array<{ role: "user" | "system" | "assistant"; content: string }>;
  /** JSON schema for structured output */
  jsonSchema: JsonSchemaDefinition;
  /** Number of retries on parsing failures (default: 0) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 500) */
  retryDelayMs?: number;
  /** Job ID for logging purposes */
  jobId?: string;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
  /**
   * Ceiling on ONE attempt, in ms. Omitted — every caller today — resolves
   * from the `llmRequestTimeoutMs` setting. Pass it only when the caller has
   * a budget of its own that is tighter than the user's global one.
   */
  timeoutMs?: number;
  /** Short human label shown in the live LLM queue (e.g. "score job", "tailor CV") */
  label?: string;
  /** Optional secondary line shown under the label (e.g. "Title @ Employer") */
  subject?: string;
  /**
   * Per-call reasoning effort, claude_code only. Overrides the
   * `claudeCodeEffort` setting (which reaches the spawner as
   * CLAUDE_CODE_EFFORT) for this call alone — the setting is a process-global,
   * so a caller that needs a different effort must pass it here rather than
   * writing process.env, which would leak into every concurrent call.
   * Other providers ignore it: no other provider exposes the knob.
   */
  effort?: ClaudeCodeEffortLevel;
}

export interface LlmTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface LlmResult<T> {
  success: true;
  data: T;
  usage?: LlmTokenUsage;
}

export interface LlmError {
  success: false;
  error: string;
  /**
   * Why it failed. Required so no caller can accidentally treat a rate limit as
   * a configuration problem — the mistake that had a 429 reported as
   * "API key not configured".
   */
  code: LlmErrorCode;
}

export type LlmResponse<T> = LlmResult<T> | LlmError;

export type LlmValidationResult = {
  valid: boolean;
  message: string | null;
  username?: string | null;
};

export type LlmServiceOptions = {
  provider?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
};

export type ProviderStrategy = {
  provider: LlmProvider;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  modes: ResponseMode[];
  validationPaths: string[];
  buildRequest: (args: {
    mode: ResponseMode;
    baseUrl: string;
    apiKey: string | null;
    model: string;
    messages: LlmRequestOptions<unknown>["messages"];
    jsonSchema: JsonSchemaDefinition;
  }) => { url: string; headers: Record<string, string>; body: unknown };
  extractText: (response: unknown) => string | null;
  isCapabilityError: (args: {
    mode: ResponseMode;
    status?: number;
    body?: string;
  }) => boolean;
  getValidationUrls: (args: {
    baseUrl: string;
    apiKey: string | null;
  }) => string[];
};

export interface LlmApiError extends Error {
  status?: number;
  body?: string;
}

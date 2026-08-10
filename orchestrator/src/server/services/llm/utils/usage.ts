/**
 * Best-effort token-usage extraction across the providers we support.
 * Returns `{ promptTokens, completionTokens }`; either or both may be
 * `null` when the provider didn't include usage info or used keys we
 * don't recognise. Callers shouldn't fail on missing data — the
 * `LLM call completed` log line just omits the missing fields.
 *
 * Provider key shapes:
 *  - OpenAI / OpenRouter / LM Studio / Ollama (chat completions):
 *      `data.usage.prompt_tokens` / `completion_tokens`.
 *  - OpenAI Responses API:
 *      `data.usage.input_tokens` / `output_tokens`.
 *  - Gemini:
 *      `data.usageMetadata.promptTokenCount` / `candidatesTokenCount`.
 *  - Codex (app-server protocol): no usage exposed today.
 */
export interface LlmTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export function extractUsage(data: unknown): LlmTokenUsage {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { promptTokens: null, completionTokens: null };
  }
  const root = data as Record<string, unknown>;

  const usage = readObject(root.usage);
  if (usage) {
    const promptTokens =
      numericOrNull(usage.prompt_tokens) ?? numericOrNull(usage.input_tokens);
    const completionTokens =
      numericOrNull(usage.completion_tokens) ??
      numericOrNull(usage.output_tokens);
    if (promptTokens !== null || completionTokens !== null) {
      return { promptTokens, completionTokens };
    }
  }

  const usageMetadata = readObject(root.usageMetadata);
  if (usageMetadata) {
    const promptTokens = numericOrNull(usageMetadata.promptTokenCount);
    const completionTokens = numericOrNull(
      usageMetadata.candidatesTokenCount,
    );
    if (promptTokens !== null || completionTokens !== null) {
      return { promptTokens, completionTokens };
    }
  }

  return { promptTokens: null, completionTokens: null };
}

/**
 * Sum the provider-reported halves into a single total. A provider that
 * reports just one non-zero side still yields a total, as in the
 * batch-URL-import convention. Returns `null` when the provider reported
 * neither half, and — deliberately diverging from that convention — also
 * when the reported total is zero: a zeroed usage block (some
 * OpenAI-compatible proxies emit one) is indistinguishable from "no usage
 * reported", and a real completion never costs zero tokens. Never estimates:
 * no token count is invented from prompt length.
 */
export function computeTotalTokens(
  usage: LlmTokenUsage | null | undefined,
): number | null {
  if (!usage) return null;
  const { promptTokens, completionTokens } = usage;
  if (promptTokens === null && completionTokens === null) return null;
  const total = (promptTokens ?? 0) + (completionTokens ?? 0);
  return total > 0 ? total : null;
}

/**
 * Compute output tokens-per-second for an LLM call. Returns `null` when
 * we don't have enough information (no completion-token count or
 * non-positive duration). Rounded to one decimal place for log readability.
 */
export function computeTokensPerSec(
  completionTokens: number | null,
  durationMs: number,
): number | null {
  if (completionTokens === null || durationMs <= 0) return null;
  const tps = completionTokens / (durationMs / 1000);
  return Math.round(tps * 10) / 10;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

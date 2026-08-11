/**
 * Why an LLM call failed, at the granularity callers need to make a decision.
 *
 * The distinction that matters most is `rate_limited` vs everything else: a
 * provider saying "you've hit your session limit" is a temporary, global,
 * account-wide stop, and treating it like any other failure is what let a 429
 * be reported as "API key not configured" and silently keyword-score a batch of
 * jobs.
 */
export type LlmErrorCode = "rate_limited" | "auth" | "unknown";

const RATE_LIMIT_PATTERNS = [
  /session limit/i,
  /rate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /quota/i,
  /usage limit/i,
];

const AUTH_PATTERNS = [
  /api key/i,
  /unauthorized/i,
  /invalid[_ -]?api[_ -]?key/i,
  /authentication/i,
  /credentials/i,
];

/**
 * Classify a failure from its HTTP status when we have one, falling back to the
 * message. The message path matters for the CLI-backed providers (codex,
 * claude_code), which surface a rate limit as text with no status at all —
 * "You've hit your session limit · resets 2:10am (UTC) (HTTP 429)".
 */
export function classifyLlmError(args: {
  status?: number;
  message?: string;
}): LlmErrorCode {
  const { status, message } = args;

  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";

  const text = message ?? "";
  // Checked before the auth patterns: a rate-limit body often mentions the key
  // or the account, and mistaking a temporary stop for a bad credential is the
  // exact confusion this function exists to prevent.
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "rate_limited";
  }
  // A bare "(HTTP 429)" inside a CLI's message, with no status field to read.
  if (/\b429\b/.test(text)) return "rate_limited";
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) return "auth";

  return "unknown";
}

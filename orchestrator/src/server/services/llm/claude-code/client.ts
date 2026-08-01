import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { logger } from "@infra/logger";

import type {
  JsonSchemaDefinition,
  LlmRequestOptions,
  LlmTokenUsage,
} from "../types";
import { truncate } from "../utils/string";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_AUTH_TIMEOUT_MS = 15_000;
const MAX_STDERR_LINES = 40;

/**
 * Replaces Claude Code's default agent system prompt. Keeping it minimal is
 * what makes this provider affordable: with the stock harness (no
 * --system-prompt / --tools / --setting-sources) a trivial call measured
 * ~52k input tokens and $0.062; with the flag set below the same call is
 * ~2.1k tokens and $0.007.
 */
const HARNESS_SYSTEM_PROMPT = [
  "You are a headless JSON generation service for CV Clanker.",
  "Answer directly using only the information contained in the prompt.",
  "Do not use tools and do not ask follow-up questions.",
  "Return only data conforming to the requested JSON schema.",
].join(" ");

/**
 * Suggestions for the model dropdown. The family aliases lead because they
 * never rot — the CLI resolves them to the current model in that family — while
 * the dated ids below them pin an exact build for anyone who wants that.
 */
export const CLAUDE_CODE_SUGGESTED_MODELS: string[] = [
  "sonnet",
  "opus",
  "haiku",
  "fable",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
];

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildClaudeCodeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    return "Claude Code CLI was not found in PATH. Install @anthropic-ai/claude-code in the container or set CLAUDE_CODE_BIN.";
  }
  return truncate(message, 500);
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.includes("aborted");
}

/**
 * Flattens the message list into one transcript, mirroring how the Codex
 * provider formats a turn. The app's own system message rides inside the
 * transcript; `--system-prompt` carries only the harness instruction above.
 */
function formatPrompt(
  messages: LlmRequestOptions<unknown>["messages"],
): string {
  const transcript = messages
    .map(
      (message, index) =>
        `Message ${index + 1} (${message.role.toUpperCase()}):\n${message.content.trim()}`,
    )
    .join("\n\n");

  return ["Transcript:", transcript].join("\n\n");
}

type ClaudeCodeResultEnvelope = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  usage?: Record<string, unknown>;
};

/**
 * The CLI exits 0 even on an auth failure (verified against v2.1.220: a bad
 * token yields exit 0, `is_error: true`, `subtype: "success"`,
 * `api_error_status: 401`). So `is_error` — never the exit code — is the
 * error signal.
 */
export function parseCliJsonOutput(stdout: string): {
  text: string;
  usage: LlmTokenUsage;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Claude Code CLI produced no output.");
  }

  let parsed: ClaudeCodeResultEnvelope | null = null;
  try {
    parsed = JSON.parse(trimmed) as ClaudeCodeResultEnvelope;
  } catch {
    // Tolerate stray non-JSON lines (startup notices) around the envelope by
    // scanning backwards for the result event.
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const candidate = JSON.parse(line) as ClaudeCodeResultEnvelope;
        if (candidate.type === "result") {
          parsed = candidate;
          break;
        }
      } catch {
        // Not a JSON line — keep scanning.
      }
    }
  }

  if (!parsed) {
    throw new Error("Claude Code CLI output did not include a result event.");
  }

  if (parsed.is_error) {
    const status = parsed.api_error_status
      ? ` (HTTP ${parsed.api_error_status})`
      : "";
    throw new Error(
      `${toNonEmptyString(parsed.result) || "Claude Code CLI reported an error."}${status}`,
    );
  }

  const usage = readUsage(parsed.usage);

  // `structured_output` is the parsed object the --json-schema run produced;
  // `result` is its string form. Prefer the former, fall back to the latter.
  // The guard is deliberately "is an object" rather than "is not undefined":
  // a null (or scalar) structured_output would otherwise stringify to "null"
  // and surface as a successful call carrying `data: null`, which every
  // consumer then dereferences and dies on — instead of falling through to
  // `result` and, failing that, a retryable error.
  if (
    typeof parsed.structured_output === "object" &&
    parsed.structured_output !== null
  ) {
    return { text: JSON.stringify(parsed.structured_output), usage };
  }

  const text = toNonEmptyString(parsed.result);
  if (!text) {
    throw new Error(
      "Claude Code CLI output did not include a `result` or `structured_output` field.",
    );
  }
  return { text, usage };
}

function readUsage(raw: unknown): LlmTokenUsage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { promptTokens: null, completionTokens: null };
  }
  const usage = raw as Record<string, unknown>;
  // promptTokens means BILLED input, so the cache fields count: on a Claude
  // Code turn they dominate (a stock-harness call measured 26.7k cache-creation
  // + 25.9k cache-read against 20 uncached input tokens). Reading input_tokens
  // alone would under-report input by orders of magnitude.
  const inputParts = [
    numericOrNull(usage.input_tokens),
    numericOrNull(usage.cache_creation_input_tokens),
    numericOrNull(usage.cache_read_input_tokens),
  ].filter((value): value is number => value !== null);

  return {
    promptTokens: inputParts.length
      ? inputParts.reduce((sum, value) => sum + value, 0)
      : null,
    completionTokens: numericOrNull(usage.output_tokens),
  };
}

function buildChildEnv(oauthToken: string | null): NodeJS.ProcessEnv {
  // Callers normally pass nothing: the `claudeCodeOauthToken` setting carries
  // envKey CLAUDE_CODE_OAUTH_TOKEN, so the registry already syncs the stored
  // value into process.env at boot and on save, and the child inherits it.
  // The explicit argument exists for callers holding a not-yet-persisted token.

  if (!oauthToken) return { ...process.env };
  return { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
}

export type ClaudeCodeSpawnFn = typeof spawn;

function runClaudeCode(args: {
  spawnFn: ClaudeCodeSpawnFn;
  argv: string[];
  stdin: string | null;
  oauthToken: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const bin = process.env.CLAUDE_CODE_BIN?.trim() || "claude";

  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdinError: Error | null = null;
    let settled = false;

    const readStderr = (): string => {
      const lines = Buffer.concat(stderrChunks)
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.slice(-MAX_STDERR_LINES).join(" | ");
    };

    const child = args.spawnFn(bin, args.argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(args.oauthToken),
      // Pinned to a scratch directory rather than inherited: the CLI resolves
      // context (CLAUDE.md and friends) relative to its cwd, and an ambient one
      // would silently inflate every prompt — the opposite of what the trimmed
      // flag set is for.
      cwd: tmpdir(),
      windowsHide: true,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (args.signal) args.signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      fn();
    };

    function onAbort() {
      child.kill("SIGTERM");
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        reject(
          new Error(`Claude Code CLI timed out after ${args.timeoutMs}ms.`),
        );
      });
    }, args.timeoutMs);

    if (args.signal) {
      if (args.signal.aborted) {
        onAbort();
      } else {
        args.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      finish(() => {
        if (args.signal?.aborted) {
          reject(new Error("Claude Code CLI invocation was aborted."));
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        // A stdin failure only matters if it cost us the answer. Large prompts
        // can EPIPE once the CLI has read enough and stopped reading, and
        // rejecting on that would discard a turn that actually succeeded.
        if (!stdout && stdinError) {
          reject(stdinError);
          return;
        }
        resolve({ stdout, stderr: readStderr(), code });
      });
    });

    child.stdin.on("error", (error) => {
      stdinError = error;
    });

    // Closing stdin immediately is load-bearing: the CLI otherwise stalls for
    // seconds waiting on input it will never receive.
    child.stdin.end(args.stdin ?? undefined);
  });
}

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string | null;
  email?: string | null;
  subscriptionType?: string | null;
};

export type ClaudeCodeClientOptions = {
  spawnFn?: ClaudeCodeSpawnFn;
};

export class ClaudeCodeClient {
  private readonly spawnFn: ClaudeCodeSpawnFn;

  constructor(options: ClaudeCodeClientOptions = {}) {
    this.spawnFn = options.spawnFn ?? spawn;
  }

  /**
   * Uses `claude auth status --json` — no inference, ~240ms, free. It reports
   * whether auth material is *present*, not whether it is valid: a malformed
   * token still answers `loggedIn: true`, and surfaces as a 401 on the first
   * real call. That trade is deliberate — this runs on every app load via
   * useOnboardingRequirement, where a real inference probe would mean a paid,
   * multi-second call blocking the onboarding gate each time.
   */
  async validateCredentials(
    oauthToken: string | null = null,
    signal?: AbortSignal,
  ): Promise<{
    valid: boolean;
    message: string | null;
    username?: string | null;
  }> {
    try {
      const { stdout, stderr } = await runClaudeCode({
        spawnFn: this.spawnFn,
        argv: ["auth", "status", "--json"],
        stdin: null,
        oauthToken,
        timeoutMs: getPositiveIntEnv(
          "CLAUDE_CODE_AUTH_TIMEOUT_MS",
          DEFAULT_AUTH_TIMEOUT_MS,
        ),
        signal,
      });

      let status: ClaudeAuthStatus | null = null;
      try {
        status = JSON.parse(stdout) as ClaudeAuthStatus;
      } catch {
        status = null;
      }

      if (!status) {
        return {
          valid: false,
          message: truncate(
            stderr || "Claude Code CLI returned an unreadable auth status.",
            300,
          ),
          username: null,
        };
      }

      if (!status.loggedIn) {
        return {
          valid: false,
          message:
            "Claude Code is not authenticated. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or paste the token in the Claude Code OAuth token field.",
          username: null,
        };
      }

      return {
        valid: true,
        message: null,
        username: toNonEmptyString(status.email),
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          valid: false,
          message: "Claude Code validation was cancelled.",
          username: null,
        };
      }
      const message = buildClaudeCodeErrorMessage(error);
      logger.warn("Claude Code credential validation failed", {
        message: truncate(message, 200),
      });
      return { valid: false, message, username: null };
    }
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([...CLAUDE_CODE_SUGGESTED_MODELS]);
  }

  async callJson(
    options: LlmRequestOptions<unknown>,
    oauthToken: string | null = null,
  ): Promise<{ text: string; usage: LlmTokenUsage }> {
    // Spawn failures are mapped here too, not just in validateCredentials: a
    // missing binary otherwise reaches the job's persisted failure reason as a
    // bare "spawn claude ENOENT" instead of saying how to install it.
    const { stdout, stderr, code } = await runClaudeCode({
      spawnFn: this.spawnFn,
      argv: buildCallArgv({
        model: options.model,
        jsonSchema: options.jsonSchema,
      }),
      // The prompt goes on stdin, never argv: CV/JD payloads are large and an
      // argv prompt would also expose the candidate's CV in the process table.
      stdin: formatPrompt(options.messages),
      oauthToken,
      timeoutMs: getPositiveIntEnv(
        "CLAUDE_CODE_REQUEST_TIMEOUT_MS",
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      signal: options.signal,
    }).catch((error: unknown) => {
      throw new Error(buildClaudeCodeErrorMessage(error));
    });

    // A usable run always prints the JSON envelope, and an auth failure prints
    // one too (exit 0, is_error). Empty stdout therefore means the CLI never
    // got as far as a turn — surface stderr, which is the only diagnostic left.
    if (!stdout) {
      throw new Error(
        truncate(
          stderr || `Claude Code CLI exited with code ${code ?? "unknown"}.`,
          500,
        ),
      );
    }

    try {
      return parseCliJsonOutput(stdout);
    } catch (error) {
      // Unparseable stdout means stderr is the only real diagnostic, and it
      // would otherwise be dropped on the floor.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(truncate(stderr ? `${detail} (${stderr})` : detail, 500));
    }
  }
}

/**
 * Flag order matters: `--tools` is variadic, so it must be followed by another
 * flag rather than a positional, or the CLI swallows the next value.
 */
export function buildCallArgv(args: {
  model: string;
  jsonSchema: JsonSchemaDefinition;
}): string[] {
  const argv = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    // "" disables every built-in tool; plan mode stays as defence in depth.
    "--tools",
    "",
    // Ignore user/project/local settings, CLAUDE.md and external MCP servers so
    // the server's inference is deterministic and cheap.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt",
    HARNESS_SYSTEM_PROMPT,
  ];

  const model = args.model?.trim();
  if (model) {
    argv.push("--model", model);
  }

  argv.push("--json-schema", JSON.stringify(args.jsonSchema.schema));
  return argv;
}

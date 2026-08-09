import { spawn } from "node:child_process";
import { logger } from "@infra/logger";
import type { ClaudeCodeCliStatus } from "@shared/types";
import { truncate } from "../utils/string";

const CLI_PACKAGE = "@anthropic-ai/claude-code";
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${CLI_PACKAGE}/latest`;

// The probe is a --version exec (~85ms measured); the registry fetch is one
// small JSON document. The install default covers a cold npm download of the
// package (~4s measured on this box) with two orders of magnitude of headroom
// for slow home-server links; all three are env-overridable like the other
// CLAUDE_CODE_* knobs.
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TAIL = 500;

// "latest" or a plain semver (optionally with a prerelease suffix). Anything
// else is rejected before it can reach npm's argv — a version starting with
// "-" would otherwise be parsed as an npm flag.
const VERSION_PATTERN = /^(latest|\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?)$/;

export type ManageSpawnFn = typeof spawn;
export type ManageFetchFn = typeof fetch;

/** Thrown before any spawn when the requested version fails validation — the
 * route maps this (and only this) to a 400 by type, never by message text. */
export class InvalidClaudeCodeVersionError extends Error {}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Minimal env for the version probe and the npm install: PATH to resolve the
 * binaries, HOME for npm's cache, proxy/TLS vars for restricted networks.
 * Deliberately NOT the server's full env — same posture as the inference
 * spawns in client.ts.
 */
function buildManageEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCommand(args: {
  spawnFn: ManageSpawnFn;
  command: string;
  argv: string[];
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const child = args.spawnFn(args.command, args.argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildManageEnv(),
      windowsHide: true,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() =>
        reject(
          new Error(`${args.command} timed out after ${args.timeoutMs}ms.`),
        ),
      );
    }, args.timeoutMs);

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
      finish(() =>
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
          code,
        }),
      );
    });
  });
}

function parseCliVersion(output: string): string | null {
  // `claude --version` prints e.g. "2.1.220 (Claude Code)".
  const match = output.match(/\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?/);
  return match ? match[0] : null;
}

async function probeInstalledVersion(
  spawnFn: ManageSpawnFn,
): Promise<string | null> {
  const bin = process.env.CLAUDE_CODE_BIN?.trim() || "claude";
  try {
    const { stdout, code } = await runCommand({
      spawnFn,
      command: bin,
      argv: ["--version"],
      timeoutMs: getPositiveIntEnv(
        "CLAUDE_CODE_PROBE_TIMEOUT_MS",
        DEFAULT_PROBE_TIMEOUT_MS,
      ),
    });
    if (code !== 0) return null;
    return parseCliVersion(stdout);
  } catch {
    return null;
  }
}

async function fetchLatestVersion(
  fetchFn: ManageFetchFn,
): Promise<string | null> {
  try {
    const response = await fetchFn(REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(
        getPositiveIntEnv(
          "CLAUDE_CODE_REGISTRY_TIMEOUT_MS",
          DEFAULT_REGISTRY_TIMEOUT_MS,
        ),
      ),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" &&
      VERSION_PATTERN.test(data.version)
      ? data.version
      : null;
  } catch (error) {
    logger.debug("Claude Code registry version check failed", {
      message: truncate(
        error instanceof Error ? error.message : String(error),
        200,
      ),
    });
    return null;
  }
}

export async function getClaudeCodeCliStatus(deps?: {
  spawnFn?: ManageSpawnFn;
  fetchFn?: ManageFetchFn;
}): Promise<ClaudeCodeCliStatus> {
  const spawnFn = deps?.spawnFn ?? spawn;
  const fetchFn = deps?.fetchFn ?? fetch;

  const [installed, latest] = await Promise.all([
    probeInstalledVersion(spawnFn),
    fetchLatestVersion(fetchFn),
  ]);

  return {
    installed,
    latest,
    pinned: process.env.CLAUDE_CODE_CLI_PINNED?.trim() || null,
  };
}

/**
 * User-triggered `npm install -g` of the CLI inside the running container —
 * the explicit counterpart to the disabled auto-updater. The install lasts
 * until the next image rebuild, where the Dockerfile pin wins again. The
 * version string is validated before it touches argv, and the command is an
 * argv array (no shell), so neither npm flags nor shell syntax can be
 * injected through it.
 */
export async function updateClaudeCodeCli(
  version: string,
  deps?: { spawnFn?: ManageSpawnFn; fetchFn?: ManageFetchFn },
): Promise<ClaudeCodeCliStatus> {
  const spawnFn = deps?.spawnFn ?? spawn;
  const requested = version.trim();

  if (!VERSION_PATTERN.test(requested)) {
    throw new InvalidClaudeCodeVersionError(
      `Invalid version "${truncate(requested, 50)}" — use "latest" or an exact version like 2.1.220.`,
    );
  }

  const { stderr, code } = await runCommand({
    spawnFn,
    command: "npm",
    argv: [
      "install",
      "-g",
      "--no-fund",
      "--no-audit",
      `${CLI_PACKAGE}@${requested}`,
    ],
    timeoutMs: getPositiveIntEnv(
      "CLAUDE_CODE_INSTALL_TIMEOUT_MS",
      DEFAULT_INSTALL_TIMEOUT_MS,
    ),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new Error("npm was not found in PATH inside the container.");
    }
    throw new Error(truncate(message, MAX_OUTPUT_TAIL));
  });

  if (code !== 0) {
    throw new Error(
      truncate(
        stderr || `npm install exited with code ${code ?? "unknown"}.`,
        MAX_OUTPUT_TAIL,
      ),
    );
  }

  logger.info("Claude Code CLI updated", { requested });
  return getClaudeCodeCliStatus(deps);
}

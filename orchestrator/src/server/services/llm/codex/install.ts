import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@infra/logger";
import { getDataDir } from "../../../config/dataDir";
import { truncate } from "../utils/string";

const CLI_PACKAGE = "@openai/codex";

// Everything Codex-related that npm writes lives under <data>/codex so the
// install rides the same volume as the rest of the app state and survives an
// image recreate.
const INSTALL_SUBDIR = "codex";

// Covers a cold npm download of the CLI on a slow home-server link, matching
// the Claude Code install default in ../claude-code/manage.ts. Node's own
// server.requestTimeout (300s) is the outer ceiling for the synchronous
// install POST, so a larger default would only outlive its own request.
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TAIL = 500;

// "latest" or a plain semver (optionally with a prerelease suffix). The value
// comes from the operator's CODEX_CLI_VERSION env, but it still must not reach
// npm's argv unvalidated — a value starting with "-" would parse as a flag.
const VERSION_PATTERN = /^(latest|\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?)$/;

export type InstallSpawnFn = typeof spawn;

export type CodexInstallStatus = {
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string | null;
};

/** Thrown before any spawn when CODEX_CLI_VERSION fails validation. */
export class InvalidCodexCliVersionError extends Error {}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function installBinPath(): string {
  return join(getDataDir(), INSTALL_SUBDIR, "node_modules", ".bin", "codex");
}

/**
 * The ONE predicate for "the runtime-installed Codex is present" — shared by
 * the binary resolver and the /codex-auth `installed` status field so the two
 * can never disagree. `npm install --prefix` drops `.bin/codex` as a symlink,
 * so the check must follow it (statSync), demand a regular file (X_OK alone
 * passes on directories), and demand execute permission; a broken or
 * half-written link fails here and the resolver falls through to PATH.
 */
export function resolvedCodexInstallPath(): string | null {
  const binPath = installBinPath();
  try {
    const stats = statSync(binPath);
    if (!stats.isFile()) return null;
    accessSync(binPath, constants.X_OK);
    return binPath;
  } catch {
    return null;
  }
}

/**
 * Binary resolution for every codex spawn. Precedence: explicit operator
 * override (the bring-your-own / air-gapped escape hatch) → the runtime
 * install in the data volume (a deliberate in-app Update must beat a binary
 * baked into a derived image) → bare "codex" on PATH.
 */
export function resolveCodexCommand(): string {
  const override = process.env.CODEX_APP_SERVER_BIN?.trim();
  if (override) return override;
  return resolvedCodexInstallPath() ?? "codex";
}

function readInstalledVersion(): string | null {
  try {
    const pkgPath = join(
      getDataDir(),
      INSTALL_SUBDIR,
      "node_modules",
      CLI_PACKAGE,
      "package.json",
    );
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getCodexInstallStatus(): CodexInstallStatus {
  // An explicit CODEX_CLI_VERSION=latest means the same as unset — "tracking
  // latest" — so normalize it to null rather than surfacing a pin the UI
  // would render as a version.
  const pin = process.env.CODEX_CLI_VERSION?.trim();
  return {
    installed: resolvedCodexInstallPath() !== null,
    installedVersion: readInstalledVersion(),
    pinnedVersion: pin && pin !== "latest" ? pin : null,
  };
}

export function resolveRequestedCodexVersion(): string {
  const requested = process.env.CODEX_CLI_VERSION?.trim() || "latest";
  if (!VERSION_PATTERN.test(requested)) {
    throw new InvalidCodexCliVersionError(
      `Invalid CODEX_CLI_VERSION "${truncate(requested, 50)}" — leave it unset for latest, or set an exact version like 0.120.0.`,
    );
  }
  return requested;
}

/**
 * Minimal env for the npm install: PATH to resolve the binaries, HOME for
 * npm's cache, proxy/TLS vars for restricted networks. Same posture and key
 * list as the Claude Code manage spawns.
 */
function buildInstallEnv(): NodeJS.ProcessEnv {
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
  spawnFn: InstallSpawnFn;
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
      env: buildInstallEnv(),
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

/** Maps npm's stderr onto the failure modes a user can actually act on. */
function describeInstallFailure(stderr: string, code: number | null): string {
  const tail = truncate(stderr, MAX_OUTPUT_TAIL);
  if (/EACCES|EPERM/.test(stderr)) {
    return `npm hit a permissions error (its cache lives under $HOME/.npm): ${tail}`;
  }
  if (/ENOSPC/.test(stderr)) {
    return `Not enough disk space for the Codex install: ${tail}`;
  }
  if (
    /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network/i.test(
      stderr,
    )
  ) {
    return `Network error reaching the npm registry: ${tail}`;
  }
  return tail || `npm install exited with code ${code ?? "unknown"}.`;
}

let activeInstall: Promise<CodexInstallStatus> | null = null;

async function runInstall(
  spawnFn: InstallSpawnFn,
): Promise<CodexInstallStatus> {
  const requested = resolveRequestedCodexVersion();
  const prefix = join(getDataDir(), INSTALL_SUBDIR);

  const { stderr, code } = await runCommand({
    spawnFn,
    command: "npm",
    argv: [
      "install",
      "--prefix",
      prefix,
      "--no-fund",
      "--no-audit",
      `${CLI_PACKAGE}@${requested}`,
    ],
    timeoutMs: getPositiveIntEnv(
      "CODEX_INSTALL_TIMEOUT_MS",
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
    throw new Error(describeInstallFailure(stderr, code));
  }

  if (resolvedCodexInstallPath() === null) {
    throw new Error(
      `npm reported success but no executable appeared at ${installBinPath()} — retry the install, or check the data volume.`,
    );
  }

  const status = getCodexInstallStatus();
  logger.info("Codex CLI installed", {
    requested,
    installedVersion: status.installedVersion,
  });
  return status;
}

/**
 * User-triggered install/update of the Codex CLI into the data volume,
 * fetching CODEX_CLI_VERSION (operator pin) or latest. Single-flight: an
 * overlapping request JOINS the in-flight install rather than racing a second
 * `npm install --prefix` into the same dir, which corrupts node_modules —
 * the same reason login.ts guards its device-auth session. Install-during-use
 * is fine and needs no "stop the server first" step: a live app-server keeps
 * its inode; only the next spawn picks up the new binary.
 */
export async function installCodexCli(deps?: {
  spawnFn?: InstallSpawnFn;
}): Promise<CodexInstallStatus> {
  if (activeInstall) {
    return await activeInstall;
  }
  const install = runInstall(deps?.spawnFn ?? spawn).finally(() => {
    activeInstall = null;
  });
  activeInstall = install;
  return await install;
}

export function __resetCodexInstallForTests(): void {
  activeInstall = null;
}

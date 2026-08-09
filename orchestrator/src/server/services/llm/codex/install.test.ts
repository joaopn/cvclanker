// @vitest-environment node
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCodexInstallForTests,
  getCodexInstallStatus,
  InvalidCodexCliVersionError,
  installCodexCli,
  resolveCodexCommand,
  resolvedCodexInstallPath,
  resolveRequestedCodexVersion,
} from "./install";

let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["DATA_DIR", "CODEX_APP_SERVER_BIN", "CODEX_CLI_VERSION"];

function binDir(): string {
  return join(dataDir, "codex", "node_modules", ".bin");
}

function binPath(): string {
  return join(binDir(), "codex");
}

function writeExecutableBin(): void {
  mkdirSync(binDir(), { recursive: true });
  writeFileSync(binPath(), "#!/bin/sh\nexit 0\n");
  chmodSync(binPath(), 0o755);
}

function writePackageJson(version: string): void {
  const pkgDir = join(dataDir, "codex", "node_modules", "@openai", "codex");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
}

type MockProc = ChildProcessWithoutNullStreams & { killed: boolean };

function createMockProcess(
  configure: (stderr: PassThrough, proc: EventEmitter) => void,
): MockProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as MockProc;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  configure(stderr, proc);
  return proc;
}

function succeedingSpawn(onSpawn?: () => void) {
  return vi.fn(() =>
    createMockProcess((_stderr, proc) => {
      setImmediate(() => {
        onSpawn?.();
        proc.emit("close", 0);
      });
    }),
  ) as never;
}

function failingSpawn(stderrText: string, code = 1) {
  return vi.fn(() =>
    createMockProcess((stderr, proc) => {
      setImmediate(() => {
        stderr.write(stderrText);
        proc.emit("close", code);
      });
    }),
  ) as never;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  dataDir = mkdtempSync(join(tmpdir(), "codex-install-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.CODEX_APP_SERVER_BIN;
  delete process.env.CODEX_CLI_VERSION;
  __resetCodexInstallForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("resolveCodexCommand precedence", () => {
  it("prefers CODEX_APP_SERVER_BIN over an existing data install", () => {
    writeExecutableBin();
    process.env.CODEX_APP_SERVER_BIN = "/custom/codex ";
    expect(resolveCodexCommand()).toBe("/custom/codex");
  });

  it("resolves the data-volume install when present and executable", () => {
    writeExecutableBin();
    expect(resolveCodexCommand()).toBe(binPath());
  });

  it("falls back to PATH when nothing is installed", () => {
    expect(resolveCodexCommand()).toBe("codex");
  });

  it("falls through to PATH on a broken symlink", () => {
    mkdirSync(binDir(), { recursive: true });
    symlinkSync(join(dataDir, "does-not-exist"), binPath());
    expect(resolveCodexCommand()).toBe("codex");
    expect(resolvedCodexInstallPath()).toBeNull();
  });

  it("falls through to PATH on a non-executable file", () => {
    mkdirSync(binDir(), { recursive: true });
    writeFileSync(binPath(), "not executable");
    chmodSync(binPath(), 0o644);
    expect(resolveCodexCommand()).toBe("codex");
  });

  it("falls through to PATH when the bin path is a directory", () => {
    mkdirSync(binPath(), { recursive: true });
    expect(resolveCodexCommand()).toBe("codex");
  });
});

describe("getCodexInstallStatus", () => {
  it("shares the resolver predicate: a broken symlink is not installed", () => {
    mkdirSync(binDir(), { recursive: true });
    symlinkSync(join(dataDir, "does-not-exist"), binPath());
    writePackageJson("1.2.3");
    expect(getCodexInstallStatus()).toEqual({
      installed: false,
      installedVersion: "1.2.3",
      pinnedVersion: null,
    });
  });

  it("reports the installed version and the operator pin", () => {
    writeExecutableBin();
    writePackageJson("0.130.0");
    process.env.CODEX_CLI_VERSION = "0.130.0";
    expect(getCodexInstallStatus()).toEqual({
      installed: true,
      installedVersion: "0.130.0",
      pinnedVersion: "0.130.0",
    });
  });

  it("normalizes an explicit latest pin to null (tracking latest)", () => {
    process.env.CODEX_CLI_VERSION = "latest";
    expect(getCodexInstallStatus().pinnedVersion).toBeNull();
  });
});

describe("resolveRequestedCodexVersion", () => {
  it("defaults to latest when CODEX_CLI_VERSION is unset", () => {
    expect(resolveRequestedCodexVersion()).toBe("latest");
  });

  it("honors a concrete pin", () => {
    process.env.CODEX_CLI_VERSION = "0.120.0";
    expect(resolveRequestedCodexVersion()).toBe("0.120.0");
  });

  it("rejects a value that could parse as an npm flag", () => {
    process.env.CODEX_CLI_VERSION = "--registry=https://evil.example";
    expect(() => resolveRequestedCodexVersion()).toThrow(
      InvalidCodexCliVersionError,
    );
  });
});

describe("installCodexCli", () => {
  it("runs npm install --prefix into the data dir and returns the status", async () => {
    const spawnFn = succeedingSpawn(() => {
      writeExecutableBin();
      writePackageJson("9.9.9");
    });

    const status = await installCodexCli({ spawnFn });

    expect(status).toEqual({
      installed: true,
      installedVersion: "9.9.9",
      pinnedVersion: null,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "--prefix",
        join(dataDir, "codex"),
        "--no-fund",
        "--no-audit",
        "@openai/codex@latest",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("honors the CODEX_CLI_VERSION pin", async () => {
    process.env.CODEX_CLI_VERSION = "0.120.0";
    const spawnFn = succeedingSpawn(() => {
      writeExecutableBin();
      writePackageJson("0.120.0");
    });

    const status = await installCodexCli({ spawnFn });

    expect(status.pinnedVersion).toBe("0.120.0");
    expect(spawnFn).toHaveBeenCalledWith(
      "npm",
      expect.arrayContaining(["@openai/codex@0.120.0"]),
      expect.anything(),
    );
  });

  it("maps a missing npm to a clear message", async () => {
    const spawnFn = vi.fn(() =>
      createMockProcess((_stderr, proc) => {
        setImmediate(() => {
          proc.emit("error", new Error("spawn npm ENOENT"));
        });
      }),
    ) as never;

    await expect(installCodexCli({ spawnFn })).rejects.toThrow(
      "npm was not found in PATH inside the container.",
    );
  });

  it("classifies EACCES failures", async () => {
    await expect(
      installCodexCli({ spawnFn: failingSpawn("npm ERR! EACCES /root/.npm") }),
    ).rejects.toThrow(/permissions error/);
  });

  it("classifies ENOSPC failures", async () => {
    await expect(
      installCodexCli({ spawnFn: failingSpawn("npm ERR! ENOSPC") }),
    ).rejects.toThrow(/disk space/);
  });

  it("classifies registry network failures", async () => {
    await expect(
      installCodexCli({
        spawnFn: failingSpawn("npm ERR! ENOTFOUND registry.npmjs.org"),
      }),
    ).rejects.toThrow(/Network error/);
  });

  it("fails loudly when npm exits 0 but no executable appeared", async () => {
    await expect(
      installCodexCli({ spawnFn: succeedingSpawn() }),
    ).rejects.toThrow(/no executable appeared/);
  });

  it("joins an overlapping install instead of spawning twice", async () => {
    const spawnFn = succeedingSpawn(() => {
      writeExecutableBin();
      writePackageJson("9.9.9");
    });

    const [first, second] = await Promise.all([
      installCodexCli({ spawnFn }),
      installCodexCli({ spawnFn }),
    ]);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("clears the single-flight guard on failure so a retry can run", async () => {
    await expect(
      installCodexCli({ spawnFn: failingSpawn("npm ERR! ENOSPC") }),
    ).rejects.toThrow(/disk space/);

    const spawnFn = succeedingSpawn(() => {
      writeExecutableBin();
      writePackageJson("9.9.9");
    });
    await expect(installCodexCli({ spawnFn })).resolves.toMatchObject({
      installed: true,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

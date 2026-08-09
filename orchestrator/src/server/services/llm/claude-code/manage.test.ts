// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClaudeCodeCliStatus,
  type ManageFetchFn,
  type ManageSpawnFn,
  updateClaudeCodeCli,
} from "./manage";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

type SpawnCapture = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

type FakeRun = {
  stdout?: string;
  stderr?: string;
  code?: number;
  emitError?: Error;
};

function fakeSpawn(runs: FakeRun[]): {
  spawnFn: ManageSpawnFn;
  calls: SpawnCapture[];
} {
  const calls: SpawnCapture[] = [];

  const spawnFn = ((
    command: string,
    argv: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    const run = runs[calls.length] ?? runs[runs.length - 1] ?? {};
    calls.push({ command, args: argv, env: options?.env ?? {} });

    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
      killed: boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });

    setImmediate(() => {
      if (run.emitError) {
        child.emit("error", run.emitError);
        return;
      }
      if (run.stdout) child.stdout.write(run.stdout);
      if (run.stderr) child.stderr.write(run.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", run.code ?? 0);
    });

    return child;
  }) as unknown as ManageSpawnFn;

  return { spawnFn, calls };
}

function fakeFetch(response: {
  ok?: boolean;
  version?: unknown;
  reject?: Error;
}): ManageFetchFn {
  return (async () => {
    if (response.reject) throw response.reject;
    return {
      ok: response.ok ?? true,
      json: async () => ({ version: response.version }),
    };
  }) as unknown as ManageFetchFn;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CLAUDE_CODE_CLI_PINNED;
});

describe("getClaudeCodeCliStatus", () => {
  it("reports installed, latest, and pinned versions", async () => {
    process.env.CLAUDE_CODE_CLI_PINNED = "2.1.220";
    const { spawnFn, calls } = fakeSpawn([
      { stdout: "2.1.220 (Claude Code)\n" },
    ]);

    const status = await getClaudeCodeCliStatus({
      spawnFn,
      fetchFn: fakeFetch({ version: "2.1.226" }),
    });

    expect(status).toEqual({
      installed: "2.1.220",
      latest: "2.1.226",
      pinned: "2.1.220",
    });
    expect(calls[0].command).toBe("claude");
    expect(calls[0].args).toEqual(["--version"]);
  });

  it("reports null installed when the binary is missing", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    const { spawnFn } = fakeSpawn([{ emitError: enoent }]);

    const status = await getClaudeCodeCliStatus({
      spawnFn,
      fetchFn: fakeFetch({ version: "2.1.226" }),
    });

    expect(status.installed).toBeNull();
    expect(status.latest).toBe("2.1.226");
  });

  it("reports null latest when the registry is unreachable or garbled", async () => {
    const { spawnFn } = fakeSpawn([{ stdout: "2.1.220 (Claude Code)" }]);

    const unreachable = await getClaudeCodeCliStatus({
      spawnFn,
      fetchFn: fakeFetch({ reject: new Error("network down") }),
    });
    expect(unreachable.latest).toBeNull();

    const { spawnFn: spawn2 } = fakeSpawn([{ stdout: "2.1.220" }]);
    const garbled = await getClaudeCodeCliStatus({
      spawnFn: spawn2,
      fetchFn: fakeFetch({ version: "not-a-version; rm -rf /" }),
    });
    expect(garbled.latest).toBeNull();
  });

  it("gives the probe a minimal env without server secrets", async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "server-secret";
    try {
      const { spawnFn, calls } = fakeSpawn([{ stdout: "2.1.220" }]);
      await getClaudeCodeCliStatus({
        spawnFn,
        fetchFn: fakeFetch({ version: "2.1.226" }),
      });
      expect(calls[0].env.JWT_SECRET).toBeUndefined();
      expect(calls[0].env.PATH).toBe(process.env.PATH);
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });
});

describe("updateClaudeCodeCli", () => {
  it("rejects anything that is not latest or an exact version", async () => {
    const { spawnFn, calls } = fakeSpawn([{}]);

    for (const bad of ["", "--registry=evil", "^2.1.0", "latest; rm -rf /"]) {
      await expect(
        updateClaudeCodeCli(bad, {
          spawnFn,
          fetchFn: fakeFetch({ version: "2.1.226" }),
        }),
      ).rejects.toThrow(/Invalid version/);
    }
    expect(calls.length).toBe(0);
  });

  it("runs a shell-free npm install and re-probes the version", async () => {
    const { spawnFn, calls } = fakeSpawn([
      { stdout: "", code: 0 },
      { stdout: "2.1.226 (Claude Code)" },
    ]);

    const status = await updateClaudeCodeCli("latest", {
      spawnFn,
      fetchFn: fakeFetch({ version: "2.1.226" }),
    });

    expect(calls[0].command).toBe("npm");
    expect(calls[0].args).toEqual([
      "install",
      "-g",
      "--no-fund",
      "--no-audit",
      "@anthropic-ai/claude-code@latest",
    ]);
    expect(calls[1].args).toEqual(["--version"]);
    expect(status.installed).toBe("2.1.226");
  });

  it("surfaces npm stderr when the install fails", async () => {
    const { spawnFn } = fakeSpawn([
      { stderr: "npm ERR! 404 Not Found", code: 1 },
    ]);

    await expect(
      updateClaudeCodeCli("9.9.9", {
        spawnFn,
        fetchFn: fakeFetch({ version: "2.1.226" }),
      }),
    ).rejects.toThrow(/404 Not Found/);
  });

  it("maps a missing npm binary to an actionable message", async () => {
    const enoent = Object.assign(new Error("spawn npm ENOENT"), {
      code: "ENOENT",
    });
    const { spawnFn } = fakeSpawn([{ emitError: enoent }]);

    await expect(
      updateClaudeCodeCli("latest", {
        spawnFn,
        fetchFn: fakeFetch({ version: "2.1.226" }),
      }),
    ).rejects.toThrow(/npm was not found/);
  });
});

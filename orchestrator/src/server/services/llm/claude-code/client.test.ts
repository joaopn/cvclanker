// @vitest-environment node
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRequestOptions } from "../types";
import {
  buildCallArgv,
  ClaudeCodeClient,
  type ClaudeCodeSpawnFn,
  parseCliJsonOutput,
} from "./client";

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

type SpawnCapture = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string | undefined;
  stdin: string;
};

/**
 * Builds an injectable spawn stub that emits `stdout` then closes with
 * `code`. Captures the argv, child env and whatever was written to stdin so
 * tests can assert on the invocation itself, not just its result.
 */
function fakeSpawn(args: {
  stdout?: string;
  stderr?: string;
  code?: number;
  emitError?: Error;
  stdinError?: Error;
}): { spawnFn: ClaudeCodeSpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];

  const spawnFn = ((
    command: string,
    argv: string[],
    options: { env?: NodeJS.ProcessEnv; cwd?: string },
  ) => {
    const capture: SpawnCapture = {
      command,
      args: argv,
      env: options?.env ?? {},
      cwd: options?.cwd,
      stdin: "",
    };

    calls.push(capture);

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      capture.stdin += chunk.toString("utf8");
    });

    const child = new EventEmitter() as FakeChild;
    child.stdin = stdin as unknown as FakeChild["stdin"];
    child.stdout = stdout as unknown as FakeChild["stdout"];
    child.stderr = stderr as unknown as FakeChild["stderr"];
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    }) as unknown as FakeChild["kill"];

    setImmediate(() => {
      if (args.emitError) {
        child.emit("error", args.emitError);
        return;
      }
      if (args.stdinError) stdin.emit("error", args.stdinError);
      if (args.stdout) stdout.write(args.stdout);
      if (args.stderr) stderr.write(args.stderr);
      stdout.end();
      stderr.end();
      child.emit("close", args.code ?? 0);
    });

    return child;
  }) as unknown as ClaudeCodeSpawnFn;

  return { spawnFn, calls };
}

const REQUEST: LlmRequestOptions<unknown> = {
  model: "claude-sonnet-5",
  messages: [
    { role: "system", content: "You score jobs." },
    { role: "user", content: "Score this job." },
  ],
  jsonSchema: {
    name: "verdict",
    schema: {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
      additionalProperties: false,
    },
  },
};

function resultEnvelope(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"verdict":"good"}',
    structured_output: { verdict: "good" },
    usage: { input_tokens: 2131, output_tokens: 903 },
    ...extra,
  });
}

describe("parseCliJsonOutput", () => {
  it("prefers structured_output and reads token usage", () => {
    expect(parseCliJsonOutput(resultEnvelope())).toEqual({
      text: '{"verdict":"good"}',
      usage: { promptTokens: 2131, completionTokens: 903 },
    });
  });

  it("falls back to the result string when structured_output is absent", () => {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"verdict":"good"}',
      usage: { input_tokens: 5, output_tokens: 6 },
    });

    expect(parseCliJsonOutput(envelope).text).toBe('{"verdict":"good"}');
  });

  // The CLI exits 0 on auth failure, so `is_error` is the only usable signal.
  it("throws the CLI error message when is_error is set, despite exit 0", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "Failed to authenticate. API Error: 401 OAuth token is invalid.",
    });

    expect(() => parseCliJsonOutput(envelope)).toThrow(
      /Failed to authenticate.*HTTP 401/,
    );
  });

  it("recovers the result event from output with stray non-JSON lines", () => {
    const noisy = `Warning: something happened\n${resultEnvelope()}\nnot json`;

    expect(parseCliJsonOutput(noisy).text).toBe('{"verdict":"good"}');
  });

  it("throws when no result event is present", () => {
    expect(() => parseCliJsonOutput("just some text")).toThrow(
      /did not include a result event/,
    );
  });

  // A present-but-null structured_output must NOT be treated as the answer:
  // JSON.stringify(null) would surface as a successful call carrying null data.
  it("falls through to result when structured_output is null", () => {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      structured_output: null,
      result: '{"verdict":"good"}',
    });

    expect(parseCliJsonOutput(envelope).text).toBe('{"verdict":"good"}');
  });

  it("throws when structured_output is null and result is empty", () => {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      structured_output: null,
      result: "",
    });

    expect(() => parseCliJsonOutput(envelope)).toThrow(/structured_output/);
  });

  // promptTokens means billed input; on a Claude Code turn the cache fields
  // dominate, so reading input_tokens alone under-reports by orders of magnitude.
  it("counts cached input tokens toward promptTokens", () => {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"verdict":"good"}',
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 26701,
        cache_read_input_tokens: 25860,
        output_tokens: 1085,
      },
    });

    expect(parseCliJsonOutput(envelope).usage).toEqual({
      promptTokens: 20 + 26701 + 25860,
      completionTokens: 1085,
    });
  });

  it("reports missing usage as null rather than zero", () => {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"verdict":"good"}',
    });

    expect(parseCliJsonOutput(envelope).usage).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
  });
});

describe("buildCallArgv", () => {
  it("disables tools, settings, MCP and session persistence", () => {
    const argv = buildCallArgv({
      model: "claude-sonnet-5",
      jsonSchema: REQUEST.jsonSchema,
    });

    expect(argv).toContain("-p");
    expect(argv).toContain("--no-session-persistence");
    expect(argv).toContain("--strict-mcp-config");
    expect(
      argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2),
    ).toEqual(["--tools", ""]);
    expect(
      argv.slice(
        argv.indexOf("--setting-sources"),
        argv.indexOf("--setting-sources") + 2,
      ),
    ).toEqual(["--setting-sources", ""]);
  });

  // `--tools` is variadic: a positional immediately after it would be eaten.
  it("never leaves a variadic flag followed by a non-flag value", () => {
    const argv = buildCallArgv({
      model: "claude-sonnet-5",
      jsonSchema: REQUEST.jsonSchema,
    });

    const afterTools = argv[argv.indexOf("--tools") + 2];
    expect(afterTools.startsWith("--")).toBe(true);
  });

  it("passes the model only when one is configured", () => {
    const withModel = buildCallArgv({
      model: "claude-opus-5",
      jsonSchema: REQUEST.jsonSchema,
    });
    expect(withModel.slice(withModel.indexOf("--model"))).toContain(
      "claude-opus-5",
    );

    const withoutModel = buildCallArgv({
      model: "   ",
      jsonSchema: REQUEST.jsonSchema,
    });
    expect(withoutModel).not.toContain("--model");
  });

  it("serializes the JSON schema for --json-schema", () => {
    const argv = buildCallArgv({
      model: "",
      jsonSchema: REQUEST.jsonSchema,
    });

    expect(argv[argv.indexOf("--json-schema") + 1]).toBe(
      JSON.stringify(REQUEST.jsonSchema.schema),
    );
  });
});

describe("ClaudeCodeClient.callJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLAUDE_CODE_BIN;
  });

  it("sends the transcript on stdin and returns text plus usage", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

    const result = await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

    expect(result).toEqual({
      text: '{"verdict":"good"}',
      usage: { promptTokens: 2131, completionTokens: 903 },
    });
    // The prompt must never ride in argv — CV payloads are large and argv is
    // visible in the process table.
    expect(calls[0].stdin).toContain("You score jobs.");
    expect(calls[0].stdin).toContain("Score this job.");
    expect(calls[0].args.join(" ")).not.toContain("Score this job.");
  });

  it("injects a configured token as CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

    await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST, "token-abc");

    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-abc");
  });

  it("leaves the ambient token untouched when none is configured", async () => {
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token";
    try {
      const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

      await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST, null);

      expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-token");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    }
  });

  it("honours CLAUDE_CODE_BIN for the spawned command", async () => {
    process.env.CLAUDE_CODE_BIN = "/opt/claude";
    const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

    await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

    expect(calls[0].command).toBe("/opt/claude");
  });

  it("surfaces stderr when the CLI dies before printing an envelope", async () => {
    const { spawnFn } = fakeSpawn({
      stdout: "",
      stderr: "error: unknown option '--json-schema'",
      code: 1,
    });

    await expect(
      new ClaudeCodeClient({ spawnFn }).callJson(REQUEST),
    ).rejects.toThrow(/unknown option/);
  });

  // Must assert the ACTIONABLE text, not merely /ENOENT/ — the raw spawn error
  // satisfies that pattern, so a loose matcher hides the mapping being absent.
  it("surfaces a missing CLI as an actionable install message", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    const { spawnFn } = fakeSpawn({ emitError: enoent });

    await expect(
      new ClaudeCodeClient({ spawnFn }).callJson(REQUEST),
    ).rejects.toThrow(/Install @anthropic-ai\/claude-code|CLAUDE_CODE_BIN/);
  });

  it("keeps a successful turn even when stdin errors after the write", async () => {
    const { spawnFn } = fakeSpawn({
      stdout: resultEnvelope(),
      stdinError: new Error("write EPIPE"),
    });

    const result = await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

    expect(result.text).toBe('{"verdict":"good"}');
  });

  it("reports the stdin error when it did cost the answer", async () => {
    const { spawnFn } = fakeSpawn({
      stdout: "",
      stdinError: new Error("write EPIPE"),
    });

    await expect(
      new ClaudeCodeClient({ spawnFn }).callJson(REQUEST),
    ).rejects.toThrow(/EPIPE/);
  });

  it("appends stderr when stdout cannot be parsed", async () => {
    const { spawnFn } = fakeSpawn({
      stdout: "not an envelope",
      stderr: "credential store unavailable",
    });

    await expect(
      new ClaudeCodeClient({ spawnFn }).callJson(REQUEST),
    ).rejects.toThrow(/credential store unavailable/);
  });

  it("pins cwd and HOME to a fresh per-spawn scratch dir and removes it after", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

    await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

    const scratch = calls[0].cwd;
    expect(scratch).toBeDefined();
    expect(scratch).not.toBe(tmpdir());
    expect(scratch?.startsWith(join(tmpdir(), "cvclanker-claude-"))).toBe(true);
    expect(calls[0].env.HOME).toBe(scratch);
    expect(existsSync(scratch as string)).toBe(false);
  });

  it("removes the scratch dir even when the CLI fails", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    const { spawnFn, calls } = fakeSpawn({ emitError: enoent });

    await expect(
      new ClaudeCodeClient({ spawnFn }).callJson(REQUEST),
    ).rejects.toThrow();

    expect(existsSync(calls[0].cwd as string)).toBe(false);
  });

  // The child env is an allowlist, never {...process.env}: the CLI must not
  // receive unrelated server secrets.
  it("does not forward server secrets or ambient Anthropic keys to the CLI", async () => {
    const previous = {
      JWT_SECRET: process.env.JWT_SECRET,
      LLM_API_KEY: process.env.LLM_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      APIFY_API_TOKEN: process.env.APIFY_API_TOKEN,
    };
    process.env.JWT_SECRET = "server-jwt-secret";
    process.env.LLM_API_KEY = "other-provider-key";
    process.env.ANTHROPIC_API_KEY = "ambient-api-key";
    process.env.APIFY_API_TOKEN = "apify-token";
    try {
      const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

      await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

      expect(calls[0].env.JWT_SECRET).toBeUndefined();
      expect(calls[0].env.LLM_API_KEY).toBeUndefined();
      expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(calls[0].env.APIFY_API_TOKEN).toBeUndefined();
      expect(calls[0].env.PATH).toBe(process.env.PATH);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("disables CLI telemetry, error reporting, and the auto-updater", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: resultEnvelope() });

    await new ClaudeCodeClient({ spawnFn }).callJson(REQUEST);

    expect(calls[0].env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(calls[0].env.DISABLE_TELEMETRY).toBe("1");
    expect(calls[0].env.DISABLE_ERROR_REPORTING).toBe("1");
    expect(calls[0].env.DISABLE_AUTOUPDATER).toBe("1");
  });
});

describe("ClaudeCodeClient.validateCredentials", () => {
  it("runs `claude auth status --json` without inference", async () => {
    const { spawnFn, calls } = fakeSpawn({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "oauth_token",
        email: "user@example.com",
      }),
    });

    const result = await new ClaudeCodeClient({
      spawnFn,
    }).validateCredentials();

    expect(calls[0].args).toEqual(["auth", "status", "--json"]);
    expect(result).toEqual({
      valid: true,
      message: null,
      username: "user@example.com",
    });
  });

  it("reports an actionable message when not logged in", async () => {
    const { spawnFn } = fakeSpawn({
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }),
      code: 1,
    });

    const result = await new ClaudeCodeClient({
      spawnFn,
    }).validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/setup-token/);
  });

  it("passes a configured token through to the auth check", async () => {
    const { spawnFn, calls } = fakeSpawn({
      stdout: JSON.stringify({ loggedIn: true }),
    });

    await new ClaudeCodeClient({ spawnFn }).validateCredentials("token-xyz");

    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-xyz");
  });

  it("returns invalid rather than throwing on unreadable output", async () => {
    const { spawnFn } = fakeSpawn({ stdout: "<html>proxy error</html>" });

    const result = await new ClaudeCodeClient({
      spawnFn,
    }).validateCredentials();

    expect(result.valid).toBe(false);
  });

  it("does not throw when the CLI is missing", async () => {
    const { spawnFn } = fakeSpawn({
      emitError: new Error("spawn claude ENOENT"),
    });

    const result = await new ClaudeCodeClient({
      spawnFn,
    }).validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/not found in PATH/);
  });
});

describe("ClaudeCodeClient.listModels", () => {
  it("returns curated suggestions without spawning anything", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "" });

    const models = await new ClaudeCodeClient({ spawnFn }).listModels();

    expect(models).toContain("claude-sonnet-5");
    expect(calls).toHaveLength(0);
  });
});

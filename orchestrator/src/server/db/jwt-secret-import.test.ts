// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_SECRET = "a-legacy-secret-that-is-at-least-32-chars-long";

describe.sequential("legacy jwt-secret file import", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  async function readSecretRow(): Promise<string | null> {
    const { getRuntimeSecret } = await import(
      "../repositories/runtime-secrets"
    );
    return getRuntimeSecret("jwt_secret");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jwt-import-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    const { closeDb } = await import("./index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("imports a legacy jwt-secret file into runtime_secrets", async () => {
    await writeFile(join(tempDir, "jwt-secret"), `${VALID_SECRET}\n`, "utf8");
    await boot();

    expect(await readSecretRow()).toBe(VALID_SECRET);
  });

  it("is idempotent and never overwrites an existing row", async () => {
    await writeFile(join(tempDir, "jwt-secret"), `${VALID_SECRET}\n`, "utf8");
    await boot();

    // Second boot with a DIFFERENT file on disk: the existing row wins.
    await writeFile(
      join(tempDir, "jwt-secret"),
      "another-secret-that-is-also-at-least-32-chars\n",
      "utf8",
    );
    const { closeDb } = await import("./index");
    closeDb();
    await boot();

    expect(await readSecretRow()).toBe(VALID_SECRET);
  });

  it("creates no row when no legacy file exists", async () => {
    await boot();
    expect(await readSecretRow()).toBeNull();
  });

  it("refuses to import a file shorter than 32 chars", async () => {
    await writeFile(join(tempDir, "jwt-secret"), "too-short\n", "utf8");
    await boot();
    expect(await readSecretRow()).toBeNull();
  });
});

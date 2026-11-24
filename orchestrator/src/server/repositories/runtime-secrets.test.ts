// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("runtime secrets repository", () => {
  let tempDir: string;
  let repo: Awaited<typeof import("./runtime-secrets")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-runtime-secrets-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    repo = await import("./runtime-secrets");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function backdate(key: string): Promise<void> {
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.runtimeSecrets)
      .set({ createdAt: "2001-02-03T04:05:06.000Z" })
      .where(eq(schema.runtimeSecrets.key, key));
  }

  it("reads a secret with its creation time", async () => {
    await repo.insertRuntimeSecretIfAbsent("alpha", "one");

    expect(repo.getRuntimeSecretRecord("alpha")).toEqual({
      value: "one",
      createdAt: expect.any(String),
    });
    expect(repo.getRuntimeSecretRecord("missing")).toBeNull();
  });

  it("upserts the value and restamps the creation time", async () => {
    await repo.insertRuntimeSecretIfAbsent("alpha", "one");
    await backdate("alpha");
    const before = Date.now();

    repo.upsertRuntimeSecret("alpha", "two");

    const record = repo.getRuntimeSecretRecord("alpha");
    expect(record?.value).toBe("two");
    expect(record?.createdAt).not.toBe("2001-02-03T04:05:06.000Z");
    expect(Date.parse(record?.createdAt ?? "")).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it("inserts a key the upsert has not seen", async () => {
    repo.upsertRuntimeSecret("beta", "fresh");

    expect(await repo.getRuntimeSecret("beta")).toBe("fresh");
  });

  it("deletes only the named keys", async () => {
    await repo.insertRuntimeSecretIfAbsent("jwt_secret", "signing");
    await repo.insertRuntimeSecretIfAbsent("alpha", "one");
    await repo.insertRuntimeSecretIfAbsent("beta", "two");
    await repo.insertRuntimeSecretIfAbsent("gamma", "three");

    repo.deleteRuntimeSecrets(["alpha", "beta"]);

    expect(await repo.getRuntimeSecret("alpha")).toBeNull();
    expect(await repo.getRuntimeSecret("beta")).toBeNull();
    expect(await repo.getRuntimeSecret("gamma")).toBe("three");
    expect(await repo.getRuntimeSecret("jwt_secret")).toBe("signing");
  });
});

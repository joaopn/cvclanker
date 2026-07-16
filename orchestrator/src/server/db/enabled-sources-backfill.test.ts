// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An empty `enabledSourceIds` used to mean "every enabled extractor"; it now
 * means "no extractors". Without the boot backfill, every Search Profile
 * holding an empty list would silently stop scraping.
 */
describe.sequential("enabledSourceIds backfill", () => {
  let tempDir: string;
  let db: Awaited<typeof import("./index")>["db"];
  let schema: Awaited<typeof import("./index")>["schema"];
  let profilesRepo: Awaited<typeof import("../repositories/profiles")>;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
    ({ db, schema } = await import("./index"));
    profilesRepo = await import("../repositories/profiles");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-sources-backfill-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await boot();
  });

  afterEach(async () => {
    const { closeDb } = await import("./index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** Write a profile row directly, bypassing createProfile's ticked-by-default fill. */
  async function insertRawProfile(
    id: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(schema.profiles).values({
      id,
      name: id,
      configJson: config,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }

  it("fills an empty source selection with every enabled extractor", async () => {
    await insertRawProfile("empty-pins", {
      searchTerms: ["ml engineer"],
      enabledSourceIds: [],
      providerInstanceIds: [],
    });

    await boot();

    const profile = await profilesRepo.getProfile("empty-pins");
    expect(profile?.config.enabledSourceIds).toEqual(
      expect.arrayContaining(["jobspy", "hiringcafe"]),
    );
  });

  it("leaves a narrowed selection untouched", async () => {
    await insertRawProfile("narrowed", {
      searchTerms: ["ml engineer"],
      enabledSourceIds: ["jobspy"],
      providerInstanceIds: [],
    });

    await boot();

    const profile = await profilesRepo.getProfile("narrowed");
    expect(profile?.config.enabledSourceIds).toEqual(["jobspy"]);
  });

  it("never backfills Apify instances", async () => {
    // An empty instance list ALREADY means "no Apify actors", so those
    // profiles run none today. Filling it would silently start spending the
    // user's money on every run.
    await db.insert(schema.providerInstances).values({
      id: "inst-1",
      providerId: "apify",
      actorRef: "acme/actor",
      label: "Acme actor",
      templateId: null,
      enabled: true,
      inputTemplateJson: "{}",
      outputMappingJson: "{}",
      mappingsJson: {},
    });
    await insertRawProfile("no-apify", {
      searchTerms: ["ml engineer"],
      enabledSourceIds: [],
      providerInstanceIds: [],
    });

    await boot();

    const profile = await profilesRepo.getProfile("no-apify");
    expect(profile?.config.providerInstanceIds).toEqual([]);
  });

  it("is a no-op on a second boot", async () => {
    await insertRawProfile("empty-pins", {
      searchTerms: ["ml engineer"],
      enabledSourceIds: [],
      providerInstanceIds: [],
    });

    await boot();
    const first = await profilesRepo.getProfile("empty-pins");

    await boot();
    const second = await profilesRepo.getProfile("empty-pins");

    expect(second?.config.enabledSourceIds).toEqual(
      first?.config.enabledSourceIds,
    );
    expect(second?.updatedAt).toBe(first?.updatedAt);
  });
});

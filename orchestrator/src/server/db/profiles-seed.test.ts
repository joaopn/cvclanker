// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("profiles first-boot seed", () => {
  let tempDir: string;
  let db: Awaited<typeof import("./index")>["db"];
  let schema: Awaited<typeof import("./index")>["schema"];
  let profilesRepo: Awaited<typeof import("../repositories/profiles")>;
  let settingsRepo: Awaited<typeof import("../repositories/settings")>;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
    ({ db, schema } = await import("./index"));
    profilesRepo = await import("../repositories/profiles");
    settingsRepo = await import("../repositories/settings");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-profiles-seed-"));
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

  it("seeds exactly one Default profile pointed at by defaultProfileId", async () => {
    const all = await profilesRepo.getAllProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Default");

    const pointer = await settingsRepo.getSetting("defaultProfileId");
    expect(pointer).toBe(all[0].id);

    // Fresh DB: pipeline extractors are backfilled as enabled, so the seed
    // pins them.
    expect(all[0].config.enabledSourceIds).toEqual(
      expect.arrayContaining([
        "jobspy",
        "hiringcafe",
        "startupjobs",
        "workingnomads",
      ]),
    );
  });

  it("is idempotent across reboots (no second Default, same id)", async () => {
    const before = await profilesRepo.getAllProfiles();
    expect(before).toHaveLength(1);
    const seededId = before[0].id;

    const { closeDb } = await import("./index");
    closeDb();
    await boot();

    const after = await profilesRepo.getAllProfiles();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(seededId);
  });

  it("re-seeds from current settings once profiles are cleared", async () => {
    // The seed reads legacy scrape rows straight off the settings table; the
    // keys are gone from the registry, so write them untyped.
    await db.insert(schema.settings).values([
      { key: "searchTerms", value: JSON.stringify(["rust engineer"]) },
      { key: "searchCountry", value: "Germany" },
      { key: "scrapeMaxAgeDays", value: "14" },
    ]);
    await db.delete(schema.profiles);
    await settingsRepo.setSetting("defaultProfileId", null);

    const { closeDb } = await import("./index");
    closeDb();
    await boot();

    const all = await profilesRepo.getAllProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].config.searchTerms).toEqual(["rust engineer"]);
    expect(all[0].config.searchCountry).toBe("Germany");
    expect(all[0].config.scrapeMaxAgeDays).toBe(14);
    expect(await settingsRepo.getSetting("defaultProfileId")).toBe(all[0].id);
  });
});

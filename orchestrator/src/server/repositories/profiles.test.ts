// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("profiles repository CRUD", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let profilesRepo: Awaited<typeof import("./profiles")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-profiles-repo-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    profilesRepo = await import("./profiles");

    // Start from a clean slate — drop the seeded Default profile.
    await db.delete(schema.profiles);
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("creates a profile with defaults filled in for omitted config fields", async () => {
    const created = await profilesRepo.createProfile({
      name: "Berlin backend",
      config: { searchTerms: ["backend engineer"], searchCountry: "Germany" },
    });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Berlin backend");
    expect(created.config.searchTerms).toEqual(["backend engineer"]);
    expect(created.config.searchCountry).toBe("Germany");
    // Omitted fields fall back to defaultProfileConfig().
    expect(created.config.runBudget).toBe(500);
    expect(created.config.topN).toBe(10);
    expect(created.config.minSuitabilityCategory).toBe("good_fit");
    expect(created.config.workplaceTypes).toEqual([
      "remote",
      "hybrid",
      "onsite",
    ]);
    expect(created.config.scrapeMaxAgeDays).toBeNull();
    // A new Search Profile is born TICKED — every source the User Profile has
    // enabled. An empty list now means "no sources at all", so creating a
    // profile with one would ship something that can only be rejected at run
    // time.
    const { getEnabledExtractorIds } = await import("./source-configs");
    expect(created.config.enabledSourceIds).toEqual(
      await getEnabledExtractorIds(),
    );
    expect(created.config.enabledSourceIds.length).toBeGreaterThan(0);
  });

  it("round-trips through getProfile and getAllProfiles", async () => {
    const created = await profilesRepo.createProfile({ name: "A" });
    const fetched = await profilesRepo.getProfile(created.id);
    expect(fetched).toEqual(created);

    const all = await profilesRepo.getAllProfiles();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.id);
  });

  it("orders getAllProfiles by updated_at descending", async () => {
    await db.insert(schema.profiles).values({
      id: "older",
      name: "Older",
      configJson: {},
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    await db.insert(schema.profiles).values({
      id: "newer",
      name: "Newer",
      configJson: {},
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2025-06-01T00:00:00.000Z",
    });

    const all = await profilesRepo.getAllProfiles();
    expect(all.map((p) => p.id)).toEqual(["newer", "older"]);
  });

  it("merges config patches over the existing blob on update", async () => {
    const created = await profilesRepo.createProfile({
      name: "Original",
      config: { searchTerms: ["a"], scrapeMaxAgeDays: 30, topN: 5 },
    });

    const updated = await profilesRepo.updateProfile(created.id, {
      name: "Renamed",
      config: { topN: 25 },
    });

    expect(updated?.name).toBe("Renamed");
    // Patched field changes, untouched fields survive.
    expect(updated?.config.topN).toBe(25);
    expect(updated?.config.searchTerms).toEqual(["a"]);
    expect(updated?.config.scrapeMaxAgeDays).toBe(30);
  });

  it("clears scrapeMaxAgeDays when the patch sets it to null", async () => {
    const created = await profilesRepo.createProfile({
      name: "Cap",
      config: { scrapeMaxAgeDays: 14 },
    });
    const updated = await profilesRepo.updateProfile(created.id, {
      config: { scrapeMaxAgeDays: null },
    });
    expect(updated?.config.scrapeMaxAgeDays).toBeNull();
  });

  it("returns null when updating a missing profile", async () => {
    const updated = await profilesRepo.updateProfile("nope", { name: "X" });
    expect(updated).toBeNull();
  });

  it("deletes a profile and reports the change", async () => {
    const created = await profilesRepo.createProfile({ name: "Doomed" });
    expect(await profilesRepo.deleteProfile(created.id)).toBe(true);
    expect(await profilesRepo.getProfile(created.id)).toBeNull();
    expect(await profilesRepo.deleteProfile(created.id)).toBe(false);
  });

  it("counts profiles", async () => {
    expect(await profilesRepo.countProfiles()).toBe(0);
    await profilesRepo.createProfile({ name: "One" });
    await profilesRepo.createProfile({ name: "Two" });
    expect(await profilesRepo.countProfiles()).toBe(2);
  });

  it("falls back to defaults for a corrupt config blob", async () => {
    await db.insert(schema.profiles).values({
      id: "corrupt",
      name: "Corrupt",
      // Invalid types for several fields — parser should drop them to default.
      configJson: { searchTerms: "not-an-array", topN: "abc", runBudget: 42 },
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const fetched = await profilesRepo.getProfile("corrupt");
    expect(fetched?.config.searchTerms).toEqual([]);
    expect(fetched?.config.topN).toBe(10);
    // Valid field survives.
    expect(fetched?.config.runBudget).toBe(42);
  });
});

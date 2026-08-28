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

  async function seedProfile(id: string, name: string, updatedAt: string) {
    await db.insert(schema.profiles).values({
      id,
      name,
      configJson: {},
      createdAt: updatedAt,
      updatedAt,
    });
  }

  it("orders getAllProfiles alphabetically, not by recency", async () => {
    // Names chosen so alphabetical and recency DISAGREE — with "Older"/"Newer"
    // the two orders coincide and the assertion would prove nothing.
    await seedProfile("zulu", "Zulu", "2025-06-01T00:00:00.000Z");
    await seedProfile("alpha", "Alpha", "2025-01-01T00:00:00.000Z");

    const all = await profilesRepo.getAllProfiles();
    expect(all.map((p) => p.id)).toEqual(["alpha", "zulu"]);
  });

  it("sorts case-insensitively and numerically", async () => {
    await seedProfile("p10", "profile 10", "2025-01-01T00:00:00.000Z");
    await seedProfile("p2", "Profile 2", "2025-01-01T00:00:00.000Z");
    await seedProfile("b", "banana", "2025-01-01T00:00:00.000Z");

    const all = await profilesRepo.getAllProfiles();
    // Lowercase "banana" before "Profile", and 2 before 10 — a plain string
    // sort would give ["Profile 2", "banana", "profile 10"].
    expect(all.map((p) => p.id)).toEqual(["b", "p2", "p10"]);
  });

  it("keeps a profile in place when it is edited", async () => {
    // The whole point: editing bumps updated_at, and that must not move the row.
    await seedProfile("alpha", "Alpha", "2025-01-01T00:00:00.000Z");
    await seedProfile("zulu", "Zulu", "2025-01-02T00:00:00.000Z");

    await profilesRepo.updateProfile("alpha", { config: { topN: 7 } });

    const all = await profilesRepo.getAllProfiles();
    expect(all.map((p) => p.id)).toEqual(["alpha", "zulu"]);
  });

  it("getMostRecentProfile still reports the last-touched profile", async () => {
    await seedProfile("alpha", "Alpha", "2025-01-01T00:00:00.000Z");
    await seedProfile("zulu", "Zulu", "2025-06-01T00:00:00.000Z");

    expect((await profilesRepo.getMostRecentProfile())?.id).toBe("zulu");
  });

  it("getMostRecentProfile returns null with no profiles", async () => {
    expect(await profilesRepo.getMostRecentProfile()).toBeNull();
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

  describe("scrape watermarks", () => {
    let watermarksRepo: Awaited<typeof import("./source-scrape-watermarks")>;

    const seed = async (profileId: string) => {
      watermarksRepo = await import("./source-scrape-watermarks");
      await watermarksRepo.recordScrapeWatermarks(
        profileId,
        [{ sourceKey: "jobspy", windowDays: 30, policyWindowDays: null }],
        "2026-08-01T00:00:00.000Z",
      );
      expect(await watermarksRepo.getScrapeWatermarks(profileId)).toEqual(
        new Map([["jobspy", "2026-08-01T00:00:00.000Z"]]),
      );
    };

    it("clears them when a patch changes what the profile matches", async () => {
      const created = await profilesRepo.createProfile({
        name: "Coverage",
        config: { searchTerms: ["a"], scrapeMaxAgeDays: 30 },
      });
      await seed(created.id);

      await profilesRepo.updateProfile(created.id, {
        config: { searchTerms: ["a", "b"] },
      });

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map(),
      );
    });

    it("clears them when the max-age cap changes", async () => {
      const created = await profilesRepo.createProfile({
        name: "Cap change",
        config: { scrapeMaxAgeDays: 7 },
      });
      await seed(created.id);

      await profilesRepo.updateProfile(created.id, {
        config: { scrapeMaxAgeDays: 60 },
      });

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map(),
      );
    });

    it("keeps them for a patch that does not change coverage", async () => {
      const created = await profilesRepo.createProfile({
        name: "Volume only",
        config: { searchTerms: ["a"], topN: 5 },
      });
      await seed(created.id);

      await profilesRepo.updateProfile(created.id, {
        name: "Renamed",
        config: { topN: 25, searchTerms: ["a"], scrapeSinceLastRun: true },
      });

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([["jobspy", "2026-08-01T00:00:00.000Z"]]),
      );
    });

    it("clears them when the profile is deleted", async () => {
      const created = await profilesRepo.createProfile({ name: "Doomed" });
      await seed(created.id);

      await profilesRepo.deleteProfile(created.id);

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map(),
      );
    });

    it("upserts a source's watermark in place", async () => {
      const created = await profilesRepo.createProfile({ name: "Upsert" });
      await seed(created.id);

      // A 30-day window comfortably covers the 4 days since the seed, so both
      // marks advance — this test is about the upsert, not the advance rule.
      await watermarksRepo.recordScrapeWatermarks(
        created.id,
        [
          { sourceKey: "jobspy", windowDays: 30, policyWindowDays: null },
          { sourceKey: "apify:abc", windowDays: 30, policyWindowDays: null },
        ],
        "2026-08-05T00:00:00.000Z",
      );

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([
          ["jobspy", "2026-08-05T00:00:00.000Z"],
          ["apify:abc", "2026-08-05T00:00:00.000Z"],
        ]),
      );
    });

    it("leaves a mark alone when the run's window left a hole", async () => {
      const created = await profilesRepo.createProfile({ name: "Hole" });
      await seed(created.id);

      // Four days later with a one-day window: the run covered [4th, 5th] and
      // nothing fetched the 1st-4th band, so the boundary must not move over
      // it — the next narrowed window has to reach back and re-cover it.
      await watermarksRepo.recordScrapeWatermarks(
        created.id,
        [{ sourceKey: "jobspy", windowDays: 1, policyWindowDays: null }],
        "2026-08-05T00:00:00.000Z",
      );

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([["jobspy", "2026-08-01T00:00:00.000Z"]]),
      );
    });

    it("decides per source within one call", async () => {
      const created = await profilesRepo.createProfile({ name: "Mixed" });
      await seed(created.id);

      await watermarksRepo.recordScrapeWatermarks(
        created.id,
        [
          { sourceKey: "jobspy", windowDays: 1, policyWindowDays: null },
          { sourceKey: "apify:abc", windowDays: 30, policyWindowDays: null },
        ],
        "2026-08-05T00:00:00.000Z",
      );

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([
          // Held: a 1-day window over a 4-day gap.
          ["jobspy", "2026-08-01T00:00:00.000Z"],
          // Written fresh: no prior mark, so this run is its boundary.
          ["apify:abc", "2026-08-05T00:00:00.000Z"],
        ]),
      );
    });

    /**
     * An unknown window still establishes a FIRST boundary — nothing before it
     * was ever claimed. Declining here would leave an uncapped profile without
     * a mark forever, making "scrape since the last run" a permanent no-op.
     */
    it("bootstraps a first mark even when the window is unknown", async () => {
      // Imported here rather than via `seed`: this case has no prior mark, and
      // the module is re-imported per test against a fresh connection.
      watermarksRepo = await import("./source-scrape-watermarks");
      const created = await profilesRepo.createProfile({ name: "Unknown" });

      await watermarksRepo.recordScrapeWatermarks(
        created.id,
        [{ sourceKey: "jobspy", windowDays: null, policyWindowDays: null }],
        "2026-08-05T00:00:00.000Z",
      );

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([["jobspy", "2026-08-05T00:00:00.000Z"]]),
      );
    });

    it("leaves an existing mark alone when the window is unknown", async () => {
      const created = await profilesRepo.createProfile({ name: "Unknowable" });
      await seed(created.id);

      await watermarksRepo.recordScrapeWatermarks(
        created.id,
        [{ sourceKey: "jobspy", windowDays: null, policyWindowDays: null }],
        "2026-08-05T00:00:00.000Z",
      );

      expect(await watermarksRepo.getScrapeWatermarks(created.id)).toEqual(
        new Map([["jobspy", "2026-08-01T00:00:00.000Z"]]),
      );
    });
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

// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("profiles service", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let profilesRepo: Awaited<typeof import("../repositories/profiles")>;
  let settingsRepo: Awaited<typeof import("../repositories/settings")>;
  let service: Awaited<typeof import("./profiles")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-profiles-svc-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    profilesRepo = await import("../repositories/profiles");
    settingsRepo = await import("../repositories/settings");
    service = await import("./profiles");

    // Clean slate: drop the seeded Default profile + its pointer.
    await db.delete(schema.profiles);
    await settingsRepo.setSetting("defaultProfileId", null);
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function insertProfile(id: string, name: string, updatedAt: string) {
    await db.insert(schema.profiles).values({
      id,
      name,
      configJson: {},
      createdAt: updatedAt,
      updatedAt,
    });
  }

  describe("getDefaultProfile", () => {
    it("returns null when no profiles exist", async () => {
      expect(await service.getDefaultProfile()).toBeNull();
    });

    it("returns the pointed profile when defaultProfileId is valid", async () => {
      await insertProfile("a", "A", "2025-01-01T00:00:00.000Z");
      await insertProfile("b", "B", "2025-06-01T00:00:00.000Z");
      await settingsRepo.setSetting("defaultProfileId", "a");

      const resolved = await service.getDefaultProfile();
      expect(resolved?.id).toBe("a");
    });

    // Names deliberately make alphabetical order DISAGREE with recency: the
    // list is alphabetical now, so a fallback that read `getAllProfiles()[0]`
    // would answer "Alpha" and these would catch it. With the old
    // "Older"/"Newer" fixtures both orders agreed and proved nothing.
    it("falls back to the most-recently-updated profile when no pointer is set", async () => {
      await insertProfile("alpha", "Alpha", "2025-01-01T00:00:00.000Z");
      await insertProfile("zulu", "Zulu", "2025-06-01T00:00:00.000Z");

      const resolved = await service.getDefaultProfile();
      expect(resolved?.id).toBe("zulu");
    });

    it("falls back to most-recent when the pointer is stale", async () => {
      await insertProfile("alpha", "Alpha", "2025-01-01T00:00:00.000Z");
      await insertProfile("zulu", "Zulu", "2025-06-01T00:00:00.000Z");
      await settingsRepo.setSetting("defaultProfileId", "ghost");

      const resolved = await service.getDefaultProfile();
      expect(resolved?.id).toBe("zulu");
    });
  });

  describe("setDefaultProfile", () => {
    it("writes the pointer and returns the profile", async () => {
      const created = await profilesRepo.createProfile({ name: "Pick me" });
      const result = await service.setDefaultProfile(created.id);
      expect(result?.id).toBe(created.id);
      expect(await settingsRepo.getSetting("defaultProfileId")).toBe(created.id);
    });

    it("returns null for a missing profile and leaves the pointer untouched", async () => {
      expect(await service.setDefaultProfile("nope")).toBeNull();
      expect(await settingsRepo.getSetting("defaultProfileId")).toBeNull();
    });
  });

  describe("deleteProfileById", () => {
    it("blocks deletion of the last profile", async () => {
      const only = await profilesRepo.createProfile({ name: "Only" });
      const result = await service.deleteProfileById(only.id);
      expect(result).toEqual({ ok: false, reason: "last" });
      expect(await profilesRepo.getProfile(only.id)).not.toBeNull();
    });

    it("returns not_found for a missing profile", async () => {
      await profilesRepo.createProfile({ name: "Keep" });
      const result = await service.deleteProfileById("ghost");
      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("clears the pointer when the deleted profile was the default", async () => {
      const a = await profilesRepo.createProfile({ name: "A" });
      const b = await profilesRepo.createProfile({ name: "B" });
      await service.setDefaultProfile(a.id);

      const result = await service.deleteProfileById(a.id);
      expect(result).toEqual({ ok: true });
      expect(await settingsRepo.getSetting("defaultProfileId")).toBeNull();
      // Resolver now falls back to the survivor.
      expect((await service.getDefaultProfile())?.id).toBe(b.id);
    });

    it("leaves the pointer intact when a non-default profile is deleted", async () => {
      const a = await profilesRepo.createProfile({ name: "A" });
      const b = await profilesRepo.createProfile({ name: "B" });
      await service.setDefaultProfile(a.id);

      const result = await service.deleteProfileById(b.id);
      expect(result).toEqual({ ok: true });
      expect(await settingsRepo.getSetting("defaultProfileId")).toBe(a.id);
    });
  });

  describe("duplicateProfile", () => {
    it("copies config under a suffixed name with a new id", async () => {
      const original = await profilesRepo.createProfile({
        name: "Source",
        config: { searchTerms: ["ml engineer"], topN: 3 },
      });
      const copy = await service.duplicateProfile(original.id);

      expect(copy?.id).not.toBe(original.id);
      expect(copy?.name).toBe("Source (copy)");
      expect(copy?.config.searchTerms).toEqual(["ml engineer"]);
      expect(copy?.config.topN).toBe(3);
    });

    it("returns null when the source is missing", async () => {
      expect(await service.duplicateProfile("ghost")).toBeNull();
    });
  });
  describe("setSourcePinOnAllProfiles", () => {
    async function insertWithPins(
      id: string,
      enabledSourceIds: string[],
      providerInstanceIds: string[] = [],
      remoteProfile = false,
    ) {
      await db.insert(schema.profiles).values({
        id,
        name: id.toUpperCase(),
        configJson: { enabledSourceIds, providerInstanceIds, remoteProfile },
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      });
    }

    async function pins(id: string) {
      const profile = await profilesRepo.getProfile(id);
      if (!profile) throw new Error(`profile ${id} vanished`);
      return profile.config;
    }

    it("appends the extractor to every profile that lacks it", async () => {
      await insertWithPins("a", ["hiringcafe"]);
      await insertWithPins("b", ["jobspy", "hiringcafe"]);
      await insertWithPins("c", []);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: true,
      });

      expect(result).toEqual({
        ok: true,
        changed: [
          { id: "a", name: "A" },
          { id: "c", name: "C" },
        ],
        unchanged: [{ id: "b", name: "B" }],
        skipped: [],
        empty: [],
      });
      expect((await pins("a")).enabledSourceIds).toEqual([
        "hiringcafe",
        "jobspy",
      ]);
      // Already pinned: neither duplicated nor reordered.
      expect((await pins("b")).enabledSourceIds).toEqual([
        "jobspy",
        "hiringcafe",
      ]);
      expect((await pins("c")).enabledSourceIds).toEqual(["jobspy"]);
    });

    it("removes the extractor everywhere and names the profiles left with nothing", async () => {
      await insertWithPins("a", ["jobspy", "hiringcafe"]);
      await insertWithPins("b", ["jobspy"]);
      await insertWithPins("c", ["jobspy"], ["inst-1"]);
      await insertWithPins("d", ["hiringcafe"]);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: false,
      });

      expect(result).toEqual({
        ok: true,
        changed: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
          { id: "c", name: "C" },
        ],
        unchanged: [{ id: "d", name: "D" }],
        skipped: [],
        // C keeps an Apify actor, so only B is left with no source at all.
        empty: [{ id: "b", name: "B" }],
      });
      expect((await pins("a")).enabledSourceIds).toEqual(["hiringcafe"]);
      expect((await pins("b")).enabledSourceIds).toEqual([]);
      expect((await pins("c")).providerInstanceIds).toEqual(["inst-1"]);
    });

    it("pins an Apify actor into providerInstanceIds and leaves extractors alone", async () => {
      const { createProviderInstance } = await import(
        "../repositories/provider-instances"
      );
      const instance = await createProviderInstance({
        providerId: "apify",
        actorRef: "someone/actor",
        label: "Actor",
        inputTemplateJson: "{}",
      });
      await insertWithPins("a", ["jobspy"]);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "provider_instance",
        sourceId: instance.id,
        pinned: true,
      });

      expect(result.ok).toBe(true);
      const config = await pins("a");
      expect(config.providerInstanceIds).toEqual([instance.id]);
      expect(config.enabledSourceIds).toEqual(["jobspy"]);
    });

    it("does not pin a remote-only board into a non-remote profile", async () => {
      await insertWithPins("a", ["jobspy"]);
      await insertWithPins("b", ["jobspy"], [], true);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "extractor",
        sourceId: "himalayas",
        pinned: true,
      });

      expect(result).toEqual({
        ok: true,
        changed: [{ id: "b", name: "B" }],
        unchanged: [],
        skipped: [{ id: "a", name: "A" }],
        empty: [],
      });
      expect((await pins("a")).enabledSourceIds).toEqual(["jobspy"]);
      expect((await pins("b")).enabledSourceIds).toEqual([
        "jobspy",
        "himalayas",
      ]);
    });

    it("counts a remote profile left with only Apify actors as empty", async () => {
      // Apify actors are excluded from a remote profile's run, so the actor
      // it still pins does not save that run from failing.
      await insertWithPins("a", ["jobspy"], ["inst-1"], true);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: false,
      });

      expect(result.ok && result.empty).toEqual([{ id: "a", name: "A" }]);
    });

    it("refuses to pin a source that does not exist, writing nothing", async () => {
      await insertWithPins("a", []);

      for (const kind of ["extractor", "provider_instance"] as const) {
        const result = await service.setSourcePinOnAllProfiles({
          kind,
          sourceId: "ghost",
          pinned: true,
        });
        expect(result).toEqual({ ok: false, reason: "unknown_source" });
      }
      const config = await pins("a");
      expect(config.enabledSourceIds).toEqual([]);
      expect(config.providerInstanceIds).toEqual([]);
    });

    it("still unpins an id nothing knows any more", async () => {
      await insertWithPins("a", ["jobspy"], ["deleted-instance"]);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "provider_instance",
        sourceId: "deleted-instance",
        pinned: false,
      });

      expect(result.ok).toBe(true);
      expect((await pins("a")).providerInstanceIds).toEqual([]);
    });

    it("refuses the whole request when one profile is at the pin cap", async () => {
      const { MAX_PROFILE_SOURCE_PINS } = await import("@shared/types");
      const full = Array.from(
        { length: MAX_PROFILE_SOURCE_PINS },
        (_, index) => `x${index}`,
      );
      // "a" sorts first, so a write-as-you-go loop would have written it.
      await insertWithPins("a", []);
      await insertWithPins("b", full);

      const result = await service.setSourcePinOnAllProfiles({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: true,
      });

      expect(result).toEqual({
        ok: false,
        reason: "full",
        profileId: "b",
        profileName: "B",
      });
      expect((await pins("a")).enabledSourceIds).toEqual([]);
      expect((await pins("b")).enabledSourceIds).toEqual(full);
    });
  });
});

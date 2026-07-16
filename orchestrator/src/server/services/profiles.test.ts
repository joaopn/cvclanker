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

    it("falls back to the most-recently-updated profile when no pointer is set", async () => {
      await insertProfile("older", "Older", "2025-01-01T00:00:00.000Z");
      await insertProfile("newer", "Newer", "2025-06-01T00:00:00.000Z");

      const resolved = await service.getDefaultProfile();
      expect(resolved?.id).toBe("newer");
    });

    it("falls back to most-recent when the pointer is stale", async () => {
      await insertProfile("older", "Older", "2025-01-01T00:00:00.000Z");
      await insertProfile("newer", "Newer", "2025-06-01T00:00:00.000Z");
      await settingsRepo.setSetting("defaultProfileId", "ghost");

      const resolved = await service.getDefaultProfile();
      expect(resolved?.id).toBe("newer");
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
});

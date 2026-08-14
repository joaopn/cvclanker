import * as profilesRepo from "@server/repositories/profiles";
import * as settingsRepo from "@server/repositories/settings";
import type { Profile } from "@shared/types";

const DEFAULT_PROFILE_ID_KEY = "defaultProfileId" as const;

export type DeleteProfileResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "last" };

/**
 * Resolve the active default profile:
 *   1. `settings.defaultProfileId` when it points at an existing profile;
 *   2. otherwise the most-recently-updated profile;
 *   3. otherwise null (no profiles exist — pre-seed only).
 * A stale pointer silently falls through to (2).
 */
export async function getDefaultProfile(): Promise<Profile | null> {
  const pointer = await settingsRepo.getSetting(DEFAULT_PROFILE_ID_KEY);
  if (pointer) {
    const match = await profilesRepo.getProfile(pointer);
    if (match) return match;
  }
  // Asked for explicitly: `getAllProfiles` is alphabetical, so its `[0]` is the
  // first name, not the last-touched profile.
  return await profilesRepo.getMostRecentProfile();
}

/** Set the default-profile pointer. Returns the profile, or null if missing. */
export async function setDefaultProfile(id: string): Promise<Profile | null> {
  const profile = await profilesRepo.getProfile(id);
  if (!profile) return null;
  await settingsRepo.setSetting(DEFAULT_PROFILE_ID_KEY, id);
  return profile;
}

/**
 * Delete a profile. Blocks deletion of the last remaining profile (there must
 * always be ≥1 once seeded), and clears the default pointer when the deleted
 * profile was the default — the resolver then falls back on next read.
 */
export async function deleteProfileById(
  id: string,
): Promise<DeleteProfileResult> {
  const existing = await profilesRepo.getProfile(id);
  if (!existing) return { ok: false, reason: "not_found" };

  const count = await profilesRepo.countProfiles();
  if (count <= 1) return { ok: false, reason: "last" };

  const removed = await profilesRepo.deleteProfile(id);
  if (!removed) return { ok: false, reason: "not_found" };

  const pointer = await settingsRepo.getSetting(DEFAULT_PROFILE_ID_KEY);
  if (pointer === id) {
    await settingsRepo.setSetting(DEFAULT_PROFILE_ID_KEY, null);
  }
  return { ok: true };
}

/** Duplicate a profile, suffixing its name. Returns null if the source is gone. */
export async function duplicateProfile(id: string): Promise<Profile | null> {
  const existing = await profilesRepo.getProfile(id);
  if (!existing) return null;
  return await profilesRepo.createProfile({
    name: `${existing.name} (copy)`,
    config: existing.config,
  });
}

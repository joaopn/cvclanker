import * as profilesRepo from "@server/repositories/profiles";
import { getProviderInstance } from "@server/repositories/provider-instances";
import * as settingsRepo from "@server/repositories/settings";
import { getSourceConfig } from "@server/repositories/source-configs";
import {
  isEmployerBlocked,
  MAX_BLOCKED_COMPANY_KEYWORDS,
} from "@shared/blocked-companies.js";
import { isRemoteProfileOnlyExtractor } from "@shared/extractors";
import { MAX_PROFILE_SOURCE_PINS, type Profile } from "@shared/types";

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

export type BlockCompanyResult =
  | {
      ok: true;
      /** Profiles the company was appended to, in request order. */
      blocked: Array<{ id: string; name: string }>;
      /** Profiles that already blocked it, so nothing was written for them. */
      alreadyBlocked: Array<{ id: string; name: string }>;
    }
  | { ok: false; reason: "not_found"; profileId: string }
  | { ok: false; reason: "full"; profileId: string; profileName: string };

/**
 * Add a company to the blocked list of one or more Search Profiles.
 *
 * Only future runs are affected: `blockedCompanyKeywords` is read by
 * `discoverJobsStep` alone, so jobs already in the database stay exactly where
 * they are — and neither manual URL import nor batch import consults it, so a
 * blocked company can still be added by hand.
 *
 * Writing a profile bumps its `updated_at`, which is also what
 * `getMostRecentProfile` orders by. On an install whose `defaultProfileId`
 * pointer is unset (deleting the default clears it), blacklisting therefore
 * moves which profile a run with no explicit profile picks. That is the
 * fallback behaving as written, and the profile editor does the same on every
 * save; it is called out here because this is a one-click path to it.
 *
 * Every profile is loaded and checked BEFORE anything is written, so a bad id
 * or a full list refuses the whole request rather than leaving the company
 * blocked on some of the profiles the user ticked. A profile that already
 * blocks the company is reported back rather than gaining a duplicate entry.
 *
 * What that ordering does NOT cover, deliberately: a database failure on the
 * k-th write leaves the first k-1 written and answers 500, and each write is
 * built from the list read in the checking loop, so a company added to the
 * same profile in between is lost. Both are the single-writer assumptions this
 * app runs on everywhere else; `blocked` is what was actually written, so a
 * profile deleted in the gap is left out of it rather than reported.
 */
export async function blockCompanyOnProfiles(args: {
  employer: string;
  profileIds: readonly string[];
}): Promise<BlockCompanyResult> {
  // The route already trims, but this is callable without it, and the read
  // schema would trim it anyway — never stored as sent.
  const employer = args.employer.trim();
  const ids = [...new Set(args.profileIds)];

  const blocked: Array<{ id: string; name: string }> = [];
  const alreadyBlocked: Array<{ id: string; name: string }> = [];
  const pending: Profile[] = [];

  for (const id of ids) {
    const profile = await profilesRepo.getProfile(id);
    if (!profile) return { ok: false, reason: "not_found", profileId: id };

    if (isEmployerBlocked(employer, profile.config.blockedCompanyKeywords)) {
      alreadyBlocked.push({ id: profile.id, name: profile.name });
      continue;
    }
    // The read path validates too, and falls back to the field's DEFAULT when
    // it fails — so writing past the cap would not error, it would silently
    // discard every company this profile already blocks.
    if (
      profile.config.blockedCompanyKeywords.length >=
      MAX_BLOCKED_COMPANY_KEYWORDS
    ) {
      return {
        ok: false,
        reason: "full",
        profileId: profile.id,
        profileName: profile.name,
      };
    }
    pending.push(profile);
  }

  for (const profile of pending) {
    const updated = await profilesRepo.updateProfile(profile.id, {
      config: {
        blockedCompanyKeywords: [
          ...profile.config.blockedCompanyKeywords,
          employer,
        ],
      },
    });
    // Null means the profile was deleted between the check and the write.
    // Nothing was stored, so reporting it as blocked would be a lie the
    // caller's toast would repeat.
    if (updated) blocked.push({ id: profile.id, name: profile.name });
  }

  return { ok: true, blocked, alreadyBlocked };
}

/** A built-in extractor (`enabledSourceIds`) or an Apify actor (`providerInstanceIds`). */
export type SourcePinKind = "extractor" | "provider_instance";

type ProfileRef = { id: string; name: string };

export type SetSourcePinResult =
  | {
      ok: true;
      /** Profiles whose pin list was written, in list order. */
      changed: ProfileRef[];
      /** Profiles already in the requested state, so nothing was written. */
      unchanged: ProfileRef[];
      /**
       * Non-remote profiles a remote-only board was NOT pinned into — the
       * profile editor refuses that tick, so this does too.
       */
      skipped: ProfileRef[];
      /**
       * Changed profiles now pinning no extractor and no Apify actor, or — on
       * a remote profile, whose runs exclude Apify actors — no extractor. The
       * run route refuses such a profile, so the caller says so. Coarse on
       * purpose, like that route: a pin that is disabled or incompatible
       * still counts.
       */
      empty: ProfileRef[];
    }
  | { ok: false; reason: "unknown_source" }
  | { ok: false; reason: "full"; profileId: string; profileName: string };

function pinField(kind: SourcePinKind) {
  return kind === "extractor"
    ? ("enabledSourceIds" as const)
    : ("providerInstanceIds" as const);
}

/**
 * Pin a source into, or unpin it from, EVERY Search Profile — the Sources
 * page's "enable/disable in all profiles" buttons.
 *
 * This is the Search-Profile half of the two-level AND only. Whether the
 * source is enabled on the User Profile (the Sources card's own tickbox) is
 * untouched, so pinning a disabled source still runs nothing until it is
 * enabled there too. Pins are not a scrape-coverage field, so no watermarks
 * are dropped. A remote-only board is not pinned into a non-remote profile,
 * matching the profile editor, which blocks that tick.
 *
 * Same check-then-write order as `blockCompanyOnProfiles`: a profile already
 * at the pin cap refuses the whole request before anything is written,
 * because the read path falls back to the field's DEFAULT (an empty list) on
 * a blob that fails validation — writing past the cap would silently unpin
 * every source that profile had.
 */
export async function setSourcePinOnAllProfiles(args: {
  kind: SourcePinKind;
  sourceId: string;
  pinned: boolean;
}): Promise<SetSourcePinResult> {
  const { kind, sourceId, pinned } = args;
  const known =
    kind === "extractor"
      ? await getSourceConfig(sourceId)
      : await getProviderInstance(sourceId);
  // Unpinning an id nothing knows any more is still a cleanup worth allowing;
  // pinning one would plant a pin no run can ever resolve.
  if (!known && pinned) return { ok: false, reason: "unknown_source" };

  const field = pinField(kind);
  const profiles = await profilesRepo.getAllProfiles();
  const pending: Array<{ profile: Profile; next: string[] }> = [];
  const unchanged: ProfileRef[] = [];
  const skipped: ProfileRef[] = [];
  const remoteOnly =
    kind === "extractor" && isRemoteProfileOnlyExtractor(sourceId);

  for (const profile of profiles) {
    const current = profile.config[field];
    const has = current.includes(sourceId);
    if (has === pinned) {
      unchanged.push({ id: profile.id, name: profile.name });
      continue;
    }
    if (pinned && remoteOnly && !profile.config.remoteProfile) {
      skipped.push({ id: profile.id, name: profile.name });
      continue;
    }
    if (pinned && current.length >= MAX_PROFILE_SOURCE_PINS) {
      return {
        ok: false,
        reason: "full",
        profileId: profile.id,
        profileName: profile.name,
      };
    }
    pending.push({
      profile,
      next: pinned
        ? [...current, sourceId]
        : current.filter((id) => id !== sourceId),
    });
  }

  const changed: ProfileRef[] = [];
  const empty: ProfileRef[] = [];
  for (const { profile, next } of pending) {
    const updated = await profilesRepo.updateProfile(profile.id, {
      config: { [field]: next },
    });
    // Deleted between the read and the write: nothing stored, so not reported.
    if (!updated) continue;
    changed.push({ id: profile.id, name: profile.name });
    const usableInstances = updated.config.remoteProfile
      ? 0
      : updated.config.providerInstanceIds.length;
    if (updated.config.enabledSourceIds.length === 0 && usableInstances === 0) {
      empty.push({ id: profile.id, name: profile.name });
    }
  }

  return { ok: true, changed, unchanged, skipped, empty };
}

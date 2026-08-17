import { randomUUID } from "node:crypto";
import { changesScrapeCoverage } from "@shared/scrape-window.js";
import {
  type CreateProfileInput,
  defaultProfileConfig,
  type Profile,
  type ProfileConfig,
  parseProfileConfig,
  type UpdateProfileInput,
} from "@shared/types";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index";
import type { ProfileDbRow } from "../db/schema";
import { getEnabledProviderInstances } from "./provider-instances";
import { getEnabledExtractorIds } from "./source-configs";
import { clearScrapeWatermarks } from "./source-scrape-watermarks";

const { profiles } = schema;

function mapRow(row: ProfileDbRow): Profile {
  return {
    id: row.id,
    name: row.name,
    config: parseProfileConfig(row.configJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Display order: by name, case-insensitively, with embedded numbers compared
 * numerically ("Profile 2" before "Profile 10") and the id as a tiebreaker so
 * two identically-named profiles never swap places between reads.
 *
 * Sorted in JS rather than SQL on purpose — SQLite's `COLLATE NOCASE` and
 * `lower()` only fold ASCII, so an accented name would sort as if it were
 * unrelated. The list is a handful of rows and already fully materialised.
 */
function byDisplayName(a: Profile, b: Profile): number {
  const byName = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Every profile, in a STABLE alphabetical order — editing one must not move it
 * in the list. Callers wanting "the one touched most recently" must ask for it
 * explicitly via `getMostRecentProfile`; `[0]` no longer means that.
 */
export async function getAllProfiles(): Promise<Profile[]> {
  const rows = await db.select().from(profiles);
  return rows.map(mapRow).sort(byDisplayName);
}

/**
 * The most-recently-updated profile, or null when none exist. Sole consumer is
 * the default-profile resolver's fallback, which used to read `getAllProfiles`
 * `[0]` back when that list was ordered `updated_at DESC`.
 */
export async function getMostRecentProfile(): Promise<Profile | null> {
  const [row] = await db
    .select()
    .from(profiles)
    .orderBy(desc(profiles.updatedAt))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function getProfile(id: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, id));
  return row ? mapRow(row) : null;
}

export async function countProfiles(): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles);
  return rows.length;
}

export async function createProfile(
  input: CreateProfileInput,
): Promise<Profile> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const config: ProfileConfig = {
    ...defaultProfileConfig(),
    ...(input.config ?? {}),
  };

  // A new Search Profile starts with every source the User Profile has
  // enabled, Apify actors included. Absent and empty are treated identically:
  // `parseProfileConfig` collapses an omitted list to `[]`, so the distinction
  // cannot survive a round-trip — and an explicitly source-less profile could
  // only ever be rejected at run time anyway.
  if (config.enabledSourceIds.length === 0) {
    config.enabledSourceIds = await getEnabledExtractorIds();
  }
  if (config.providerInstanceIds.length === 0) {
    config.providerInstanceIds = (await getEnabledProviderInstances()).map(
      (row) => row.id,
    );
  }

  await db.insert(profiles).values({
    id,
    name: input.name,
    configJson: config,
    createdAt: now,
    updatedAt: now,
  });
  const created = await getProfile(id);
  if (!created) {
    throw new Error(`Failed to load created profile ${id}`);
  }
  return created;
}

export async function updateProfile(
  id: string,
  patch: UpdateProfileInput,
): Promise<Profile | null> {
  const existing = await getProfile(id);
  if (!existing) return null;

  const next: Partial<typeof profiles.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.config !== undefined) {
    // Field-level merge over the existing blob; an explicit `null` inside the
    // patch (e.g. scrapeMaxAgeDays) sets null, an omitted key is preserved.
    next.configJson = { ...existing.config, ...patch.config };
  }

  await db.update(profiles).set(next).where(eq(profiles.id, id));

  if (
    patch.config !== undefined &&
    changesScrapeCoverage(existing.config, patch.config)
  ) {
    await clearScrapeWatermarks(id);
  }

  return await getProfile(id);
}

export async function deleteProfile(id: string): Promise<boolean> {
  const result = await db.delete(profiles).where(eq(profiles.id, id)).run();
  // No FK cascade on the runtime connection — clean up explicitly, or a
  // recycled profile id would inherit a dead profile's watermarks.
  await clearScrapeWatermarks(id);
  return result.changes > 0;
}

import {
  resolveWatermarkAdvance,
  type ScrapedSourceMark,
} from "@shared/scrape-window.js";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index";

const { sourceScrapeWatermarks } = schema;

/**
 * When each source last scraped successfully for a Search Profile, keyed by
 * the discovery task's source id (extractor manifest id, or
 * `<providerId>:<instanceId>` for a provider instance).
 */
export async function getScrapeWatermarks(
  profileId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(sourceScrapeWatermarks)
    .where(eq(sourceScrapeWatermarks.profileId, profileId));
  return new Map(rows.map((row) => [row.sourceKey, row.lastScrapedAt]));
}

/**
 * Advance the watermark for every source that scraped successfully. Called
 * only once the run's jobs are imported — advancing on discovery alone would
 * narrow the next run's window past postings that never reached the DB.
 *
 * `scrapedAt` is the run's START, not the moment each source ran, so a window
 * that reaches back to the previous mark always covers the gap with slack.
 *
 * A source only advances when its window actually closed that gap;
 * `resolveWatermarkAdvance` owns the rule, and a source it declines is left
 * exactly as it was rather than written with an older value.
 */
export async function recordScrapeWatermarks(
  profileId: string,
  marks: readonly ScrapedSourceMark[],
  scrapedAt: string,
): Promise<void> {
  if (marks.length === 0) return;

  const existing = await getScrapeWatermarks(profileId);
  const rows: Array<{
    profileId: string;
    sourceKey: string;
    lastScrapedAt: string;
  }> = [];

  // Unreachable today — discovery tasks are unique by construction — but a
  // duplicate must not let a narrow reading veto a wide one, so the widest
  // window for a key is the one judged. Collapsing arbitrarily could hold a
  // mark that should have advanced.
  const widest = new Map<string, ScrapedSourceMark>();
  for (const mark of marks) {
    const current = widest.get(mark.sourceKey);
    if (
      current === undefined ||
      (mark.windowDays ?? -1) > (current.windowDays ?? -1)
    ) {
      widest.set(mark.sourceKey, mark);
    }
  }

  for (const mark of widest.values()) {
    const lastScrapedAt = resolveWatermarkAdvance({
      previous: existing.get(mark.sourceKey),
      runStartedAt: scrapedAt,
      windowDays: mark.windowDays,
      policyWindowDays: mark.policyWindowDays,
    });
    if (lastScrapedAt === null) continue;
    rows.push({ profileId, sourceKey: mark.sourceKey, lastScrapedAt });
  }

  if (rows.length === 0) return;
  await db
    .insert(sourceScrapeWatermarks)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        sourceScrapeWatermarks.profileId,
        sourceScrapeWatermarks.sourceKey,
      ],
      // Write back whatever the row carries rather than the scalar
      // `scrapedAt`. Identical today (an advancing source always lands on the
      // run's start), but it stays correct if the advance rule ever returns
      // something else, instead of silently writing a value the row disagrees
      // with.
      set: { lastScrapedAt: sql`excluded.last_scraped_at` },
    });
}

/**
 * Drop a profile's watermarks so its next run scrapes its full configured
 * window again. Called when the profile is deleted, and when an edit changes
 * what the profile would have matched — a narrowed window is only safe while
 * the previous run looked for the same things.
 */
export async function clearScrapeWatermarks(profileId: string): Promise<void> {
  await db
    .delete(sourceScrapeWatermarks)
    .where(eq(sourceScrapeWatermarks.profileId, profileId));
}

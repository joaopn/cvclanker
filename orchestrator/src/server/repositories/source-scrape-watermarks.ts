import { eq } from "drizzle-orm";
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
 * `scrapedAt` is the run's START, not the moment each source ran, so the next
 * window always reaches back at least as far as the previous run's coverage.
 */
export async function recordScrapeWatermarks(
  profileId: string,
  sourceKeys: readonly string[],
  scrapedAt: string,
): Promise<void> {
  if (sourceKeys.length === 0) return;
  const unique = Array.from(new Set(sourceKeys));
  await db
    .insert(sourceScrapeWatermarks)
    .values(
      unique.map((sourceKey) => ({
        profileId,
        sourceKey,
        lastScrapedAt: scrapedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [
        sourceScrapeWatermarks.profileId,
        sourceScrapeWatermarks.sourceKey,
      ],
      set: { lastScrapedAt: scrapedAt },
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

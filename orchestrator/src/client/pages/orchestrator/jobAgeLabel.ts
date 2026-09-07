/**
 * The "Posted 12d" / "Found 3d" pill shared by the company dialogs.
 *
 * Extracted when the in-flight guard's dialog needed the same label the company
 * panel renders: two byte-identical copies of a date parser is how the two
 * surfaces drift into disagreeing about a job's age.
 */

import type { JobListItem } from "@shared/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `date_posted` is normalised to ISO at ingestion, but the all-digit Unix-ms
 * coercion stays as belt-and-braces for rows written before that (see the
 * date-normalisation notes in project memory).
 */
function parseJobDate(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Posting age when known, else how long we have held the row. */
export function jobAgeLabel(
  job: Pick<JobListItem, "datePosted" | "discoveredAt">,
): string | null {
  const now = Date.now();
  const posted = parseJobDate(job.datePosted);
  if (posted != null) {
    return `Posted ${Math.max(0, Math.floor((now - posted) / DAY_MS))}d`;
  }
  const found = parseJobDate(job.discoveredAt);
  if (found != null) {
    return `Found ${Math.max(0, Math.floor((now - found) / DAY_MS))}d`;
  }
  return null;
}

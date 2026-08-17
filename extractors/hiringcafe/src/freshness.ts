const MS_PER_DAY = 86_400_000;

/**
 * Slack added to the requested window before a posting counts as out of date.
 *
 * `estimated_publish_date` is hiring.cafe's ESTIMATE of when a posting went up,
 * so a hard cutoff would drop postings that are genuinely inside the window and
 * merely mis-estimated. Two days is the smallest slack that clears that: their
 * own UI treats anything under three days as one bucket ("Today" / "Last 3
 * days"), so nothing they would call same-day is lost. At half of it a posting
 * estimated a day or two early is dropped for no reason; at ten times it the
 * drop stops meaning anything against a one-week window, which is the window the
 * bug was reported on.
 */
export const PUBLISH_DATE_TOLERANCE_DAYS = 2;

interface PublishWindowArgs {
  /** `v5_processed_job_data.estimated_publish_date`, as mapped onto the job. */
  estimatedPublishDate: string | null | undefined;
  /** The resolved max-age window, in days. */
  windowDays: number;
  nowMs?: number;
}

/**
 * Whether a posting's estimated publish date is inside the requested window.
 *
 * Hiring Cafe's own date filter (`dateFetchedPastNDays`) is its INDEX date, not
 * the posting date, so a "last 7 days" search legitimately returns postings that
 * are months old. This is the publish-date check that filter cannot do.
 *
 * Fails OPEN: no window, no date, an unparseable date or a future date all keep
 * the job. An absent estimate is not evidence of staleness.
 */
export function isWithinPublishWindow(args: PublishWindowArgs): boolean {
  const { estimatedPublishDate, windowDays } = args;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return true;
  if (!estimatedPublishDate) return true;

  const publishedMs = Date.parse(estimatedPublishDate);
  if (!Number.isFinite(publishedMs)) return true;

  const nowMs = args.nowMs ?? Date.now();
  const ageDays = (nowMs - publishedMs) / MS_PER_DAY;
  if (ageDays < 0) return true;

  return ageDays <= windowDays + PUBLISH_DATE_TOLERANCE_DAYS;
}

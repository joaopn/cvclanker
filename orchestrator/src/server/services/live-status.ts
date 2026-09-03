/**
 * Live LinkedIn posting status: is the job still accepting applications, and
 * what does the board say about applicant volume.
 *
 * Fetches LinkedIn's public guest endpoint
 * (`/jobs-guest/jobs/api/jobPosting/<id>`, the same URL manualJob.ts rewrites
 * job-view links to) through the same two tiers as the manual-job fetcher:
 * plain static fetch first, Camoufox browser fallback when that fails or
 * returns a page that doesn't look like a job posting.
 */

import { AppError, badRequest, unprocessableEntity } from "@infra/errors";
import { extractExternalId } from "@shared/duplicate-identity";
import { JSDOM } from "jsdom";
import { tryBrowserFetch, tryStaticFetch } from "./manualJob";
import { getEffectiveSettings } from "./settings";

/**
 * Global pacing for every LinkedIn request this service makes (both tiers —
 * the browser fetch is a LinkedIn request too). LinkedIn rate-limits per IP:
 * a bulk check at `bulkActionConcurrency` parallel jobs × up to 3 attempts
 * each drew 429s in production, which then 429'd the USER's own browsing on
 * the shared IP — and falling to Camoufox on a rate-limited IP just gets the
 * authwall. So:
 * - Requests are SERIALIZED with a minimum spacing. 1s ≈ human browsing
 *   pace: a 100-job sweep takes under 2 minutes; at 100ms the burst reads
 *   as scraping again, and at 10s a sweep crawls for no gain (a burst of 10
 *   unspaced requests measured fine — it's the sustained parallel volume
 *   that trips the limiter).
 * - A 429 opens an EXPONENTIAL backoff window shared by every queued job
 *   (the limit is per-IP, so per-job retries would multiply the damage —
 *   same reasoning as the LLM rate-limit budget). 5s base: LinkedIn's
 *   short-window limiter typically clears in seconds; doubling to a 60s cap
 *   keeps a hard-limited IP from hammering once a minute-scale block is on.
 * - A job whose remaining budget (`manualJobFetchTimeoutMs`, default 15s)
 *   cannot cover the wait fails FAST with a rate-limit message instead of
 *   burning its timeout in the queue — and a 429 NEVER falls to the browser
 *   tier.
 */
const GUEST_REQUEST_SPACING_MS = 1_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 5_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;

let paceQueueTail: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;
let currentBackoffMs = 0;

/** Test-only: clear the module-level pacing state between tests. */
export function resetLiveStatusPacingForTests(): void {
  paceQueueTail = Promise.resolve();
  nextAllowedAt = 0;
  currentBackoffMs = 0;
}

/**
 * Marker for the two failures that mean "LinkedIn is refusing THIS MACHINE"
 * rather than "this posting could not be read": a 429 backoff the job's budget
 * cannot outwait, and the sign-in wall. Both are per-IP and shared by every
 * caller, so a caller working through a list of rows should stop on them
 * instead of spending the rest of the list proving the same thing.
 *
 * A marker property rather than an exported class: both errors are AppError
 * subclasses nothing outside should construct, and the rate-limit message
 * varies with the current backoff, so matching on text would be fragile.
 */
const LINKEDIN_BLOCKED = "__linkedinBlocked";

/** Stamp the marker on an error about to be thrown. */
function markLinkedinBlocked<T extends AppError>(error: T): T {
  Object.defineProperty(error, LINKEDIN_BLOCKED, { value: true });
  return error;
}

/**
 * True when the failure means LinkedIn is refusing this machine (rate limit or
 * sign-in wall), as opposed to one posting failing to read. Callers iterating
 * over rows should stop; per-posting failures they should skip past.
 */
export function isLinkedinBlockedError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error as unknown as Record<string, unknown>)[LINKEDIN_BLOCKED] === true
  );
}

class LinkedinRateLimitedError extends AppError {
  constructor() {
    const backoffOpen = currentBackoffMs > 0;
    super({
      status: 502,
      code: "UPSTREAM_ERROR",
      // Two ways to land here: a real 429 opened a backoff window this job's
      // budget can't cover, or (large selections) the 1s pacing alone pushed
      // this job past its fetch timeout. Both resolve the same way.
      message: backoffOpen
        ? "LinkedIn is rate limiting requests from this machine (HTTP 429). Wait a few minutes and re-run the live-status check on the remaining jobs."
        : "The paced live-status queue could not reach this job inside its fetch timeout — re-run the check on the remaining jobs (requests are spaced out to avoid LinkedIn rate limits).",
    });
    // Only the real 429 is machine-wide. The other cause is this job's own
    // wait behind a busy queue, which says nothing about the next job — and
    // marking it would make one slow caller stop a whole sweep.
    if (backoffOpen) markLinkedinBlocked(this);
  }
}

/**
 * Take the next request slot: waits out the spacing/backoff window, or
 * throws LinkedinRateLimitedError when the wait would not fit inside the
 * job's deadline — better one clear failure than a queued 408.
 *
 * The wait is a LOOP that re-reads `nextAllowedAt` after every sleep: the
 * fetch itself runs outside the mutex, so another job's 429 can open or
 * extend the backoff window while this turn is already mid-sleep, and a
 * stamp computed from the stale value would CLOBBER that window (measured:
 * at concurrency 4 the clobber self-perpetuates and the backoff never
 * engages). The break-to-stamp path has no await between the fresh read and
 * the write, so no window can slip in.
 */
async function acquireRequestSlot(deadlineAt: number): Promise<void> {
  const turn = paceQueueTail.then(async () => {
    for (;;) {
      const wait = Math.max(0, nextAllowedAt - Date.now());
      if (Date.now() + wait >= deadlineAt) {
        throw new LinkedinRateLimitedError();
      }
      if (wait === 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    nextAllowedAt = Date.now() + GUEST_REQUEST_SPACING_MS;
  });
  // The chain must survive a thrown slot (budget refusal) — swallow it on
  // the tail so later jobs still get turns; the caller still sees the throw.
  paceQueueTail = turn.catch(() => {});
  return turn;
}

/** A 429 arrived: open/double the shared backoff window. */
function registerRateLimit(): void {
  currentBackoffMs =
    currentBackoffMs === 0
      ? RATE_LIMIT_BACKOFF_BASE_MS
      : Math.min(RATE_LIMIT_BACKOFF_CAP_MS, currentBackoffMs * 2);
  nextAllowedAt = Date.now() + currentBackoffMs;
}

export interface LinkedinLiveStatus {
  /** The posting shows "No longer accepting applications". */
  closed: boolean;
  /**
   * The applicant-count caption verbatim ("45 applicants", "Be among the
   * first 25 applicants"). Null when the page carries none — and always null
   * when `closed`: LinkedIn resets the caption on closed postings to "Be
   * among the first 25 applicants", so the value would be fabricated.
   */
  applicants: string | null;
  /**
   * True when the posting applies ON LinkedIn (Easy Apply), false when it
   * sends the applicant to the employer's own site. Null when the verdict is
   * `closed`: a closed posting renders an EMPTY CTA container, so there is no
   * Apply variant left to read and any value would be invented.
   */
  easyApply: boolean | null;
}

/**
 * Read the live status out of a guest-endpoint HTML document. Returns null
 * when the page cannot support a verdict — the caller's signal to fetch
 * again (or give up). Deliberately strict: a page that merely looks like a
 * posting must NOT produce an "accepting applications" verdict, or a markup
 * change on LinkedIn's side would silently record closed jobs as open.
 *
 * Measured facts driving the shape (2026-08-24/25, 20 live pages):
 * - The endpoint ALTERNATES two renders per request: a FULL page carrying
 *   the contextual sign-in modals, and a CONDENSED one without them.
 * - An open job's Apply CTA comes in TWO variants, both inside the topcard
 *   CTA container: OFFSITE apply renders a sign-in-modal outlet button
 *   (`data-modal="job-details-topcard-apply-modal"`), FULL render only;
 *   ONSITE (Easy Apply — e.g. job 4458701238) renders `button.apply-button`
 *   with no data-modal at all, and keeps it on BOTH renders, so an onsite
 *   job is decidable even off the condensed page. Which variant is present
 *   is therefore also the Easy-Apply verdict, at no extra fetch cost — and
 *   because an open verdict REQUIRES one of the two markers, `easyApply` is
 *   never unknown while `closed` is false.
 * - The two variants are mutually exclusive and container-scoped (re-measured
 *   2026-09-03 over 68 guest pages / 34 jobs: 22 onsite, 38 offsite, 0
 *   carrying both, 0 with `.apply-button` outside the CTA container). The
 *   onsite sample was drawn through LinkedIn's OWN Easy Apply search filter
 *   (`f_AL=true`), which is what ties `.apply-button` to Easy Apply rather
 *   than to some other onsite flow; LinkedIn labels the buttons the same way
 *   in attributes we deliberately do not parse
 *   (`public_jobs_apply-link-onsite` / `…-offsite`).
 * - Closed jobs come in two kinds: with the explicit "No longer accepting
 *   applications" figure (kind A), and WITHOUT it (kind B — e.g. job
 *   4442812721), where the tell is a full render whose CTA container is
 *   EMPTY. Neither closed kind carries either Apply variant on any render.
 * - On the condensed render an OFFSITE open job and a bannerless closed job
 *   are identical (both an empty CTA container) — no verdict there.
 *
 * Detection is by class/attribute, never by text, so localized pages parse
 * the same. Apply probes are scoped to the CTA container so employer-authored
 * description markup can never flip a verdict.
 */
export function parseLinkedinLiveStatus(
  html: string,
): LinkedinLiveStatus | null {
  const document = new JSDOM(html).window.document;

  // Kind A: the explicit banner decides regardless of render variant.
  // Scoped to <figure> so employer-authored description markup that happens
  // to reuse the class can never flip the verdict.
  if (document.querySelector("figure.closed-job")) {
    return { closed: true, applicants: null, easyApply: null };
  }

  // Either Apply variant proves the job is still taking applications; WHICH
  // one also says whether applying happens on LinkedIn. The offsite probe
  // pins the exact data-modal value because the same container carries a
  // `job-details-topcard-save-modal` outlet for the Save button.
  const isEasyApply =
    document.querySelector(".top-card-layout__cta-container .apply-button") !==
    null;
  const isOffsiteApply =
    document.querySelector(
      '.top-card-layout__cta-container [data-modal="job-details-topcard-apply-modal"]',
    ) !== null;
  if (isEasyApply || isOffsiteApply) {
    const caption = document
      .querySelector(".num-applicants__caption")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    return {
      closed: false,
      applicants: caption ?? null,
      easyApply: isEasyApply,
    };
  }

  // No banner, no Apply CTA: on the FULL render that means closed (kind B);
  // on the condensed render it is undecidable — an offsite open job looks
  // exactly like this there. Never guess "closed" off a condensed page.
  const isFullRender =
    document.querySelector(".contextual-sign-in-modal") !== null;
  if (!isFullRender) return null;

  return { closed: true, applicants: null, easyApply: null };
}

/**
 * Fetch the live status for one LinkedIn job. Throws AppError: 400 when the
 * URL carries no LinkedIn posting id, 502 on upstream/authwall failures, 408
 * on timeout, 422 when neither tier produced a recognizable posting page.
 */
export async function fetchLinkedinLiveStatus(
  jobUrl: string,
  sourceJobId?: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<LinkedinLiveStatus> {
  const id = extractExternalId({ jobUrl, sourceJobId });
  if (!id) {
    throw badRequest("Job has no LinkedIn posting id", { jobUrl });
  }
  const guestUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`;

  const settings = await getEffectiveSettings();
  const timeoutMs = settings.manualJobFetchTimeoutMs.value;
  const settleMs = settings.manualJobFetchBrowserSettleMs.value;

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    options.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  // The endpoint alternates its two renders per request (strict alternation
  // in measurement), so a condensed no-verdict draw is retried: three such
  // draws mean the browser tier fires only after three in a row, which the
  // observed alternation makes vanishingly unlikely. 429s retry separately,
  // bounded by the shared backoff + this job's deadline rather than a count.
  const CONDENSED_DRAW_ATTEMPTS = 3;
  const deadlineAt = startedAt + timeoutMs;

  try {
    let condensedDraws = 0;
    let goToBrowser = false;
    while (condensedDraws < CONDENSED_DRAW_ATTEMPTS && !goToBrowser) {
      await acquireRequestSlot(deadlineAt);
      let nonOkStatus: number | null = null;
      const staticResult = await tryStaticFetch(guestUrl, controller.signal, {
        onNonOkStatus: (status) => {
          nonOkStatus = status;
        },
      });
      if (staticResult) {
        currentBackoffMs = 0;
        const status = parseLinkedinLiveStatus(staticResult.html);
        if (status) return status;
        condensedDraws += 1;
        continue;
      }
      if (nonOkStatus === 429) {
        // Rate limited: open the shared backoff and retry within this job's
        // budget. acquireRequestSlot throws the clear rate-limit error once
        // the window no longer fits — and a 429 must NEVER launch the
        // browser tier (a rate-limited IP just gets the authwall, and the
        // launch adds more heat).
        registerRateLimit();
        continue;
      }
      // Any other non-OK/empty body: repeating the identical request buys
      // nothing — fall through to the browser tier.
      goToBrowser = true;
    }

    await acquireRequestSlot(deadlineAt);
    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    const browserResult = await tryBrowserFetch(
      guestUrl,
      remainingMs,
      settleMs,
    );
    if (browserResult.finalUrl.includes("linkedin.com/authwall")) {
      // Machine-wide, like a rate limit: the wall is served to this IP, not to
      // this posting, so a caller working a list should stop here.
      throw markLinkedinBlocked(
        new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          message:
            "LinkedIn redirected to its sign-in wall; the live status could not be read.",
        }),
      );
    }
    const status = parseLinkedinLiveStatus(browserResult.html);
    if (!status) {
      throw unprocessableEntity(
        "Fetched page does not look like a LinkedIn job posting; the job was left unchanged.",
        { jobUrl },
      );
    }
    return status;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new AppError({
        status: 408,
        code: "REQUEST_TIMEOUT",
        message: "Timed out fetching the LinkedIn live status",
      });
    }
    throw new AppError({
      status: 502,
      code: "UPSTREAM_ERROR",
      message:
        error instanceof Error
          ? error.message
          : "Failed to fetch the LinkedIn live status",
    });
  } finally {
    clearTimeout(timeout);
  }
}

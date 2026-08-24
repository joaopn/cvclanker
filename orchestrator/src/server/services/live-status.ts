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
}

/**
 * Read the live status out of a guest-endpoint HTML document. Returns null
 * when the page cannot support a verdict — the caller's signal to fetch
 * again (or give up). Deliberately strict: a page that merely looks like a
 * posting must NOT produce an "accepting applications" verdict, or a markup
 * change on LinkedIn's side would silently record closed jobs as open.
 *
 * Two measured facts drive the shape (2026-08-24, 16 live pages):
 * - The endpoint ALTERNATES two renders per request: a FULL page carrying
 *   the contextual sign-in modals, and a CONDENSED one without them. Only
 *   the full render can prove open-ness — on the condensed one an open job
 *   and a bannerless closed job are identical (both an empty CTA container).
 * - Closed jobs come in two kinds: with the explicit "No longer accepting
 *   applications" figure (kind A), and WITHOUT it (kind B — e.g. job
 *   4442812721), where the only tell is the full render omitting the Apply
 *   CTA. Every open full render carries the CTA (13/13 measured, offsite
 *   apply included); both closed kinds lack it.
 *
 * Detection is by class/attribute, never by text, so localized pages parse
 * the same.
 */
export function parseLinkedinLiveStatus(
  html: string,
): LinkedinLiveStatus | null {
  const document = new JSDOM(html).window.document;

  // Kind A: the explicit banner decides regardless of render variant.
  // Scoped to <figure> so employer-authored description markup that happens
  // to reuse the class can never flip the verdict.
  if (document.querySelector("figure.closed-job")) {
    return { closed: true, applicants: null };
  }

  // Condensed render: no verdict possible — never guess "open" off it.
  const isFullRender =
    document.querySelector(".contextual-sign-in-modal") !== null;
  if (!isFullRender) return null;

  // Kind B: a full render with no Apply CTA is a job no longer taking
  // applications, banner or not.
  const hasApplyCta =
    document.querySelector('[data-modal="job-details-topcard-apply-modal"]') !==
    null;
  if (!hasApplyCta) {
    return { closed: true, applicants: null };
  }

  const caption = document
    .querySelector(".num-applicants__caption")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return { closed: false, applicants: caption ?? null };
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
  // in measurement), so a condensed no-verdict draw is retried: three
  // attempts mean the browser tier fires only after three condensed draws in
  // a row, which the observed alternation makes vanishingly unlikely.
  const STATIC_ATTEMPTS = 3;

  try {
    for (let attempt = 0; attempt < STATIC_ATTEMPTS; attempt++) {
      const staticResult = await tryStaticFetch(guestUrl, controller.signal);
      // Non-OK/empty body: repeating the identical request buys nothing —
      // fall straight through to the browser tier.
      if (!staticResult) break;
      const status = parseLinkedinLiveStatus(staticResult.html);
      if (status) return status;
    }

    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
    const browserResult = await tryBrowserFetch(
      guestUrl,
      remainingMs,
      settleMs,
    );
    if (browserResult.finalUrl.includes("linkedin.com/authwall")) {
      throw new AppError({
        status: 502,
        code: "UPSTREAM_ERROR",
        message:
          "LinkedIn redirected to its sign-in wall; the live status could not be read.",
      });
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

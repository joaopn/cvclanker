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
 * Read the live status out of a guest-endpoint (or job page) HTML document.
 * Returns null when the page carries NEITHER the applicant caption nor the
 * closed figure — the two facts this check exists to read — which is the
 * caller's signal to try the browser tier (or give up). Deliberately strict:
 * a page that merely looks like a posting (title present, markers absent)
 * must NOT produce an "accepting applications" verdict, or a class rename on
 * LinkedIn's side would silently record every closed job as open.
 *
 * Detection is by class, never by text, so localized pages parse the same.
 */
export function parseLinkedinLiveStatus(
  html: string,
): LinkedinLiveStatus | null {
  const document = new JSDOM(html).window.document;

  // Scoped to <figure> so employer-authored description markup that happens
  // to reuse the class can never flip the verdict.
  const closed = document.querySelector("figure.closed-job") !== null;
  const caption = document
    .querySelector(".num-applicants__caption")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();

  if (!closed && !caption) return null;
  return { closed, applicants: closed ? null : (caption ?? null) };
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

  try {
    const staticResult = await tryStaticFetch(guestUrl, controller.signal);
    if (staticResult) {
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

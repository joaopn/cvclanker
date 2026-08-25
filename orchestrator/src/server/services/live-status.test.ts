// @vitest-environment node

import { AppError } from "@infra/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryStaticFetchMock = vi.hoisted(() => vi.fn());
const tryBrowserFetchMock = vi.hoisted(() => vi.fn());

// Factory-only mocks (no importActual): manualJob's module scope imports
// playwright and ./settings → repositories → SQLite, and ./settings does the
// same — evaluating either real module in this unit test would open the DB.
vi.mock("./manualJob", () => ({
  tryStaticFetch: tryStaticFetchMock,
  tryBrowserFetch: tryBrowserFetchMock,
}));
vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn().mockResolvedValue({
    manualJobFetchTimeoutMs: { value: 5_000 },
    manualJobFetchBrowserSettleMs: { value: 0 },
  }),
}));

import {
  fetchLinkedinLiveStatus,
  parseLinkedinLiveStatus,
} from "./live-status";

// Markup captured live from the guest endpoint (jobs-guest/jobs/api/
// jobPosting/<id>) on 2026-08-24, verbatim modulo trimming. The endpoint
// alternates a FULL render (carries the contextual sign-in modals + the
// Apply CTA on open jobs) with a CONDENSED one (neither, even when open).
const TITLE_MARKUP = `<h2 class="top-card-layout__title font-sans text-lg topcard__title">AI Developer</h2>`;
const FULL_RENDER_MARKER = `<div class="contextual-sign-in-modal"></div>`;
// OFFSITE apply: a sign-in-modal outlet button, full render only. Wrapped in
// the CTA container because the parse's Apply probes are scoped to it.
const APPLY_CTA = `<div class="top-card-layout__cta-container flex flex-wrap"><button class="sign-up-modal__outlet top-card-layout__cta btn-md btn-primary" data-modal="job-details-topcard-apply-modal">Apply</button></div>`;
// ONSITE (Easy Apply): a plain apply-button with NO data-modal (job
// 4458701238), present on BOTH renders.
const ONSITE_APPLY_CTA = `<div class="top-card-layout__cta-container flex flex-wrap"><button class="apply-button apply-button--default top-card-layout__cta btn-md btn-primary" data-reference-id="idN64ZZ4Tp==">Apply</button></div>`;

const OPEN_FIGURE_VARIANT = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${APPLY_CTA}
  <figure class="num-applicants__figure topcard__flavor--metadata topcard__flavor--bullet">
    <span class="num-applicants__icon num-applicants__icon--clock lazy-load"></span>
    <figcaption class="num-applicants__caption">
      Be among the first 25 applicants
    </figcaption>
  </figure>
</body></html>`;

const OPEN_SPAN_VARIANT = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${APPLY_CTA}
  <span class="num-applicants__caption topcard__flavor--metadata topcard__flavor--bullet">
    45 applicants
  </span>
</body></html>`;

// Kind A: the explicit closed banner (job 4441896971).
const CLOSED_MARKUP = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}
  <figure class="closed-job closed-job__flavor topcard__flavor-row">
    <span class="closed-job__icon closed-job__icon--error-pebble lazy-load"></span>
    <figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>
  </figure>
  <figure class="num-applicants__figure">
    <figcaption class="num-applicants__caption">Be among the first 25 applicants</figcaption>
  </figure>
</body></html>`;

// Kind B: no banner, but the full render omits the Apply CTA entirely
// (job 4442812721 — an empty cta-container plus the reset caption).
const CLOSED_NO_BANNER = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}
  <div class="top-card-layout__cta-container flex flex-wrap"><!----><!----></div>
  <figure class="num-applicants__figure">
    <figcaption class="num-applicants__caption">Be among the first 25 applicants</figcaption>
  </figure>
</body></html>`;

// The condensed render of an OPEN job: caption present, but no sign-in
// modals and no Apply CTA — indistinguishable from kind-B closed, so it
// must yield NO verdict (job 4427933585 had this shape while open).
const CONDENSED_OPEN = `<html><body>${TITLE_MARKUP}
  <div class="top-card-layout__cta-container flex flex-wrap"><!----><!----></div>
  <span class="num-applicants__caption topcard__flavor--metadata">50 applicants</span>
</body></html>`;

const NOT_A_POSTING = `<html><body><p>Sign in to continue</p></body></html>`;

const JOB_URL = "https://www.linkedin.com/jobs/view/4441896971";
const GUEST_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4441896971";

describe("parseLinkedinLiveStatus", () => {
  it("reads the figure-variant caption on an open job", () => {
    expect(parseLinkedinLiveStatus(OPEN_FIGURE_VARIANT)).toEqual({
      closed: false,
      applicants: "Be among the first 25 applicants",
    });
  });

  it("reads the span-variant caption on an open job", () => {
    expect(parseLinkedinLiveStatus(OPEN_SPAN_VARIANT)).toEqual({
      closed: false,
      applicants: "45 applicants",
    });
  });

  it("verdicts an ONSITE (Easy Apply) job open on the FULL render", () => {
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${ONSITE_APPLY_CTA}
      <figcaption class="num-applicants__caption">20 applicants</figcaption>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: "20 applicants",
    });
  });

  it("verdicts an ONSITE job open even on the CONDENSED render", () => {
    // Unlike offsite, the onsite apply-button survives the condensed render
    // (measured on job 4458701238) — so the verdict needs no retry.
    const html = `<html><body>${TITLE_MARKUP}${ONSITE_APPLY_CTA}
      <figcaption class="num-applicants__caption">20 applicants</figcaption>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: "20 applicants",
    });
  });

  it("ignores an apply-button outside the CTA container", () => {
    // The Apply probes are container-scoped so employer description markup
    // can never flip a bannerless closed page to open.
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}
      <div class="top-card-layout__cta-container"><!----><!----></div>
      <div class="description"><button class="apply-button">apply on our site</button></div>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: true,
      applicants: null,
    });
  });

  it("flags a banner-closed job and nulls its (reset) applicant caption", () => {
    expect(parseLinkedinLiveStatus(CLOSED_MARKUP)).toEqual({
      closed: true,
      applicants: null,
    });
  });

  it("verdicts a CONDENSED render carrying the banner (rule order)", () => {
    // The banner decides BEFORE the render-variant check — a condensed
    // kind-A page has the figure but no sign-in-modal marker, and must not
    // fall into the no-verdict branch.
    const condensedClosedA = CLOSED_MARKUP.replace(FULL_RENDER_MARKER, "");
    expect(parseLinkedinLiveStatus(condensedClosedA)).toEqual({
      closed: true,
      applicants: null,
    });
  });

  it("flags a banner-LESS closed job by its missing Apply CTA", () => {
    expect(parseLinkedinLiveStatus(CLOSED_NO_BANNER)).toEqual({
      closed: true,
      applicants: null,
    });
  });

  it("yields NO verdict on the condensed render, even of an open job", () => {
    // The condensed render of an open job is indistinguishable from a
    // banner-less closed one — guessing either way records lies.
    expect(parseLinkedinLiveStatus(CONDENSED_OPEN)).toBeNull();
  });

  it("returns null for a page with no posting markup", () => {
    expect(parseLinkedinLiveStatus(NOT_A_POSTING)).toBeNull();
  });

  it("returns null for a title-only page rather than guessing 'open'", () => {
    // A posting-shaped page with no verdict-capable markers must not produce
    // one: if LinkedIn renames its classes, closed jobs would otherwise all
    // be recorded as accepting applications.
    expect(
      parseLinkedinLiveStatus(`<html><body>${TITLE_MARKUP}</body></html>`),
    ).toBeNull();
  });

  it("ignores a closed-job class outside a figure (description markup)", () => {
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${APPLY_CTA}
      <span class="num-applicants__caption">45 applicants</span>
      <div class="description"><p class="closed-job">we reopened this role</p></div>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: "45 applicants",
    });
  });
});

describe("fetchLinkedinLiveStatus", () => {
  beforeEach(() => {
    tryStaticFetchMock.mockReset();
    tryBrowserFetchMock.mockReset();
  });

  it("rejects a URL with no LinkedIn posting id before any fetch", async () => {
    await expect(
      fetchLinkedinLiveStatus("https://example.com/jobs/123456"),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(tryStaticFetchMock).not.toHaveBeenCalled();
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("returns the parsed status from the static tier without a browser", async () => {
    tryStaticFetchMock.mockResolvedValue({
      html: OPEN_SPAN_VARIANT,
      finalUrl: GUEST_URL,
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).resolves.toEqual({
      closed: false,
      applicants: "45 applicants",
    });
    expect(tryStaticFetchMock).toHaveBeenCalledWith(
      GUEST_URL,
      expect.any(AbortSignal),
    );
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the browser tier when the static fetch fails", async () => {
    tryStaticFetchMock.mockResolvedValue(null);
    tryBrowserFetchMock.mockResolvedValue({
      html: CLOSED_MARKUP,
      finalUrl: GUEST_URL,
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).resolves.toEqual({
      closed: true,
      applicants: null,
    });
    expect(tryBrowserFetchMock).toHaveBeenCalledWith(
      GUEST_URL,
      expect.any(Number),
      0,
    );
  });

  it("retries the static tier past a condensed render", async () => {
    tryStaticFetchMock
      .mockResolvedValueOnce({ html: CONDENSED_OPEN, finalUrl: GUEST_URL })
      .mockResolvedValueOnce({ html: OPEN_SPAN_VARIANT, finalUrl: GUEST_URL });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).resolves.toEqual({
      closed: false,
      applicants: "45 applicants",
    });
    expect(tryStaticFetchMock).toHaveBeenCalledTimes(2);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("falls to the browser only after three condensed draws", async () => {
    tryStaticFetchMock.mockResolvedValue({
      html: CONDENSED_OPEN,
      finalUrl: GUEST_URL,
    });
    tryBrowserFetchMock.mockResolvedValue({
      html: CLOSED_NO_BANNER,
      finalUrl: GUEST_URL,
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).resolves.toEqual({
      closed: true,
      applicants: null,
    });
    expect(tryStaticFetchMock).toHaveBeenCalledTimes(3);
    expect(tryBrowserFetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the browser tier when the static page isn't a posting", async () => {
    tryStaticFetchMock.mockResolvedValue({
      html: NOT_A_POSTING,
      finalUrl: GUEST_URL,
    });
    tryBrowserFetchMock.mockResolvedValue({
      html: OPEN_FIGURE_VARIANT,
      finalUrl: GUEST_URL,
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).resolves.toEqual({
      closed: false,
      applicants: "Be among the first 25 applicants",
    });
  });

  it("maps an authwall redirect to 502", async () => {
    tryStaticFetchMock.mockResolvedValue(null);
    tryBrowserFetchMock.mockResolvedValue({
      html: NOT_A_POSTING,
      finalUrl: "https://www.linkedin.com/authwall?trk=x",
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
  });

  it("throws 422 when neither tier produced a posting page", async () => {
    tryStaticFetchMock.mockResolvedValue(null);
    tryBrowserFetchMock.mockResolvedValue({
      html: NOT_A_POSTING,
      finalUrl: GUEST_URL,
    });

    await expect(fetchLinkedinLiveStatus(JOB_URL)).rejects.toMatchObject({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
    });
  });

  it("maps a network throw from the static tier to 502", async () => {
    tryStaticFetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    await expect(fetchLinkedinLiveStatus(JOB_URL)).rejects.toMatchObject({
      status: 502,
      code: "UPSTREAM_ERROR",
    });
  });

  it("maps an abort to 408", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    tryStaticFetchMock.mockRejectedValue(abortError);

    await expect(fetchLinkedinLiveStatus(JOB_URL)).rejects.toMatchObject({
      status: 408,
      code: "REQUEST_TIMEOUT",
    });
  });

  it("recovers the id from sourceJobId when the URL path lacks one", async () => {
    tryStaticFetchMock.mockResolvedValue({
      html: OPEN_SPAN_VARIANT,
      finalUrl: GUEST_URL,
    });

    await expect(
      fetchLinkedinLiveStatus(
        "https://www.linkedin.com/jobs/view/ai-developer",
        "li-4441896971",
      ),
    ).resolves.toEqual({ closed: false, applicants: "45 applicants" });
    expect(tryStaticFetchMock).toHaveBeenCalledWith(
      GUEST_URL,
      expect.any(AbortSignal),
    );
  });

  it("throws AppError instances end to end", async () => {
    tryStaticFetchMock.mockRejectedValue(new Error("boom"));
    await expect(fetchLinkedinLiveStatus(JOB_URL)).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

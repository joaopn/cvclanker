// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    manualJobFetchTimeoutMs: { value: 30_000 },
    manualJobFetchBrowserSettleMs: { value: 0 },
  }),
}));

import {
  fetchLinkedinLiveStatus,
  isLinkedinBlockedError,
  parseLinkedinLiveStatus,
  resetLiveStatusPacingForTests,
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

// The Save button is a sign-up-modal outlet living in the SAME container as
// the Apply CTA (measured on job 4456944509) — which is why the offsite probe
// pins the exact `job-details-topcard-apply-modal` value rather than testing
// for a data-modal attribute.
const SAVE_OUTLET = `<button class="top-card-layout__cta mt-2 ml-1.5 h-auto babybear:flex-auto top-card-layout__cta--secondary btn-md btn-secondary sign-up-modal__outlet" data-tracking-client-ingraph data-modal="job-details-topcard-save-modal" data-impression-id="public_jobs_topcard-save-job" data-tracking-control-name="public_jobs_topcard-save-job">Save</button>`;

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
      easyApply: false,
    });
  });

  it("reads the span-variant caption on an open job", () => {
    expect(parseLinkedinLiveStatus(OPEN_SPAN_VARIANT)).toEqual({
      closed: false,
      applicants: "45 applicants",
      easyApply: false,
    });
  });

  it("verdicts an ONSITE (Easy Apply) job open on the FULL render", () => {
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${ONSITE_APPLY_CTA}
      <figcaption class="num-applicants__caption">20 applicants</figcaption>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: "20 applicants",
      easyApply: true,
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
      easyApply: true,
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
      easyApply: null,
    });
  });

  it("flags a banner-closed job and nulls its (reset) applicant caption", () => {
    expect(parseLinkedinLiveStatus(CLOSED_MARKUP)).toEqual({
      closed: true,
      applicants: null,
      easyApply: null,
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
      easyApply: null,
    });
  });

  it("flags a banner-LESS closed job by its missing Apply CTA", () => {
    expect(parseLinkedinLiveStatus(CLOSED_NO_BANNER)).toEqual({
      closed: true,
      applicants: null,
      easyApply: null,
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

  it("reads the Easy-Apply verdict off which Apply variant is present", () => {
    // Measured 2026-09-03 over 68 guest pages / 34 jobs: the onsite and
    // offsite markers never co-occur, and the onsite sample was drawn through
    // LinkedIn's own Easy Apply search filter (f_AL=true).
    expect(parseLinkedinLiveStatus(OPEN_FIGURE_VARIANT)?.easyApply).toBe(false);
    const onsite = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${ONSITE_APPLY_CTA}</body></html>`;
    expect(parseLinkedinLiveStatus(onsite)?.easyApply).toBe(true);
  });

  it("keeps the Easy-Apply verdict on the CONDENSED render", () => {
    // The onsite button survives the condensed render where the offsite one
    // does not, so an Easy Apply job needs no full draw to be flagged.
    const html = `<html><body>${TITLE_MARKUP}${ONSITE_APPLY_CTA}</body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: null,
      easyApply: true,
    });
  });

  it("still flags Easy Apply when the Save outlet shares the CTA container", () => {
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}<div class="top-card-layout__cta-container flex flex-wrap"><button class="apply-button apply-button--default top-card-layout__cta btn-md btn-primary" data-reference-id="idN64ZZ4Tp==">Apply</button>${SAVE_OUTLET}</div></body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: null,
      easyApply: true,
    });
  });

  it("does not read the Save outlet as an offsite Apply", () => {
    // This is the case that makes the offsite probe's EXACT data-modal value
    // load-bearing: the Save button is a sign-up-modal outlet too, so a probe
    // for a bare `[data-modal]` would call this bannerless page OPEN. The
    // fixture is an adversarial construction, not a captured page — every
    // closed page in the sample had a fully empty container — but the Save
    // outlet and its `job-details-topcard-save-modal` value are measured
    // (job 4456944509), and the selector it guards is real.
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}<div class="top-card-layout__cta-container flex flex-wrap">${SAVE_OUTLET}</div></body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: true,
      applicants: null,
      easyApply: null,
    });
  });

  it("prefers the onsite verdict if both Apply variants ever co-occur", () => {
    // Never observed (0 of 68 measured pages) and deliberately not treated as
    // undecidable: the open/closed verdict is the higher-value half of this
    // check, and refusing one over a disagreement about the chip would cost a
    // re-fetch and risk a 422 that leaves the row unchecked entirely. Pinned
    // so the precedence is a decision rather than an accident of ordering.
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}<div class="top-card-layout__cta-container flex flex-wrap"><button class="apply-button" data-reference-id="x">Apply</button><button class="sign-up-modal__outlet" data-modal="job-details-topcard-apply-modal">Apply</button></div></body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: null,
      easyApply: true,
    });
  });

  it("leaves the Easy-Apply verdict NULL on both closed kinds", () => {
    // A closed posting renders an empty CTA container, so there is no Apply
    // variant left to read — false would claim an offsite posting we never saw.
    expect(parseLinkedinLiveStatus(CLOSED_MARKUP)?.easyApply).toBeNull();
    expect(parseLinkedinLiveStatus(CLOSED_NO_BANNER)?.easyApply).toBeNull();
  });

  it("ignores a closed-job class outside a figure (description markup)", () => {
    const html = `<html><body>${TITLE_MARKUP}${FULL_RENDER_MARKER}${APPLY_CTA}
      <span class="num-applicants__caption">45 applicants</span>
      <div class="description"><p class="closed-job">we reopened this role</p></div>
    </body></html>`;
    expect(parseLinkedinLiveStatus(html)).toEqual({
      closed: false,
      applicants: "45 applicants",
      easyApply: false,
    });
  });
});

describe("fetchLinkedinLiveStatus", () => {
  // Fake timers throughout: the pacer spaces requests 1s apart and a 429
  // opens a 5s+ backoff — tests drive the clock instead of sleeping. Every
  // test kicks the fetch off, attaches its assertion, then advances time.
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveStatusPacingForTests();
    tryStaticFetchMock.mockReset();
    tryBrowserFetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** Record the (faked) time of each static fetch alongside a queued reply. */
  function staticRepliesAt(
    times: number[],
    replies: Array<{ html: string } | { status: number } | null>,
  ) {
    let i = 0;
    tryStaticFetchMock.mockImplementation(
      async (
        _url: string,
        _signal: AbortSignal,
        options: { onNonOkStatus?: (status: number) => void } = {},
      ) => {
        times.push(Date.now());
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        if (reply && "html" in reply) {
          return { html: reply.html, finalUrl: GUEST_URL };
        }
        if (reply && "status" in reply) {
          options.onNonOkStatus?.(reply.status);
        }
        return null;
      },
    );
  }

  async function settled<T>(promise: Promise<T>, advanceMs: number) {
    const outcome = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(advanceMs);
    return outcome;
  }

  it("rejects a URL with no LinkedIn posting id before any fetch", async () => {
    const result = await settled(
      fetchLinkedinLiveStatus("https://example.com/jobs/123456"),
      0,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { status: 400, code: "INVALID_REQUEST" },
    });
    expect(tryStaticFetchMock).not.toHaveBeenCalled();
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("returns the parsed status from the static tier without a browser", async () => {
    staticRepliesAt([], [{ html: OPEN_SPAN_VARIANT }]);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 0);
    expect(result).toEqual({
      ok: true,
      value: {
        closed: false,
        applicants: "45 applicants",
        easyApply: false,
      },
    });
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("spaces consecutive requests at least 1s apart", async () => {
    const times: number[] = [];
    staticRepliesAt(times, [
      { html: CONDENSED_OPEN },
      { html: OPEN_SPAN_VARIANT },
    ]);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toMatchObject({ ok: true });
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1_000);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("backs off exponentially on a 429 and retries WITHOUT the browser", async () => {
    const times: number[] = [];
    staticRepliesAt(times, [{ status: 429 }, { html: CLOSED_MARKUP }]);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 30_000);
    expect(result).toEqual({
      ok: true,
      value: {
        closed: true,
        applicants: null,
        easyApply: null,
      },
    });
    // Second attempt sat out the 5s backoff window, not just the 1s spacing.
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(5_000);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("fails fast with a rate-limit error when 429s outlast the job's budget", async () => {
    const times: number[] = [];
    staticRepliesAt(times, [{ status: 429 }]);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 60_000);
    // 30s budget: 429s at 0s/5s/15s open 5s→10s→20s backoff windows; the
    // fourth attempt would land at 35s ≥ deadline → clear failure, no
    // queued 408, and never a browser launch.
    expect(result).toMatchObject({
      ok: false,
      error: { status: 502, code: "UPSTREAM_ERROR" },
    });
    if (result.ok === false) {
      expect((result.error as Error).message).toMatch(/rate limiting/i);
      // Machine-wide: a caller sweeping many rows must be able to tell this
      // from one posting failing, and stop.
      expect(isLinkedinBlockedError(result.error)).toBe(true);
    }
    expect(times).toHaveLength(3);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("resets the backoff after a successful response", async () => {
    const t1: number[] = [];
    staticRepliesAt(t1, [{ status: 429 }, { html: OPEN_SPAN_VARIANT }]);
    expect(
      await settled(fetchLinkedinLiveStatus(JOB_URL), 30_000),
    ).toMatchObject({ ok: true });

    const t2: number[] = [];
    staticRepliesAt(t2, [
      { html: CONDENSED_OPEN },
      { html: OPEN_SPAN_VARIANT },
    ]);
    expect(
      await settled(fetchLinkedinLiveStatus(JOB_URL), 30_000),
    ).toMatchObject({ ok: true });
    // Post-success gap is the 1s spacing again, not a doubled backoff.
    expect(t2[1] - t2[0]).toBeLessThan(5_000);
  });

  it("falls back to the paced browser tier when the static fetch fails non-429", async () => {
    staticRepliesAt([], [null]);
    tryBrowserFetchMock.mockResolvedValue({
      html: CLOSED_MARKUP,
      finalUrl: GUEST_URL,
    });

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toEqual({
      ok: true,
      value: {
        closed: true,
        applicants: null,
        easyApply: null,
      },
    });
    expect(tryStaticFetchMock).toHaveBeenCalledTimes(1);
    expect(tryBrowserFetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries the static tier past a condensed render", async () => {
    staticRepliesAt(
      [],
      [{ html: CONDENSED_OPEN }, { html: OPEN_SPAN_VARIANT }],
    );

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toEqual({
      ok: true,
      value: {
        closed: false,
        applicants: "45 applicants",
        easyApply: false,
      },
    });
    expect(tryStaticFetchMock).toHaveBeenCalledTimes(2);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("falls to the browser only after three condensed draws", async () => {
    staticRepliesAt([], [{ html: CONDENSED_OPEN }]);
    tryBrowserFetchMock.mockResolvedValue({
      html: CLOSED_NO_BANNER,
      finalUrl: GUEST_URL,
    });

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toEqual({
      ok: true,
      value: {
        closed: true,
        applicants: null,
        easyApply: null,
      },
    });
    expect(tryStaticFetchMock).toHaveBeenCalledTimes(3);
    expect(tryBrowserFetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an authwall redirect to 502", async () => {
    staticRepliesAt([], [null]);
    tryBrowserFetchMock.mockResolvedValue({
      html: NOT_A_POSTING,
      finalUrl: "https://www.linkedin.com/authwall?trk=x",
    });

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toMatchObject({
      ok: false,
      error: { status: 502, code: "UPSTREAM_ERROR" },
    });
    // The wall is served to this IP, not to this posting — the module's own
    // header notes that a rate-limited IP falling to the browser tier lands
    // here, so it counts as machine-wide too.
    if (result.ok === false) {
      expect(isLinkedinBlockedError(result.error)).toBe(true);
    }
  });

  it("throws 422 when neither tier produced a posting page", async () => {
    staticRepliesAt([], [null]);
    tryBrowserFetchMock.mockResolvedValue({
      html: NOT_A_POSTING,
      finalUrl: GUEST_URL,
    });

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toMatchObject({
      ok: false,
      error: { status: 422, code: "UNPROCESSABLE_ENTITY" },
    });
    // One unreadable posting says nothing about the next one, so a sweep
    // must NOT treat this as a reason to stop.
    if (result.ok === false) {
      expect(isLinkedinBlockedError(result.error)).toBe(false);
    }
  });

  it("does not call a queue-pressure refusal a rate limit", async () => {
    // No 429 anywhere: the budget is simply too small for the paced queue to
    // reach this job. Same error class and status as a real rate limit, but
    // it is this caller's own crowding — marking it machine-wide would let
    // one impatient caller stop an unrelated sweep.
    const { getEffectiveSettings } = await import("./settings");
    vi.mocked(getEffectiveSettings).mockResolvedValueOnce({
      manualJobFetchTimeoutMs: { value: 0 },
      manualJobFetchBrowserSettleMs: { value: 0 },
    } as unknown as Awaited<ReturnType<typeof getEffectiveSettings>>);
    staticRepliesAt([], [{ html: OPEN_SPAN_VARIANT }]);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 10_000);
    expect(result).toMatchObject({
      ok: false,
      error: { status: 502, code: "UPSTREAM_ERROR" },
    });
    if (result.ok === false) {
      expect((result.error as Error).message).toMatch(/paced live-status/i);
      expect(isLinkedinBlockedError(result.error)).toBe(false);
    }
    expect(tryStaticFetchMock).not.toHaveBeenCalled();
  });

  it("maps a network throw from the static tier to 502", async () => {
    tryStaticFetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 0);
    expect(result).toMatchObject({
      ok: false,
      error: { status: 502, code: "UPSTREAM_ERROR" },
    });
  });

  it("maps an abort to 408", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    tryStaticFetchMock.mockRejectedValue(abortError);

    const result = await settled(fetchLinkedinLiveStatus(JOB_URL), 0);
    expect(result).toMatchObject({
      ok: false,
      error: { status: 408, code: "REQUEST_TIMEOUT" },
    });
  });

  it("recovers the id from sourceJobId when the URL path lacks one", async () => {
    staticRepliesAt([], [{ html: OPEN_SPAN_VARIANT }]);

    const result = await settled(
      fetchLinkedinLiveStatus(
        "https://www.linkedin.com/jobs/view/ai-developer",
        "li-4441896971",
      ),
      0,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        closed: false,
        applicants: "45 applicants",
        easyApply: false,
      },
    });
    expect(tryStaticFetchMock).toHaveBeenCalledWith(
      GUEST_URL,
      expect.any(AbortSignal),
      expect.anything(),
    );
  });

  it("honors a 429 backoff opened while another job was already sleeping", async () => {
    // The clobber case: job B's turn is mid-sleep (sized off the 1s spacing)
    // when job A's 429 opens the 5s window. B must re-read on wake and sit
    // the window out — not fetch into it and stamp the window away.
    const times: number[] = [];
    staticRepliesAt(times, [{ status: 429 }, { html: OPEN_SPAN_VARIANT }]);

    const a = fetchLinkedinLiveStatus(JOB_URL);
    const b = fetchLinkedinLiveStatus(JOB_URL);
    const outcomes = Promise.all([a, b]);
    await vi.advanceTimersByTimeAsync(30_000);
    const [resultA, resultB] = await outcomes;

    expect(resultA).toEqual({
      closed: false,
      applicants: "45 applicants",
      easyApply: false,
    });
    expect(resultB).toEqual({
      closed: false,
      applicants: "45 applicants",
      easyApply: false,
    });
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(5_000);
    expect(tryBrowserFetchMock).not.toHaveBeenCalled();
  });

  it("paces CONCURRENT jobs through one shared queue", async () => {
    const times: number[] = [];
    staticRepliesAt(times, [{ html: OPEN_SPAN_VARIANT }]);

    const a = fetchLinkedinLiveStatus(JOB_URL);
    const b = fetchLinkedinLiveStatus(JOB_URL);
    const outcomes = Promise.all([a, b]);
    await vi.advanceTimersByTimeAsync(5_000);
    await outcomes;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1_000);
  });
});

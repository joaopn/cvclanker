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
// jobPosting/<id>) on 2026-08-24 — two open-job caption variants and the
// closed-job figure, verbatim modulo trimming.
const TITLE_MARKUP = `<h2 class="top-card-layout__title font-sans text-lg topcard__title">AI Developer</h2>`;

const OPEN_FIGURE_VARIANT = `<html><body>${TITLE_MARKUP}
  <figure class="num-applicants__figure topcard__flavor--metadata topcard__flavor--bullet">
    <span class="num-applicants__icon num-applicants__icon--clock lazy-load"></span>
    <figcaption class="num-applicants__caption">
      Be among the first 25 applicants
    </figcaption>
  </figure>
</body></html>`;

const OPEN_SPAN_VARIANT = `<html><body>${TITLE_MARKUP}
  <span class="num-applicants__caption topcard__flavor--metadata topcard__flavor--bullet">
    45 applicants
  </span>
</body></html>`;

const CLOSED_MARKUP = `<html><body>${TITLE_MARKUP}
  <figure class="closed-job closed-job__flavor topcard__flavor-row">
    <span class="closed-job__icon closed-job__icon--error-pebble lazy-load"></span>
    <figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>
  </figure>
  <figure class="num-applicants__figure">
    <figcaption class="num-applicants__caption">Be among the first 25 applicants</figcaption>
  </figure>
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

  it("flags a closed job and nulls its (reset) applicant caption", () => {
    expect(parseLinkedinLiveStatus(CLOSED_MARKUP)).toEqual({
      closed: true,
      applicants: null,
    });
  });

  it("returns null for a page with no posting markup", () => {
    expect(parseLinkedinLiveStatus(NOT_A_POSTING)).toBeNull();
  });

  it("returns null for a title-only page rather than guessing 'open'", () => {
    // A posting-shaped page missing BOTH markers must not produce a verdict:
    // if LinkedIn renames the closed-figure class, closed jobs would
    // otherwise all be recorded as accepting applications.
    expect(
      parseLinkedinLiveStatus(`<html><body>${TITLE_MARKUP}</body></html>`),
    ).toBeNull();
  });

  it("ignores a closed-job class outside a figure (description markup)", () => {
    const html = `<html><body>${TITLE_MARKUP}
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

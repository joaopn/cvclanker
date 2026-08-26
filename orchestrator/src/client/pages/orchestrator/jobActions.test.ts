import { createJob } from "@shared/testing/factories.js";
import type { JobActionResponse } from "@shared/types.js";
import { describe, expect, it } from "vitest";
import {
  canClearScore,
  canDelete,
  canFetchLiveStatus,
  canMoveToReady,
  canRescore,
  canRescrape,
  canRetailor,
  canSkip,
  getFailedJobIds,
} from "./jobActions";

describe("jobActions", () => {
  it("computes eligibility for skip, move-to-ready, and rescore", () => {
    expect(
      canSkip([
        createJob({ id: "1", status: "discovered" }),
        createJob({ id: "2", status: "ready" }),
      ]),
    ).toBe(true);
    expect(canSkip([createJob({ id: "1", status: "applied" })])).toBe(false);

    expect(
      canMoveToReady([
        createJob({ id: "1", status: "discovered" }),
        createJob({ id: "2", status: "discovered" }),
      ]),
    ).toBe(true);
    expect(canMoveToReady([createJob({ id: "1", status: "ready" })])).toBe(
      false,
    );

    expect(
      canRescore([
        createJob({ id: "1", status: "discovered" }),
        createJob({ id: "2", status: "ready" }),
        createJob({ id: "3", status: "applied" }),
        createJob({ id: "4", status: "skipped" }),
        createJob({ id: "5", status: "closed" }),
      ]),
    ).toBe(true);
    expect(
      canRescore([
        createJob({ id: "1", status: "ready" }),
        createJob({ id: "2", status: "processing" }),
      ]),
    ).toBe(false);
  });

  it("offers clear-score only when something is actually scored", () => {
    const scored = createJob({
      id: "1",
      status: "discovered",
      suitabilityCategory: "good_fit",
    });
    const unscored = createJob({
      id: "2",
      status: "discovered",
      suitabilityCategory: null,
    });

    expect(canClearScore([scored])).toBe(true);
    // Mixed is still offered — the unscored rows are simply left alone.
    expect(canClearScore([scored, unscored])).toBe(true);
    // All-unscored would be a silent no-op, so the button stays hidden.
    expect(canClearScore([unscored])).toBe(false);
    expect(canClearScore([])).toBe(false);
    // A row mid-tailor is off limits, matching the server guard.
    expect(
      canClearScore([
        scored,
        createJob({
          id: "3",
          status: "processing",
          suitabilityCategory: "good_fit",
        }),
      ]),
    ).toBe(false);
  });

  it("treats a failed processing row as retryable and skippable, not a running one", () => {
    const failed = createJob({
      id: "f",
      status: "processing",
      tailoringFailureReason: "LLM provider error",
    });
    const running = createJob({ id: "r", status: "processing" });

    // Failed tailor (reason set) → can retry (move-to-ready) and can skip.
    expect(canMoveToReady([failed])).toBe(true);
    expect(canSkip([failed])).toBe(true);

    // Actively running (no reason) → neither.
    expect(canMoveToReady([running])).toBe(false);
    expect(canSkip([running])).toBe(false);

    // The per-row gate holds in a mixed selection.
    expect(
      canMoveToReady([createJob({ id: "d", status: "discovered" }), failed]),
    ).toBe(true);
    expect(
      canMoveToReady([createJob({ id: "d", status: "discovered" }), running]),
    ).toBe(false);
  });

  it("computes rescrape eligibility: not processing AND an http(s) URL", () => {
    // Non-processing rows with real http(s) URLs are rescrapable.
    expect(
      canRescrape([
        createJob({ id: "1", status: "discovered" }),
        createJob({ id: "2", status: "backlog" }),
        createJob({ id: "3", status: "stale" }),
        createJob({ id: "4", status: "closed" }),
      ]),
    ).toBe(true);

    // A processing row is excluded (mid-tailor).
    expect(
      canRescrape([
        createJob({ id: "1", status: "discovered" }),
        createJob({ id: "2", status: "processing" }),
      ]),
    ).toBe(false);

    // A synthetic manual:// URL (paste-JD job) is not rescrapable.
    expect(
      canRescrape([
        createJob({
          id: "1",
          status: "discovered",
          jobUrl: "manual://abc",
        }),
      ]),
    ).toBe(false);

    // Empty selection is never actionable.
    expect(canRescrape([])).toBe(false);
  });

  it("extracts failed job ids from an action response", () => {
    const response: JobActionResponse = {
      action: "skip",
      requested: 3,
      succeeded: 1,
      failed: 2,
      results: [
        {
          jobId: "job-1",
          ok: true,
          job: createJob({ id: "job-1", status: "skipped" }),
        },
        {
          jobId: "job-2",
          ok: false,
          error: { code: "INVALID_REQUEST", message: "bad status" },
        },
        {
          jobId: "job-3",
          ok: false,
          error: { code: "NOT_FOUND", message: "missing" },
        },
      ],
    };

    expect(Array.from(getFailedJobIds(response))).toEqual(["job-2", "job-3"]);
  });

  describe("canDelete", () => {
    it("allows every status a row can actually sit in", () => {
      for (const status of [
        "discovered",
        "ready",
        "applied",
        "in_progress",
        "backlog",
        "stale",
        "skipped",
        "closed",
      ] as const) {
        expect(canDelete([createJob({ id: "1", status })])).toBe(true);
      }
    });

    it("refuses a live tailor but allows a failed one", () => {
      const running = createJob({
        id: "1",
        status: "processing",
        tailoringFailureReason: null,
      });
      const failed = createJob({
        id: "2",
        status: "processing",
        tailoringFailureReason: "tectonic exited 1",
      });

      expect(canDelete([running])).toBe(false);
      expect(canDelete([failed])).toBe(true);
      // Mixed selection: one live tailor is enough to hide the button.
      expect(canDelete([failed, running])).toBe(false);
    });

    it("is false for an empty selection", () => {
      expect(canDelete([])).toBe(false);
    });
  });

  describe("canFetchLiveStatus", () => {
    it("allows a selection where every job has a LinkedIn posting id", () => {
      const bare = createJob({
        id: "1",
        jobUrl: "https://www.linkedin.com/jobs/view/4441896971",
      });
      const slugged = createJob({
        id: "2",
        jobUrl: "https://uk.linkedin.com/jobs/view/data-engineer-4383993915",
      });
      expect(canFetchLiveStatus([bare, slugged])).toBe(true);
    });

    it("allows a MIXED selection — the dispatcher acts on the LinkedIn subset", () => {
      const linkedin = createJob({
        id: "1",
        jobUrl: "https://www.linkedin.com/jobs/view/4441896971",
      });
      const other = createJob({
        id: "2",
        jobUrl: "https://example.com/jobs/123456",
      });
      expect(canFetchLiveStatus([linkedin, other])).toBe(true);
    });

    it("refuses when no selected job is a LinkedIn posting", () => {
      const other = createJob({
        id: "2",
        jobUrl: "https://example.com/jobs/123456",
      });
      expect(canFetchLiveStatus([other])).toBe(false);
    });

    it("is false for an empty selection", () => {
      expect(canFetchLiveStatus([])).toBe(false);
    });
  });

  describe("canRetailor", () => {
    it("allows a selection of already-tailored rows", () => {
      expect(
        canRetailor([
          createJob({ id: "1", status: "ready" }),
          createJob({ id: "2", status: "ready" }),
        ]),
      ).toBe(true);
    });

    it("allows a MIXED selection — the dispatcher acts on the eligible subset", () => {
      expect(
        canRetailor([
          createJob({ id: "1", status: "ready" }),
          createJob({ id: "2", status: "processing" }),
        ]),
      ).toBe(true);
    });

    // A failed tailor is not tailored, so Generate retries it in the same press
    // rather than making the user hunt it out separately afterwards.
    it("includes a FAILED tailor, which sits at processing with a reason", () => {
      expect(
        canRetailor([
          createJob({
            id: "1",
            status: "processing",
            tailoringFailureReason: "tectonic exited 1",
          }),
        ]),
      ).toBe(true);
    });

    // The one exclusion: a detached tailor is mid-write on this row. It is also
    // what makes a second press on an in-flight batch a no-op — the first press
    // cleared every reason, so each row it touched looks exactly like this.
    it("refuses a LIVE tailor, and anything off this tab", () => {
      expect(canRetailor([createJob({ id: "1", status: "processing" })])).toBe(
        false,
      );
      expect(canRetailor([createJob({ id: "3", status: "discovered" })])).toBe(
        false,
      );
    });

    // Re-tailoring one of these would flip it to `processing`, moving the row
    // out of its own tab — and the PDF there is the record of what was sent.
    // They cannot be selected on the Tailoring tab anyway.
    it("refuses rows that are past tailoring", () => {
      for (const status of ["applied", "in_progress", "closed"] as const) {
        expect(canRetailor([createJob({ id: status, status })])).toBe(false);
      }
    });

    it("is false for an empty selection", () => {
      expect(canRetailor([])).toBe(false);
    });
  });
});

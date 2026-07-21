import { createJob } from "@shared/testing/factories.js";
import type { JobActionResponse } from "@shared/types.js";
import { describe, expect, it } from "vitest";
import {
  canMoveToReady,
  canRescore,
  canRescrape,
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
});

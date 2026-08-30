import * as api from "@client/api";
import { createJob } from "@shared/testing/factories.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreJobStates, snapshotJob } from "./undo";

vi.mock("@client/api", () => ({ updateJob: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.updateJob).mockResolvedValue(
    createJob({ id: "x" }) as Awaited<ReturnType<typeof api.updateJob>>,
  );
});

describe("snapshotJob", () => {
  it("captures only the reversible triage fields", () => {
    const job = createJob({
      id: "j1",
      status: "applied",
      outcome: null,
      closedAt: null,
      appliedAt: "2026-05-01T09:00:00.000Z",
    });
    expect(snapshotJob(job)).toEqual({
      jobId: "j1",
      status: "applied",
      outcome: null,
      closedAt: null,
      appliedAt: "2026-05-01T09:00:00.000Z",
    });
  });

  /**
   * The mark is sticky and nothing else in the app can clear it, so undo has to
   * carry it. Capturing `null` is the load-bearing case: it is what lets
   * undoing a mis-pressed "Mark applied" put the row back to never-applied
   * instead of leaving a permanent Applied badge on it.
   */
  it("captures an absent applied mark as null", () => {
    const job = createJob({ id: "j2", status: "ready", appliedAt: null });

    expect(snapshotJob(job).appliedAt).toBeNull();
  });
});

describe("restoreJobStates", () => {
  it("PATCHes each snapshot back to its captured state", async () => {
    const result = await restoreJobStates([
      {
        jobId: "a",
        status: "discovered",
        outcome: null,
        closedAt: null,
        appliedAt: null,
      },
      {
        jobId: "b",
        status: "applied",
        outcome: "rejected",
        closedAt: 1700,
        appliedAt: "2026-05-01T09:00:00.000Z",
      },
    ]);

    expect(api.updateJob).toHaveBeenCalledTimes(2);
    // `a` restores appliedAt to null — undoing an apply must UNSET the mark,
    // which is the only path in the app that can.
    expect(api.updateJob).toHaveBeenCalledWith("a", {
      status: "discovered",
      outcome: null,
      closedAt: null,
      appliedAt: null,
    });
    expect(api.updateJob).toHaveBeenCalledWith("b", {
      status: "applied",
      outcome: "rejected",
      closedAt: 1700,
      appliedAt: "2026-05-01T09:00:00.000Z",
    });
    expect(result).toEqual({ restored: 2, failed: 0 });
  });

  it("reports partial failures without rejecting", async () => {
    vi.mocked(api.updateJob)
      .mockResolvedValueOnce(
        createJob({ id: "a" }) as Awaited<ReturnType<typeof api.updateJob>>,
      )
      .mockRejectedValueOnce(new Error("boom"));

    const result = await restoreJobStates([
      {
        jobId: "a",
        status: "discovered",
        outcome: null,
        closedAt: null,
        appliedAt: null,
      },
      {
        jobId: "b",
        status: "selected",
        outcome: null,
        closedAt: null,
        appliedAt: null,
      },
    ]);

    expect(result).toEqual({ restored: 1, failed: 1 });
  });
});

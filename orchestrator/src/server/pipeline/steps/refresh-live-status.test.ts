// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJobsForLiveStatusRefreshMock = vi.hoisted(() => vi.fn());
const updateJobMock = vi.hoisted(() => vi.fn());
const fetchLinkedinLiveStatusMock = vi.hoisted(() => vi.fn());
const liveStatusJobMock = vi.hoisted(() => vi.fn());
const getEffectiveSettingsMock = vi.hoisted(() => vi.fn());

// Factory-only mocks (no importActual): every one of these modules opens
// SQLite or playwright at module scope.
vi.mock("@server/repositories/jobs", () => ({
  getJobsForLiveStatusRefresh: getJobsForLiveStatusRefreshMock,
  updateJob: updateJobMock,
}));
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));
vi.mock("@server/services/live-status", () => ({
  fetchLinkedinLiveStatus: fetchLinkedinLiveStatusMock,
  // The real predicate is exercised in live-status.test.ts; here it only has
  // to tell the step which failures are machine-wide.
  isLinkedinBlockedError: (error: unknown) =>
    (error as { blocked?: boolean })?.blocked === true,
}));
vi.mock("../progress", () => ({
  progressHelpers: { liveStatusJob: liveStatusJobMock },
}));

import { refreshLiveStatusStep } from "./refresh-live-status";

const candidate = (id: string) => ({
  id,
  title: `Job ${id}`,
  jobUrl: `https://www.linkedin.com/jobs/view/43800000${id}`,
  sourceJobId: null,
});

const blocked = () =>
  Object.assign(new Error("LinkedIn says no"), {
    blocked: true,
  });

describe("refreshLiveStatusStep", () => {
  beforeEach(() => {
    // Seeded here, not left to each test: `resetAllMocks` below wipes
    // implementations as well as calls, so an unseeded mock would return
    // undefined and the step's own catch would turn that into a quiet
    // all-zero pass instead of a failure anyone could read.
    getJobsForLiveStatusRefreshMock.mockResolvedValue([]);
    getEffectiveSettingsMock.mockResolvedValue({
      liveStatusRefreshLimit: { value: 25 },
      // Deliberately NOT the registry default of 24: a step that hardcoded
      // the default, or read the wrong key, would satisfy an assertion made
      // against it.
      liveStatusRefreshMinAgeHours: { value: 7 },
    });
    updateJobMock.mockResolvedValue({});
    fetchLinkedinLiveStatusMock.mockResolvedValue({
      closed: false,
      applicants: "12 applicants",
    });
  });

  afterEach(() => {
    // reset, not clear: `clearAllMocks` keeps implementations AND unconsumed
    // `*Once` queues, so a test that queues a rejection the step never reaches
    // would hand it to whichever test ran next.
    vi.resetAllMocks();
  });

  it("asks for the configured number of rows and writes what it reads", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
    ]);
    fetchLinkedinLiveStatusMock
      .mockResolvedValueOnce({ closed: false, applicants: "12 applicants" })
      .mockResolvedValueOnce({ closed: true, applicants: null });

    const result = await refreshLiveStatusStep({});

    // Both knobs, not just the cap: the floor is what stops the run re-reading
    // rows it read an hour ago, so a step that dropped it would look correct
    // in every single-run assertion and only misbehave on the second run.
    expect(getJobsForLiveStatusRefreshMock).toHaveBeenCalledWith(25, 7);
    expect(result).toEqual({ checked: 2, failed: 0, closed: 1, unchecked: 0 });
    expect(updateJobMock).toHaveBeenNthCalledWith(1, "1", {
      liveClosed: false,
      liveApplicants: "12 applicants",
      liveStatusCheckedAt: expect.any(String),
    });
    expect(updateJobMock).toHaveBeenNthCalledWith(2, "2", {
      liveClosed: true,
      liveApplicants: null,
      liveStatusCheckedAt: expect.any(String),
    });
  });

  it("does nothing at all when there is nothing to check", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([]);

    const result = await refreshLiveStatusStep({});

    expect(result).toEqual({ checked: 0, failed: 0, closed: 0, unchecked: 0 });
    expect(fetchLinkedinLiveStatusMock).not.toHaveBeenCalled();
    expect(liveStatusJobMock).not.toHaveBeenCalled();
  });

  it("skips a posting that fails and keeps going", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
      candidate("3"),
    ]);
    fetchLinkedinLiveStatusMock.mockImplementation(async (url: string) =>
      url.endsWith("2")
        ? Promise.reject(new Error("that page did not parse"))
        : { closed: false, applicants: null },
    );

    const result = await refreshLiveStatusStep({});

    expect(result).toEqual({ checked: 2, failed: 1, closed: 0, unchecked: 0 });
    expect(updateJobMock).toHaveBeenCalledTimes(2);
  });

  it("stops the sweep when LinkedIn refuses the machine", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
      candidate("3"),
    ]);
    fetchLinkedinLiveStatusMock
      .mockResolvedValueOnce({ closed: false, applicants: null })
      .mockRejectedValueOnce(blocked());

    const result = await refreshLiveStatusStep({});

    // Row 3 is never attempted: the refusal is per-IP, so the rest of the
    // list would only re-prove it while adding heat.
    expect(fetchLinkedinLiveStatusMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 1, failed: 1, closed: 0, unchecked: 1 });
  });

  it("stops when the run is cancelled", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
      candidate("3"),
    ]);
    let cancelled = false;
    fetchLinkedinLiveStatusMock.mockImplementation(async () => {
      cancelled = true;
      return { closed: false, applicants: null };
    });

    const result = await refreshLiveStatusStep({
      shouldCancel: () => cancelled,
    });

    expect(fetchLinkedinLiveStatusMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, failed: 0, closed: 0, unchecked: 2 });
  });

  it("does not count a row that vanished under the write", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
    ]);
    // updateJob answers null when the row is gone between the query and the
    // write; nothing was stored, so counting it as checked would overstate
    // what the run refreshed.
    updateJobMock.mockResolvedValueOnce(null).mockResolvedValueOnce({});

    const result = await refreshLiveStatusStep({});

    expect(result).toEqual({ checked: 1, failed: 1, closed: 0, unchecked: 0 });
  });

  it("never throws, whatever fails around the postings", async () => {
    // The orchestrator calls this step outside its own try/catch guard for
    // per-step failures, so a throw here marks a run FAILED that scraped,
    // imported and scored perfectly well.
    getEffectiveSettingsMock.mockRejectedValueOnce(new Error("db is gone"));
    await expect(refreshLiveStatusStep({})).resolves.toEqual({
      checked: 0,
      failed: 0,
      closed: 0,
      unchecked: 0,
    });

    getJobsForLiveStatusRefreshMock.mockRejectedValueOnce(
      new Error("query blew up"),
    );
    await expect(refreshLiveStatusStep({})).resolves.toMatchObject({
      checked: 0,
    });

    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
    ]);
    liveStatusJobMock.mockImplementationOnce(() => {
      throw new Error("progress emit blew up");
    });
    // Abandoned mid-row, so the row it was on is UNCHECKED, not silently
    // dropped: `checked + failed + unchecked` has to equal what was picked, or
    // the log cannot be read as an account of the run. Deriving `unchecked`
    // from the loop index instead loses exactly this row.
    await expect(refreshLiveStatusStep({})).resolves.toEqual({
      checked: 0,
      failed: 0,
      closed: 0,
      unchecked: 2,
    });
  });

  it("reports progress per row so a multi-minute step is not a silent gap", async () => {
    getJobsForLiveStatusRefreshMock.mockResolvedValue([
      candidate("1"),
      candidate("2"),
    ]);

    await refreshLiveStatusStep({});

    expect(liveStatusJobMock).toHaveBeenNthCalledWith(1, 1, 2, "Job 1");
    expect(liveStatusJobMock).toHaveBeenNthCalledWith(2, 2, 2, "Job 2");
  });
});

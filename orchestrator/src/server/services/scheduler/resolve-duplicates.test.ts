// @vitest-environment node
import type { DuplicateJobGroup, JobListItem } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDuplicateGroups = vi.fn();
const updateJob = vi.fn().mockResolvedValue({ id: "x" });
vi.mock("@server/repositories/jobs", () => ({
  getDuplicateGroups: () => getDuplicateGroups(),
  updateJob: (id: string, updates: unknown) => updateJob(id, updates),
}));

const getEffectiveSettings = vi.fn();
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: () => getEffectiveSettings(),
}));

import {
  getJobActionBatches,
  resetJobActionBatchesForTests,
} from "@server/services/job-actions/batch-store";
import { resolveDuplicatesForSchedule } from "./resolve-duplicates";

const job = (overrides: Partial<JobListItem> = {}): JobListItem =>
  ({
    id: "job-1",
    title: "Backend Engineer",
    employer: "Acme",
    status: "discovered",
    suitabilityCategory: null,
    datePosted: "2026-08-01T00:00:00.000Z",
    discoveredAt: "2026-08-01T00:00:00.000Z",
    tailoringFailureReason: null,
    ...overrides,
  }) as JobListItem;

const group = (
  jobs: JobListItem[],
  overrides: Partial<DuplicateJobGroup> = {},
): DuplicateJobGroup =>
  ({
    key: `key-${jobs[0]?.id}`,
    jobs,
    bulkSafe: true,
    ...overrides,
  }) as DuplicateJobGroup;

describe("automatic duplicate resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The store is a module singleton; without this a file's batches leak into
    // each other's assertions.
    resetJobActionBatchesForTests();
    updateJob.mockResolvedValue({ id: "x" });
    getEffectiveSettings.mockResolvedValue({
      maxBulkActionJobs: { value: 1000 },
    });
  });

  it("closes every copy but the keeper", async () => {
    getDuplicateGroups.mockResolvedValue([
      group([
        job({ id: "keep", status: "ready" }),
        job({ id: "loser-a" }),
        job({ id: "loser-b" }),
      ]),
    ]);

    expect(await resolveDuplicatesForSchedule()).toBe(2);
    const closed = updateJob.mock.calls.map((call) => call[0]);
    // Furthest along the pipeline wins, exactly as the review wizard preselects.
    expect(closed.sort()).toEqual(["loser-a", "loser-b"]);
    expect(updateJob).toHaveBeenCalledWith(
      "loser-a",
      expect.objectContaining({ status: "closed", outcome: "duplicated" }),
    );
  });

  it("leaves a group whose copies disagree about the title for a human", async () => {
    getDuplicateGroups.mockResolvedValue([
      group([job({ id: "a" }), job({ id: "b" })], { bulkSafe: false }),
    ]);

    // The standing rule everywhere else: prefer extra duplicates over
    // incorrectly joining two jobs. There is no server-side undo.
    expect(await resolveDuplicatesForSchedule()).toBe(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("skips a group holding a tailor that is running right now", async () => {
    getDuplicateGroups.mockResolvedValue([
      group([
        job({ id: "keep", status: "ready" }),
        job({ id: "live", status: "processing", tailoringFailureReason: null }),
      ]),
    ]);

    // `runProcessJob` writes `ready` when it finishes, with no status guard, so
    // a row closed mid-tailor comes back a minute later and the close silently
    // undoes itself.
    expect(await resolveDuplicatesForSchedule()).toBe(0);
    expect(updateJob).not.toHaveBeenCalled();
  });

  it("still closes a group whose only processing row is a FAILED tailor", async () => {
    getDuplicateGroups.mockResolvedValue([
      group([
        job({ id: "keep", status: "ready" }),
        job({
          id: "failed-tailor",
          status: "processing",
          tailoringFailureReason: "boom",
        }),
      ]),
    ]);

    // A reason means the run is over. Same distinction `delete` and the stale
    // sweep make: the status alone does not say whether anything is in flight.
    expect(await resolveDuplicatesForSchedule()).toBe(1);
  });

  it("never splits a group across batches", async () => {
    getEffectiveSettings.mockResolvedValue({
      maxBulkActionJobs: { value: 3 },
    });
    getDuplicateGroups.mockResolvedValue([
      group([job({ id: "k1", status: "ready" }), job({ id: "l1" })]),
      group([
        job({ id: "k2", status: "ready" }),
        job({ id: "l2" }),
        job({ id: "l3" }),
        job({ id: "l4" }),
      ]),
    ]);

    expect(await resolveDuplicatesForSchedule()).toBe(4);

    // The COUNT alone cannot show this — it is the same whether the cap is
    // honoured or ignored. Half a closed group leaves copies that no longer
    // read as duplicates to anyone, so the second group must start a new
    // batch whole rather than filling the first to the cap.
    const batches = getJobActionBatches()
      .filter((batch) => batch.action === "mark_duplicated")
      .map((batch) => batch.requested)
      .sort();
    expect(batches).toEqual([1, 3]);
  });

  it("carries on when one row cannot be closed", async () => {
    getDuplicateGroups.mockResolvedValue([
      group([
        job({ id: "keep", status: "ready" }),
        job({ id: "bad" }),
        job({ id: "good" }),
      ]),
    ]);
    updateJob.mockRejectedValueOnce(new Error("row vanished"));

    // One unclosable row must not abandon the rest of the sweep.
    expect(await resolveDuplicatesForSchedule()).toBe(1);
  });

  it("does nothing when there is nothing to sweep", async () => {
    getDuplicateGroups.mockResolvedValue([]);
    expect(await resolveDuplicatesForSchedule()).toBe(0);
  });
});

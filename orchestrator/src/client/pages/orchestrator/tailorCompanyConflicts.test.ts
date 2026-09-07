import { createJob } from "@shared/testing/factories";
import type { JobListItem, JobStatus } from "@shared/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCompanyConflicts,
  IN_FLIGHT_STATUSES,
  nonConflictingIds,
  type TailorCandidate,
  tailorApproved,
} from "./tailorCompanyConflicts";

const candidate = (id: string, employer: string): TailorCandidate => ({
  id,
  employer,
});

const inFlightJob = (
  id: string,
  employer: string,
  status: JobStatus = "applied",
): JobListItem => createJob({ id, employer, status });

/**
 * A failed tailor: `processing` with a reason set. The one row that is both in
 * flight AND a legitimate Tailor target (`canMoveToReady` admits it as the
 * retry), so it is what the self/sibling exclusions actually have to survive.
 */
const failedTailor = (id: string, employer: string): JobListItem =>
  createJob({
    id,
    employer,
    status: "processing",
    tailoringFailureReason: "tectonic exited 1",
  });

describe("IN_FLIGHT_STATUSES", () => {
  it("is exactly the four unconcluded working statuses", () => {
    expect([...IN_FLIGHT_STATUSES]).toEqual([
      "processing",
      "ready",
      "applied",
      "in_progress",
    ]);
  });

  it("excludes the shelves and the concluded statuses", () => {
    for (const status of [
      "discovered",
      "backlog",
      "stale",
      "skipped",
      "closed",
    ] as const) {
      expect(IN_FLIGHT_STATUSES).not.toContain(status);
    }
  });
});

describe("buildCompanyConflicts", () => {
  it("returns nothing when no employer overlaps", () => {
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme")],
      [inFlightJob("x", "Globex")],
    );
    expect(groups).toEqual([]);
  });

  it("groups a candidate with the in-flight rows at its employer", () => {
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme")],
      [inFlightJob("x", "Acme"), inFlightJob("y", "Globex")],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].employer).toBe("Acme");
    expect(groups[0].candidates.map((c) => c.id)).toEqual(["a"]);
    expect(groups[0].inFlight.map((j) => j.id)).toEqual(["x"]);
  });

  it("matches employers case- and whitespace-insensitively", () => {
    const groups = buildCompanyConflicts(
      [candidate("a", "  acme CORP ")],
      [inFlightJob("x", "Acme Corp")],
    );
    expect(groups).toHaveLength(1);
    // The candidate's own spelling is what the dialog shows, trimmed.
    expect(groups[0].employer).toBe("acme CORP");
  });

  it("does not treat a near-miss spelling as the same company", () => {
    // Deliberate: an exact rule under-blocks VISIBLY, a fuzzy one hides a real
    // second opening. Same direction as the blocked-companies rule.
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme")],
      [inFlightJob("x", "Acme Inc."), inFlightJob("y", "Acme GmbH")],
    );
    expect(groups).toEqual([]);
  });

  it("never conflicts a job with itself", () => {
    // Retrying a failed tailor must not warn about the row being retried.
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme")],
      [failedTailor("a", "Acme")],
    );
    expect(groups).toEqual([]);
  });

  it("does not conflict two selected jobs with each other", () => {
    // Both are "what this press is about to do", not "what is already running".
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme"), candidate("b", "Acme")],
      [failedTailor("a", "Acme"), failedTailor("b", "Acme")],
    );
    expect(groups).toEqual([]);
  });

  it("still reports the rows a selected sibling does not account for", () => {
    const groups = buildCompanyConflicts(
      [candidate("a", "Acme"), candidate("b", "Acme")],
      [failedTailor("a", "Acme"), inFlightJob("z", "Acme", "applied")],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates.map((c) => c.id)).toEqual(["a", "b"]);
    expect(groups[0].inFlight.map((j) => j.id)).toEqual(["z"]);
  });

  it("never matches two jobs on a blank employer", () => {
    // Both sides blank is the only shape that can produce a false match: an
    // empty name is unknown, not a company two rows have in common.
    expect(
      buildCompanyConflicts([candidate("a", "   ")], [inFlightJob("x", "")]),
    ).toEqual([]);
  });

  it("keeps groups and candidates in the selection's order", () => {
    const groups = buildCompanyConflicts(
      [
        candidate("b", "Globex"),
        candidate("a", "Acme"),
        candidate("c", "Globex"),
      ],
      [inFlightJob("x", "Acme"), inFlightJob("y", "Globex")],
    );
    expect(groups.map((g) => g.employer)).toEqual(["Globex", "Acme"]);
    expect(groups[0].candidates.map((c) => c.id)).toEqual(["b", "c"]);
  });
});

describe("nonConflictingIds", () => {
  it("returns every id when nothing conflicts", () => {
    const candidates = [candidate("a", "Acme"), candidate("b", "Globex")];
    expect(nonConflictingIds(candidates, [])).toEqual(["a", "b"]);
  });

  it("drops only the ids a group claims, preserving order", () => {
    const candidates = [
      candidate("a", "Acme"),
      candidate("b", "Globex"),
      candidate("c", "Acme"),
    ];
    const groups = buildCompanyConflicts(candidates, [
      inFlightJob("x", "Acme"),
    ]);
    expect(nonConflictingIds(candidates, groups)).toEqual(["b"]);
  });
});

describe("tailorApproved", () => {
  const job = candidate("a", "Acme");

  it("passes the single job through as a one-element selection", async () => {
    const confirmTailor = vi.fn().mockResolvedValue(["a"]);
    await tailorApproved(confirmTailor, job);
    expect(confirmTailor).toHaveBeenCalledWith([job]);
  });

  it("approves when the guard returns the job", async () => {
    expect(await tailorApproved(vi.fn().mockResolvedValue(["a"]), job)).toBe(
      true,
    );
  });

  it("refuses on an explicit cancel", async () => {
    expect(await tailorApproved(vi.fn().mockResolvedValue(null), job)).toBe(
      false,
    );
  });

  it("refuses on an EMPTY approval, not just on null", async () => {
    // "Tailor the other N" approves nothing when everything conflicts; a caller
    // checking only for null would tailor anyway.
    expect(await tailorApproved(vi.fn().mockResolvedValue([]), job)).toBe(
      false,
    );
  });
});

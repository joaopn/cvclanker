import { createJob } from "@shared/testing/factories.js";
import type { JobStatus } from "@shared/types.js";
import { describe, expect, it } from "vitest";
import {
  type CommandBarLock,
  computeJobMatchScore,
  getLockMatchesFromAliasPrefix,
  groupJobsForCommandBar,
  jobMatchesLock,
  lockTokens,
  resolveLockFromAliasPrefix,
} from "./JobCommandBar.utils";

describe("JobCommandBar score helpers", () => {
  it("returns zero when no title, employer, or location matches", () => {
    const score = computeJobMatchScore(
      createJob({
        title: "Backend Engineer",
        employer: "Acme",
        location: "London",
      }),
      "kubernetes",
    );

    expect(score).toBe(0);
  });

  // Which rows answer the query is the server's decision now; the grouping
  // only orders what it is given, and must not drop a row the server chose.
  it("orders the rows it is given by score, then newest, dropping none", () => {
    const grouped = groupJobsForCommandBar(
      [
        createJob({
          id: "no-score",
          title: "Visual Designer",
          employer: "Studio Co",
          discoveredAt: "2025-02-01T00:00:00Z",
        }),
        createJob({
          id: "prefix",
          title: "Backender Engineer",
          employer: "Platform Co",
          discoveredAt: "2025-01-02T00:00:00Z",
        }),
        createJob({
          id: "exact",
          title: "Backend",
          employer: "Infra Co",
          discoveredAt: "2025-01-01T00:00:00Z",
        }),
      ],
      "backend",
    );

    expect(grouped.ready.map((job) => job.id)).toEqual([
      "exact",
      "prefix",
      "no-score",
    ]);
  });

  it("orders by newest alone when there is no query", () => {
    const grouped = groupJobsForCommandBar(
      [
        createJob({ id: "older", discoveredAt: "2025-01-01T00:00:00Z" }),
        createJob({ id: "newer", discoveredAt: "2025-02-01T00:00:00Z" }),
      ],
      "",
    );

    expect(grouped.ready.map((job) => job.id)).toEqual(["newer", "older"]);
  });

  it("scores a location across diacritic spellings", () => {
    // The server matches "malaga" to Málaga; the ordering has to agree, or
    // the row it matched sinks below rows that merely share letters.
    const job = createJob({
      title: "Research Scientist",
      employer: "Acme",
      location: "Málaga, Andalusia, Spain",
    });
    expect(computeJobMatchScore(job, "malaga")).toBeGreaterThan(0);
    expect(computeJobMatchScore(job, "málaga")).toBeGreaterThan(0);
    expect(computeJobMatchScore(job, "barcelona")).toBe(0);
    // Title and employer ride the same scorer.
    expect(
      computeJobMatchScore(
        createJob({ title: "Ingénieur Logiciel", employer: "Acme" }),
        "ingenieur",
      ),
    ).toBeGreaterThan(0);
  });
});

describe("JobCommandBar locks", () => {
  it("offers every lock for a bare @, with ever-applied last", () => {
    // Order is user-visible twice: it is the order the suggestions render in,
    // and `@` + Enter applies whichever is first. Appending keeps both answers
    // where they were.
    expect(getLockMatchesFromAliasPrefix("")).toEqual([
      "ready",
      "discovered",
      "applied",
      "in_progress",
      "skipped",
      "ever_applied",
    ]);
  });

  it("resolves the ever-applied aliases", () => {
    for (const token of [
      "e",
      "ev",
      "ever",
      "ever-",
      "everapplied",
      "ever-applied",
    ]) {
      expect(resolveLockFromAliasPrefix(token)).toBe("ever_applied");
    }
  });

  it("leaves the applied aliases resolving to the status lock", () => {
    // `resolveLockFromAliasPrefix` refuses a token that prefixes more than one
    // lock, so naming the new lock "applied-ever" would have made all three of
    // these ambiguous and silently stopped Tab completing them.
    for (const token of ["app", "appl", "apply", "applied"]) {
      expect(resolveLockFromAliasPrefix(token)).toBe("applied");
    }
  });

  it("matches every job carrying the permanent applied mark, whatever its status", () => {
    const applied = "2025-03-01T00:00:00Z";
    const cases: Array<[JobStatus, string | null, boolean]> = [
      ["applied", applied, true],
      ["in_progress", applied, true],
      ["closed", applied, true],
      ["skipped", applied, true],
      ["ready", applied, true],
      ["closed", null, false],
      ["skipped", null, false],
      ["ready", null, false],
      ["discovered", null, false],
    ];

    for (const [status, appliedAt, expected] of cases) {
      expect(
        jobMatchesLock(createJob({ status, appliedAt }), "ever_applied"),
      ).toBe(expected);
    }
  });

  it("matches nothing, not everything, for a lock it does not know", () => {
    // Only reachable with a cast — every caller resolves a lock through
    // `lockAliases`. Pinned because this line was first written returning the
    // lock itself, which is a non-empty string and therefore matched EVERY
    // job: the opposite of the if-chain it replaced, and invisible to tsc.
    expect(
      jobMatchesLock(
        createJob({ appliedAt: "2025-03-01T00:00:00Z" }),
        "bogus" as CommandBarLock,
      ),
    ).toBe(false);
  });

  it("gives the non-status lock a colour no status lock wears", () => {
    // The Record is exhaustive so tsc forces an ENTRY, but nothing type-level
    // stops that entry being empty or a copy of a status's — and the whole
    // claim is that a filter which is not a status must not look like one.
    //
    // Each loop catches a different thing, and only for `ever_applied`: the
    // first is the only assertion that fails when its badge or dot is empty
    // (an empty string is still `not.toBe` every status token, so the second
    // loop sails past it), and the second is the only one that fails when it
    // is a copy. The five status iterations of the first loop are vacuous —
    // those locks ARE their status tokens, which cannot go empty without
    // breaking every status badge in the app. Nothing compares one status lock
    // against another because two of them (ready, applied) are deliberately
    // identical.
    const statusLocks = [
      "ready",
      "discovered",
      "applied",
      "in_progress",
      "skipped",
    ] as const;

    for (const lock of [...statusLocks, "ever_applied"] as const) {
      expect(lockTokens[lock].badge).not.toBe("");
      expect(lockTokens[lock].dot).not.toBe("");
    }

    for (const lock of statusLocks) {
      expect(lockTokens.ever_applied.badge).not.toBe(lockTokens[lock].badge);
      expect(lockTokens.ever_applied.dot).not.toBe(lockTokens[lock].dot);
    }
  });

  it("keeps the status locks reading the status, not the mark", () => {
    // A closed job that was applied for is the case the two locks disagree
    // on, and the reason both exist.
    const closedButApplied = createJob({
      status: "closed",
      appliedAt: "2025-03-01T00:00:00Z",
    });
    expect(jobMatchesLock(closedButApplied, "applied")).toBe(false);
    expect(jobMatchesLock(closedButApplied, "ever_applied")).toBe(true);

    const liveApplication = createJob({
      status: "applied",
      appliedAt: "2025-03-01T00:00:00Z",
    });
    expect(jobMatchesLock(liveApplication, "applied")).toBe(true);
    expect(jobMatchesLock(liveApplication, "ever_applied")).toBe(true);
  });
});

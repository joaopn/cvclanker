import { createAppSettings, createJob } from "@shared/testing/factories.js";
import {
  defaultProfileConfig,
  type Job,
  type JobListItem,
  type Profile,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import type { SortDirection, SortKey } from "./constants";
import {
  applicantsSortRank,
  collectProfileSearchTitles,
  compareJobs,
  easyApplySortRank,
  formatCheckedAge,
  getEnabledSources,
  getJobCountsFromStats,
  parseLiveApplicants,
} from "./utils";

const profile = (id: string, searchTerms: string[]): Profile => ({
  id,
  name: id,
  config: { ...defaultProfileConfig(), searchTerms },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("collectProfileSearchTitles", () => {
  it("unions every profile's terms, deduped case-insensitively (first spelling wins), sorted", () => {
    expect(
      collectProfileSearchTitles([
        profile("a", ["Python Developer", "  ", "SRE"]),
        profile("b", ["python developer", "Backend Engineer"]),
      ]),
    ).toEqual(["Backend Engineer", "Python Developer", "SRE"]);
  });

  it("returns an empty list with no profiles", () => {
    expect(collectProfileSearchTitles([])).toEqual([]);
  });
});

describe("orchestrator utils", () => {
  it("enables startupjobs without credentials", () => {
    expect(getEnabledSources(createAppSettings())).toContain("startupjobs");
  });

  it("enables workingnomads without credentials", () => {
    expect(getEnabledSources(createAppSettings())).toContain("workingnomads");
  });

  it("maps by-status stats to tab counts including the `discovered` alias", () => {
    expect(
      getJobCountsFromStats({
        discovered: 1,
        selected: 1,
        processing: 1,
        ready: 1,
        applied: 1,
        in_progress: 1,
        backlog: 1,
        stale: 1,
        skipped: 1,
        closed: 1,
      }),
    ).toEqual({
      inbox: 1,
      tailoring: 2, // processing + ready
      live: 1, // applied
      interviewing: 1, // in_progress
      backlog: 1,
      stale: 1,
      closed: 2, // skipped + closed
      all: 10, // a stray legacy `selected` row counts only here
      discovered: 1, // legacy alias for inbox
    });
  });
});

describe("formatCheckedAge", () => {
  const now = Date.parse("2026-08-24T10:00:00.000Z");

  it("reads the same day as today and older checks in whole days", () => {
    expect(formatCheckedAge("2026-08-24T01:00:00.000Z", now)).toBe(
      "checked today",
    );
    expect(formatCheckedAge("2026-08-21T10:00:00.000Z", now)).toBe(
      "checked 3d ago",
    );
  });

  it("coerces an all-digit Unix-ms timestamp like every other date read", () => {
    expect(formatCheckedAge(String(now - 2 * 24 * 60 * 60 * 1000), now)).toBe(
      "checked 2d ago",
    );
  });

  it("returns null when the row was never checked", () => {
    expect(formatCheckedAge(null, now)).toBeNull();
    expect(formatCheckedAge("not a date", now)).toBeNull();
  });
});

describe("parseLiveApplicants", () => {
  it("reads LinkedIn's caption shapes into a count", () => {
    expect(parseLiveApplicants("45 applicants")).toBe(45);
    expect(parseLiveApplicants("1,204 applicants")).toBe(1204);
    expect(parseLiveApplicants("  7 Applicants ")).toBe(7);
  });

  it("puts 'Be among the first N' at zero — LinkedIn shows it instead of any count below N", () => {
    expect(parseLiveApplicants("Be among the first 25 applicants")).toBe(0);
  });

  it("reads 'Over N' and 'N+' as at least N + 1", () => {
    expect(parseLiveApplicants("Over 200 applicants")).toBe(201);
    expect(parseLiveApplicants("200+ applicants")).toBe(201);
  });

  it("returns null for anything that is not a count", () => {
    expect(parseLiveApplicants(null)).toBeNull();
    expect(parseLiveApplicants("")).toBeNull();
    expect(parseLiveApplicants("Accepting applications")).toBeNull();
    expect(parseLiveApplicants("applicants")).toBeNull();
    // Every branch keys on the "applicants" tail — a number about anything
    // else is not a count.
    expect(parseLiveApplicants("Over 100 people clicked apply")).toBeNull();
    expect(parseLiveApplicants("first 3 to apply")).toBeNull();
  });
});

describe("compareJobs applicants", () => {
  const linkedin = (id: string, overrides: Partial<Job> = {}): JobListItem =>
    createJob({
      id,
      jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
      liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
      datePosted: "2026-08-01T00:00:00.000Z",
      ...overrides,
    });

  const twelve = linkedin("4000000012", {
    liveClosed: false,
    liveApplicants: "12 applicants",
  });
  const three = linkedin("4000000003", {
    liveClosed: false,
    liveApplicants: "3 applicants",
  });
  const first25 = linkedin("4000000025", {
    liveClosed: false,
    liveApplicants: "Be among the first 25 applicants",
  });
  const unchecked = linkedin("4000000099", {
    liveClosed: null,
    liveApplicants: null,
    liveStatusCheckedAt: null,
  });
  const closed = linkedin("4000000098", {
    liveClosed: true,
    liveApplicants: null,
  });
  const indeed = createJob({
    id: "indeed-1",
    source: "indeed",
    jobUrl: "https://www.indeed.com/viewjob?jk=abc123",
    datePosted: "2026-08-20T00:00:00.000Z",
  });

  const order = (jobs: JobListItem[], direction: SortDirection) =>
    [...jobs]
      .sort((a, b) => compareJobs(a, b, { key: "applicants", direction }))
      .map((job) => job.id);

  it("ranks rows into tiers: counted, unchecked LinkedIn, closed LinkedIn, non-LinkedIn", () => {
    expect(applicantsSortRank(twelve)).toEqual({ tier: 0, count: 12 });
    expect(applicantsSortRank(unchecked)).toEqual({ tier: 1, count: null });
    expect(applicantsSortRank(closed)).toEqual({ tier: 2, count: null });
    expect(applicantsSortRank(indeed)).toEqual({ tier: 3, count: null });
  });

  it("ranks on the row's data before the URL shape", () => {
    // A slug URL under /jobs/view/ carries no id the client can see, but the
    // server resolves the posting through `sourceJobId` and writes the row
    // all the same — its count or verdict is what places it, not whether
    // the URL shows the id.
    const slugCounted = createJob({
      id: "slug-counted",
      jobUrl: "https://www.linkedin.com/jobs/view/senior-engineer-at-acme",
      sourceJobId: "li-4383255214",
      liveClosed: false,
      liveApplicants: "9 applicants",
      liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
    });
    const slugClosed = createJob({
      id: "slug-closed",
      jobUrl: "https://www.linkedin.com/jobs/view/senior-engineer-at-acme",
      sourceJobId: "li-4383255214",
      liveClosed: true,
      liveApplicants: null,
      liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
    });
    expect(applicantsSortRank(slugCounted)).toEqual({ tier: 0, count: 9 });
    expect(applicantsSortRank(slugClosed)).toEqual({ tier: 2, count: null });
  });

  it("orders fewest applicants first, then the count-less tiers, non-LinkedIn last", () => {
    expect(
      order([indeed, closed, twelve, unchecked, first25, three], "asc"),
    ).toEqual([
      "4000000025",
      "4000000003",
      "4000000012",
      "4000000099",
      "4000000098",
      "indeed-1",
    ]);
  });

  it("flips only the counted rows when the direction flips — the count-less tiers stay at the bottom", () => {
    expect(
      order([indeed, closed, twelve, unchecked, first25, three], "desc"),
    ).toEqual([
      "4000000012",
      "4000000003",
      "4000000025",
      "4000000099",
      "4000000098",
      "indeed-1",
    ]);
  });

  it("breaks ties newest posted / found first, whatever the direction", () => {
    const olderUnchecked = linkedin("4000000001", {
      liveClosed: null,
      liveApplicants: null,
      liveStatusCheckedAt: null,
      datePosted: "2026-07-01T00:00:00.000Z",
    });
    const newerUnchecked = linkedin("4000000002", {
      liveClosed: null,
      liveApplicants: null,
      liveStatusCheckedAt: null,
      datePosted: "2026-08-15T00:00:00.000Z",
    });
    // No datePosted: falls back to discoveredAt, like the row's pill.
    const foundToday = linkedin("4000000000", {
      liveClosed: null,
      liveApplicants: null,
      liveStatusCheckedAt: null,
      datePosted: null,
      discoveredAt: "2026-08-25T00:00:00.000Z",
    });
    const sameCountOlder = linkedin("4000000011", {
      liveClosed: false,
      liveApplicants: "12 applicants",
      datePosted: "2026-07-01T00:00:00.000Z",
    });

    for (const direction of ["asc", "desc"] as const) {
      expect(
        order(
          [olderUnchecked, sameCountOlder, foundToday, twelve, newerUnchecked],
          direction,
        ),
      ).toEqual([
        "4000000012",
        "4000000011",
        "4000000000",
        "4000000002",
        "4000000001",
      ]);
    }
  });
});

describe("compareJobs easyApplyApplicants", () => {
  const linkedin = (id: string, overrides: Partial<Job> = {}): JobListItem =>
    createJob({
      id,
      jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
      liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
      liveClosed: false,
      datePosted: "2026-08-01T00:00:00.000Z",
      ...overrides,
    });

  // Ids run backwards through the expected order, so nothing below can pass on
  // `compareJobs`' id tiebreak alone.
  const easyFew = linkedin("7000000007", {
    liveEasyApply: true,
    liveApplicants: "3 applicants",
  });
  const easyLots = linkedin("7000000006", {
    liveEasyApply: true,
    liveApplicants: "300 applicants",
  });
  // Checked and open, but LinkedIn rendered no applicant caption: an Easy
  // Apply row with no count, i.e. applicant tier 1 inside group 0.
  const easyNoCount = linkedin("7000000005", {
    liveEasyApply: true,
    liveApplicants: null,
  });
  const offsiteTwo = linkedin("7000000004", {
    liveEasyApply: false,
    liveApplicants: "2 applicants",
  });
  const unchecked = linkedin("7000000003", {
    liveClosed: null,
    liveEasyApply: null,
    liveApplicants: null,
    liveStatusCheckedAt: null,
  });
  const closed = linkedin("7000000002", {
    liveClosed: true,
    liveEasyApply: null,
    liveApplicants: null,
  });
  const indeed = createJob({
    id: "indeed-2",
    source: "indeed",
    jobUrl: "https://www.indeed.com/viewjob?jk=abc123",
    datePosted: "2026-08-20T00:00:00.000Z",
  });

  const all = [
    indeed,
    closed,
    unchecked,
    offsiteTwo,
    easyNoCount,
    easyLots,
    easyFew,
  ];

  const order = (key: SortKey, direction: SortDirection) =>
    [...all]
      .sort((a, b) => compareJobs(a, b, { key, direction }))
      .map((job) => job.id);

  it("groups on the chip's own rule, not on liveEasyApply alone", () => {
    expect(easyApplySortRank(easyFew)).toBe(0);
    expect(easyApplySortRank(offsiteTwo)).toBe(1);
    expect(easyApplySortRank(unchecked)).toBe(1);
    // Neither of these can reach the client today — the server writes a null
    // verdict for a closed posting, and only a checked row has one at all —
    // but the sort lifts exactly the rows wearing the chip, so an unshown
    // verdict must not lift anything.
    expect(
      easyApplySortRank(
        linkedin("7000000010", { liveEasyApply: true, liveClosed: true }),
      ),
    ).toBe(1);
    expect(
      easyApplySortRank(
        linkedin("7000000011", {
          liveEasyApply: true,
          liveClosed: null,
          liveStatusCheckedAt: null,
        }),
      ),
    ).toBe(1);
  });

  it("keeps a slug-URL Easy Apply row in the group, at the bottom of it", () => {
    // `applicantsSortRank` asks `hasLinkedinPostingId`, which reads the URL
    // only, so an uncaptioned row whose id lives in `sourceJobId` ranks as
    // non-LinkedIn (tier 3) — the group is what keeps it above the offsite
    // postings instead of on the floor with them.
    const slugEasy = createJob({
      id: "7000000009",
      jobUrl: "https://www.linkedin.com/jobs/view/senior-engineer-at-acme",
      sourceJobId: "li-4383255214",
      liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
      liveClosed: false,
      liveEasyApply: true,
      liveApplicants: null,
      datePosted: "2026-08-01T00:00:00.000Z",
    });
    expect(easyApplySortRank(slugEasy)).toBe(0);
    expect(applicantsSortRank(slugEasy)).toEqual({ tier: 3, count: null });
    expect(
      [slugEasy, offsiteTwo, easyNoCount]
        .sort((a, b) =>
          compareJobs(a, b, { key: "easyApplyApplicants", direction: "asc" }),
        )
        .map((job) => job.id),
    ).toEqual(["7000000005", "7000000009", "7000000004"]);
  });

  it("puts every Easy Apply row above the rest, whatever its count", () => {
    // easyLots has 300 applicants and still outranks the 2-applicant offsite
    // row: the group is a super-tier over the whole applicants ladder.
    expect(order("easyApplyApplicants", "asc")).toEqual([
      "7000000007",
      "7000000006",
      "7000000005",
      "7000000004",
      "7000000003",
      "7000000002",
      "indeed-2",
    ]);
  });

  it("flips the counts inside each group but never the groups themselves", () => {
    expect(order("easyApplyApplicants", "desc")).toEqual([
      "7000000006",
      "7000000007",
      "7000000005",
      "7000000004",
      "7000000003",
      "7000000002",
      "indeed-2",
    ]);
  });

  it("leaves the plain applicants sort alone — the grouping is keyed on the sort", () => {
    // Counts first (2, 3, 300), then the two count-less checked/unchecked
    // rows — same posted date, so the id tiebreak orders them — then closed,
    // then the non-LinkedIn floor.
    expect(order("applicants", "asc")).toEqual([
      "7000000004",
      "7000000007",
      "7000000006",
      "7000000003",
      "7000000005",
      "7000000002",
      "indeed-2",
    ]);
  });
});

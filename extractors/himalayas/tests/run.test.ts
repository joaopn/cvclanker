import { describe, expect, it, vi } from "vitest";
import {
  mapHimalayasJob,
  matchesSearchTerms,
  runHimalayas,
  stripHtml,
} from "../src/run";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const DAY_MS = 86_400_000;

function fixtureJob(overrides: Record<string, unknown> = {}) {
  // Field names and shapes match the live API payload (probed 2026-08-21).
  return {
    title: "Senior TypeScript Engineer",
    companyName: "Acme",
    companySlug: "acme",
    description: "<h3>About</h3><p>Build &amp; ship TypeScript services.</p>",
    excerpt: "Build and ship TypeScript services.",
    guid: "https://himalayas.app/companies/acme/jobs/senior-typescript-engineer",
    applicationLink: "https://jobs.acme.dev/apply/123",
    locationRestrictions: ["Germany"],
    timezoneRestrictions: [],
    minSalary: 90000,
    maxSalary: 120000,
    currency: "EUR",
    salaryPeriod: "yearly",
    seniority: ["Senior"],
    employmentType: "Full Time",
    categories: ["Engineering", "TypeScript"],
    pubDate: Math.floor((NOW - DAY_MS) / 1000),
    ...overrides,
  };
}

function pageResponse(jobs: unknown[]): Response {
  return new Response(JSON.stringify({ jobs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("mapHimalayasJob", () => {
  it("maps the live payload shape", () => {
    const mapped = mapHimalayasJob(fixtureJob());
    expect(mapped).toMatchObject({
      source: "himalayas",
      title: "Senior TypeScript Engineer",
      employer: "Acme",
      employerUrl: "https://himalayas.app/companies/acme",
      jobUrl:
        "https://himalayas.app/companies/acme/jobs/senior-typescript-engineer",
      applicationLink: "https://jobs.acme.dev/apply/123",
      location: "Germany",
      salaryMinAmount: 90000,
      salaryMaxAmount: 120000,
      salaryCurrency: "EUR",
      jobLevel: "Senior",
      jobType: "Full Time",
      isRemote: true,
    });
    expect(mapped?.locationEvidence).toMatchObject({
      location: "Germany",
      country: "Germany",
      isRemote: true,
      source: "himalayas",
    });
    expect(mapped?.jobDescription).toBe(
      "About\nBuild & ship TypeScript services.",
    );
    expect(mapped?.datePosted).toBe(new Date(NOW - DAY_MS).toISOString());
  });

  it("labels an unrestricted posting as eligible from anywhere", () => {
    const mapped = mapHimalayasJob(fixtureJob({ locationRestrictions: [] }));
    expect(mapped?.location).toBe("Anywhere in the World");
    expect(mapped?.locationEvidence?.country).toBeUndefined();
  });

  it("joins a multi-country restriction into one comma list", () => {
    const mapped = mapHimalayasJob(
      fixtureJob({ locationRestrictions: ["Germany", "Austria"] }),
    );
    expect(mapped?.location).toBe("Germany, Austria");
  });

  it("returns null for a row without title or url", () => {
    expect(mapHimalayasJob(fixtureJob({ guid: undefined }))).toBeNull();
    expect(mapHimalayasJob(fixtureJob({ title: "  " }))).toBeNull();
  });
});

describe("matchesSearchTerms", () => {
  it("requires every word of at least one term", () => {
    expect(
      matchesSearchTerms("Senior TypeScript Engineer", ["typescript"]),
    ).toBe(true);
    expect(
      matchesSearchTerms("Senior TypeScript Engineer", ["typescript engineer"]),
    ).toBe(true);
    expect(
      matchesSearchTerms("Senior TypeScript Engineer", ["python developer"]),
    ).toBe(false);
    expect(
      matchesSearchTerms("Senior TypeScript Engineer", [
        "python",
        "typescript",
      ]),
    ).toBe(true);
  });

  it("keeps everything when no terms are configured", () => {
    expect(matchesSearchTerms("anything", [])).toBe(true);
  });
});

describe("stripHtml", () => {
  it("flattens tags and decodes the common entities", () => {
    expect(stripHtml("<p>a &amp; b</p><p>c&nbsp;d</p>")).toBe("a & b\nc d");
  });
});

describe("runHimalayas", () => {
  it("pages newest-first and stops at the age window", async () => {
    const fresh = fixtureJob();
    const alsoFresh = fixtureJob({
      guid: "https://himalayas.app/companies/acme/jobs/second",
      pubDate: Math.floor((NOW - 2 * DAY_MS) / 1000),
    });
    const stale = fixtureJob({
      guid: "https://himalayas.app/companies/acme/jobs/old",
      pubDate: Math.floor((NOW - 40 * DAY_MS) / 1000),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([fresh, alsoFresh, stale]));

    const result = await runHimalayas({
      searchTerms: ["typescript"],
      maxAgeDays: 7,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      fresh.guid,
      alsoFresh.guid,
    ]);
    // The stale row ended the walk — no second page request.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("filters by search terms without counting misses as dropped", async () => {
    const match = fixtureJob();
    const miss = fixtureJob({
      guid: "https://himalayas.app/companies/acme/jobs/nurse",
      title: "Registered Nurse",
      excerpt: "Care team",
      categories: ["Healthcare"],
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([match, miss]))
      .mockResolvedValueOnce(pageResponse([]));

    const result = await runHimalayas({
      searchTerms: ["typescript"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it("counts unmappable rows and dedupes by url", async () => {
    const good = fixtureJob();
    const broken = fixtureJob({ guid: undefined });
    const dupe = fixtureJob();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([good, broken, dupe]))
      .mockResolvedValueOnce(pageResponse([]));

    const result = await runHimalayas({
      searchTerms: [],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it("stops paging at the job cap", async () => {
    // Distinct urls per page (the runner dedupes), fresh Response per call
    // (a shared one has its body consumed by the first page read).
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      call += 1;
      const rows = Array.from({ length: 20 }, (_, index) =>
        fixtureJob({
          guid: `https://himalayas.app/companies/acme/jobs/p${call}-${index}`,
        }),
      );
      return Promise.resolve(pageResponse(rows));
    });

    const result = await runHimalayas({
      searchTerms: [],
      maxJobs: 25,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(25);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("contributes nothing when the profile unticked remote", async () => {
    const fetchImpl = vi.fn();
    const result = await runHimalayas({
      workplaceTypes: ["hybrid", "onsite"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails the run when the API errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 503 }));
    const result = await runHimalayas({
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});

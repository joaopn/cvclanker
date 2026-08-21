import { describe, expect, it, vi } from "vitest";
import { jobicyGeoSlug, mapJobicyJob, runJobicy, stripHtml } from "../src/run";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const DAY_MS = 86_400_000;

function fixtureJob(overrides: Record<string, unknown> = {}) {
  // Field names and shapes match the live API payload (probed 2026-08-21):
  // ISO pubDate with offset, ARRAY jobType/jobIndustry, numeric id.
  return {
    id: 146848,
    url: "https://jobicy.com/jobs/146848-salesforce-developer-2",
    jobSlug: "146848-salesforce-developer-2",
    jobTitle: "Salesforce Developer",
    companyName: "dentsu",
    companyLogo: "https://jobicy.com/data/logo.png",
    jobIndustry: ["Software Engineering"],
    jobType: ["Full-Time"],
    jobGeo: "Spain",
    jobLevel: "Senior",
    jobExcerpt: "Omega CRM is a Merkle &amp; Dentsu company",
    jobDescription: "<p><b>Job Description:</b></p><p>Build things.</p>",
    pubDate: new Date(NOW - DAY_MS).toISOString(),
    ...overrides,
  };
}

function apiResponse(jobs: unknown[]): Response {
  return new Response(JSON.stringify({ jobs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("jobicyGeoSlug", () => {
  it("follows the live slug grammar including the short forms", () => {
    expect(jobicyGeoSlug("portugal")).toBe("portugal");
    expect(jobicyGeoSlug("New Zealand")).toBe("new-zealand");
    expect(jobicyGeoSlug("united kingdom")).toBe("uk");
    expect(jobicyGeoSlug("UK")).toBe("uk");
    expect(jobicyGeoSlug("united states")).toBe("usa");
    // Jobicy spells it turkiye — geo=turkey silently un-filters (verified).
    expect(jobicyGeoSlug("türkiye")).toBe("turkiye");
    expect(jobicyGeoSlug("turkey")).toBe("turkiye");
    // usa/ca spans two countries: request unfiltered, let the matcher's
    // eligibility branch keep US and Canada rows.
    expect(jobicyGeoSlug("usa/ca")).toBeUndefined();
    expect(jobicyGeoSlug("worldwide")).toBeUndefined();
    expect(jobicyGeoSlug("")).toBeUndefined();
    expect(jobicyGeoSlug(undefined)).toBeUndefined();
  });
});

describe("mapJobicyJob", () => {
  it("maps the live payload shape", () => {
    const mapped = mapJobicyJob(fixtureJob());
    expect(mapped).toMatchObject({
      source: "jobicy",
      sourceJobId: "146848",
      title: "Salesforce Developer",
      employer: "dentsu",
      jobUrl: "https://jobicy.com/jobs/146848-salesforce-developer-2",
      location: "Spain",
      jobLevel: "Senior",
      jobType: "Full-Time",
      jobFunction: "Software Engineering",
      isRemote: true,
    });
    expect(mapped?.locationEvidence).toMatchObject({
      location: "Spain",
      isRemote: true,
      source: "jobicy",
    });
    expect(mapped?.jobDescription).toBe("Job Description:\nBuild things.");
    expect(mapped?.datePosted).toBe(new Date(NOW - DAY_MS).toISOString());
  });

  it("keeps a multi-region jobGeo as one comma list for the matcher", () => {
    expect(mapJobicyJob(fixtureJob({ jobGeo: "APAC,  EMEA" }))?.location).toBe(
      "APAC,  EMEA",
    );
  });

  it("labels a missing jobGeo as Anywhere", () => {
    const mapped = mapJobicyJob(fixtureJob({ jobGeo: undefined }));
    expect(mapped?.location).toBe("Anywhere");
  });

  it("returns null without url or title", () => {
    expect(mapJobicyJob(fixtureJob({ url: undefined }))).toBeNull();
    expect(mapJobicyJob(fixtureJob({ jobTitle: " " }))).toBeNull();
  });
});

describe("stripHtml", () => {
  it("flattens tags and single-decodes entities", () => {
    expect(stripHtml("<p>a &amp; b</p>")).toBe("a & b");
    expect(stripHtml("knows Vec&amp;lt;T&amp;gt; well")).toBe(
      "knows Vec&lt;T&gt; well",
    );
  });
});

describe("runJobicy", () => {
  it("requests one tagged search per term with the geo slug, deduping across terms", async () => {
    const shared = fixtureJob();
    const other = fixtureJob({
      id: 2,
      url: "https://jobicy.com/jobs/2-platform-engineer",
      jobTitle: "Platform Engineer",
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([shared]))
      .mockResolvedValueOnce(apiResponse([shared, other]));

    const result = await runJobicy({
      searchTerms: ["salesforce", "platform"],
      selectedCountry: "united kingdom",
      maxJobsPerTerm: 40,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Salesforce Developer",
      "Platform Engineer",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("tag")).toBe("salesforce");
    expect(firstUrl.searchParams.get("geo")).toBe("uk");
    expect(firstUrl.searchParams.get("count")).toBe("40");
  });

  it("makes one un-tagged request when no terms are configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([fixtureJob()]));

    const result = await runJobicy({
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(1);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get("tag")).toBeNull();
    expect(url.searchParams.get("geo")).toBeNull();
  });

  it("skips rows outside the window and counts unmappable rows", async () => {
    const stale = fixtureJob({
      id: 3,
      url: "https://jobicy.com/jobs/3-old",
      pubDate: new Date(NOW - 40 * DAY_MS).toISOString(),
    });
    const broken = fixtureJob({ id: 4, url: undefined });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse([fixtureJob(), stale, broken]));

    const result = await runJobicy({
      searchTerms: ["salesforce"],
      maxAgeDays: 7,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it("tolerates one failing term and fails only when every term failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(apiResponse([fixtureJob()]));

    const tolerated = await runJobicy({
      searchTerms: ["broken", "healthy"],
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(tolerated.success).toBe(true);
    expect(tolerated.jobs).toHaveLength(1);

    const allFailed = await runJobicy({
      searchTerms: ["a"],
      now: NOW,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response("nope", { status: 503 }),
        ) as unknown as typeof fetch,
    });
    expect(allFailed.success).toBe(false);
    expect(allFailed.error).toContain("503");
  });

  it("contributes nothing when the profile unticked remote", async () => {
    const fetchImpl = vi.fn();
    const result = await runJobicy({
      workplaceTypes: ["hybrid"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ success: true, jobs: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns partial results on cancellation", async () => {
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve(apiResponse([fixtureJob()]));
    });
    const result = await runJobicy({
      searchTerms: ["a", "b"],
      shouldCancel: () => calls >= 1,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

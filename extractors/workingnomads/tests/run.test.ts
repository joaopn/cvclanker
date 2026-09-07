import { describe, expect, it, vi } from "vitest";
import { runWorkingNomads } from "../src/run";

function createResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

describe("runWorkingNomads", () => {
  it("filters jobs by search term and infers contract job types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createResponse([
        {
          url: "https://www.workingnomads.com/job/go/123/",
          title: "Senior Backend Engineer",
          description: "<p>Contract role building APIs.</p>",
          company_name: "Acme",
          category_name: "Development",
          tags: "nodejs,backend",
          location: "Europe",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        {
          url: "https://www.workingnomads.com/job/go/124/",
          title: "Account Executive",
          description: "<p>Sales role.</p>",
          company_name: "Beta",
          category_name: "Sales",
          tags: "sales",
          location: "United States",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
      ]),
    );

    const result = await runWorkingNomads({
      searchTerms: ["backend engineer"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        source: "workingnomads",
        sourceJobId: "123",
        title: "Senior Backend Engineer",
        employer: "Acme",
        jobType: "Contract",
        jobFunction: "Development",
        isRemote: true,
      }),
    );
  });

  it("falls through an empty location_base to the locations array", async () => {
    // B72: ~70% of live rows carry `location_base: ""` with the real geography
    // in `locations` (measured: 344 of 500 empty, and NOT ONE of those with an
    // empty `locations` array). The empty string is not nullish, so the mapper
    // used to stop at the blank and store `location: ""` — leaving the row with
    // no location and no evidence, judged only by the remote-worldwide escape.
    // Whether a configured city can still reject these is covered end-to-end
    // in ignores-cities.test.ts, the only level that can express a city.
    const fetchMock = vi.fn().mockResolvedValue(
      createResponse([
        {
          url: "https://www.workingnomads.com/job/go/123/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Acme",
          category_name: "Development",
          tags: "nodejs",
          locations: ["Europe"],
          location_base: "Europe",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        {
          url: "https://www.workingnomads.com/job/go/124/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Beta",
          category_name: "Development",
          tags: "python",
          locations: ["Germany"],
          location_base: "",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
      ]),
    );

    const result = await runWorkingNomads({
      searchTerms: ["backend"],
      selectedCountry: "germany",
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.employer)).toEqual(["Acme", "Beta"]);
    expect(result.jobs.map((job) => job.location)).toEqual([
      "Europe",
      "Germany",
    ]);
    // The evidence reads the same two fields, so it has to fall through too —
    // an undefined evidence is what left these rows with no country to judge.
    expect(result.jobs.map((job) => job.locationEvidence?.location)).toEqual([
      "Europe",
      "Germany",
    ]);
  });

  it("treats a whitespace-only location_base as absent, and keeps the Remote default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createResponse([
        {
          url: "https://www.workingnomads.com/job/go/125/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Gamma",
          tags: "nodejs",
          locations: ["Poland"],
          location_base: "   ",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        {
          // Nothing to fall through TO: the "Remote" default still applies, and
          // no evidence is fabricated for it.
          url: "https://www.workingnomads.com/job/go/126/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Delta",
          tags: "nodejs",
          locations: [],
          location_base: "",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
      ]),
    );

    const result = await runWorkingNomads({
      searchTerms: ["backend"],
      selectedCountry: "poland",
      fetchImpl: fetchMock,
    });

    expect(result.jobs.map((job) => job.location)).toEqual([
      "Poland",
      "Remote",
    ]);
    expect(result.jobs[0]?.locationEvidence?.location).toBe("Poland");
    // The whole evidence object is absent, not merely an evidence whose
    // location is empty — `?.location` alone cannot tell those apart.
    expect(result.jobs[1]?.locationEvidence).toBeUndefined();
  });

  it("drops blank entries inside locations, and pins the join/primary split", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      createResponse([
        {
          // A blank entry is B72 in miniature: it would join to ", Germany",
          // and a lone "" would join to "" while `locations.length > 0`
          // suppressed the "Remote" default.
          url: "https://www.workingnomads.com/job/go/127/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Epsilon",
          tags: "nodejs",
          locations: ["", "Germany"],
          location_base: "",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        {
          url: "https://www.workingnomads.com/job/go/128/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Zeta",
          tags: "nodejs",
          locations: ["   "],
          location_base: "",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        {
          url: "https://www.workingnomads.com/job/go/129/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Eta",
          tags: "nodejs",
          locations: ["Germany", "Poland"],
          location_base: "",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
      ]),
    );

    const result = await runWorkingNomads({
      searchTerms: ["backend"],
      selectedCountry: "germany",
      fetchImpl: fetchMock,
    });

    expect(result.jobs.map((job) => job.location)).toEqual([
      "Germany",
      // Nothing usable left in the array, so the default applies.
      "Remote",
      "Germany, Poland",
    ]);
    // The display string lists every location; the evidence names the primary
    // one. They deliberately differ — pinned so neither drifts into the other.
    expect(result.jobs[0]?.locationEvidence?.location).toBe("Germany");
    expect(result.jobs[2]?.locationEvidence?.location).toBe("Germany");
    // Absent, not merely an evidence carrying an empty location.
    expect(result.jobs[1]?.locationEvidence).toBeUndefined();
  });

  it("returns no jobs when remote is not an allowed workplace type", async () => {
    const fetchMock = vi.fn();

    const result = await runWorkingNomads({
      searchTerms: ["backend"],
      workplaceTypes: ["onsite"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps the legacy usa/ca country filter to the search tokens used for US and Canada", async () => {
    const fetchMock = vi.fn().mockResolvedValue(createResponse([]));

    await runWorkingNomads({
      searchTerms: ["backend"],
      selectedCountry: "usa/ca",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toEqual(
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(requestInit?.body)) as {
      query?: {
        bool?: {
          filter?: Array<{ terms?: { locations?: string[] } }>;
        };
      };
    };
    expect(body.query?.bool?.filter).toEqual([
      {
        terms: {
          locations: expect.arrayContaining([
            "USA",
            "Canada",
            "North America",
            "Anywhere",
          ]),
        },
      },
    ]);
  });

  it("stops scanning a term once the per-term cap is reached", async () => {
    const overflowingJob = {};
    Object.defineProperty(overflowingJob, "title", {
      get() {
        throw new Error("loop should stop before inspecting overflow jobs");
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      createResponse([
        {
          url: "https://www.workingnomads.com/job/go/123/",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company_name: "Acme",
          category_name: "Development",
          tags: "nodejs",
          location: "Anywhere",
          pub_date: "2026-03-20T10:00:00-04:00",
        },
        overflowingJob,
      ]),
    );

    const result = await runWorkingNomads({
      searchTerms: ["backend"],
      maxJobsPerTerm: 1,
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
  });
});

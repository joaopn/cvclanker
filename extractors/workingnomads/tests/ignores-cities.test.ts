// Deliberately does NOT mock ../src/run: this drives the REAL runner through the
// manifest, which is the only level at which a configured city can still be
// expressed (B71 removed `locations` from the runner's own options).
import { afterEach, describe, expect, it, vi } from "vitest";
import { manifest } from "../src/manifest";

function searchResponse(sources: Array<Record<string, unknown>>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      hits: { hits: sources.map((s) => ({ _source: s })) },
    }),
  } as Response;
}

describe("workingnomads ignores a configured city", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the country tokens and keeps every row even with a city stored", async () => {
    // Both rows carry shapes measured on the live index: a region name, and an
    // EMPTY location_base (72% of 500 sampled rows — those rows still carry a
    // populated `locations` array, which is what the ES filter matches on).
    // Before B71 a stored city blanked the country filter AND rejected both of
    // these, which is how the source returned nothing for every non-remote
    // profile.
    const fetchMock = vi.fn().mockResolvedValue(
      searchResponse([
        {
          id: 123,
          slug: "backend-engineer-acme",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company: "Acme",
          category_name: "Development",
          tags: ["nodejs"],
          locations: ["Europe"],
          location_base: "Europe",
          pub_date: "2026-03-20T10:00:00+00:00",
        },
        {
          id: 124,
          slug: "backend-engineer-beta",
          title: "Backend Engineer",
          description: "<p>Full-time role.</p>",
          company: "Beta",
          category_name: "Development",
          tags: ["python"],
          locations: ["Germany"],
          location_base: "",
          pub_date: "2026-03-20T10:00:00+00:00",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await manifest.run({
      source: "workingnomads",
      selectedSources: ["workingnomads"],
      // A city the Sources page can no longer set, but which a pre-existing
      // source_configs row still carries: resolveSourceContextSettings copies
      // every stored key into settings regardless of schema.
      settings: { searchCities: "Berlin", max_jobs_per_term: "50" },
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query?: {
        bool?: { filter?: Array<{ terms?: { locations?: string[] } }> };
      };
    };
    // The city used to blank this filter entirely.
    expect(body.query?.bool?.filter).toEqual([
      {
        terms: {
          locations: expect.arrayContaining(["Germany", "Europe", "Anywhere"]),
        },
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.employer)).toEqual(["Acme", "Beta"]);
  });
});

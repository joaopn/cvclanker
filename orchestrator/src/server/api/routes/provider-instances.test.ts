// @vitest-environment node
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

vi.mock("@server/providers/apify/client", async (importActual) => ({
  ...(await importActual<typeof import("@server/providers/apify/client")>()),
  runApifyActor: vi.fn(),
}));

describe.sequential("provider instance test route", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it("stops a per-term preview at the first term with postings, at its budget", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [
        {
          link: "https://www.linkedin.com/jobs/view/4000000001",
          title: "AI Engineer",
          companyName: "ACME",
        },
      ],
      status: "SUCCEEDED",
    });
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");

    const profile = await post("/api/profiles", {
      name: "Budgets",
      config: {
        searchTerms: ["AI Engineer", "Data Scientist"],
        searchCountry: "united kingdom",
        termJobBudget: 60,
        termJobBudgets: { "ai engineer": 35 },
      },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "curious_coder/linkedin-jobs-scraper",
      label: "LinkedIn",
      templateId: "linkedin-jobs-scraper",
      inputTemplateJson: "{}",
    });

    const result = await post(
      `/api/provider-instances/${instance.body.data.id}/test`,
      {},
    );

    expect(result.status).toBe(200);
    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    const input = vi.mocked(runApifyActor).mock.calls[0][0].input as {
      urls: string[];
      count: number;
    };
    expect(
      input.urls.map((url) => new URL(url).searchParams.get("keywords")),
    ).toEqual(['"AI Engineer"']);
    expect(input.count).toBe(35);
    expect(result.body.data.searched).toEqual({
      terms: [{ term: "AI Engineer", mapped: 1, unmapped: 0 }],
      // Stopping at postings is the answer, not the time limit.
      untried: 0,
      place: "United Kingdom",
    });
  });

  it("tries each term in a per-city template's first city until one has postings", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [],
      status: "SUCCEEDED",
    });
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");

    const profile = await post("/api/profiles", {
      name: "Cities",
      config: {
        searchTerms: ["AI Engineer", "Data Scientist"],
        searchCountry: "austria",
        searchCities: "Vienna|Graz|Linz",
      },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "valig/linkedin-jobs-scraper",
      label: "LinkedIn (valig)",
      templateId: "valig-linkedin",
      inputTemplateJson: "{}",
    });

    const result = await post(
      `/api/provider-instances/${instance.body.data.id}/test`,
      {},
    );

    expect(result.status).toBe(200);
    expect(
      vi.mocked(runApifyActor).mock.calls.map(([args]) => {
        const input = args.input as { keywords: string; location: string };
        return [input.keywords, input.location];
      }),
    ).toEqual([
      ["AI Engineer", "Vienna, Austria"],
      ["Data Scientist", "Vienna, Austria"],
    ]);
    // Every term came back empty: the preview says what it tried, and where.
    expect(result.body.data).toMatchObject({
      outcome: "ok",
      samples: [],
      searched: {
        terms: [
          { term: "AI Engineer", mapped: 0, unmapped: 0 },
          { term: "Data Scientist", mapped: 0, unmapped: 0 },
        ],
        untried: 0,
        place: "Vienna, Austria",
      },
    });
  });

  it("stops trying terms at one whose run failed", async () => {
    const { runApifyActor, ApifyApiError } = await import(
      "@server/providers/apify/client"
    );
    vi.mocked(runApifyActor).mockRejectedValue(
      new ApifyApiError("Apify 402: no credit", 402, false),
    );
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");
    const profile = await post("/api/profiles", {
      name: "Failing",
      config: {
        searchTerms: ["AI Engineer", "Data Scientist"],
        searchCountry: "austria",
      },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "valig/linkedin-jobs-scraper",
      label: "LinkedIn (valig)",
      templateId: "valig-linkedin",
      inputTemplateJson: "{}",
    });

    const result = await post(
      `/api/provider-instances/${instance.body.data.id}/test`,
      {},
    );

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    expect(result.body.data).toMatchObject({
      outcome: "error",
      searched: {
        terms: [{ term: "AI Engineer", mapped: 0, unmapped: 0 }],
        untried: 0,
        place: "Austria",
      },
    });
    expect(result.body.data.error).toContain("Apify 402: no credit");
  });

  it("previews a template without per-term runs on every term at once, reporting no search list", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [],
      status: "SUCCEEDED",
    });
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");
    const profile = await post("/api/profiles", {
      name: "Freeform",
      config: {
        searchTerms: ["AI Engineer", "Data Scientist"],
        searchCountry: "austria",
      },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "acme/actor",
      label: "Freeform",
      inputTemplateJson: JSON.stringify({ queries: "{{searchTerms}}" }),
    });

    const result = await post(
      `/api/provider-instances/${instance.body.data.id}/test`,
      {},
    );

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runApifyActor).mock.calls[0][0].input).toEqual({
      queries: ["AI Engineer", "Data Scientist"],
    });
    expect(result.body.data).not.toHaveProperty("searched");
  });
  it("shows what a run scraped before the preview's deadline aborted it", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    const realNow = Date.now();
    vi.mocked(runApifyActor).mockImplementation(async (args) => {
      // Over five minutes later: the preview's deadline has passed.
      vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
      expect(args.shouldCancel?.()).toBe(true);
      return {
        items: [1, 2].map((n) => ({
          jobUrl: `https://www.linkedin.com/jobs/view/40000000${n}`,
          jobTitle: `Data Scientist ${n}`,
          companyName: "ACME",
        })),
        status: "ABORTED",
      };
    });
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");
    const profile = await post("/api/profiles", {
      name: "Deadline",
      config: { searchTerms: ["Data Scientist"], searchCountry: "austria" },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "cheap_scraper/linkedin-job-scraper",
      label: "LinkedIn (cheap_scraper)",
      templateId: "cheap-scraper-linkedin",
      inputTemplateJson: "{}",
    });

    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await post(
        `/api/provider-instances/${instance.body.data.id}/test`,
        {},
      );
    } finally {
      // The clock spy must not outlive this test.
      vi.restoreAllMocks();
    }

    expect(result.body.data.outcome).toBe("error");
    expect(result.body.data.totalMapped).toBe(2);
    expect(
      result.body.data.samples.map((job: { title: string }) => job.title),
    ).toEqual(["Data Scientist 1", "Data Scientist 2"]);
  });

  async function valigPreview(searchTerms: string[]) {
    const { setSetting } = await import("@server/repositories/settings");
    await setSetting("apifyApiToken", "tok");
    const profile = await post("/api/profiles", {
      name: "Terms",
      config: { searchTerms, searchCountry: "austria" },
    });
    await post(`/api/profiles/${profile.body.data.id}/set-default`, {});
    const instance = await post("/api/provider-instances", {
      providerId: "apify",
      actorRef: "valig/linkedin-jobs-scraper",
      label: "LinkedIn (valig)",
      templateId: "valig-linkedin",
      inputTemplateJson: "{}",
    });
    return post(`/api/provider-instances/${instance.body.data.id}/test`, {});
  }

  it("stops at a term whose rows the mapper could not read", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [{ unexpected: "shape" }],
      status: "SUCCEEDED",
    });

    const result = await valigPreview(["AI Engineer", "Data Scientist"]);

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    expect(result.body.data.searched).toEqual({
      terms: [{ term: "AI Engineer", mapped: 0, unmapped: 1 }],
      untried: 0,
      place: "Austria",
    });
  });

  it("searches each case-insensitive variant of a term once", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [],
      status: "SUCCEEDED",
    });

    await valigPreview(["AI Engineer", "ai engineer", "Data Scientist"]);

    expect(
      vi
        .mocked(runApifyActor)
        .mock.calls.map(
          ([args]) => (args.input as { keywords: string }).keywords,
        ),
    ).toEqual(["AI Engineer", "Data Scientist"]);
  });

  it("counts the terms the deadline left untried, keeping the empty answer", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    const realNow = Date.now();
    vi.mocked(runApifyActor).mockImplementation(async () => {
      // The first term comes back empty, after the deadline has passed.
      vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
      return { items: [], status: "SUCCEEDED" };
    });

    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await valigPreview(["A one", "B two", "C three"]);
    } finally {
      vi.restoreAllMocks();
    }

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    expect(result.body.data).toMatchObject({
      outcome: "ok",
      searched: {
        terms: [{ term: "A one", mapped: 0, unmapped: 0 }],
        untried: 2,
      },
    });
  });

  it("reports a later term the deadline cut short as unfinished, not as a failure", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    const realNow = Date.now();
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: [], status: "SUCCEEDED" })
      .mockImplementationOnce(async () => {
        vi.spyOn(Date, "now").mockReturnValue(realNow + 301_000);
        return { items: [], status: "ABORTED" };
      });

    let result: Awaited<ReturnType<typeof post>>;
    try {
      result = await valigPreview(["A one", "B two", "C three"]);
    } finally {
      vi.restoreAllMocks();
    }

    expect(result.body.data).toMatchObject({
      outcome: "ok",
      searched: {
        terms: [
          { term: "A one", mapped: 0, unmapped: 0 },
          { term: "B two", mapped: 0, unmapped: 0, unfinished: true },
        ],
        untried: 1,
      },
    });
  });
});

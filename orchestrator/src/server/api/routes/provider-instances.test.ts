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

  it("previews a per-term template on the first term alone, at its budget", async () => {
    const { runApifyActor } = await import("@server/providers/apify/client");
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [],
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
  });

  it("previews a per-city template on the first city alone", async () => {
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
    ).toEqual([["AI Engineer", "Vienna, Austria"]]);
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
});

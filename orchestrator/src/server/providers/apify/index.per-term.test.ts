import type {
  ExtractorProgressEvent,
  ProviderInstanceRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async (importActual) => ({
  ...(await importActual<typeof import("./client")>()),
  runApifyActor: vi.fn(),
}));

import { ApifyApiError, runApifyActor } from "./client";
import { apifyProvider } from "./index";

const instance = {
  id: "inst-1",
  providerId: "apify",
  actorRef: "curious_coder/linkedin-jobs-scraper",
  label: "LinkedIn",
  templateId: "linkedin-jobs-scraper",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  maxJobs: 1000,
  maxAgeDays: null,
} as unknown as ProviderInstanceRow;

const runGlobals = {
  city: "London|Oxford",
  country: "united kingdom",
  maxJobsPerTerm: "15",
} as SourceConfigRunGlobals;

const item = (term: string, n: number) => ({
  link: `https://www.linkedin.com/jobs/view/${term.length}00${n}`,
  title: `${term} ${n}`,
  companyName: "ACME",
});

const items = (term: string, count: number) =>
  Array.from({ length: count }, (_, n) => item(term, n));

// The single quoted keyword each actor call searched, in call order.
function searchedKeywords(): string[] {
  return vi.mocked(runApifyActor).mock.calls.map(([args]) => {
    const input = args.input as { urls: string[] };
    const keywords = new Set(
      input.urls.map((url) => new URL(url).searchParams.get("keywords")),
    );
    expect(keywords.size).toBe(1);
    return [...keywords][0] ?? "";
  });
}

function callInput(index: number) {
  return vi.mocked(runApifyActor).mock.calls[index][0].input as {
    count: number;
    limitPerSource: number;
  };
}

beforeEach(() => {
  vi.mocked(runApifyActor).mockReset();
});

describe("apifyProvider per-term runs", () => {
  it("runs one actor call per distinct term, in order, capped at its budget", async () => {
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: items("AI", 40), status: "SUCCEEDED" })
      .mockResolvedValueOnce({ items: items("DS", 7), status: "SUCCEEDED" });

    const result = await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["AI Engineer", "ai engineer ", "Data Scientist"],
      termBudgets: { "ai engineer": 40 },
    });

    expect(searchedKeywords()).toEqual(['"AI Engineer"', '"Data Scientist"']);
    // The term's budget caps the whole run; the cities share it.
    expect(callInput(0)).toMatchObject({ count: 40, limitPerSource: 20 });
    // No entry for the term: the run's per-term cap is its budget.
    expect(callInput(1)).toMatchObject({ count: 15, limitPerSource: 10 });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(47);
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 40, scraped: 40, status: "capped" },
      { term: "Data Scientist", budget: 15, scraped: 7, status: "under" },
    ]);
  });

  it("runs cheap_scraper once per term, at max(150, its budget)", async () => {
    // A term's job budget, never the instance's own max-jobs, sets the cap,
    // so the instance carries a value that would otherwise win.
    const cheapInstance = {
      ...instance,
      actorRef: "cheap_scraper/linkedin-job-scraper",
      templateId: "cheap-scraper-linkedin",
      maxJobs: 900,
    } as ProviderInstanceRow;
    const cheapItem = (term: string, n: number) => ({
      jobUrl: `https://www.linkedin.com/jobs/view/${term.length}00${n}`,
      jobTitle: `${term} ${n}`,
      companyName: "ACME",
    });
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({
        items: Array.from({ length: 400 }, (_, n) => cheapItem("AI", n)),
        status: "SUCCEEDED",
      })
      .mockResolvedValueOnce({
        items: Array.from({ length: 20 }, (_, n) => cheapItem("DS", n)),
        status: "SUCCEEDED",
      });

    const result = await apifyProvider.run({
      instance: cheapInstance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["AI Engineer", "Data Scientist"],
      termBudgets: { "ai engineer": 400 },
    });

    const inputs = vi
      .mocked(runApifyActor)
      .mock.calls.map(
        ([args]) => args.input as { keyword: string[]; maxItems: number },
      );
    expect(inputs.map((input) => input.keyword)).toEqual([
      ["AI Engineer"],
      ["Data Scientist"],
    ]);
    // No entry for "Data Scientist": its budget is the run's per-term cap of
    // 15, which the actor's minimum lifts to 150.
    expect(inputs.map((input) => input.maxItems)).toEqual([400, 150]);
    // Reported against the 150 the actor was asked for, so a term LinkedIn
    // ran short of reads as under its budget, not as one worth raising.
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(420);
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 400, scraped: 400, status: "capped" },
      { term: "Data Scientist", budget: 150, scraped: 20, status: "under" },
    ]);
  });

  it("never asks for fewer than the actor's minimum of 10", async () => {
    vi.mocked(runApifyActor).mockResolvedValueOnce({
      items: [],
      status: "SUCCEEDED",
    });

    const result = await apifyProvider.run({
      instance,
      runGlobals: { ...runGlobals, maxJobsPerTerm: "3" },
      apiToken: "tok",
      searchTerms: ["AI Engineer"],
    });

    expect(callInput(0).count).toBe(10);
    expect(result.termBudgets?.[0]).toMatchObject({ budget: 10 });
  });

  it("stops at a call that throws, keeping earlier rows and naming the rest", async () => {
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: items("A", 3), status: "SUCCEEDED" })
      .mockRejectedValueOnce(new ApifyApiError("Unauthorized", 401, false));

    const result = await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["A", "B", "C"],
    });

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(3);
    expect(result.termBudgets?.map((outcome) => outcome.status)).toEqual([
      "under",
      "failed",
      "not_run",
    ]);
    expect(result.error).toContain('"B": Unauthorized');
    expect(result.error).toContain("1 search term(s) were not searched");
  });

  it("keeps going past a run that timed out, keeping its rows", async () => {
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: items("A", 2), status: "TIMED-OUT" })
      .mockResolvedValueOnce({ items: items("B", 15), status: "SUCCEEDED" });

    const result = await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["A", "B"],
    });

    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(17);
    expect(result.termBudgets).toEqual([
      { term: "A", budget: 15, scraped: 2, status: "failed" },
      { term: "B", budget: 15, scraped: 15, status: "capped" },
    ]);
  });

  it("stops after the term in flight when the run is cancelled", async () => {
    let cancelled = false;
    vi.mocked(runApifyActor).mockImplementationOnce(async () => {
      cancelled = true;
      return { items: items("A", 4), status: "ABORTED" };
    });

    const result = await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["A", "B", "C"],
      shouldCancel: () => cancelled,
    });

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    // Mapping stops at a cancel, as it does for a single run: a cancelled
    // pipeline imports nothing anyway. The outcome still says what it cost.
    expect(result.jobs).toHaveLength(0);
    expect(result.termBudgets).toEqual([
      { term: "A", budget: 15, scraped: 4, status: "failed" },
      { term: "B", budget: 15, scraped: 0, status: "not_run" },
      { term: "C", budget: 15, scraped: 0, status: "not_run" },
    ]);
  });

  it("keeps going past an abort nobody asked for", async () => {
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: [], status: "ABORTED" })
      .mockResolvedValueOnce({ items: items("B", 1), status: "SUCCEEDED" });

    const result = await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["A", "B"],
      shouldCancel: () => false,
    });

    expect(vi.mocked(runApifyActor)).toHaveBeenCalledTimes(2);
    expect(result.termBudgets?.map((outcome) => outcome.status)).toEqual([
      "failed",
      "under",
    ]);
  });

  it("reports progress per term with a running scraped total", async () => {
    vi.mocked(runApifyActor)
      .mockResolvedValueOnce({ items: items("A", 2), status: "SUCCEEDED" })
      .mockResolvedValueOnce({ items: items("B", 3), status: "SUCCEEDED" });
    const events: ExtractorProgressEvent[] = [];

    await apifyProvider.run({
      instance,
      runGlobals,
      apiToken: "tok",
      searchTerms: ["A", "a", "B"],
      onProgress: (event) => events.push(event),
    });

    expect(
      events.map(({ termsProcessed, termsTotal, jobPagesProcessed }) => ({
        termsProcessed,
        termsTotal,
        jobPagesProcessed,
      })),
    ).toEqual([
      { termsProcessed: 0, termsTotal: 2, jobPagesProcessed: 0 },
      { termsProcessed: 1, termsTotal: 2, jobPagesProcessed: 2 },
      { termsProcessed: 2, termsTotal: 2, jobPagesProcessed: 5 },
    ]);
  });
});

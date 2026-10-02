import type {
  ProviderInstanceRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import type { ProviderRunContext } from "../../types";
import { linkedinJobsScraperTemplate } from "./linkedin-jobs-scraper";

const instance = (
  overrides: Partial<ProviderInstanceRow> = {},
): ProviderInstanceRow => ({
  id: "instance-1",
  providerId: "apify",
  actorRef: "curious_coder/linkedin-jobs-scraper",
  label: "LinkedIn Jobs Scraper (curious_coder)",
  templateId: "linkedin-jobs-scraper",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  updatedAt: "2026-08-16T00:00:00.000Z",
  ...overrides,
});

const context = (args: {
  runGlobals: SourceConfigRunGlobals;
  searchTerms?: string[];
  instance?: Partial<ProviderInstanceRow>;
  termBudget?: number;
}): ProviderRunContext => ({
  instance: instance(args.instance),
  runGlobals: args.runGlobals,
  apiToken: "token",
  searchTerms: args.searchTerms ?? ["Machine Learning Engineer"],
  termBudget: args.termBudget,
});

function buildInput(
  args: Parameters<typeof context>[0],
  base: unknown = {},
): Record<string, unknown> {
  const build = linkedinJobsScraperTemplate.buildInput;
  if (!build) throw new Error("template has no buildInput");
  return build(context(args), base) as Record<string, unknown>;
}

describe("linkedinJobsScraperTemplate.buildInput", () => {
  it("qualifies each city with the country in the search URL", () => {
    const input = buildInput({
      runGlobals: {
        city: "London|Cambridge",
        country: "united kingdom",
        maxJobsPerTerm: "20",
      },
    });

    const urls = input.urls as string[];
    expect(urls).toHaveLength(2);
    // Bare "Cambridge" is what LinkedIn resolves to Cambridge, Ontario.
    expect(urls[0]).toContain("location=London%2C%20United%20Kingdom");
    expect(urls[1]).toContain("location=Cambridge%2C%20United%20Kingdom");
    expect(urls.join(" ")).not.toContain("location=Cambridge&");
  });

  it("searches the country itself when no cities are configured", () => {
    const input = buildInput({
      runGlobals: { city: "", country: "canada", maxJobsPerTerm: "20" },
    });

    expect(input.urls).toEqual([expect.stringContaining("location=Canada")]);
  });

  it("caps the run at the term's budget and shares it across the cities", () => {
    const input = buildInput({
      runGlobals: {
        city: "London|Cambridge|Exeter",
        country: "united kingdom",
        maxJobsPerTerm: "5",
      },
      instance: { maxJobs: 900 },
      termBudget: 100,
    });

    // `count` is the actor's global run max, `limitPerSource` its per-URL cap.
    expect(input.count).toBe(100);
    expect(input.limitPerSource).toBe(34);
  });

  it("ignores the instance's own max jobs", () => {
    const input = buildInput({
      runGlobals: { city: "", country: "ireland", maxJobsPerTerm: "20" },
      instance: { maxJobs: 900 },
    });

    expect(input.count).toBe(20);
    expect(input.limitPerSource).toBe(20);
  });

  it("gives each city at least the actor's minimum of 10", () => {
    const input = buildInput({
      runGlobals: { city: "London|Oxford|Leeds", country: "united kingdom" },
      termBudget: 12,
    });

    expect(input.count).toBe(12);
    expect(input.limitPerSource).toBe(10);
  });

  it("falls back to the per-term cap times the terms without a term budget", () => {
    const input = buildInput({
      runGlobals: { city: "Dublin", country: "ireland", maxJobsPerTerm: "11" },
      searchTerms: ["a", "b", "c"],
    });

    expect(input.count).toBe(33);
    expect(input.limitPerSource).toBe(33);
  });

  it("runs once per term", () => {
    expect(linkedinJobsScraperTemplate.perTermRuns).toBe(true);
  });

  it("overrides a stale location-pinned url and count from the stored input", () => {
    const input = buildInput(
      {
        runGlobals: { city: "Madrid", country: "spain", maxJobsPerTerm: "20" },
        termBudget: 100,
      },
      {
        urls: [
          "https://www.linkedin.com/jobs/search/?location=United%20Kingdom",
        ],
        count: "{{maxJobsPerTerm}}",
        scrapeCompany: false,
      },
    );

    expect(input.urls).toEqual([
      expect.stringContaining("location=Madrid%2C%20Spain"),
    ]);
    expect(input.count).toBe(100);
    // Per-instance knobs from the stored input survive.
    expect(input.scrapeCompany).toBe(false);
  });

  it("rides the resolved max age in the LinkedIn date filter", () => {
    const input = buildInput({
      runGlobals: { city: "Vienna", country: "austria", maxAgeDays: "7" },
    });

    expect((input.urls as string[])[0]).toContain("f_TPR=r604800");
  });
  it("carries a max-age note saying the window is honoured exactly", () => {
    expect(linkedinJobsScraperTemplate.maxAgeNote).toMatch(/f_TPR/);
  });
});

describe("linkedinJobsScraperTemplate.termEarlyStop", () => {
  const early = linkedinJobsScraperTemplate.termEarlyStop;
  if (!early) throw new Error("template has no termEarlyStop");
  const item = (
    link: string,
    inputUrl = "https://www.linkedin.com/jobs/a",
  ) => ({
    link,
    inputUrl,
    title: "Data Scientist",
  });

  it("ranks the first response's page 0 by its own position", () => {
    expect(
      early.rankOf(
        item("https://uk.linkedin.com/jobs/view/x-1?position=40&pageNum=0"),
      ),
    ).toEqual({ search: "https://www.linkedin.com/jobs/a", rank: 40 });
  });

  it("ranks a later page of 10 after the first 60", () => {
    // Later pages are numbered from 6, so page 6 position 1 is rank 61.
    expect(
      early.rankOf(item("https://x/jobs/view/1?position=1&pageNum=6"))?.rank,
    ).toBe(61);
    expect(
      early.rankOf(item("https://x/jobs/view/1?position=10&pageNum=9"))?.rank,
    ).toBe(100);
  });

  it("cannot rank an item without a position or its search", () => {
    expect(early.rankOf(item("https://x/jobs/view/1"))).toBeNull();
    expect(
      early.rankOf({ link: "https://x/jobs/view/1?position=1&pageNum=0" }),
    ).toBeNull();
    expect(early.rankOf(null)).toBeNull();
  });

  it("reads the built input's searches and their per-city cap", () => {
    const input = linkedinJobsScraperTemplate.buildInput?.(
      {
        instance: {} as ProviderRunContext["instance"],
        runGlobals: { city: "London|Oxford", country: "united kingdom" },
        apiToken: "t",
        searchTerms: ["Data Scientist"],
        termBudget: 100,
      },
      {},
    );
    const { searches, cap } = early.searchesOf(input);
    expect(searches).toEqual((input as { urls: string[] }).urls);
    expect(searches).toHaveLength(2);
    expect(cap).toBe(50);
    expect(early.searchesOf({})).toEqual({ searches: [], cap: undefined });
  });
});

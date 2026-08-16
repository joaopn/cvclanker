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
}): ProviderRunContext => ({
  instance: instance(args.instance),
  runGlobals: args.runGlobals,
  apiToken: "token",
  searchTerms: args.searchTerms ?? ["Machine Learning Engineer"],
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

  it("splits the run budget across the search URLs", () => {
    const input = buildInput({
      runGlobals: {
        city: "London|Cambridge|Exeter",
        country: "united kingdom",
      },
      instance: { maxJobs: 900 },
    });

    // `count` is the actor's global run max; `limitPerSource` the per-URL one.
    expect(input.count).toBe(900);
    expect(input.limitPerSource).toBe(300);
  });

  it("keeps the per-URL cap at or above 1 for a tiny budget", () => {
    const input = buildInput({
      runGlobals: { city: "A|B|C|D|E|F|G|H|I|J|K|L", country: "ireland" },
      instance: { maxJobs: 10 },
    });

    expect(input.count).toBe(10);
    expect(input.limitPerSource).toBe(1);
  });

  it("derives the budget from the run budget and term count when unset", () => {
    const input = buildInput({
      runGlobals: { city: "Dublin", country: "ireland", maxJobsPerTerm: "11" },
      searchTerms: ["a", "b", "c"],
    });

    expect(input.count).toBe(33);
    expect(input.limitPerSource).toBe(33);
  });

  it("overrides a stale location-pinned url and count from the stored input", () => {
    const input = buildInput(
      {
        runGlobals: { city: "Madrid", country: "spain", maxJobsPerTerm: "20" },
        instance: { maxJobs: 100 },
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
});

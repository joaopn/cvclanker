import type {
  ProviderInstanceRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import type { ProviderRunContext } from "../../types";
import { cheapScraperLinkedinTemplate } from "./cheap-scraper-linkedin";

const instance = (
  overrides: Partial<ProviderInstanceRow> = {},
): ProviderInstanceRow => ({
  id: "instance-2",
  providerId: "apify",
  actorRef: "cheap_scraper/linkedin-job-scraper",
  label: "LinkedIn Jobs Scraper (cheap_scraper)",
  templateId: "cheap-scraper-linkedin",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  updatedAt: "2026-08-16T00:00:00.000Z",
  ...overrides,
});

function buildInput(args: {
  runGlobals: SourceConfigRunGlobals;
  searchTerms?: string[];
  instance?: Partial<ProviderInstanceRow>;
}): Record<string, unknown> {
  const build = cheapScraperLinkedinTemplate.buildInput;
  if (!build) throw new Error("template has no buildInput");
  const context: ProviderRunContext = {
    instance: instance(args.instance),
    runGlobals: args.runGlobals,
    apiToken: "token",
    searchTerms: args.searchTerms ?? ["Machine Learning Engineer"],
  };
  return build(context, { saveOnlyUniqueItems: true }) as Record<
    string,
    unknown
  >;
}

describe("cheapScraperLinkedinTemplate.buildInput", () => {
  it("qualifies each city with the country", () => {
    const input = buildInput({
      runGlobals: { city: "Amsterdam|Delft", country: "netherlands" },
    });

    expect(input.locations).toEqual([
      "Amsterdam, Netherlands",
      "Delft, Netherlands",
    ]);
    expect(input.saveOnlyUniqueItems).toBe(true);
  });

  it("searches the country itself when no cities are configured", () => {
    const input = buildInput({ runGlobals: { city: "", country: "spain" } });

    expect(input.locations).toEqual(["Spain"]);
  });

  it("omits locations entirely when nothing is configured", () => {
    const input = buildInput({ runGlobals: {} });

    expect(input).not.toHaveProperty("locations");
  });

  it("clamps maxItems up to the actor's floor", () => {
    const input = buildInput({
      runGlobals: { city: "Dublin", country: "ireland" },
      instance: { maxJobs: 10 },
    });

    expect(input.maxItems).toBe(150);
  });

  it("buckets the resolved max age into the actor's date filter", () => {
    expect(
      buildInput({
        runGlobals: { city: "Dublin", country: "ireland", maxAgeDays: "1" },
      }).publishedAt,
    ).toBe("r86400");
    expect(
      buildInput({
        runGlobals: { city: "Dublin", country: "ireland", maxAgeDays: "7" },
      }).publishedAt,
    ).toBe("r604800");
  });
});

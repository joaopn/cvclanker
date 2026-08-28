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
    const publishedAtFor = (maxAgeDays: string) =>
      buildInput({
        runGlobals: { city: "Dublin", country: "ireland", maxAgeDays },
      }).publishedAt;

    // Exact bucket boundaries.
    expect(publishedAtFor("1")).toBe("r86400");
    expect(publishedAtFor("7")).toBe("r604800");
    expect(publishedAtFor("30")).toBe("r2592000");

    // Between boundaries: rounds UP, so nothing in range is excluded.
    expect(publishedAtFor("2")).toBe("r604800");
    expect(publishedAtFor("8")).toBe("r2592000");

    // Wider than the widest bucket: CLAMPED to it. The actor cannot look back
    // further, so this scrapes less than was asked — pinned because deriving
    // the filter from a bucket list makes it easy to turn this into "no filter"
    // by accident, and the run-window gate refuses the request on this basis.
    expect(publishedAtFor("31")).toBe("r2592000");
    expect(publishedAtFor("365")).toBe("r2592000");

    // No usable age → no filter at all.
    expect(publishedAtFor("0")).toBeUndefined();
    expect(publishedAtFor("")).toBeUndefined();
  });

  it("publishes the bucket list the gate and the UI read", () => {
    expect(cheapScraperLinkedinTemplate.maxAgeBuckets).toEqual([1, 7, 30]);
  });
  it("carries a max-age note, since its window is bucketed and rounds up", () => {
    // The bucketing is a vendor limit we cannot fix; the field that sets it has
    // to say so, or a 2-day window silently buys a week on a per-result actor.
    expect(cheapScraperLinkedinTemplate.maxAgeNote).toMatch(/24 hours/);
    expect(cheapScraperLinkedinTemplate.maxAgeNote).toMatch(/rounds UP/);
    expect(cheapScraperLinkedinTemplate.maxAgeNote).toMatch(/30 days/);
  });
});

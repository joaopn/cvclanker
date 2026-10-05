import type {
  ProviderInstanceRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { describe, expect, it } from "vitest";
import type { ProviderRunContext } from "../../types";
import { valigLinkedinTemplate } from "./valig-linkedin";

const instance = (
  overrides: Partial<ProviderInstanceRow> = {},
): ProviderInstanceRow => ({
  id: "instance-v",
  providerId: "apify",
  actorRef: "valig/linkedin-jobs-scraper",
  label: "LinkedIn Jobs Scraper (valig)",
  templateId: "valig-linkedin",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  updatedAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

function inputsFor(args: {
  runGlobals: SourceConfigRunGlobals;
  searchTerms?: string[];
  termBudget?: number;
  instance?: Partial<ProviderInstanceRow>;
  base?: unknown;
}): Array<{ input: Record<string, unknown>; cap: number }> {
  const build = valigLinkedinTemplate.termRunInputs;
  if (!build) throw new Error("template has no termRunInputs");
  const context: ProviderRunContext = {
    instance: instance(args.instance),
    runGlobals: args.runGlobals,
    apiToken: "token",
    searchTerms: args.searchTerms ?? ["Data Scientist"],
    termBudget: args.termBudget,
  };
  return build(context, args.base ?? {}) as Array<{
    input: Record<string, unknown>;
    cap: number;
  }>;
}

const inputsOf = (args: Parameters<typeof inputsFor>[0]) =>
  inputsFor(args).map(({ input }) => input);

describe("valigLinkedinTemplate.termRunInputs", () => {
  it("searches the term in each city, keeping only titles that name it", () => {
    const inputs = inputsOf({
      runGlobals: { city: "Vienna|Graz", country: "austria" },
      termBudget: 100,
    });

    expect(inputs).toEqual([
      {
        keywords: "Data Scientist",
        titleInclude: ["Data Scientist"],
        location: "Vienna, Austria",
        limit: 50,
      },
      {
        keywords: "Data Scientist",
        titleInclude: ["Data Scientist"],
        location: "Graz, Austria",
        limit: 50,
      },
    ]);
  });

  it("searches the country when no city is configured", () => {
    const inputs = inputsOf({
      runGlobals: { city: "", country: "spain" },
      termBudget: 40,
    });
    expect(inputs.map((input) => [input.location, input.limit])).toEqual([
      ["Spain", 40],
    ]);
  });

  it("runs one unscoped search with the whole budget when there is no location", () => {
    const inputs = inputsOf({ runGlobals: {}, termBudget: 40 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("location");
    expect(inputs[0].limit).toBe(40);
  });

  it("never asks a city for more than the actor's limit of 1000", () => {
    const inputs = inputsOf({
      runGlobals: { city: "London", country: "united kingdom" },
      termBudget: 5000,
    });
    expect(inputs[0].limit).toBe(1000);
    // Reported against what the run was capped at, so a city that hit the
    // actor's limit reads as capped rather than as LinkedIn running out.
    expect(
      inputsFor({
        runGlobals: { city: "London", country: "united kingdom" },
        termBudget: 5000,
      })[0].cap,
    ).toBe(1000);
  });

  it("splits the budget so the cities' shares add up to it exactly", () => {
    const runs = inputsFor({
      runGlobals: { city: "A|B|C", country: "austria" },
      termBudget: 10,
    });
    expect(runs.map(({ input, cap }) => [input.limit, cap])).toEqual([
      [4, 4],
      [3, 3],
      [3, 3],
    ]);
  });

  it("gives every city at least one result when cities outnumber the budget", () => {
    const runs = inputsFor({
      runGlobals: { city: "A|B|C", country: "austria" },
      termBudget: 2,
    });
    expect(runs.map(({ cap }) => cap)).toEqual([1, 1, 1]);
  });

  it.each([
    ["1", "r86400"],
    ["3", "r604800"],
    ["7", "r604800"],
    ["30", "r2592000"],
    // Wider than the actor can look: clamped to its widest window.
    ["45", "r2592000"],
  ])("buckets a %s-day window to %s", (maxAgeDays, datePosted) => {
    const [input] = inputsOf({
      runGlobals: { city: "Vienna", country: "austria", maxAgeDays },
      termBudget: 10,
    });
    expect(input.datePosted).toBe(datePosted);
  });

  it("sends no date filter without a max age, and the instance's wins", () => {
    const [none] = inputsOf({
      runGlobals: { city: "Vienna", country: "austria" },
      termBudget: 10,
    });
    expect(none).not.toHaveProperty("datePosted");
    const [instanceWins] = inputsOf({
      runGlobals: { city: "Vienna", country: "austria", maxAgeDays: "30" },
      instance: { maxAgeDays: 1 },
      termBudget: 10,
    });
    expect(instanceWins.datePosted).toBe("r86400");
  });

  it("keeps the instance's own input fields and overrides only its own", () => {
    const [input] = inputsOf({
      runGlobals: { city: "Vienna", country: "austria" },
      termBudget: 10,
      base: { under10Applicants: true, keywords: "stale" },
    });
    expect(input.under10Applicants).toBe(true);
    expect(input.keywords).toBe("Data Scientist");
  });

  it("returns no run for a blank term", () => {
    expect(inputsOf({ runGlobals: {}, searchTerms: ["  "] })).toEqual([]);
  });
});

describe("valigLinkedinTemplate.mapItem", () => {
  const row = {
    id: "4474330420",
    url: "https://uk.linkedin.com/jobs/view/data-scientist-at-harnham-4474330420",
    title: "Data Scientist",
    location: "London, England, United Kingdom",
    postedDate: "2026-10-01T00:00:00.000Z",
    companyName: "Harnham",
    companyUrl: "https://uk.linkedin.com/company/harnham",
    experienceLevel: "Mid-Senior level",
    contractType: "Full-time",
    workType: "Financial Services",
    sector: "",
    salary: "£55,000.00/yr - £65,000.00/yr",
    applyType: "EXTERNAL",
    description: "First paragraph.Second paragraph.",
    descriptionHtml: "<p>First paragraph.</p><p>Second paragraph.</p>",
    applyUrl: "https://careers.example.com/apply/1",
  };

  it("maps a row, reading the industry out of `workType`", () => {
    expect(
      valigLinkedinTemplate.mapItem(row, { sourceId: "apify:instance-v" }),
    ).toEqual({
      source: "apify:instance-v",
      title: "Data Scientist",
      employer: "Harnham",
      jobUrl: row.url,
      sourceJobId: "4474330420",
      employerUrl: "https://uk.linkedin.com/company/harnham",
      location: "London, England, United Kingdom",
      jobDescription: "First paragraph.\n\nSecond paragraph.",
      datePosted: "2026-10-01T00:00:00.000Z",
      jobType: "Full-time",
      jobLevel: "Mid-Senior level",
      companyIndustry: "Financial Services",
      salary: "£55,000.00/yr - £65,000.00/yr",
      applicationLink: "https://careers.example.com/apply/1",
    });
  });

  it("falls back to the plain description, and drops empty optional fields", () => {
    const job = valigLinkedinTemplate.mapItem(
      { ...row, descriptionHtml: "", salary: "", applyUrl: "" },
      { sourceId: "apify:instance-v" },
    );
    expect(job?.jobDescription).toBe("First paragraph.Second paragraph.");
    expect(job).not.toHaveProperty("salary");
    expect(job).not.toHaveProperty("applicationLink");
  });

  it("drops a row with no url or no title", () => {
    const ctx = { sourceId: "apify:instance-v" };
    expect(valigLinkedinTemplate.mapItem({ ...row, url: "" }, ctx)).toBeNull();
    expect(
      valigLinkedinTemplate.mapItem({ ...row, title: "  " }, ctx),
    ).toBeNull();
    expect(valigLinkedinTemplate.mapItem(null, ctx)).toBeNull();
  });

  it("names an employer the row leaves out Unknown", () => {
    const job = valigLinkedinTemplate.mapItem(
      { ...row, companyName: "" },
      { sourceId: "apify:instance-v" },
    );
    expect(job?.employer).toBe("Unknown");
  });
});

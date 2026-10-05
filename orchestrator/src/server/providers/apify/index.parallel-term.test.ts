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

import {
  ApifyApiError,
  type ApifyRunOutcome,
  type RunActorArgs,
  runApifyActor,
} from "./client";
import { apifyProvider } from "./index";

const valigInstance = {
  id: "inst-v",
  providerId: "apify",
  actorRef: "valig/linkedin-jobs-scraper",
  label: "LinkedIn (valig)",
  templateId: "valig-linkedin",
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  maxJobs: null,
  maxAgeDays: null,
} as unknown as ProviderInstanceRow;

const oneCity = {
  city: "Vienna",
  country: "austria",
  maxJobsPerTerm: "50",
} as SourceConfigRunGlobals;

type ValigInput = {
  keywords: string;
  location?: string;
  limit: number;
  titleInclude: string[];
};

const valigItem = (key: string, n: number) => ({
  id: `${key}-${n}`,
  url: `https://at.linkedin.com/jobs/view/${key}-${n}`,
  title: `${key} ${n}`,
  companyName: "ACME",
});

/** A run the test settles by hand, so it can choose the completion order. */
type Pending = {
  input: ValigInput;
  args: RunActorArgs;
  resolve: (outcome: ApifyRunOutcome) => void;
  reject: (error: unknown) => void;
};

let pending: Pending[] = [];
let inFlight = 0;
let maxInFlight = 0;

function holdRuns() {
  vi.mocked(runApifyActor).mockImplementation(
    (args) =>
      new Promise<ApifyRunOutcome>((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const settle =
          <T>(fn: (value: T) => void) =>
          (value: T) => {
            inFlight -= 1;
            fn(value);
          };
        pending.push({
          input: args.input as ValigInput,
          args,
          resolve: settle(resolve),
          reject: settle(reject),
        });
      }),
  );
}

// Lets the pool's workers reach their next `runApifyActor` call.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function runFor(keywords: string, location?: string): Pending {
  const run = pending.find(
    (p) =>
      p.input.keywords === keywords &&
      (location === undefined || p.input.location === location),
  );
  if (!run) throw new Error(`no run for ${keywords} ${location ?? ""}`);
  return run;
}

const succeed = (run: Pending, count: number) =>
  run.resolve({
    items: Array.from({ length: count }, (_, n) =>
      valigItem(`${run.input.keywords}@${run.input.location}`, n),
    ),
    status: "SUCCEEDED",
  });

beforeEach(() => {
  vi.mocked(runApifyActor).mockReset();
  pending = [];
  inFlight = 0;
  maxInFlight = 0;
});

describe("apifyProvider parallel per-term runs (valig)", () => {
  it("runs terms at once, up to the concurrency, and reports them in term order", async () => {
    holdRuns();
    const events: ExtractorProgressEvent[] = [];
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: oneCity,
      apiToken: "tok",
      searchTerms: ["AI Engineer", "Data Scientist", "Agent Engineer"],
      termBudgets: { "ai engineer": 12 },
      termRunConcurrency: 2,
      onProgress: (event) => events.push(event),
    });
    await flush();

    // Two of three started; the third waits for a slot.
    expect(pending.map((p) => p.input.keywords)).toEqual([
      "AI Engineer",
      "Data Scientist",
    ]);
    // The second term finishes first; the third takes its slot.
    succeed(runFor("Data Scientist"), 3);
    await flush();
    expect(pending.map((p) => p.input.keywords)).toContain("Agent Engineer");
    succeed(runFor("Agent Engineer"), 1);
    await flush();
    // AI Engineer still running: a term processed count that only grows.
    expect(events.at(-1)?.termsProcessed).toBe(2);
    succeed(runFor("AI Engineer"), 12);

    const result = await resultPromise;
    expect(maxInFlight).toBe(2);
    expect(result.success).toBe(true);
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 12, scraped: 12, status: "capped" },
      { term: "Data Scientist", budget: 50, scraped: 3, status: "under" },
      { term: "Agent Engineer", budget: 50, scraped: 1, status: "under" },
    ]);
    // Rows come back in term order, not completion order.
    expect(result.jobs.map((job) => job.title.split("@")[0])).toEqual([
      ...Array(12).fill("AI Engineer"),
      ...Array(3).fill("Data Scientist"),
      "Agent Engineer",
    ]);
    expect(events.map((event) => event.termsProcessed)).toEqual([0, 1, 2, 3]);
  });

  it("sends each term with its title filter, budget and the actor's run timeout", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, maxAgeDays: "2" },
      apiToken: "tok",
      searchTerms: ["Data Scientist"],
      termRunConcurrency: 4,
    });
    await flush();

    const [run] = pending;
    expect(run.input).toEqual({
      keywords: "Data Scientist",
      titleInclude: ["Data Scientist"],
      location: "Vienna, Austria",
      limit: 50,
      datePosted: "r604800",
    });
    expect(run.args.timeoutSecs).toBe(1200);
    // valig has no ranked results to stop early on.
    expect(run.args.watch).toBeUndefined();
    succeed(run, 0);
    await resultPromise;
  });

  it("searches each city separately and sums them into the term", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, city: "Vienna|Graz" },
      apiToken: "tok",
      searchTerms: ["AI Engineer"],
      termBudgets: { "ai engineer": 21 },
      termRunConcurrency: 4,
    });
    await flush();

    // The budget is split across the cities, adding up to it.
    expect(pending.map((p) => [p.input.location, p.input.limit])).toEqual([
      ["Vienna, Austria", 11],
      ["Graz, Austria", 10],
    ]);
    succeed(runFor("AI Engineer", "Graz, Austria"), 10);
    succeed(runFor("AI Engineer", "Vienna, Austria"), 11);

    const result = await resultPromise;
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 21, scraped: 21, status: "capped" },
    ]);
    // Within a term, rows follow its city order.
    expect(result.jobs.map((job) => job.location ?? job.title)).toEqual([
      ...Array(11).fill(expect.stringContaining("Vienna")),
      ...Array(10).fill(expect.stringContaining("Graz")),
    ]);
  });

  it("fails a term one of whose cities timed out, keeping every row", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, city: "Vienna|Graz" },
      apiToken: "tok",
      searchTerms: ["AI Engineer", "Data Scientist"],
      termRunConcurrency: 4,
    });
    await flush();

    succeed(runFor("AI Engineer", "Vienna, Austria"), 2);
    runFor("AI Engineer", "Graz, Austria").resolve({
      items: [valigItem("graz", 0)],
      status: "TIMED-OUT",
    });
    succeed(runFor("Data Scientist", "Vienna, Austria"), 1);
    succeed(runFor("Data Scientist", "Graz, Austria"), 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(5);
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 50, scraped: 3, status: "failed" },
      { term: "Data Scientist", budget: 50, scraped: 2, status: "under" },
    ]);
    expect(result.error).toContain('"AI Engineer": Actor run timed out');
  });

  it("starts nothing new after a run throws, letting the runs in flight finish", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: oneCity,
      apiToken: "tok",
      searchTerms: ["A one", "B two", "C three"],
      termRunConcurrency: 2,
    });
    await flush();

    runFor("A one").reject(
      new ApifyApiError("Apify 402: no credit", 402, false),
    );
    await flush();
    // The free slot is not refilled.
    expect(pending.map((p) => p.input.keywords)).toEqual(["A one", "B two"]);
    succeed(runFor("B two"), 2);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(2);
    expect(result.termBudgets).toEqual([
      { term: "A one", budget: 50, scraped: 0, status: "failed" },
      { term: "B two", budget: 50, scraped: 2, status: "under" },
      { term: "C three", budget: 50, scraped: 0, status: "not_run" },
    ]);
    expect(result.error).toContain('"A one": Apify 402: no credit');
    expect(result.error).toContain("1 search term(s) were not searched");
  });

  it("calls a term capped when one city reached its share, whatever the total", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, city: "Vienna|Graz" },
      apiToken: "tok",
      searchTerms: ["AI Engineer", "Data Scientist"],
      termBudgets: { "ai engineer": 20, "data scientist": 20 },
      termRunConcurrency: 4,
    });
    await flush();

    // Vienna had more to give; Graz ran out. The term is short of its
    // budget, but raising it would buy more Vienna postings.
    succeed(runFor("AI Engineer", "Vienna, Austria"), 10);
    succeed(runFor("AI Engineer", "Graz, Austria"), 3);
    // Both cities ran out below their shares.
    succeed(runFor("Data Scientist", "Vienna, Austria"), 9);
    succeed(runFor("Data Scientist", "Graz, Austria"), 9);

    const result = await resultPromise;
    expect(result.termBudgets).toEqual([
      { term: "AI Engineer", budget: 20, scraped: 13, status: "capped" },
      { term: "Data Scientist", budget: 20, scraped: 18, status: "under" },
    ]);
  });

  it("fails a term one of whose cities never started", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, city: "Vienna|Graz|Linz" },
      apiToken: "tok",
      searchTerms: ["A one"],
      termRunConcurrency: 2,
    });
    await flush();

    // Vienna dies while Graz runs; Linz, waiting for a slot, never starts.
    runFor("A one", "Vienna, Austria").reject(new Error("boom"));
    await flush();
    expect(pending).toHaveLength(2);
    succeed(runFor("A one", "Graz, Austria"), 1);

    const result = await resultPromise;
    expect(result.jobs).toHaveLength(1);
    expect(result.termBudgets).toEqual([
      { term: "A one", budget: 50, scraped: 1, status: "failed" },
    ]);
    expect(result.error).toBe(
      '"A one": boom; 1 of its 3 searches were not run',
    );
  });

  it("fails a term whose second city never started after another run threw", async () => {
    holdRuns();
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: { ...oneCity, city: "Vienna|Graz" },
      apiToken: "tok",
      searchTerms: ["A one", "B two"],
      termRunConcurrency: 2,
    });
    await flush();

    // A one's two cities hold both slots; Vienna dies, Graz finishes.
    runFor("A one", "Vienna, Austria").reject(new Error("boom"));
    await flush();
    succeed(runFor("A one", "Graz, Austria"), 1);

    const result = await resultPromise;
    expect(result.termBudgets).toEqual([
      { term: "A one", budget: 50, scraped: 1, status: "failed" },
      { term: "B two", budget: 50, scraped: 0, status: "not_run" },
    ]);
  });

  it("starts nothing once the run is cancelled", async () => {
    holdRuns();
    let cancelled = false;
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: oneCity,
      apiToken: "tok",
      searchTerms: ["A one", "B two", "C three"],
      termRunConcurrency: 1,
      shouldCancel: () => cancelled,
    });
    await flush();

    cancelled = true;
    // Rows the aborted run had scraped are not kept: a cancelled pipeline
    // imports nothing anyway.
    runFor("A one").resolve({
      items: [valigItem("a", 0), valigItem("a", 1)],
      status: "ABORTED",
    });

    const result = await resultPromise;
    expect(pending).toHaveLength(1);
    expect(result.jobs).toEqual([]);
    expect(result.termBudgets?.map((outcome) => outcome.status)).toEqual([
      "failed",
      "not_run",
      "not_run",
    ]);
  });

  it("keeps what the runs scraped when a deadline stops them, starting nothing more", async () => {
    holdRuns();
    let expired = false;
    const resultPromise = apifyProvider.run({
      instance: valigInstance,
      runGlobals: oneCity,
      apiToken: "tok",
      searchTerms: ["A one", "B two", "C three"],
      termRunConcurrency: 2,
      deadline: () => expired,
    });
    await flush();

    expired = true;
    // The client sees the deadline as its stop signal and aborts.
    expect(runFor("A one").args.shouldCancel?.()).toBe(true);
    runFor("A one").resolve({
      items: [valigItem("a", 0), valigItem("a", 1)],
      status: "ABORTED",
    });
    succeed(runFor("B two"), 1);

    const result = await resultPromise;
    expect(pending).toHaveLength(2);
    expect(result.jobs).toHaveLength(3);
    expect(result.termBudgets).toEqual([
      { term: "A one", budget: 50, scraped: 2, status: "failed" },
      { term: "B two", budget: 50, scraped: 1, status: "under" },
      { term: "C three", budget: 50, scraped: 0, status: "not_run" },
    ]);
  });

  it("keeps a template without parallelTermRuns sequential whatever the setting", async () => {
    holdRuns();
    const curious = {
      ...valigInstance,
      actorRef: "curious_coder/linkedin-jobs-scraper",
      templateId: "linkedin-jobs-scraper",
    } as ProviderInstanceRow;
    const resultPromise = apifyProvider.run({
      instance: curious,
      runGlobals: oneCity,
      apiToken: "tok",
      searchTerms: ["A one", "B two"],
      termRunConcurrency: 8,
    });
    await flush();
    expect(pending).toHaveLength(1);
    pending[0].resolve({ items: [], status: "SUCCEEDED" });
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].resolve({ items: [], status: "SUCCEEDED" });

    await resultPromise;
    expect(maxInFlight).toBe(1);
    // A template that does not set a run timeout leaves the actor's own.
    expect(pending[0].args.timeoutSecs).toBeUndefined();
  });
});

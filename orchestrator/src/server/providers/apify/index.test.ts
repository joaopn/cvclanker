import type {
  ProviderInstanceRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("./client", async (importActual) => ({
  ...(await importActual<typeof import("./client")>()),
  runApifyActor: vi.fn(),
}));

import { runApifyActor } from "./client";
import { apifyProvider } from "./index";

const instance = {
  id: "inst-1",
  providerId: "apify",
  actorRef: "acme/actor",
  label: "Acme actor",
  templateId: null,
  enabled: true,
  inputTemplateJson: "{}",
  // Freeform mapping: read jobUrl/title/employer straight off each item.
  outputMappingJson: JSON.stringify({
    jobUrl: "url",
    title: "title",
    employer: "company",
  }),
  maxJobs: null,
  maxAgeDays: null,
} as unknown as ProviderInstanceRow;

const context = {
  instance,
  runGlobals: {} as SourceConfigRunGlobals,
  apiToken: "tok",
  searchTerms: ["engineer"],
};

const item = (n: number) => ({
  url: `https://example.com/job/${n}`,
  title: `Job ${n}`,
  company: "ACME",
});

describe("apifyProvider salvage", () => {
  it("returns a TIMED-OUT run's mapped rows as a FAILED result that keeps them", async () => {
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [item(1), item(2), { junk: true }],
      status: "TIMED-OUT",
    });

    const result = await apifyProvider.run(context);

    expect(result.success).toBe(false);
    expect(result.jobs.map((job) => job.title)).toEqual(["Job 1", "Job 2"]);
    expect(result.droppedCount).toBe(1);
    expect(result.error).toMatch(/timed out after scraping 3 item\(s\)/);
    expect(result.error).toMatch(/kept the 2 job\(s\)/);
  });

  it("keeps an ABORTED run's rows when a deadline stopped it, and hands the client the deadline", async () => {
    let expired = false;
    vi.mocked(runApifyActor).mockImplementation(async (args) => {
      expired = true;
      // The client aborts once this reads true.
      expect(args.shouldCancel?.()).toBe(true);
      return { items: [item(1), item(2)], status: "ABORTED" };
    });

    const result = await apifyProvider.run({
      ...context,
      deadline: () => expired,
    });

    expect(result.success).toBe(false);
    expect(result.jobs.map((job) => job.title)).toEqual(["Job 1", "Job 2"]);
    expect(result.error).toMatch(/was aborted after scraping 2 item\(s\)/);
  });

  it("drops an ABORTED run's rows when a cancel stopped it", async () => {
    let cancelled = false;
    vi.mocked(runApifyActor).mockImplementation(async () => {
      cancelled = true;
      return { items: [item(1), item(2)], status: "ABORTED" };
    });

    const result = await apifyProvider.run({
      ...context,
      shouldCancel: () => cancelled,
    });

    expect(result.jobs).toEqual([]);
  });

  it("stays a plain success when the run SUCCEEDED", async () => {
    vi.mocked(runApifyActor).mockResolvedValue({
      items: [item(1)],
      status: "SUCCEEDED",
    });

    const result = await apifyProvider.run(context);

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });
});

import type { RunOptionSource } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  buildRunSelection,
  describeLastScraped,
  findWindowIssues,
  runnableSources,
} from "./runMenu";

const source = (overrides: Partial<RunOptionSource>): RunOptionSource => ({
  key: "jobspy",
  kind: "extractor",
  label: "JobSpy",
  platforms: ["indeed", "linkedin"],
  incompatible: [],
  lastScrapedAt: null,
  capDays: null,
  windowSupport: "run_window",
  maxAgeBuckets: null,
  note: null,
  ...overrides,
});

const instance = (overrides: Partial<RunOptionSource> = {}): RunOptionSource =>
  source({
    key: "apify:abc",
    kind: "provider_instance",
    label: "ACME",
    platforms: [],
    ...overrides,
  });

describe("runnableSources", () => {
  it("drops an extractor with no compatible platform", () => {
    const usable = runnableSources([
      source({ key: "jobspy" }),
      source({ key: "glassdoor", platforms: [] }),
    ]);
    expect(usable.map((entry) => entry.key)).toEqual(["jobspy"]);
  });

  it("keeps a provider instance, which carries no platforms by design", () => {
    expect(runnableSources([instance()])).toHaveLength(1);
  });
});

describe("buildRunSelection", () => {
  const sources = [source({}), instance()];

  /**
   * Everything ticked must send NOTHING. An explicit list freezes the source
   * set at whatever the menu last fetched and is validated against enablement,
   * so a Sources-page toggle in another tab would turn a full selection into a
   * failed run.
   */
  it("sends no scoping when everything is selected", () => {
    expect(
      buildRunSelection(sources, new Set(["jobspy", "apify:abc"])),
    ).toEqual({});
  });

  it("ignores an unrunnable source when deciding 'everything'", () => {
    const withDead = [...sources, source({ key: "glassdoor", platforms: [] })];
    expect(
      buildRunSelection(withDead, new Set(["jobspy", "apify:abc"])),
    ).toEqual({});
  });

  it("expands a selected extractor to its compatible platforms", () => {
    expect(buildRunSelection(sources, new Set(["jobspy"]))).toEqual({
      sources: ["indeed", "linkedin"],
      providerInstanceIds: [],
    });
  });

  it("sends a provider instance by its bare id, not its task key", () => {
    expect(buildRunSelection(sources, new Set(["apify:abc"]))).toEqual({
      sources: [],
      providerInstanceIds: ["abc"],
    });
  });

  it("never emits a platform the profile's location rules out", () => {
    const partial = source({
      platforms: ["indeed"],
      incompatible: [{ platform: "glassdoor", reasons: ["needs a city"] }],
    });
    expect(buildRunSelection([partial, instance()], new Set(["jobspy"])))
      .toEqual({ sources: ["indeed"], providerInstanceIds: [] });
  });
});

describe("findWindowIssues", () => {
  const selected = new Set(["jobspy", "apify:abc"]);

  it("reports nothing without an explicit window", () => {
    expect(
      findWindowIssues({ windowDays: null, sources: [source({})], selectedKeys: selected }),
    ).toEqual([]);
  });

  it("blocks a window over a source's cap", () => {
    const issues = findWindowIssues({
      windowDays: 30,
      sources: [source({ capDays: 7 })],
      selectedKeys: selected,
    });
    expect(issues).toEqual([
      expect.objectContaining({ blocking: true, message: "only allows 7 days" }),
    ]);
  });

  it("ignores a source the run window never reaches", () => {
    for (const windowSupport of ["own_max_age", "ignores"] as const) {
      expect(
        findWindowIssues({
          windowDays: 30,
          sources: [source({ capDays: 7, windowSupport })],
          selectedKeys: selected,
        }),
      ).toEqual([]);
    }
  });

  it("ignores a source the user deselected", () => {
    expect(
      findWindowIssues({
        windowDays: 30,
        sources: [source({ capDays: 7 })],
        selectedKeys: new Set<string>(),
      }),
    ).toEqual([]);
  });

  /**
   * The two bucket directions are different answers: down loses coverage and
   * must block, up merely costs money and must not.
   */
  it("blocks a window the actor would clamp DOWN", () => {
    const issues = findWindowIssues({
      windowDays: 60,
      sources: [instance({ maxAgeBuckets: [1, 7, 30] })],
      selectedKeys: selected,
    });
    expect(issues).toEqual([
      expect.objectContaining({
        blocking: true,
        message: "cannot look back past 30 days",
      }),
    ]);
  });

  it("warns without blocking when the actor rounds UP", () => {
    const issues = findWindowIssues({
      windowDays: 2,
      sources: [instance({ maxAgeBuckets: [1, 7, 30] })],
      selectedKeys: selected,
    });
    expect(issues).toEqual([
      expect.objectContaining({
        blocking: false,
        message: "rounds up to 7 days, and bills per result",
      }),
    ]);
  });

  it("says nothing when the window lands exactly on a bucket", () => {
    expect(
      findWindowIssues({
        windowDays: 7,
        sources: [instance({ maxAgeBuckets: [1, 7, 30] })],
        selectedKeys: selected,
      }),
    ).toEqual([]);
  });
});

describe("describeLastScraped", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("reads never for a source with no mark", () => {
    expect(describeLastScraped(null, now)).toBe("never");
    expect(describeLastScraped("nonsense", now)).toBe("never");
  });

  it("describes recent marks in whole days", () => {
    expect(describeLastScraped("2026-08-28T06:00:00.000Z", now)).toBe("today");
    expect(describeLastScraped("2026-08-27T06:00:00.000Z", now)).toBe("1d ago");
    expect(describeLastScraped("2026-08-20T12:00:00.000Z", now)).toBe("8d ago");
  });
});

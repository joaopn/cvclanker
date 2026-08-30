import { describe, expect, it, vi } from "vitest";

vi.mock("@server/providers", () => ({
  getProvider: vi.fn((providerId: string) =>
    providerId === "apify"
      ? {
          templates: [
            { id: "buckets", maxAgeBuckets: [1, 7, 30] },
            { id: "exact" },
          ],
        }
      : undefined,
  ),
}));

import type { ExtractorRegistry } from "@server/extractors/registry";
import type { ProviderInstanceRow, SourceConfigRow } from "@shared/types";
import {
  extractorHonoursRunWindow,
  findRunWindowViolations,
} from "./run-window";

const manifest = (
  id: string,
  options: { mapsMaxAge?: boolean; enabledByDefault?: boolean } = {},
) => ({
  id,
  displayName: id.toUpperCase(),
  providesSources: [id],
  configSchema: {
    fields: [],
    globalMappings: options.mapsMaxAge
      ? ([
          {
            globalField: "maxAgeDays",
            sourceField: "max_age_days",
            enabledByDefault: options.enabledByDefault ?? true,
          },
        ] as const)
      : [],
  },
});

const registryOf = (manifests: ReturnType<typeof manifest>[]) =>
  ({
    manifests: new Map(manifests.map((m) => [m.id, m])),
    manifestBySource: new Map(manifests.map((m) => [m.id, m])),
    availableSources: manifests.map((m) => m.id),
  }) as unknown as ExtractorRegistry;

const instance = (
  overrides: Partial<ProviderInstanceRow> = {},
): ProviderInstanceRow => ({
  id: "i1",
  providerId: "apify",
  actorRef: "acme/actor",
  label: "ACME",
  templateId: null,
  enabled: true,
  inputTemplateJson: "{}",
  outputMappingJson: "{}",
  mappings: {},
  updatedAt: "",
  ...overrides,
});

const row = (
  extractorId: string,
  mappings: SourceConfigRow["mappings"],
): SourceConfigRow =>
  ({ extractorId, mappings, config: {} }) as unknown as SourceConfigRow;

describe("extractorHonoursRunWindow", () => {
  it("is false for a manifest with no maxAgeDays mapping", () => {
    expect(extractorHonoursRunWindow(manifest("startupjobs"), undefined)).toBe(
      false,
    );
  });

  it("is true when the mapping exists and was never touched", () => {
    expect(
      extractorHonoursRunWindow(
        manifest("jobspy", { mapsMaxAge: true }),
        undefined,
      ),
    ).toBe(true);
  });

  /**
   * An unticked mapping makes the source honour its OWN stored max age and
   * ignore the run entirely, so the run's window cannot exceed a limit that
   * never applies to it.
   */
  /**
   * `resolveSourceContextSettings` falls back to the mapping's own
   * `enabledByDefault`, so defaulting to `true` here would disagree with the
   * runtime for any manifest shipping `false` — refusing a run over a ceiling
   * that never reaches the source.
   */
  it("honours a mapping that is off by default", () => {
    expect(
      extractorHonoursRunWindow(
        manifest("quiet", { mapsMaxAge: true, enabledByDefault: false }),
        undefined,
      ),
    ).toBe(false);
  });

  it("lets an explicit tick override enabledByDefault: false", () => {
    expect(
      extractorHonoursRunWindow(
        manifest("quiet", { mapsMaxAge: true, enabledByDefault: false }),
        row("quiet", { maxAgeDays: true }),
      ),
    ).toBe(true);
  });

  it("is false when the user unticked the mapping", () => {
    expect(
      extractorHonoursRunWindow(
        manifest("jobspy", { mapsMaxAge: true }),
        row("jobspy", { maxAgeDays: false }),
      ),
    ).toBe(false);
  });
});

describe("findRunWindowViolations", () => {
  const base = {
    profileMaxAgeDays: 7,
    registry: registryOf([manifest("jobspy", { mapsMaxAge: true })]),
    sources: ["jobspy"] as never,
    sourceConfigs: [],
    instances: [],
  };

  it("returns nothing when no explicit window was requested", () => {
    expect(findRunWindowViolations({ ...base, windowDays: undefined })).toEqual(
      [],
    );
  });

  it("returns nothing for a window within the cap", () => {
    expect(findRunWindowViolations({ ...base, windowDays: 7 })).toEqual([]);
  });

  it("reports an extractor whose cap the window exceeds", () => {
    expect(findRunWindowViolations({ ...base, windowDays: 30 })).toEqual([
      {
        sourceKey: "jobspy",
        label: "JOBSPY",
        kind: "over_cap",
        limitDays: 7,
      },
    ]);
  });

  it("ignores an extractor that does not honour the run window", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 30,
        registry: registryOf([manifest("startupjobs")]),
        sources: ["startupjobs"] as never,
      }),
    ).toEqual([]);
  });

  it("ignores an extractor whose mapping the user unticked", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 30,
        sourceConfigs: [row("jobspy", { maxAgeDays: false })],
      }),
    ).toEqual([]);
  });

  it("treats an uncapped profile as no ceiling", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 365,
        profileMaxAgeDays: null,
      }),
    ).toEqual([]);
  });

  it("reports a fan-out extractor once, not once per platform", () => {
    const jobspy = manifest("jobspy", { mapsMaxAge: true });
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 30,
        registry: {
          manifests: new Map([["jobspy", jobspy]]),
          manifestBySource: new Map([
            ["indeed", jobspy],
            ["linkedin", jobspy],
            ["glassdoor", jobspy],
          ]),
          availableSources: [],
        } as unknown as ExtractorRegistry,
        sources: ["indeed", "linkedin", "glassdoor"] as never,
      }),
    ).toHaveLength(1);
  });

  it("prefers an instance's own max age over the profile's", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 5,
        sources: [] as never,
        instances: [instance({ maxAgeDays: 2 })],
      }),
    ).toEqual([
      { sourceKey: "apify:i1", label: "ACME", kind: "over_cap", limitDays: 2 },
    ]);
  });

  /**
   * The window is under every cap, so the cap check is silent — but the actor
   * would snap 14 days down to its widest bucket and scrape half of what was
   * asked. Invisible to `over_cap` by construction, which is why it is its own
   * violation kind rather than a warning.
   */
  it("reports an actor that would clamp the window down to a bucket", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 60,
        profileMaxAgeDays: null,
        sources: [] as never,
        instances: [instance({ templateId: "buckets" })],
      }),
    ).toEqual([
      {
        sourceKey: "apify:i1",
        label: "ACME",
        kind: "over_bucket",
        limitDays: 30,
      },
    ]);
  });

  it("does not report a window that merely rounds UP to a bucket", () => {
    // 2 days becomes 7 — more than asked, which costs money but loses nothing.
    // That is a warning the client renders, never a refusal.
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 2,
        profileMaxAgeDays: null,
        sources: [] as never,
        instances: [instance({ templateId: "buckets" })],
      }),
    ).toEqual([]);
  });

  it("does not bucket an actor whose template takes an exact day count", () => {
    expect(
      findRunWindowViolations({
        ...base,
        windowDays: 60,
        profileMaxAgeDays: null,
        sources: [] as never,
        instances: [instance({ templateId: "exact" })],
      }),
    ).toEqual([]);
  });

  it("reports the cap rather than the bucket when both would fire", () => {
    const violations = findRunWindowViolations({
      ...base,
      windowDays: 60,
      profileMaxAgeDays: 7,
      sources: [] as never,
      instances: [instance({ templateId: "buckets" })],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("over_cap");
  });
});

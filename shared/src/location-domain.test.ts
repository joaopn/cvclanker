import { describe, expect, it } from "vitest";
import {
  buildLocationEvidence,
  createLocationIntent,
  createLocationIntentFromLegacyInputs,
  getDefaultLocationSourceCapabilities,
  getLegacyLocationSelection,
  getPrimaryLocationLabel,
  normalizeLocationMatchStrictness,
  planLocationSource,
  planLocationSources,
} from "./location-domain";
import { defaultProfileConfig } from "./types/profile";

describe("location-domain", () => {
  it("defaults match strictness to flexible", () => {
    // Cities are a SEARCH location, not a filter — boards resolve one to a
    // radius, so exact_only pays for every neighbouring town the board returns
    // and then discards it. Must stay in step with defaultProfileConfig(): an
    // intent built without a strictness has to resolve the same way a profile
    // that never stored one does.
    expect(normalizeLocationMatchStrictness(undefined)).toBe("flexible");
    expect(normalizeLocationMatchStrictness(null)).toBe("flexible");
    expect(normalizeLocationMatchStrictness("")).toBe("flexible");
    expect(normalizeLocationMatchStrictness("nonsense")).toBe("flexible");
    // An explicit value still wins, in both directions.
    expect(normalizeLocationMatchStrictness("exact_only")).toBe("exact_only");
    expect(normalizeLocationMatchStrictness("flexible")).toBe("flexible");
    expect(createLocationIntentFromLegacyInputs({}).matchStrictness).toBe(
      "flexible",
    );
    // The lockstep itself: a new profile and an unset intent must agree, or a
    // run and the profile editor disagree about the same profile.
    expect(defaultProfileConfig().locationMatchStrictness).toBe(
      normalizeLocationMatchStrictness(undefined),
    );
  });

  it("normalizes intent values and deduplicates cities and workplace types", () => {
    expect(
      createLocationIntent({
        selectedCountry: "UK",
        cityLocations: ["Leeds", "london", "Leeds"],
        workplaceTypes: ["remote", "onsite", "remote", "hybrid"],
        searchScope: "remote_worldwide_prioritize_selected",
        matchStrictness: "flexible",
      }),
    ).toEqual({
      selectedCountry: "united kingdom",
      country: "united kingdom",
      cityLocations: ["Leeds", "london"],
      remoteProfile: false,
      remoteLocationBlocklist: [],
      workplaceTypes: ["remote", "onsite", "hybrid"],
      geoScope: "remote_worldwide_prioritize_selected",
      searchScope: "remote_worldwide_prioritize_selected",
      matchStrictness: "flexible",
    });
  });

  it("normalizes legacy intent inputs and evidence payloads", () => {
    expect(
      createLocationIntentFromLegacyInputs({
        country: "UK",
        searchCities: "Leeds|London",
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "flexible",
      }),
    ).toEqual({
      selectedCountry: "united kingdom",
      country: "united kingdom",
      cityLocations: ["Leeds", "London"],
      remoteProfile: false,
      remoteLocationBlocklist: [],
      workplaceTypes: [],
      geoScope: "selected_plus_remote_worldwide",
      searchScope: "selected_plus_remote_worldwide",
      matchStrictness: "flexible",
    });

    expect(
      buildLocationEvidence([
        {
          kind: "location",
          value: "Remote - Worldwide",
          sourceField: "location",
        },
        {
          kind: "country",
          value: "UK",
        },
      ]),
    ).toMatchObject({
      location: "Remote - Worldwide",
      country: "united kingdom",
      source: null,
      isRemote: true,
    });
  });

  it("keeps sources compatible when a country is selected", () => {
    const result = planLocationSources({
      intent: {
        selectedCountry: "united states",
        cityLocations: ["New York"],
        workplaceTypes: ["remote"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "exact_only",
      },
      sources: ["indeed", "startupjobs"],
    });

    expect(result.compatibleSources).toEqual(["indeed", "startupjobs"]);
    expect(result.incompatibleSources).toEqual([]);
  });

  it("exposes legacy location labels for compatibility", () => {
    const intent = createLocationIntent({
      selectedCountry: "croatia",
      cityLocations: ["Zagreb"],
      workplaceTypes: ["remote"],
      searchScope: "remote_worldwide_prioritize_selected",
      matchStrictness: "exact_only",
    });

    expect(getLegacyLocationSelection(intent)).toBe("croatia");
    expect(getPrimaryLocationLabel(intent)).toBe("Zagreb in Croatia");
    expect(
      getPrimaryLocationLabel({
        selectedCountry: "UK",
        cityLocations: ["Leeds", "London"],
      }),
    ).toBe("Leeds and London in United Kingdom");
  });

  it("exposes default source capabilities for known sources", () => {
    expect(getDefaultLocationSourceCapabilities("startupjobs")).toEqual({
      requiresCountry: true,
      requiresRemoteProfile: false,
      source: "startupjobs",
    });
  });

  it("treats worldwide as an explicit selected country", () => {
    expect(
      createLocationIntent({
        selectedCountry: "worldwide",
        cityLocations: [],
        workplaceTypes: ["remote"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "exact_only",
      }),
    ).toMatchObject({
      selectedCountry: "worldwide",
      country: "worldwide",
    });
  });

  it("marks country-scoped sources incompatible when no country is selected", () => {
    const result = planLocationSources({
      intent: {
        selectedCountry: null,
        cityLocations: [],
        workplaceTypes: ["remote"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "exact_only",
      },
      sources: ["linkedin", "startupjobs"],
    });

    // startup.jobs needs a country OR a city (it would silently return
    // nothing with neither), so with no cities it is skipped.
    expect(result.compatibleSources).toEqual(["linkedin"]);
    expect(result.incompatibleSources).toEqual(["startupjobs"]);
    expect(result.plans[1]?.reasons).toContain(
      "A selected country or city is required for this source.",
    );
  });
});

describe("remote-type profile plumbing", () => {
  it("normalizes remoteProfile and defaults it off", () => {
    expect(createLocationIntent({}).remoteProfile).toBe(false);
    expect(createLocationIntent({ remoteProfile: true }).remoteProfile).toBe(
      true,
    );
  });

  it("survives the legacy-inputs re-derivation runPipeline performs", () => {
    // runPipeline rebuilds the run's intent through this function; a field
    // missing from its input literal is silently stripped before discovery.
    const intent = createLocationIntent({
      selectedCountry: "portugal",
      remoteProfile: true,
      remoteLocationBlocklist: [" US only ", "us only", "Colorado"],
    });
    const rederived = createLocationIntentFromLegacyInputs(intent);
    expect(rederived.remoteProfile).toBe(true);
    // Trimmed + case-insensitively deduped on the way in, preserved on the
    // way through.
    expect(rederived.remoteLocationBlocklist).toEqual(["US only", "Colorado"]);
  });

  it("gates a remote-only source on the profile flag, read from its metadata", () => {
    const blocked = planLocationSource({
      intent: { selectedCountry: "portugal", workplaceTypes: ["remote"] },
      source: "himalayas",
    });
    expect(blocked).toMatchObject({ isCompatible: false, canRun: false });
    expect(blocked.reasons).toContain("Only runs on a remote-type profile.");

    const allowed = planLocationSource({
      intent: {
        selectedCountry: "portugal",
        workplaceTypes: ["remote"],
        remoteProfile: true,
      },
      source: "himalayas",
    });
    expect(allowed).toMatchObject({ isCompatible: true, canRun: true });
  });

  it("leaves sources without the capability unaffected by the flag", () => {
    const plan = planLocationSource({
      intent: {
        selectedCountry: "portugal",
        workplaceTypes: ["remote"],
        remoteProfile: true,
      },
      source: "startupjobs",
    });
    expect(plan).toMatchObject({ isCompatible: true, canRun: true });
  });

  it("skips a country-requiring source on a country-less remote run", () => {
    // Remote runs carry no country; startup.jobs would return nothing, so
    // it is excluded with a reason (and from the per-term budget divisor).
    const plan = planLocationSource({
      intent: { selectedCountry: "", remoteProfile: true },
      source: "startupjobs",
    });
    expect(plan).toMatchObject({ isCompatible: false, canRun: false });
    expect(plan.reasons).toContain(
      "A selected country or city is required for this source.",
    );
    // A city alone satisfies it: startup.jobs searches its city list first.
    expect(
      planLocationSource({
        intent: { selectedCountry: "", cityLocations: ["Berlin"] },
        source: "startupjobs",
      }),
    ).toMatchObject({ isCompatible: true, canRun: true });
  });
});

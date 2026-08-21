import { describe, expect, it } from "vitest";
import {
  buildLocationEvidence,
  createLocationIntent,
  createLocationIntentFromLegacyInputs,
  describeLocationIntent,
  getLegacyLocationSelection,
  getPrimaryLocationLabel,
  normalizeLocationSourceCapabilities,
  planLocationSource,
  planLocationSources,
} from "./location-domain";

describe("location-domain", () => {
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

  it("describes location intent using the current preference wording", () => {
    expect(
      describeLocationIntent({
        selectedCountry: "UK",
        cityLocations: ["Leeds", "London"],
        workplaceTypes: ["remote", "hybrid", "onsite"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "flexible",
      }),
    ).toBe(
      "You'll get hybrid and onsite jobs in Leeds and London in United Kingdom plus remote jobs worldwide. Likely matches are included.",
    );
  });

  it("plans source compatibility based on the selected country", () => {
    const result = planLocationSources({
      intent: {
        selectedCountry: "united states",
        cityLocations: ["New York"],
        workplaceTypes: ["remote"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "exact_only",
      },
      sources: ["indeed", "glassdoor", "startupjobs"],
    });

    expect(result.compatibleSources).toEqual([
      "indeed",
      "glassdoor",
      "startupjobs",
    ]);
    expect(result.incompatibleSources).toEqual([]);
  });

  it("marks glassdoor incompatible until at least one city is provided", () => {
    const result = planLocationSources({
      intent: {
        selectedCountry: "united kingdom",
        cityLocations: [],
        workplaceTypes: ["remote"],
        searchScope: "selected_only",
        matchStrictness: "exact_only",
      },
      sources: ["glassdoor", "linkedin"],
    });

    expect(result.compatibleSources).toEqual(["linkedin"]);
    expect(result.incompatibleSources).toEqual(["glassdoor"]);
    expect(result.plans[0]).toMatchObject({
      source: "glassdoor",
      isCompatible: false,
      canRun: false,
    });
    expect(result.plans[0]?.reasons).toContain(
      "At least one city is required for this source.",
    );
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
  });

  it("exposes normalized source capabilities for known sources", () => {
    expect(
      normalizeLocationSourceCapabilities({ source: "startupjobs" }),
    ).toEqual({
      requiresCityLocations: false,
      requiresRemoteProfile: false,
      source: "startupjobs",
      supportedCountryKeys: null,
    });
    expect(
      normalizeLocationSourceCapabilities({ source: "glassdoor" }),
    ).toMatchObject({
      requiresCityLocations: true,
      source: "glassdoor",
    });
  });

  it("preserves default city requirements when overriding supported countries", () => {
    expect(
      normalizeLocationSourceCapabilities({
        source: "glassdoor",
        supportedCountryKeys: ["united kingdom"],
      }),
    ).toEqual({
      requiresCityLocations: true,
      requiresRemoteProfile: false,
      source: "glassdoor",
      supportedCountryKeys: ["united kingdom"],
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
      sources: ["glassdoor", "startupjobs"],
    });

    expect(result.compatibleSources).toEqual(["startupjobs"]);
    expect(result.incompatibleSources).toEqual(["glassdoor"]);
    expect(result.plans[0]).toMatchObject({
      source: "glassdoor",
      isCompatible: false,
      canRun: false,
    });
    expect(result.plans[0]?.reasons).toContain(
      "A selected country is required for this source.",
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
    });
    expect(createLocationIntentFromLegacyInputs(intent).remoteProfile).toBe(
      true,
    );
  });

  it("gates a requiresRemoteProfile source on the profile flag", () => {
    const capabilities = {
      source: "himalayas",
      requiresRemoteProfile: true,
    };
    const blocked = planLocationSource({
      intent: { selectedCountry: "portugal", workplaceTypes: ["remote"] },
      source: "himalayas",
      capabilities,
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
      capabilities,
    });
    expect(allowed).toMatchObject({ isCompatible: true, canRun: true });
  });

  it("keeps requiresRemoteProfile through the capabilities normalizer", () => {
    // planLocationSource routes EVERY capabilities value through the
    // normalizer's field-by-field rebuild — a field dropped there fails the
    // gate open on every profile.
    expect(
      normalizeLocationSourceCapabilities({
        source: "himalayas",
        requiresRemoteProfile: true,
      }).requiresRemoteProfile,
    ).toBe(true);
    expect(
      normalizeLocationSourceCapabilities({ source: "startupjobs" })
        .requiresRemoteProfile,
    ).toBe(false);
  });

  it("derives the gate from source metadata on the default-capabilities path", () => {
    // No explicit capabilities: this exercises metadata -> defaults ->
    // normalizer end to end, so a dropped metadata flag fails the test, not
    // just the explicit-capabilities path above.
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
});

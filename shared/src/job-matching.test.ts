import { describe, expect, it } from "vitest";
import {
  describeLocationRejection,
  matchJobLocationIntent,
} from "./job-matching";
import { createLocationIntent } from "./location-domain";

const intentFor = (overrides: Parameters<typeof createLocationIntent>[0]) =>
  createLocationIntent({
    workplaceTypes: ["remote", "hybrid", "onsite"],
    searchScope: "selected_plus_remote_worldwide",
    matchStrictness: "exact_only",
    ...overrides,
  });

describe("matchJobLocationIntent", () => {
  it("matches a country named by ISO alpha-2 in the location tail", () => {
    const austria = intentFor({ selectedCountry: "austria" });
    expect(
      matchJobLocationIntent({ location: "Wien, W, AT" }, austria),
    ).toMatchObject({ matched: true, reasonCode: "selected_location" });

    const canada = intentFor({ selectedCountry: "canada" });
    expect(
      matchJobLocationIntent({ location: "Toronto, ON, CA" }, canada),
    ).toMatchObject({ matched: true });
  });

  it("still rejects a coded location from another country", () => {
    const uk = intentFor({
      selectedCountry: "united kingdom",
      cityLocations: ["London", "Cambridge"],
    });
    expect(
      matchJobLocationIntent({ location: "Toronto, ON, CA" }, uk).matched,
    ).toBe(false);
  });

  it("keeps a location that names no country as the requested country", () => {
    const countryOnly = intentFor({ selectedCountry: "united kingdom" });
    expect(
      matchJobLocationIntent({ location: "Greater Reading Area" }, countryOnly),
    ).toMatchObject({ matched: true, reasonCode: "selected_location" });

    const flexible = intentFor({
      selectedCountry: "netherlands",
      cityLocations: ["Amsterdam", "Eindhoven"],
      matchStrictness: "flexible",
    });
    expect(
      matchJobLocationIntent({ location: "Brabantine City Row" }, flexible)
        .matched,
    ).toBe(true);

    const austria = intentFor({ selectedCountry: "austria" });
    expect(
      matchJobLocationIntent({ location: "Vienna or Graz" }, austria).matched,
    ).toBe(true);
  });

  it("does not let a country-less location bypass a city requirement", () => {
    const exactOnly = intentFor({
      selectedCountry: "united kingdom",
      cityLocations: ["London", "Cambridge"],
    });
    expect(
      matchJobLocationIntent({ location: "Greater Reading Area" }, exactOnly)
        .matched,
    ).toBe(false);
  });

  it("still rejects a row that names another country outright", () => {
    const flexible = intentFor({
      selectedCountry: "united kingdom",
      cityLocations: ["London", "Cambridge"],
      matchStrictness: "flexible",
    });
    expect(
      matchJobLocationIntent({ location: "Toronto, Ontario, Canada" }, flexible)
        .matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { location: "Washington, United States" },
        flexible,
      ).matched,
    ).toBe(false);
    // A bare state code is a jurisdiction we cannot assume is the requested one.
    expect(
      matchJobLocationIntent({ location: "Wenatchee, WA" }, flexible).matched,
    ).toBe(false);
  });

  it("leaves a placeless location to the remote arm", () => {
    const selectedOnly = intentFor({
      selectedCountry: "united kingdom",
      searchScope: "selected_only",
      matchStrictness: "flexible",
    });
    expect(
      matchJobLocationIntent({ location: "Remote" }, selectedOnly).matched,
    ).toBe(false);

    const withRemote = intentFor({
      selectedCountry: "united kingdom",
      matchStrictness: "flexible",
    });
    expect(
      matchJobLocationIntent(
        { location: "Remote", isRemote: true },
        withRemote,
      ),
    ).toMatchObject({ matched: true, reasonCode: "remote_worldwide" });
  });

  it("judges an evidence country even when the location text omits it", () => {
    const uk = intentFor({ selectedCountry: "united kingdom" });
    expect(
      matchJobLocationIntent(
        {
          location: "Greater Toronto Area",
          locationEvidence: {
            location: "Greater Toronto Area",
            country: "Canada",
            city: "Toronto",
            workplaceType: "onsite",
          },
        },
        uk,
      ).matched,
    ).toBe(false);
  });
  it("names the check that failed on a reject", () => {
    const uk = intentFor({
      selectedCountry: "united kingdom",
      cityLocations: ["London", "Cambridge"],
    });

    expect(
      matchJobLocationIntent({ location: "Toronto, Ontario, Canada" }, uk)
        .reasonCode,
    ).toBe("no_country_match");
    // In the country, but not in a city the profile listed.
    expect(
      matchJobLocationIntent({ location: "Leeds, England, United Kingdom" }, uk)
        .reasonCode,
    ).toBe("no_city_match");

    const countryOnly = intentFor({ selectedCountry: "united kingdom" });
    expect(
      matchJobLocationIntent(
        { location: "Toronto, Ontario, Canada" },
        countryOnly,
      ).reasonCode,
    ).toBe("no_country_match");
  });

  it("describes a rejection in one readable line", () => {
    const uk = intentFor({
      selectedCountry: "united kingdom",
      cityLocations: ["London"],
    });

    expect(describeLocationRejection("no_country_match", uk)).toBe(
      "location mismatch: outside United Kingdom",
    );
    expect(describeLocationRejection("no_city_match", uk)).toBe(
      "location mismatch: in United Kingdom, but not in a selected city",
    );
    // An accept code has no rejection to describe; the generic line is the
    // honest fallback rather than a sentence claiming a specific failure.
    expect(describeLocationRejection("selected_location", uk)).toBe(
      "location mismatch",
    );
  });
});

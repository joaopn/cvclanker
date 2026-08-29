import { describe, expect, it } from "vitest";
import {
  locationCountryUnspecified,
  matchesRequestedCity,
  matchesRequestedCountry,
  parseSearchCitiesSetting,
  resolveSearchCities,
  serializeSearchCitiesSetting,
  shouldApplyStrictCityFilter,
} from "./search-cities";

describe("search-cities", () => {
  it("parses and deduplicates search cities", () => {
    expect(parseSearchCitiesSetting("Leeds|london|Leeds")).toEqual([
      "Leeds",
      "london",
    ]);
    expect(parseSearchCitiesSetting("Leeds\nLondon\nleeds")).toEqual([
      "Leeds",
      "London",
    ]);
    expect(parseSearchCitiesSetting("")).toEqual([]);
  });

  it("serializes search cities", () => {
    expect(serializeSearchCitiesSetting(["Leeds", "London"])).toBe(
      "Leeds|London",
    );
    expect(serializeSearchCitiesSetting([])).toBeNull();
  });

  it("resolves search cities from list/single/env/fallback", () => {
    expect(
      resolveSearchCities({
        list: [" Leeds ", "London", "leeds"],
      }),
    ).toEqual(["Leeds", "London"]);

    expect(resolveSearchCities({ single: "Leeds|London" })).toEqual([
      "Leeds",
      "London",
    ]);
    expect(resolveSearchCities({ env: "Leeds\nLondon" })).toEqual([
      "Leeds",
      "London",
    ]);
    expect(resolveSearchCities({ fallback: "UK" })).toEqual(["UK"]);
  });

  it("falls back when single/env values parse to empty", () => {
    expect(resolveSearchCities({ single: "", fallback: "UK" })).toEqual(["UK"]);
    expect(resolveSearchCities({ single: "||", fallback: "UK" })).toEqual([
      "UK",
    ]);
    expect(resolveSearchCities({ env: "   ", fallback: "UK" })).toEqual(["UK"]);
  });

  it("returns empty array when all resolve options are empty", () => {
    expect(
      resolveSearchCities({
        list: [],
        single: "",
        env: "",
        fallback: "",
      }),
    ).toEqual([]);
  });

  it("applies strict filter only when city differs from country", () => {
    expect(shouldApplyStrictCityFilter("Leeds", "united kingdom")).toBe(true);
    expect(shouldApplyStrictCityFilter("UK", "united kingdom")).toBe(false);
    expect(shouldApplyStrictCityFilter("usa", "united states")).toBe(false);
  });

  it("matches by whole location tokens and avoids substring false positives", () => {
    expect(matchesRequestedCity("Leeds, England, UK", "Leeds")).toBe(true);
    expect(matchesRequestedCity("Manchester, England, UK", "Chester")).toBe(
      false,
    );
    expect(
      matchesRequestedCity("New York, NY, United States", "new york"),
    ).toBe(true);
  });

  it("matches requested countries using canonical names and common aliases", () => {
    expect(matchesRequestedCountry("Zagreb, Croatia", "croatia")).toBe(true);
    expect(
      matchesRequestedCountry("Leeds, England, UK", "united kingdom"),
    ).toBe(true);
    expect(
      matchesRequestedCountry(
        "Austin, Texas, United States of America",
        "united states",
      ),
    ).toBe(true);
    expect(matchesRequestedCountry("Bengaluru, India", "croatia")).toBe(false);
    expect(matchesRequestedCountry(undefined, "croatia")).toBe(false);
  });

  it("matches an ISO alpha-2 country code in the location tail", () => {
    expect(matchesRequestedCountry("Wien, W, AT", "austria")).toBe(true);
    expect(matchesRequestedCountry("Toronto, ON, CA", "canada")).toBe(true);
    expect(matchesRequestedCountry("London, ENG, GB", "united kingdom")).toBe(
      true,
    );
    expect(matchesRequestedCountry("london, eng, gb", "uk")).toBe(true);

    expect(matchesRequestedCountry("Toronto, ON, CA", "austria")).toBe(false);
    // The tail is the country code, so a state code that collides with another
    // country's alpha-2 must not match it.
    expect(matchesRequestedCountry("Chicago, IL, US", "israel")).toBe(false);
  });

  it("requires three segments before reading a tail as a country code", () => {
    // "City, ST" is a US state, not a country: DE is Delaware here, not Germany.
    expect(matchesRequestedCountry("Wilmington, DE", "germany")).toBe(false);
    expect(matchesRequestedCountry("Wenatchee, WA", "spain")).toBe(false);
    expect(matchesRequestedCountry("AT", "austria")).toBe(false);
  });

  it("treats a location that names no country as country-unspecified", () => {
    expect(locationCountryUnspecified(["Greater Reading Area"])).toBe(true);
    expect(locationCountryUnspecified(["Utrecht Area"])).toBe(true);
    expect(locationCountryUnspecified(["Brabantine City Row"])).toBe(true);
    expect(locationCountryUnspecified(["Amsterdam Area", "Amsterdam"])).toBe(
      true,
    );
    // A non-geographic candidate rides alongside a real one without hiding it.
    expect(locationCountryUnspecified(["Amsterdam Area", "remote"])).toBe(true);
  });

  it("does not treat a named or coded country as unspecified", () => {
    expect(locationCountryUnspecified(["Toronto, Ontario, Canada"])).toBe(
      false,
    );
    expect(locationCountryUnspecified(["Washington, United States"])).toBe(
      false,
    );
    expect(locationCountryUnspecified(["London, England, UK"])).toBe(false);
    expect(locationCountryUnspecified(["Wenatchee, WA"])).toBe(false);
    expect(locationCountryUnspecified(["Toronto, ON, CA"])).toBe(false);
    // One country-naming candidate is enough to decide the whole set.
    expect(
      locationCountryUnspecified([
        "Amsterdam Area",
        "Toronto, Ontario, Canada",
      ]),
    ).toBe(false);
  });

  it("does not treat a placeless location as country-unspecified", () => {
    expect(locationCountryUnspecified([])).toBe(false);
    expect(locationCountryUnspecified(["Remote"])).toBe(false);
    expect(locationCountryUnspecified(["Remote - Worldwide"])).toBe(false);
    expect(locationCountryUnspecified(["Anywhere"])).toBe(false);
    expect(locationCountryUnspecified([""])).toBe(false);
  });

  it("matches a city across diacritic spellings, in both directions", () => {
    // The prod case: the user types the ASCII spelling (which is also what is
    // sent to LinkedIn, where it resolves correctly) and the board answers with
    // its own accented canonical spelling.
    expect(matchesRequestedCity("Málaga, Andalusia, Spain", "Malaga")).toBe(
      true,
    );
    expect(
      matchesRequestedCity("Greater Málaga Metropolitan Area", "Malaga"),
    ).toBe(true);
    expect(matchesRequestedCity("Malaga, Andalusia, Spain", "Málaga")).toBe(
      true,
    );
    expect(matchesRequestedCity("Zürich, Switzerland", "Zurich")).toBe(true);
    expect(
      matchesRequestedCity("Kraków, Lesser Poland, Poland", "Krakow"),
    ).toBe(true);
    expect(matchesRequestedCity("Wrocław, Poland", "Wroclaw")).toBe(true);
    // Same spelling on both sides kept working — this is the case that always
    // passed, because both sides were mangled identically.
    expect(matchesRequestedCity("Málaga, Andalusia, Spain", "Málaga")).toBe(
      true,
    );
  });

  it("folding does not widen which CITY counts as a match", () => {
    // A different city is still a different city.
    expect(
      matchesRequestedCity("Sant Cugat del Vallès, Catalonia, Spain", "Malaga"),
    ).toBe(false);
    expect(matchesRequestedCity("Valencia, Spain", "Malaga")).toBe(false);
    // A folded prefix is not a token match: "Malag" is not "Malaga".
    expect(matchesRequestedCity("Málaga, Andalusia, Spain", "Malag")).toBe(
      false,
    );
    // Exonyms are a translation, not a normalization, and stay unmatched.
    expect(matchesRequestedCity("München, Bavaria, Germany", "Munich")).toBe(
      false,
    );
  });

  it("folding DOES widen the country-name index, by design", () => {
    // Honest record of a real consequence, not an accident. The index is built
    // by tokenizing every country name, so folding re-spells six of them and
    // `reunion` / `curacao` become single-token runs that ordinary English
    // place text can hit. namesAnyCountry matches any contiguous sub-run and
    // locationCountryUnspecified NEGATES it, so "Reunion Tower Area" stops
    // qualifying for the country-less fallback and is rejected on a US profile
    // where it used to be kept.
    //
    // Accepted rather than fixed: the hazard class is PRE-EXISTING and much
    // larger than these two words — `georgia`, `jersey`, `malta`, `chad`,
    // `guinea`, `peru` and friends are already single-token runs, so
    // "Jersey City" and "Georgia, Atlanta" reject on the base commit too.
    // Narrowing that is its own change with its own measurement; this test
    // exists so the widening is a recorded decision.
    expect(locationCountryUnspecified(["Reunion Tower Area"])).toBe(false);
    expect(locationCountryUnspecified(["Curacao Plaza"])).toBe(false);
    // Pre-existing members of the same class, unchanged by this commit.
    expect(locationCountryUnspecified(["Jersey City"])).toBe(false);
    // And the fold REMOVES one bogus run: base carried "land islands" from the
    // mangled "Åland Islands", so this used to read as naming a country.
    expect(locationCountryUnspecified(["Land Islands Business Park"])).toBe(
      true,
    );
  });

  it("matches a country across diacritic spellings", () => {
    expect(matchesRequestedCountry("Istanbul, Türkiye", "turkey")).toBe(true);
    expect(matchesRequestedCountry("Istanbul, Turkiye", "turkey")).toBe(true);
    // A location naming a country in either spelling is not country-less, so
    // the "country not contradicted" fallback correctly stops applying.
    expect(locationCountryUnspecified(["Istanbul, Turkiye"])).toBe(false);
  });
});

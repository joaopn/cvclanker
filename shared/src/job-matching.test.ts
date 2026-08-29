import { describe, expect, it } from "vitest";
import {
  describeLocationRejection,
  matchJobLocationIntent,
  titleRestrictionSegments,
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
  it("ranks a country-matched remote job above the remote-worldwide arm under flexible", () => {
    // The one behaviour change of this flag beyond the keep/drop decision. A
    // job that matches the country, misses every city, and is flagged remote
    // returns from the REMOTE arm under exact_only (priority 0) and from the
    // country arm under flexible (priority 1). selectJobsStep uses priority as
    // the within-category tie-break, so the same job can now displace another
    // from the auto-tailor slice.
    const job = {
      location: "Manchester, England, United Kingdom",
      isRemote: true,
    };
    const base = {
      selectedCountry: "united kingdom",
      cityLocations: ["London"],
      workplaceTypes: ["remote" as const],
      searchScope: "remote_worldwide_prioritize_selected" as const,
    };
    expect(
      matchJobLocationIntent(
        job,
        intentFor({ ...base, matchStrictness: "exact_only" }),
      ),
    ).toEqual({
      matched: true,
      reasonCode: "remote_worldwide",
      priority: 0,
    });
    expect(
      matchJobLocationIntent(
        job,
        intentFor({ ...base, matchStrictness: "flexible" }),
      ),
    ).toEqual({
      matched: true,
      reasonCode: "selected_location",
      priority: 1,
    });
  });

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

describe("matchJobLocationIntent — remote-type profile", () => {
  const remoteIntent = (
    blocklist: string[],
    country: string | null = "portugal",
  ) =>
    intentFor({
      selectedCountry: country,
      workplaceTypes: ["remote"],
      remoteProfile: true,
      remoteLocationBlocklist: blocklist,
    });

  it("keeps everything when the blocklist is empty, whatever the country", () => {
    for (const location of ["United States", "Anywhere in the World", "EMEA"]) {
      expect(
        matchJobLocationIntent({ location }, remoteIntent([])),
      ).toMatchObject({ matched: true, reasonCode: "remote_worldwide" });
    }
    expect(matchJobLocationIntent({}, remoteIntent(["US only"]))).toMatchObject(
      { matched: true, reasonCode: "remote_worldwide" },
    );
  });

  it("drops a posting whose location matches a blocklist entry", () => {
    expect(
      matchJobLocationIntent(
        { location: "USA Only" },
        remoteIntent(["US only"]),
      ),
    ).toMatchObject({ matched: false, reasonCode: "remote_location_blocked" });
  });

  it("matches punctuation-blind and country-alias-aware on both sides", () => {
    const blocked = remoteIntent(["US-only"]);
    for (const location of ["USA Only", "United States Only", "us only"]) {
      expect(matchJobLocationIntent({ location }, blocked).matched).toBe(false);
    }
    // An entry is a contiguous run: "US only" does not block a bare country.
    expect(
      matchJobLocationIntent({ location: "United States" }, blocked).matched,
    ).toBe(true);
    expect(
      matchJobLocationIntent(
        { location: "United States" },
        remoteIntent(["United States"]),
      ).matched,
    ).toBe(false);
  });

  it("scans the title's restriction segments and the evidence fields", () => {
    const blocked = remoteIntent(["US only"]);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer (US Only)", location: "Remote" },
        blocked,
      ).matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer - US only", location: "Remote" },
        blocked,
      ).matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer - US-only", location: "Remote" },
        blocked,
      ).matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer (U.S. only)", location: "Remote" },
        blocked,
      ).matched,
    ).toBe(false);
    // A lowercase "us" in text is the pronoun, never the country — a bare
    // "US" entry must not block "help us scale" (leading free text is not
    // scanned either, but a separator tail is).
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer — help us scale", location: "Remote" },
        remoteIntent(["US"]),
      ).matched,
    ).toBe(true);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer — US", location: "Remote" },
        remoteIntent(["US"]),
      ).matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { locationEvidence: { location: "North America Only" } },
        remoteIntent(["north america only"]),
      ).matched,
    ).toBe(false);
  });

  it("keeps the pronoun-us protection alive on an accented title", () => {
    // Guards the fold inside pronounUsIndices. That function bails when its
    // own word split disagrees with tokenizeLocation, and the tokenizer folds
    // — so an UNFOLDED split counts "Zürich" as two words against the
    // tokenizer's one, the guard bails, protection switches off, and the
    // pronoun "us" canonicalises to the country. Every other pronoun case in
    // this file is pure ASCII, where the two sides agree either way.
    expect(
      matchJobLocationIntent(
        {
          title: "Senior Engineer — Zürich, help us scale",
          location: "Remote",
        },
        remoteIntent(["United States"]),
      ).matched,
    ).toBe(true);
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer — Málaga, help us grow", location: "Remote" },
        remoteIntent(["US"]),
      ).matched,
    ).toBe(true);
    // The country itself is still blocked from an accented title.
    expect(
      matchJobLocationIntent(
        { title: "Senior Engineer — Zürich, US only", location: "Remote" },
        remoteIntent(["United States"]),
      ).matched,
    ).toBe(false);
  });

  it("blocks a country variant in either spelling", () => {
    // Guards the fold inside rawLocationTokens, which keys the variant index.
    // "Istanbul, Türkiye" matches a "turkey" blocklist entry TODAY; folding
    // only the tokenizer would break that, because the index would still hold
    // the mangled run while the text side emits the folded one.
    for (const location of ["Istanbul, Türkiye", "Istanbul, Turkiye"]) {
      expect(
        matchJobLocationIntent({ location }, remoteIntent(["turkey"])).matched,
      ).toBe(false);
    }
    expect(
      matchJobLocationIntent(
        { location: "Istanbul, Türkiye" },
        remoteIntent(["spain"]),
      ).matched,
    ).toBe(true);
  });

  it("drops a posting the source explicitly flags as not remote", () => {
    // jobspy's LinkedIn/Indeed legs leak on-site rows past their remote
    // filters but report per-row remoteness (board attribute or keyword
    // scan); unknown (hiring.cafe) stays kept.
    expect(
      matchJobLocationIntent(
        { location: "North Carolina, United States", isRemote: false },
        remoteIntent([]),
      ),
    ).toMatchObject({ matched: false, reasonCode: "not_remote" });
    expect(
      matchJobLocationIntent(
        { location: "North Carolina, United States", isRemote: true },
        remoteIntent([]),
      ).matched,
    ).toBe(true);
    expect(
      matchJobLocationIntent(
        { location: "North Carolina, United States" },
        remoteIntent([]),
      ).matched,
    ).toBe(true);
    expect(describeLocationRejection("not_remote", remoteIntent([]))).toBe(
      "the source flags this posting as not remote",
    );
  });

  it("is not a whitelist: an unlisted foreign restriction is kept", () => {
    expect(
      matchJobLocationIntent(
        { location: "Germany" },
        remoteIntent(["US only"], "portugal"),
      ),
    ).toMatchObject({ matched: true, reasonCode: "remote_worldwide" });
  });

  it("applies with no country selected at all", () => {
    expect(
      matchJobLocationIntent(
        { location: "USA Only" },
        remoteIntent(["US only"], null),
      ).matched,
    ).toBe(false);
  });

  it("ignores city lists and strictness on a remote profile", () => {
    const withCities = intentFor({
      selectedCountry: "portugal",
      cityLocations: ["Lisbon"],
      workplaceTypes: ["remote"],
      remoteProfile: true,
      remoteLocationBlocklist: [],
    });
    expect(
      matchJobLocationIntent({ location: "Berlin, Germany" }, withCities)
        .matched,
    ).toBe(true);
  });

  it("leaves the non-remote path untouched when the flag is off", () => {
    expect(
      matchJobLocationIntent(
        { location: "United States" },
        intentFor({ selectedCountry: "portugal" }),
      ).matched,
    ).toBe(false);
    expect(
      matchJobLocationIntent(
        { location: "EMEA" },
        intentFor({ selectedCountry: "portugal" }),
      ).matched,
    ).toBe(true);
  });

  it("describes the blocklist rejection", () => {
    expect(
      describeLocationRejection("remote_location_blocked", remoteIntent([])),
    ).toBe("location matches the remote profile's blocklist");
  });
});

describe("titleRestrictionSegments", () => {
  it("extracts bracketed and trailing-separator segments only", () => {
    expect(titleRestrictionSegments("Senior Engineer (US Only)")).toEqual([
      "US Only",
    ]);
    expect(
      titleRestrictionSegments("Engineer [EMEA] - Remote | US only"),
    ).toEqual(["EMEA", "US only"]);
    // In-word hyphens are not separators: the advertised "US-only" phrasing
    // survives in a dash tail, and "Full-Stack" yields no false tail.
    expect(titleRestrictionSegments("Senior Engineer - US-only")).toEqual([
      "US-only",
    ]);
    expect(titleRestrictionSegments("Full-Stack Engineer")).toEqual([]);
    expect(
      titleRestrictionSegments("Acme: Senior Engineer (Remote, US)"),
    ).toEqual(["Remote, US", "Senior Engineer"]);
    expect(titleRestrictionSegments("Plain title")).toEqual([]);
    expect(titleRestrictionSegments(null)).toEqual([]);
  });
});

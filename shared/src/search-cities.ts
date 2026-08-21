import { countryKeyToIso2, listKnownCountryKeys } from "./country-codes.js";
import {
  normalizeCountryKey,
  SUPPORTED_COUNTRY_INPUTS,
} from "./location-support.js";

const LOCATION_ALIASES: Record<string, string> = {
  uk: "united kingdom",
  us: "united states",
  usa: "united states",
};

const COUNTRY_LOCATION_VARIANTS: Record<string, string[]> = {
  "united kingdom": [
    "uk",
    "great britain",
    "britain",
    "england",
    "scotland",
    "wales",
    "northern ireland",
  ],
  "united states": ["us", "usa", "united states of america"],
  // The boards spell these two ways; without the variant a resident's own
  // country false-rejects ("Europe, Türkiye" for a Turkey profile). Conscious
  // widening: the czechia variant also reaches the non-remote path, where it
  // only ADDS accepts.
  turkey: ["türkiye"],
  czechia: ["czech republic"],
};

// A location string that names no place at all ("Remote", "Worldwide") is not a
// country-LESS location, it is an absent one: it is no evidence for the selected
// country either way, and the remote arm of the matcher is what owns those jobs.
const NON_GEOGRAPHIC_LOCATION_TOKENS = new Set([
  "all",
  "anywhere",
  "from",
  "global",
  "globally",
  "home",
  "hybrid",
  "on",
  "onsite",
  "remote",
  "remotely",
  "site",
  "virtual",
  "wfh",
  "work",
  "worldwide",
]);

const REGION_CODE_PATTERN = /^[a-z]{2}$/;

// Indeed formats a location as `City, REGION, CC` ("Wien, W, AT"), so the alpha-2
// country code is the third segment. Requiring three segments is what stops a
// bare US state tail ("Wilmington, DE") reading as a country code.
const MIN_SEGMENTS_FOR_COUNTRY_CODE = 3;

interface CountryNameIndex {
  runs: Set<string>;
  maxTokens: number;
}

// Lazily built for the same reason the ISO map is: the region-name enumeration
// behind it costs ~10ms and most importers never ask a location question.
let countryNameIndex: CountryNameIndex | null = null;

function getCountryNameIndex(): CountryNameIndex {
  if (!countryNameIndex) {
    const runs = buildCountryNameTokenRuns();
    countryNameIndex = {
      runs,
      maxTokens: Math.max(
        ...Array.from(runs, (name) => name.split(" ").length),
      ),
    };
  }
  return countryNameIndex;
}

function buildCountryNameTokenRuns(): Set<string> {
  const names = [
    ...listKnownCountryKeys(),
    ...SUPPORTED_COUNTRY_INPUTS,
    ...Object.keys(LOCATION_ALIASES),
    ...Object.values(LOCATION_ALIASES),
    ...Object.keys(COUNTRY_LOCATION_VARIANTS),
    ...Object.values(COUNTRY_LOCATION_VARIANTS).flat(),
  ];

  const runs = new Set<string>();
  for (const name of names) {
    const tokens = tokenizeLocation(name);
    if (tokens.length > 0) runs.add(tokens.join(" "));
  }
  return runs;
}

export function tokenizeLocation(value: string | null | undefined): string[] {
  const normalized = normalizeLocationToken(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized ? normalized.split(" ") : [];
}

function splitLocationSegments(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The trailing alpha-2 code of a `City, REGION, CC` location, lowercased. */
function trailingCountryCode(jobLocation: string | undefined): string | null {
  const segments = splitLocationSegments(jobLocation);
  if (segments.length < MIN_SEGMENTS_FOR_COUNTRY_CODE) return null;
  const tail = segments[segments.length - 1].toLowerCase();
  return REGION_CODE_PATTERN.test(tail) ? tail : null;
}

/**
 * True when the location ends in a two-letter code of any kind — a country code
 * ("Toronto, ON, CA") or a bare state code ("Wenatchee, WA"). Either way the
 * location names a jurisdiction we cannot assume is the requested one.
 */
function hasTrailingRegionCode(jobLocation: string | undefined): boolean {
  const segments = splitLocationSegments(jobLocation);
  if (segments.length < 2) return false;
  return REGION_CODE_PATTERN.test(segments[segments.length - 1].toLowerCase());
}

function namesAnyCountry(jobLocation: string | undefined): boolean {
  const tokens = tokenizeLocation(jobLocation);
  const { runs, maxTokens } = getCountryNameIndex();
  for (let start = 0; start < tokens.length; start += 1) {
    const maxLength = Math.min(maxTokens, tokens.length - start);
    for (let length = 1; length <= maxLength; length += 1) {
      if (runs.has(tokens.slice(start, start + length).join(" "))) {
        return true;
      }
    }
  }
  return false;
}

export function isNonGeographicLocation(
  jobLocation: string | undefined,
): boolean {
  const tokens = tokenizeLocation(jobLocation);
  if (tokens.length === 0) return true;
  return tokens.every((token) => NON_GEOGRAPHIC_LOCATION_TOKENS.has(token));
}

/**
 * True when the job's location candidates name a place but never name a country
 * — "Greater Reading Area", "Utrecht Area", "Brabantine City Row". Such a string
 * is no evidence of a MISmatch, so the caller may fall back to the country the
 * scrape was actually asked for. A candidate that names a country, or carries a
 * trailing region code, is judged on that instead.
 */
export function locationCountryUnspecified(
  candidates: readonly string[],
): boolean {
  const geographic = candidates.filter(
    (candidate) => !isNonGeographicLocation(candidate),
  );
  if (geographic.length === 0) return false;
  return geographic.every(
    (candidate) =>
      !namesAnyCountry(candidate) && !hasTrailingRegionCode(candidate),
  );
}

export function normalizeLocationToken(
  value: string | null | undefined,
): string {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!normalized) return "";
  return LOCATION_ALIASES[normalized] ?? normalized;
}

export function parseSearchCitiesSetting(
  value: string | null | undefined,
): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const split = trimmed.includes("|")
    ? trimmed.split("|")
    : trimmed.includes("\n")
      ? trimmed.split("\n")
      : [trimmed];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of split) {
    const normalized = raw.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

interface ResolveSearchCitiesOptions {
  list?: string[] | null;
  single?: string | null;
  env?: string | null;
  fallback?: string | null;
}

export function resolveSearchCities(
  options: ResolveSearchCitiesOptions,
): string[] {
  // Priority order:
  // 1) explicit list (searchCities array in config)
  // 2) explicit single value
  // 3) environment fallback
  // 4) final hardcoded/default fallback
  if (options.list && options.list.length > 0) {
    const parsedList = parseSearchCitiesSetting(options.list.join("|"));
    if (parsedList.length > 0) return parsedList;
  }

  const fallbackCandidates = [options.single, options.env, options.fallback];
  for (const candidate of fallbackCandidates) {
    if (candidate === null || candidate === undefined) continue;
    const parsed = parseSearchCitiesSetting(candidate);
    if (parsed.length > 0) return parsed;
  }

  return [];
}

export function serializeSearchCitiesSetting(cities: string[]): string | null {
  if (cities.length === 0) return null;
  return cities.join("|");
}

export function shouldApplyStrictCityFilter(
  city: string,
  country: string,
): boolean {
  const normalizedCity = normalizeLocationToken(city);
  const normalizedCountry = normalizeCountryKey(country);
  if (!normalizedCity || !normalizedCountry) return false;
  return normalizedCity !== normalizedCountry;
}

export function matchesRequestedCity(
  jobLocation: string | undefined,
  requestedCity: string,
): boolean {
  return matchesRequestedLocationTokens(jobLocation, requestedCity);
}

function matchesRequestedLocationTokens(
  jobLocation: string | undefined,
  requestedLocation: string,
): boolean {
  const jobTokens = tokenizeLocation(jobLocation);
  const requestedTokens = tokenizeLocation(requestedLocation);
  if (jobTokens.length === 0 || requestedTokens.length === 0) return false;
  if (requestedTokens.length > jobTokens.length) return false;

  for (let i = 0; i <= jobTokens.length - requestedTokens.length; i += 1) {
    let matches = true;
    for (let j = 0; j < requestedTokens.length; j += 1) {
      if (jobTokens[i + j] !== requestedTokens[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }

  return false;
}

export function matchesRequestedCountry(
  jobLocation: string | undefined,
  requestedCountry: string,
): boolean {
  const normalizedCountry = normalizeCountryKey(requestedCountry);
  if (!normalizedCountry) return false;

  const candidates = [
    normalizedCountry,
    ...(COUNTRY_LOCATION_VARIANTS[normalizedCountry] ?? []),
  ];

  if (
    candidates.some((candidate) =>
      matchesRequestedLocationTokens(jobLocation, candidate),
    )
  ) {
    return true;
  }

  // Indeed names the country by ISO alpha-2 in the location tail and never
  // spells it out, so a country-only profile rejected 100% of its results.
  const iso2 = countryKeyToIso2(normalizedCountry);
  return (
    iso2 !== null && trailingCountryCode(jobLocation) === iso2.toLowerCase()
  );
}

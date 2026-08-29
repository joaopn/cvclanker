import { countryKeyToIso2, listKnownCountryKeys } from "./country-codes.js";
import {
  foldDiacritics,
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
  "united states": ["us", "usa", "u.s.", "u.s.a.", "united states of america"],
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

function tokenizeLocation(value: string | null | undefined): string[] {
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

function isNonGeographicLocation(jobLocation: string | undefined): boolean {
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
  // Folded here rather than in the tokenizer, so every consumer of this
  // function — the city and country matchers, the country-name index, the
  // non-geographic test — agrees on one spelling. LOCATION_ALIASES keys are
  // ASCII, so folding the input cannot make one unreachable. NOT
  // shouldApplyStrictCityFilter: it compares this against normalizeCountryKey,
  // which applies a DIFFERENT alias table, so "Türkiye" vs "türkiye" still
  // reads as city-unequal-to-country there. Pre-existing, unchanged here.
  const normalized = foldDiacritics(
    value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "",
  );
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

// Variant token-run → canonical country tokens ("usa" → "united states",
// "great britain" → "united kingdom"), built lazily from the same variant
// table the country matcher uses. Lets a blocklist entry and a board's
// location string meet on one spelling whichever each side chose.
let variantRunIndex: { runs: Map<string, string[]>; maxTokens: number } | null =
  null;

function getVariantRunIndex(): {
  runs: Map<string, string[]>;
  maxTokens: number;
} {
  if (!variantRunIndex) {
    const runs = new Map<string, string[]>();
    for (const [country, variants] of Object.entries(
      COUNTRY_LOCATION_VARIANTS,
    )) {
      const canonical = tokenizeLocation(country);
      for (const variant of variants) {
        // Raw tokens on purpose: tokenizeLocation would whole-string-alias
        // "us"/"usa"/"uk" to their canonical names first, so those runs
        // would never enter the index and "US only" vs "USA Only" could
        // never meet.
        const run = rawLocationTokens(variant).join(" ");
        if (run) runs.set(run, canonical);
      }
    }
    variantRunIndex = {
      runs,
      maxTokens: Math.max(
        1,
        ...Array.from(runs.keys(), (run) => run.split(" ").length),
      ),
    };
  }
  return variantRunIndex;
}

/** Lowercased, diacritic-folded alphanumeric tokens with NO alias rewriting. */
function rawLocationTokens(value: string | null | undefined): string[] {
  // Folds independently because this deliberately bypasses
  // normalizeLocationToken. It is BOTH a regression guard and a widening. The
  // variant index below is keyed on these tokens, so folding only the tokenizer
  // would leave the index holding the mangled run "t rkiye" while the text side
  // emits "turkiye" — and an "Istanbul, Türkiye" row that a Turkey blocklist
  // matches TODAY would stop matching. It also newly puts the run "turkiye"
  // into that index, so the ASCII spelling starts matching as well.
  const normalized = foldDiacritics((value ?? "").trim().toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized ? normalized.split(" ") : [];
}

/**
 * Indices of tokens that must NOT be read as a country: a lowercase "us" in
 * free text is the pronoun ("help us scale"), while "US"/"USA"/"U.S." is the
 * country. Only the text side asks for this — a blocklist ENTRY "us" was
 * typed by someone who means the country.
 */
function pronounUsIndices(value: string | null | undefined): Set<number> {
  const protectedIndices = new Set<number>();
  // Folded before the split, and case-preserving so the "US" test below still
  // sees the original casing. Load-bearing: the length guard underneath
  // compares this split against tokenizeLocation, which folds via
  // normalizeLocationToken. An unfolded split counts "Málaga" as two words
  // against the tokenizer's one, so every accented title would bail out of the
  // guard and silently lose its pronoun protection.
  const rawWords = foldDiacritics((value ?? "").trim())
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // The raw split and tokenizeLocation agree token-for-token unless the
  // whole string is an alias ("usa", or a bare "us" → "united states"); a
  // segment that is nothing but "us" reads as a sloppy-case country, not a
  // pronoun, so leaving it unprotected is the right call.
  if (rawWords.length !== tokenizeLocation(value).length)
    return protectedIndices;
  rawWords.forEach((word, index) => {
    if (word.toLowerCase() === "us" && word !== "US")
      protectedIndices.add(index);
  });
  return protectedIndices;
}

function canonicalizeLocationTokens(
  value: string | null | undefined,
  options: { protectPronounUs?: boolean } = {},
): string[] {
  const tokens = tokenizeLocation(value);
  const protectedIndices = options.protectPronounUs
    ? pronounUsIndices(value)
    : new Set<number>();
  const { runs, maxTokens } = getVariantRunIndex();
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    let replaced = false;
    for (
      let length = Math.min(maxTokens, tokens.length - index);
      length >= 1;
      length -= 1
    ) {
      const canonical =
        length === 1 && protectedIndices.has(index)
          ? undefined
          : runs.get(tokens.slice(index, index + length).join(" "));
      if (canonical) {
        out.push(...canonical);
        index += length;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return out;
}

/**
 * Remote-profile blocklist test: does `text` contain the blocklist `entry`?
 * Case-insensitive, punctuation-blind ("US-only" ~ "us only"), and
 * country-alias-aware on BOTH sides ("US only" matches "USA Only" and
 * "United States Only"). An entry is a contiguous token run, so "US only"
 * does not match a bare "United States". `protectPronounUs` is for free
 * text (titles), where a lowercase "us" is a pronoun, never the country;
 * location fields pass it off, a lowercase "us only" there IS the country.
 */
export function matchesBlockedLocation(
  text: string | null | undefined,
  entry: string,
  options: { protectPronounUs?: boolean } = {},
): boolean {
  const entryTokens = canonicalizeLocationTokens(entry);
  const textTokens = canonicalizeLocationTokens(text, {
    protectPronounUs: options.protectPronounUs === true,
  });
  if (entryTokens.length === 0 || textTokens.length === 0) return false;
  if (entryTokens.length > textTokens.length) return false;
  for (let i = 0; i <= textTokens.length - entryTokens.length; i += 1) {
    let matches = true;
    for (let j = 0; j < entryTokens.length; j += 1) {
      if (textTokens[i + j] !== entryTokens[j]) {
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

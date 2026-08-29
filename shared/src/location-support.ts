import type { JobSource } from "./types";

const COUNTRY_ALIASES: Record<string, string> = {
  uk: "united kingdom",
  us: "united states",
  usa: "united states",
  türkiye: "turkey",
  "czech republic": "czechia",
};

// Letters no NFD decomposition can reach: they are their own base letter, with
// no combining mark to strip. Only the ones that occur in place names we
// ingest, and BOTH cases of each — foldDiacritics preserves case, so an entry
// present in one case only would make folding stop commuting with lowercasing,
// which is the invariant `pronounUsIndices` depends on (see foldDiacritics).
// `ı` deliberately has no uppercase entry: it uppercases to plain ASCII "I",
// which needs no folding.
const STANDALONE_LETTER_FOLDS: Record<string, string> = {
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ħ: "h",
  Ħ: "H",
  ı: "i",
};

// Keys are escaped rather than concatenated raw: they are all single letters
// today, but an unescaped "-" added later would silently turn the class into a
// RANGE that compiles and over-matches. Two things this does NOT protect
// against, both developer errors with no type-level guard (the record indexes
// as `string` — `noUncheckedIndexedAccess` is off): an empty-string key emits
// a literal `\u{undefined}` and throws at MODULE LOAD, and a multi-character
// key contributes only its first code point to the class while the lookup then
// misses and inserts the string "undefined". Keys must be single characters.
const STANDALONE_LETTER_PATTERN = new RegExp(
  `[${Object.keys(STANDALONE_LETTER_FOLDS)
    .map((letter) => `\\u{${letter.codePointAt(0)?.toString(16)}}`)
    .join("")}]`,
  "gu",
);

/**
 * Drop diacritics from place text so one spelling of a name matches another:
 * "Málaga" and "Malaga", "Zürich" and "Zurich", "Kraków" and "Krakow".
 *
 * This is the ONE place that decision is made for the app's own LOCATION
 * matching — the pipeline's filter, the remote blocklist, and the two search
 * surfaces that read `job.location` (the Manage facets and the command bar).
 * Three things deliberately stay outside it: `trailingCountryCode` /
 * `hasTrailingRegionCode`, which test ISO alpha-2 and are ASCII by
 * construction; `extractors/hiringcafe/src/country-map.ts`, which carries its
 * own unfolded copy of normalizeCountryKey for the search payload it emits
 * (self-consistent today, a separate slice to unify); and TITLE/COMPANY
 * matching, which is a different domain and stays diacritic-sensitive
 * throughout — `normalizeTitleKey` (duplicate grouping, where being
 * conservative is the standing rule), `normalizeCompanyName`, and the job-title
 * filter badges in useFilteredJobs/swipeFilters.
 *
 * It exists because the alternative is what shipped before:
 * the tokenizer squashed anything outside `[a-z0-9]` to a space, so an accented
 * letter became a token BREAK ("Málaga" -> ["m", "laga"]) and a city the user
 * typed in ASCII could never match the board's own accented spelling — every
 * result for that city was scraped, paid for and rejected.
 *
 * Case-PRESERVING: `pronounUsIndices` distinguishes "US" from "us" on the raw
 * string and has to fold before it splits.
 *
 * It is a normalization, not a translation: "München" folds to "munchen", never
 * "munich". Exonyms need an alias table and are deliberately not handled here.
 */
export function foldDiacritics(value: string): string {
  // Provable identity shortcut: NFD/NFC are no-ops on pure ASCII, no ASCII
  // character is a combining mark, and every STANDALONE_LETTER_FOLDS key is
  // non-ASCII — so an all-ASCII string folds to itself. Worth the test because
  // this now runs per row inside the Manage view's facet predicates, where a
  // description facet over a few thousand full jobs is the hot case.
  if (!/[^\p{ASCII}]/u.test(value)) return value;
  return (
    value
      .normalize("NFD")
      // The combining-marks block only, NOT \p{M}: this has to reach every
      // Latin/Greek/Cyrillic accent and nothing else. \p{M} would also strip
      // Japanese dakuten and Indic vowel signs, which collides characters that
      // are not accent variants of each other — invisible in the tokenizers
      // (they squash non-ASCII anyway) but observable through the exported
      // normalizeLocationToken.
      .replace(/[\u0300-\u036f]/g, "")
      .replace(
        STANDALONE_LETTER_PATTERN,
        (letter) => STANDALONE_LETTER_FOLDS[letter],
      )
      // Back to composed form. Without this the function returns DECOMPOSED
      // text for everything it did not fold — canonically equal to the input
      // but not string-equal to it, which matters because normalizeLocationToken
      // is exported and compared with `includes` outside the tokenizers.
      .normalize("NFC")
  );
}

// The alias keys are matched against folded input, so they are folded too —
// otherwise the accented "türkiye" key could never be hit again.
//
// Must stay ABOVE GLASSDOOR_SUPPORTED_COUNTRIES and SUPPORTED_COUNTRY_KEYS: both
// call normalizeCountryKey during module evaluation, and this is a const, so
// moving it below them throws a ReferenceError at import time — which takes out
// the server boot and the client bundle (any importing test fails too, so the
// suite does catch it).
//
// Object.fromEntries keeps the LAST entry on a key collision. None collide
// today; a future accented alias that folds onto an existing key would vanish
// silently.
const FOLDED_COUNTRY_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(COUNTRY_ALIASES).map(([alias, country]) => [
    foldDiacritics(alias),
    country,
  ]),
);

const COUNTRY_LABELS: Record<string, string> = {
  "united kingdom": "United Kingdom",
  "united states": "United States",
  "usa/ca": "USA/CA",
  turkey: "Turkey",
  czechia: "Czechia",
};

// Keep this list aligned with the JobSpy supported country inputs.
export const SUPPORTED_COUNTRY_INPUTS = [
  "argentina",
  "australia",
  "austria",
  "bahrain",
  "bangladesh",
  "belgium",
  "bulgaria",
  "brazil",
  "canada",
  "chile",
  "china",
  "colombia",
  "costa rica",
  "croatia",
  "cyprus",
  "czech republic",
  "czechia",
  "denmark",
  "ecuador",
  "egypt",
  "estonia",
  "finland",
  "france",
  "germany",
  "greece",
  "hong kong",
  "hungary",
  "india",
  "indonesia",
  "ireland",
  "israel",
  "italy",
  "japan",
  "kuwait",
  "latvia",
  "lithuania",
  "luxembourg",
  "malaysia",
  "malta",
  "mexico",
  "morocco",
  "netherlands",
  "new zealand",
  "nigeria",
  "norway",
  "oman",
  "pakistan",
  "panama",
  "peru",
  "philippines",
  "poland",
  "portugal",
  "qatar",
  "romania",
  "saudi arabia",
  "singapore",
  "slovakia",
  "slovenia",
  "south africa",
  "south korea",
  "spain",
  "sweden",
  "switzerland",
  "taiwan",
  "thailand",
  "türkiye",
  "turkey",
  "ukraine",
  "united arab emirates",
  "uk",
  "united kingdom",
  "usa",
  "us",
  "united states",
  "uruguay",
  "venezuela",
  "vietnam",
  "usa/ca",
  "worldwide",
] as const;

const GLASSDOOR_SUPPORTED_COUNTRIES = new Set(
  [
    "australia",
    "austria",
    "belgium",
    "brazil",
    "canada",
    "france",
    "germany",
    "hong kong",
    "india",
    "ireland",
    "italy",
    "mexico",
    "netherlands",
    "new zealand",
    "singapore",
    "spain",
    "switzerland",
    "united kingdom",
    "united states",
    "vietnam",
  ].map((country) => normalizeCountryKey(country)),
);
export function normalizeCountryKey(value: string | null | undefined): string {
  const normalized = foldDiacritics(value?.trim().toLowerCase() ?? "");
  return FOLDED_COUNTRY_ALIASES[normalized] ?? normalized;
}

export function formatCountryLabel(value: string): string {
  const normalized = normalizeCountryKey(value);
  if (!normalized) return "";
  return (
    COUNTRY_LABELS[normalized] ||
    normalized.replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

export const SUPPORTED_COUNTRY_KEYS = Array.from(
  new Set(
    SUPPORTED_COUNTRY_INPUTS.map((country) => normalizeCountryKey(country)),
  ),
).filter(Boolean);

export function isUkCountry(country: string | null | undefined): boolean {
  return normalizeCountryKey(country) === "united kingdom";
}

export function isGlassdoorCountry(
  country: string | null | undefined,
): boolean {
  return GLASSDOOR_SUPPORTED_COUNTRIES.has(normalizeCountryKey(country));
}

export function isSourceAllowedForCountry(
  source: JobSource,
  country: string | null | undefined,
): boolean {
  if (source === "glassdoor") return isGlassdoorCountry(country);
  return true;
}

export function getCompatibleSourcesForCountry(
  sources: JobSource[],
  country: string | null | undefined,
): JobSource[] {
  return sources.filter((source) => isSourceAllowedForCountry(source, country));
}

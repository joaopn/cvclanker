import { normalizeCountryKey } from "./location-support.js";
import { tokenizeLocation } from "./search-cities.js";

/**
 * Region-eligibility vocabulary for remote-type profiles.
 *
 * The remote boards express who may apply as a region ("EMEA", "Europe Only",
 * "Anywhere in the World") rather than a country. This module answers two
 * questions the matcher's remote branch asks about one candidate string:
 * is it universally eligible, and does it name a region that contains the
 * selected country? Unknown region tokens deliberately answer "no" — for a
 * remote profile a false reject is cheaper than importing a row the user
 * cannot apply to.
 *
 * Keys and lookups both go through `tokenizeLocation`, the same tokenizer the
 * rest of location matching uses. That is load-bearing: it strips diacritics
 * ("Türkiye" tokenizes as `t rkiye`), so a raw-string map key would silently
 * never match. A trailing "only" token (We Work Remotely's "<X> Only" grammar)
 * is dropped before lookup for the same reason.
 */

const UNIVERSAL_REMOTE_RUNS = new Set([
  "anywhere in the world",
  "anywhere",
  "worldwide",
  "global",
  "remote",
]);

const EU_COUNTRIES = [
  "austria",
  "belgium",
  "bulgaria",
  "croatia",
  "cyprus",
  "czechia",
  "denmark",
  "estonia",
  "finland",
  "france",
  "germany",
  "greece",
  "hungary",
  "ireland",
  "italy",
  "latvia",
  "lithuania",
  "luxembourg",
  "malta",
  "netherlands",
  "poland",
  "portugal",
  "romania",
  "slovakia",
  "slovenia",
  "spain",
  "sweden",
] as const;

const EUROPE_COUNTRIES = [
  ...EU_COUNTRIES,
  "norway",
  "switzerland",
  "ukraine",
  "united kingdom",
] as const;

const MIDDLE_EAST_COUNTRIES = [
  "bahrain",
  "israel",
  "kuwait",
  "oman",
  "qatar",
  "saudi arabia",
  "turkey",
  "united arab emirates",
] as const;

const AFRICA_COUNTRIES = [
  "egypt",
  "morocco",
  "nigeria",
  "south africa",
] as const;

const ASIA_COUNTRIES = [
  "bangladesh",
  "china",
  "hong kong",
  "india",
  "indonesia",
  "japan",
  "malaysia",
  "pakistan",
  "philippines",
  "singapore",
  "south korea",
  "taiwan",
  "thailand",
  "vietnam",
] as const;

const OCEANIA_COUNTRIES = ["australia", "new zealand"] as const;

const NORTH_AMERICA_COUNTRIES = ["canada", "mexico", "united states"] as const;

const SOUTH_AMERICA_COUNTRIES = [
  "argentina",
  "brazil",
  "chile",
  "colombia",
  "ecuador",
  "peru",
  "uruguay",
  "venezuela",
] as const;

const LATAM_COUNTRIES = [
  ...SOUTH_AMERICA_COUNTRIES,
  "costa rica",
  "mexico",
  "panama",
] as const;

const REGION_MEMBERS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    eu: EU_COUNTRIES,
    europe: EUROPE_COUNTRIES,
    "uk eu": EUROPE_COUNTRIES,
    emea: [...EUROPE_COUNTRIES, ...MIDDLE_EAST_COUNTRIES, ...AFRICA_COUNTRIES],
    "middle east": MIDDLE_EAST_COUNTRIES,
    africa: AFRICA_COUNTRIES,
    asia: ASIA_COUNTRIES,
    apac: [...ASIA_COUNTRIES, ...OCEANIA_COUNTRIES],
    "asia pacific": [...ASIA_COUNTRIES, ...OCEANIA_COUNTRIES],
    oceania: OCEANIA_COUNTRIES,
    "north america": NORTH_AMERICA_COUNTRIES,
    "south america": SOUTH_AMERICA_COUNTRIES,
    latam: LATAM_COUNTRIES,
    "latin america": LATAM_COUNTRIES,
    americas: [...NORTH_AMERICA_COUNTRIES, ...LATAM_COUNTRIES],
  }).map(([region, members]) => [
    tokenizeLocation(region).join(" "),
    new Set(members.map((country) => normalizeCountryKey(country))),
  ]),
);

function candidateRun(candidate: string): string {
  const tokens = tokenizeLocation(candidate);
  if (tokens.length > 1 && tokens[tokens.length - 1] === "only") {
    tokens.pop();
  }
  return tokens.join(" ");
}

/** "Eligible from anywhere" — "Anywhere in the World", "Worldwide", "Remote". */
export function isUniversalRemoteRegion(candidate: string): boolean {
  return UNIVERSAL_REMOTE_RUNS.has(candidateRun(candidate));
}

/** Whether `candidate` names a known region containing the selected country. */
export function remoteRegionIncludesCountry(
  candidate: string,
  selectedCountry: string,
): boolean {
  const members = REGION_MEMBERS[candidateRun(candidate)];
  if (!members) return false;
  return members.has(normalizeCountryKey(selectedCountry));
}

import { normalizeCountryKey } from "./location-support.js";

/**
 * ISO 3166-1 alpha-2 codes for the countries a profile can select, derived by
 * inverting `Intl.DisplayNames` — the same trick the Hiring Cafe extractor uses
 * in the other direction, with no table to hand-maintain and no dependency.
 *
 * Alpha-2 only: `City, REGION, CC` is what Indeed emits, and alpha-3 never
 * appears in a job location we ingest.
 */
// Built on first use, not at module load: enumerating the region names costs
// ~10ms, and most importers of this module never ask a location question.
let iso2ByCountryKey: Map<string, string> | null = null;

function getIso2ByCountryKey(): Map<string, string> {
  iso2ByCountryKey ??= buildIso2ByCountryKey();
  return iso2ByCountryKey;
}

function buildIso2ByCountryKey(): Map<string, string> {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  const map = new Map<string, string>();

  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const iso2 = String.fromCharCode(first, second);
      const displayName = displayNames.of(iso2);
      // An unassigned code echoes itself back rather than naming a region.
      if (!displayName || displayName === iso2) continue;
      const countryKey = normalizeCountryKey(displayName);
      if (!countryKey || map.has(countryKey)) continue;
      map.set(countryKey, iso2);
    }
  }

  return map;
}

/** The alpha-2 code for a selected country, or null when it has none. */
export function countryKeyToIso2(
  country: string | null | undefined,
): string | null {
  const countryKey = normalizeCountryKey(country);
  if (!countryKey) return null;
  return getIso2ByCountryKey().get(countryKey) ?? null;
}

/** Every country name `Intl.DisplayNames` knows, normalized to a country key. */
export function listKnownCountryKeys(): string[] {
  return Array.from(getIso2ByCountryKey().keys());
}

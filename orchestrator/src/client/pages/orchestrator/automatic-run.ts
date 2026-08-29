import type {
  LocationMatchStrictness,
  LocationSearchScope,
} from "@shared/location-preferences.js";
import {
  parseSearchCitiesSetting,
  serializeSearchCitiesSetting,
} from "@shared/search-cities.js";

export type WorkplaceType = "remote" | "hybrid" | "onsite";
export const WORKPLACE_TYPE_OPTIONS: WorkplaceType[] = [
  "remote",
  "hybrid",
  "onsite",
];

export const SEARCH_SCOPE_OPTIONS: Array<{
  value: LocationSearchScope;
  label: string;
}> = [
  {
    value: "selected_only",
    label: "Only selected locations",
  },
  {
    value: "selected_plus_remote_worldwide",
    label: "Selected locations + remote worldwide",
  },
  {
    value: "remote_worldwide_prioritize_selected",
    label: "Remote worldwide",
  },
];

export const MATCH_STRICTNESS_OPTIONS: Array<{
  value: LocationMatchStrictness;
  label: string;
}> = [
  {
    value: "flexible",
    label: "Include likely matches",
  },
  {
    value: "exact_only",
    label: "Exact matches only",
  },
];

export function normalizeWorkplaceTypes(
  workplaceTypes: WorkplaceType[] | null | undefined,
): WorkplaceType[] {
  const seen = new Set<WorkplaceType>();
  const out: WorkplaceType[] = [];

  for (const workplaceType of workplaceTypes ?? []) {
    if (!WORKPLACE_TYPE_OPTIONS.includes(workplaceType)) continue;
    if (seen.has(workplaceType)) continue;
    seen.add(workplaceType);
    out.push(workplaceType);
  }

  return out.length > 0 ? out : [...WORKPLACE_TYPE_OPTIONS];
}

export function parseSearchTermsInput(input: string): string[] {
  return input
    .split(/[\n,]/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseCityLocationsInput(input: string): string[] {
  const parsed = parseSearchTermsInput(input);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const city of parsed) {
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(city);
  }
  return out;
}

export function parseCityLocationsSetting(
  location: string | null | undefined,
): string[] {
  return parseSearchCitiesSetting(location);
}

export function serializeCityLocationsSetting(cities: string[]): string | null {
  return serializeSearchCitiesSetting(cities);
}

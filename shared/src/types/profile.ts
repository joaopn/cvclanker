import { z } from "zod";
import {
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
  LOCATION_WORKPLACE_TYPE_VALUES,
  type LocationMatchStrictness,
  type LocationSearchScope,
  type LocationWorkplaceType,
} from "../location-preferences";
import { SUITABILITY_CATEGORIES, type SuitabilityCategory } from "./jobs";

/**
 * A Profile is a named, selectable scrape set: the location + search terms +
 * run knobs + pinned sources that drive a single pipeline run. Stored as one
 * JSON blob (`config_json`) on the `profiles` table, mirroring the
 * `provider_instances` / `source_configs` JSON-column convention.
 *
 * The CV / cover-letter binding is deliberately NOT here yet — it attaches to
 * the same row as nullable columns in a later pass.
 */
export interface ProfileConfig {
  searchTerms: string[];
  searchCountry: string;
  /** "|"-delimited city list, same convention as the `searchCities` setting. */
  searchCities: string;
  workplaceTypes: LocationWorkplaceType[];
  locationSearchScope: LocationSearchScope;
  locationMatchStrictness: LocationMatchStrictness;
  /**
   * Remote-type profile: the remote-only boards become runnable, Apify
   * provider instances are excluded from the run, and location filtering is a
   * BLACKLIST (`remoteLocationBlocklist`) instead of the country/city match.
   */
  remoteProfile: boolean;
  /**
   * Remote profiles only: postings whose location text (or title) matches any
   * of these strings are dropped — "US only", "North America Only", "Colorado".
   * Matching is case-insensitive, punctuation-blind, and country-alias-aware
   * ("US-only" matches "USA Only"). Everything else is kept.
   */
  remoteLocationBlocklist: string[];
  /** null = no cap; each extractor keeps its own default. */
  scrapeMaxAgeDays: number | null;
  /**
   * Narrow each source's max job age to the time elapsed since that source
   * last scraped successfully for this profile (rounded up to whole days, and
   * never wider than `scrapeMaxAgeDays`). Cuts re-scraping the same postings
   * on a continuously-running install.
   */
  scrapeSinceLastRun: boolean;
  blockedCompanyKeywords: string[];
  /** Run budget; `maxJobsPerTerm` is derived from this at run time. */
  runBudget: number;
  topN: number;
  minSuitabilityCategory: SuitabilityCategory;
  /** Extractor ids to run (e.g. jobspy / hiringcafe / ...). */
  enabledSourceIds: string[];
  /** Apify provider-instance ids to run. */
  providerInstanceIds: string[];
}

export interface Profile {
  id: string;
  name: string;
  config: ProfileConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  name: string;
  config?: Partial<ProfileConfig>;
}

export interface UpdateProfileInput {
  name?: string;
  /**
   * Partial config patch merged over the existing config. Field-level
   * null-vs-undefined applies inside the blob: `scrapeMaxAgeDays: null`
   * clears the cap, omitting the key leaves the stored value untouched.
   */
  config?: Partial<ProfileConfig>;
}

/**
 * Zod schema for a full `ProfileConfig`. Each field is validated
 * independently by `parseProfileConfig` so a partially-corrupt blob falls
 * back to defaults per-field rather than wholesale. Also reused (via
 * `.partial()`) to validate config patches at the API boundary.
 */
export const profileConfigSchema = z.object({
  searchTerms: z.array(z.string().trim().min(1).max(200)).max(200),
  searchCountry: z.string().trim().max(100),
  searchCities: z.string().trim().max(1000),
  workplaceTypes: z.array(z.enum(LOCATION_WORKPLACE_TYPE_VALUES)).max(3),
  locationSearchScope: z.enum(LOCATION_SEARCH_SCOPE_VALUES),
  locationMatchStrictness: z.enum(LOCATION_MATCH_STRICTNESS_VALUES),
  remoteProfile: z.boolean(),
  remoteLocationBlocklist: z.array(z.string().trim().min(1).max(200)).max(200),
  scrapeMaxAgeDays: z.number().int().min(1).max(365).nullable(),
  scrapeSinceLastRun: z.boolean(),
  blockedCompanyKeywords: z.array(z.string().trim().min(1).max(200)).max(200),
  runBudget: z.number().int().min(1).max(100_000),
  topN: z.number().int().min(1).max(10_000),
  minSuitabilityCategory: z.enum(SUITABILITY_CATEGORIES),
  enabledSourceIds: z.array(z.string().min(1).max(100)).max(100),
  providerInstanceIds: z.array(z.string().min(1).max(100)).max(100),
});

export function defaultProfileConfig(): ProfileConfig {
  return {
    searchTerms: [],
    searchCountry: "",
    searchCities: "",
    workplaceTypes: ["remote", "hybrid", "onsite"],
    locationSearchScope: "selected_only",
    // Cities steer WHERE the boards search; they are not a filter on what
    // comes back. A board resolves a city to a radius, so a city search also
    // returns its neighbours and postings listed for the whole country, and
    // exact_only drops all of those.
    //
    // This is NOT a cost saving, and must not be described as one: the
    // location filter runs after every extractor has returned, so the scrape
    // is billed identically either way. The trade is the other direction —
    // each row flexible keeps is a row that gets imported and scored, at one
    // LLM call apiece. The per-profile numbers behind the choice, including
    // the profiles where exact_only is the better answer, are in plan/.
    locationMatchStrictness: "flexible",
    remoteProfile: false,
    remoteLocationBlocklist: [],
    scrapeMaxAgeDays: null,
    scrapeSinceLastRun: false,
    blockedCompanyKeywords: [],
    runBudget: 500,
    topN: 10,
    minSuitabilityCategory: "good_fit",
    enabledSourceIds: [],
    providerInstanceIds: [],
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a stored `config_json` blob into a `ProfileConfig`, falling back to
 * the default value on any field that is missing or fails validation. Never
 * throws — a fully-corrupt blob yields `defaultProfileConfig()`.
 */
export function parseProfileConfig(raw: unknown): ProfileConfig {
  const defaults = defaultProfileConfig();
  const source = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return defaults;
  }
  const obj = source as Record<string, unknown>;
  const shape = profileConfigSchema.shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (!(key in obj)) continue;
    const result = shape[key].safeParse(obj[key]);
    if (result.success) {
      out[key] = result.data;
    }
  }
  return out as unknown as ProfileConfig;
}

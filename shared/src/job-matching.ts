import { formatCountryLabel } from "./location-support.js";
import {
  locationCountryUnspecified,
  matchesBlockedLocation,
  matchesRequestedCity,
  matchesRequestedCountry,
  shouldApplyStrictCityFilter,
} from "./search-cities.js";
import type { LocationIntent } from "./types/location";
import { normalizeWhitespace } from "./utils/string";

const COMPANY_SUFFIXES = [
  "limited",
  "ltd",
  "llp",
  "plc",
  "inc",
  "incorporated",
  "corporation",
  "corp",
  "company",
  "co",
  "llc",
  "uk",
  "international",
  "intl",
  "group",
  "holdings",
  "t/a",
  "trading as",
  "&",
  "the",
];

function normalizeMatchText(value: string): string {
  const normalized = value.toLowerCase().trim();
  return normalizeWhitespace(
    normalized.replace(/[.,'"()[\]{}!?@#$%^&*+=|\\/<>:;`~_-]/g, " "),
  );
}

export function normalizeCompanyName(name: string): string {
  let normalized = normalizeMatchText(name);
  for (const suffix of COMPANY_SUFFIXES) {
    const regex = new RegExp(`\\b${suffix}\\b`, "gi");
    normalized = normalized.replace(regex, " ");
  }
  return normalizeWhitespace(normalized);
}

export function normalizeJobTitle(title: string): string {
  return normalizeMatchText(title);
}

export function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

  if (s1.includes(s2) || s2.includes(s1)) {
    const longerLen = Math.max(s1.length, s2.length);
    const shorterLen = Math.min(s1.length, s2.length);
    return Math.round((shorterLen / longerLen) * 100);
  }

  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = matrix[s1.length][s2.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.round(((maxLen - distance) / maxLen) * 100);
}

function normalizeLocationCandidate(value: string): string | null {
  const trimmed = normalizeWhitespace(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function getJobLocationCandidates(job: {
  location?: string | null;
  locationEvidence?:
    | Array<{
        value?: string | null;
      }>
    | {
        location?: string | null;
        country?: string | null;
        city?: string | null;
        workplaceType?: "remote" | "hybrid" | "onsite" | null;
      }
    | null;
}): string[] {
  const evidenceCandidates = Array.isArray(job.locationEvidence)
    ? job.locationEvidence.map((item) => item.value)
    : job.locationEvidence
      ? [
          job.locationEvidence.location,
          job.locationEvidence.country,
          job.locationEvidence.city,
          job.locationEvidence.workplaceType,
        ]
      : [];
  const candidates = [job.location, ...evidenceCandidates];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = normalizeLocationCandidate(candidate);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

/**
 * Why a job was kept or dropped. The two reject codes name the check that
 * failed, so the run banner's Rejected list can say which one it was instead of
 * a bare "location mismatch" that has to be diagnosed against the database.
 */
export type LocationMatchReasonCode =
  | "unfiltered"
  | "selected_location"
  | "remote_worldwide"
  | "remote_location_blocked"
  | "not_remote"
  | "no_country_match"
  | "no_city_match";

/** One line a person can read in the run banner's Rejected column. */
export function describeLocationRejection(
  reasonCode: LocationMatchReasonCode,
  intent: LocationIntent,
): string {
  const country = intent.selectedCountry
    ? formatCountryLabel(intent.selectedCountry)
    : "the selected country";
  if (reasonCode === "no_city_match") {
    return `location mismatch: in ${country}, but not in a selected city`;
  }
  if (reasonCode === "no_country_match") {
    return `location mismatch: outside ${country}`;
  }
  if (reasonCode === "remote_location_blocked") {
    return "location matches the remote profile's blocklist";
  }
  if (reasonCode === "not_remote") {
    return "the source flags this posting as not remote";
  }
  return "location mismatch";
}

/**
 * The parts of a title that carry a location restriction: bracketed segments
 * and whatever follows the LAST whitespace-delimited separator or ": " —
 * "(US Only)", "[EMEA]", "- US-only", "| North America". In-word hyphens
 * ("US-only", "Full-Stack") are not separators, so a restriction keeps its
 * own spelling. The title's leading free text is not scanned.
 */
export function titleRestrictionSegments(
  title: string | null | undefined,
): string[] {
  if (!title) return [];
  const brackets = Array.from(
    title.matchAll(/[([]([^)\]]*)[)\]]/g),
    (match) => match[1],
  );
  const parts = title.replace(/[([][^)\]]*[)\]]/g, " ").split(/\s[-–—|]\s|:\s/);
  const tail = parts.length > 1 ? parts[parts.length - 1] : "";
  return [...brackets, tail]
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function matchJobLocationIntent(
  job: {
    title?: string | null;
    location?: string | null;
    locationEvidence?: {
      location?: string | null;
      country?: string | null;
      city?: string | null;
      workplaceType?: "remote" | "hybrid" | "onsite" | null;
    } | null;
    isRemote?: boolean | null;
  },
  intent: LocationIntent,
): {
  matched: boolean;
  reasonCode: LocationMatchReasonCode;
  priority: 0 | 1;
} {
  const candidates = getJobLocationCandidates(job);
  const selectedCountry = intent.selectedCountry;

  // Remote-type profile: location filtering is a BLACKLIST. A posting is
  // dropped when its location text (or title — boards and scrapers alike put
  // "(US Only)" there) matches any blocklist entry; everything else is kept,
  // whatever the selected country says. The description is deliberately NOT
  // scanned: "US" appears in most job ads for reasons unrelated to
  // eligibility.
  if (intent.remoteProfile) {
    // A source that reports per-row remoteness is believed: jobspy's
    // LinkedIn and Indeed legs return on-site postings even with their
    // remote filters on (LinkedIn's facet is degraded to a keyword), and
    // python-jobspy's per-row is_remote is Indeed's Remote attribute,
    // Glassdoor's location type, or on LinkedIn a remote/wfh keyword scan of
    // title+description+location (title+location only when the detail fetch
    // failed — a plain-city remote row can then drop; accepted). Unknown
    // (hiring.cafe never sets it — its search was filtered to Remote
    // server-side) is kept.
    if (job.isRemote === false) {
      return { matched: false, reasonCode: "not_remote", priority: 0 };
    }
    const titleSegments = titleRestrictionSegments(job.title);
    const blocked = intent.remoteLocationBlocklist.some(
      (entry) =>
        candidates.some((text) => matchesBlockedLocation(text, entry)) ||
        titleSegments.some((text) =>
          matchesBlockedLocation(text, entry, { protectPronounUs: true }),
        ),
    );
    if (blocked) {
      return {
        matched: false,
        reasonCode: "remote_location_blocked",
        priority: 0,
      };
    }
    return { matched: true, reasonCode: "remote_worldwide", priority: 0 };
  }

  if (!selectedCountry) {
    return { matched: true, reasonCode: "unfiltered", priority: 0 };
  }

  // A location that names no country at all ("Greater Reading Area", "Utrecht
  // Area") is not evidence of a MISmatch: the only country the scrape asked for
  // is the selected one, so an unqualified metro name is taken to be inside it.
  // A location that DOES name a country ("Toronto, Ontario, Canada"), or carries
  // a trailing region code ("Wenatchee, WA"), is still judged on that name —
  // which is what keeps out-of-country rows rejected.
  const countryMatched =
    candidates.some((candidate) =>
      matchesRequestedCountry(candidate, selectedCountry),
    ) || locationCountryUnspecified(candidates);

  // A directly-named city is sufficient on its own. Job postings frequently
  // list one or more cities ("Vienna or Graz or Munich or …") without
  // repeating the country, so gating the city check behind a country-token
  // match wrongly rejects them. Treat the location as a contains/"in" test: if
  // any requested city appears among the job's location candidates, keep it
  // regardless of whether the country name is also present.
  const cityMatched =
    intent.cityLocations.length > 0 &&
    intent.cityLocations.some((requestedCity) => {
      // A "city" entry equal to the country name isn't a real city filter — it
      // only stands in for the country, so it counts only when the country
      // itself matched.
      if (!shouldApplyStrictCityFilter(requestedCity, selectedCountry)) {
        return countryMatched;
      }
      return candidates.some((candidate) =>
        matchesRequestedCity(candidate, requestedCity),
      );
    });

  if (cityMatched) {
    return { matched: true, reasonCode: "selected_location", priority: 1 };
  }

  if (countryMatched) {
    // Country matched but either no cities were requested, or none matched and
    // the user opted into flexible matching.
    if (
      intent.cityLocations.length === 0 ||
      intent.matchStrictness === "flexible"
    ) {
      return { matched: true, reasonCode: "selected_location", priority: 1 };
    }
  }

  if (
    intent.workplaceTypes.includes("remote") &&
    intent.geoScope !== "selected_only" &&
    job.isRemote === true
  ) {
    return { matched: true, reasonCode: "remote_worldwide", priority: 0 };
  }

  // Name the check that actually failed. A country match reaching here means
  // cities were requested, none matched, and strictness is exact_only — every
  // other country-matched path has already returned.
  return {
    matched: false,
    reasonCode: countryMatched ? "no_city_match" : "no_country_match",
    priority: 0,
  };
}

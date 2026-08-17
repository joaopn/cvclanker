import type { HiringCafeCountryLocation } from "./country-map.js";

/**
 * `"default"` is hiring.cafe's relevance ranking; `"date"` is its "Most recent"
 * option. Both are values their own search state accepts.
 */
export type HiringCafeSortBy = "default" | "date";

/**
 * Ask for newest-first ONLY when the caller configured a max job age.
 *
 * hiring.cafe's date filter is its INDEX date, so a configured window still
 * returns postings months old and the extractor drops them on publish date —
 * under relevance ranking that discards ~90% of what it pages through. Sorting
 * by date fills the same budget with postings that are actually inside the
 * window. With no window configured there is no freshness intent to serve, so
 * relevance stays: the sort decides WHICH jobs a capped run keeps, and that is
 * not a change to make on a profile that never asked for it.
 */
export function resolveSortBy(
  configuredMaxAgeDays: number | null | undefined,
): HiringCafeSortBy {
  return typeof configuredMaxAgeDays === "number" && configuredMaxAgeDays > 0
    ? "date"
    : "default";
}

export interface HiringCafeSearchState {
  locations: HiringCafeCountryLocation[];
  workplaceTypes: Array<"Remote" | "Hybrid" | "Onsite">;
  defaultToUserLocation: boolean;
  userLocation: null;
  commitmentTypes: string[];
  seniorityLevel: string[];
  roleTypes: string[];
  roleYoeRange: [number, number];
  excludeIfRoleYoeIsNotSpecified: boolean;
  managementYoeRange: [number, number];
  excludeIfManagementYoeIsNotSpecified: boolean;
  securityClearances: string[];
  searchQuery: string;
  dateFetchedPastNDays: number;
  hiddenCompanies: string[];
  sortBy: HiringCafeSortBy;
  companyPublicOrPrivate: "all";
  latestInvestmentYearRange: [null, null];
  latestInvestmentSeries: string[];
  latestInvestmentAmount: null;
  latestInvestmentCurrency: string[];
  investors: string[];
  excludedInvestors: string[];
  isNonProfit: "all";
  companySizeRanges: string[];
  minYearFounded: null;
  maxYearFounded: null;
  excludedLatestInvestmentSeries: string[];
}

export function createDefaultSearchState(args: {
  searchQuery: string;
  location: HiringCafeCountryLocation | null;
  dateFetchedPastNDays: number;
  workplaceTypes?: Array<"Remote" | "Hybrid" | "Onsite">;
  sortBy: HiringCafeSortBy;
}): HiringCafeSearchState {
  return {
    locations: args.location ? [args.location] : [],
    workplaceTypes: args.workplaceTypes ?? ["Remote", "Hybrid", "Onsite"],
    defaultToUserLocation: false,
    userLocation: null,
    commitmentTypes: [
      "Full Time",
      "Part Time",
      "Contract",
      "Internship",
      "Temporary",
      "Seasonal",
      "Volunteer",
    ],
    seniorityLevel: [
      "No Prior Experience Required",
      "Entry Level",
      "Mid Level",
      "Senior Level",
    ],
    roleTypes: ["Individual Contributor", "People Manager"],
    roleYoeRange: [0, 20],
    excludeIfRoleYoeIsNotSpecified: false,
    managementYoeRange: [0, 20],
    excludeIfManagementYoeIsNotSpecified: false,
    securityClearances: [
      "None",
      "Confidential",
      "Secret",
      "Top Secret",
      "Top Secret/SCI",
      "Public Trust",
      "Interim Clearances",
      "Other",
    ],
    searchQuery: args.searchQuery,
    dateFetchedPastNDays: args.dateFetchedPastNDays,
    hiddenCompanies: [],
    sortBy: args.sortBy,
    companyPublicOrPrivate: "all",
    latestInvestmentYearRange: [null, null],
    latestInvestmentSeries: [],
    latestInvestmentAmount: null,
    latestInvestmentCurrency: [],
    investors: [],
    excludedInvestors: [],
    isNonProfit: "all",
    companySizeRanges: [],
    minYearFounded: null,
    maxYearFounded: null,
    excludedLatestInvestmentSeries: [],
  };
}

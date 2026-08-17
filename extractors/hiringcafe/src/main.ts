import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobLocationEvidence } from "@shared/types/jobs";
import { launchOptions } from "camoufox-js";
import { parseSearchTerms } from "cvclanker-shared/utils/search-terms";
import {
  toNumberOrNull,
  toStringOrNull,
} from "cvclanker-shared/utils/type-conversion";
import { type BrowserContext, firefox, type Page } from "playwright";
import {
  normalizeCountryKey,
  resolveHiringCafeCountryLocation,
} from "./country-map.js";
import {
  createDefaultSearchState,
  type HiringCafeSortBy,
  resolveSortBy,
} from "./default-search-state.js";
import { asRecord, BASE_URL, fetchJobDescription } from "./detail.js";
import {
  isWithinPublishWindow,
  PUBLISH_DATE_TOLERANCE_DAYS,
} from "./freshness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CVCLANKER_PROGRESS_PREFIX = "CVCLANKER_PROGRESS ";
const DEFAULT_MAX_JOBS_PER_TERM = 200;
const DEFAULT_SEARCH_TERM = "web developer";
const DEFAULT_DATE_FETCHED_PAST_N_DAYS = 30;
const DEFAULT_LOCATION_RADIUS_MILES = 1;
const PAGE_LIMIT = 50;

// Descriptions are fetched one page at a time (see fetchJobDescription): each
// detail page is ~62 KB / ~0.7s, so a 200-job term costs ~140s serially; at
// 5-way it is ~28s. Going much higher risks Cloudflare rate-limiting the very
// browser session our search pagination depends on — losing that session costs
// the whole run, not one job.
const DEFAULT_DETAIL_FETCH_CONCURRENCY = 5;
const DETAIL_FETCH_CONCURRENCY = parsePositiveInt(
  process.env.HIRING_CAFE_DETAIL_CONCURRENCY,
  DEFAULT_DETAIL_FETCH_CONCURRENCY,
);

type RawHiringCafeJob = Record<string, unknown>;

interface ExtractedJob {
  source: "hiringcafe";
  sourceJobId?: string;
  title: string;
  employer: string;
  jobUrl: string;
  applicationLink: string;
  location?: string;
  locationEvidence?: JobLocationEvidence;
  salary?: string;
  datePosted?: string;
  jobDescription?: string;
  jobType?: string;
}

interface SsrSearchPage {
  hits: RawHiringCafeJob[];
  totalCount: number | null;
  isLastPage: boolean;
}

interface CityLocationContext {
  id: string;
  city: string;
  regionLong: string;
  regionShort: string;
  countryLong: string;
  countryShort: string;
  lat: number;
  lon: number;
  formattedAddress: string;
  population: number | null;
  radiusMiles: number;
}

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: Record<string, unknown>;
}

type HiringCafeWorkplaceType = "Remote" | "Hybrid" | "Onsite";

function emitProgress(payload: Record<string, unknown>): void {
  if (process.env.CVCLANKER_EMIT_PROGRESS !== "1") return;
  console.log(`${CVCLANKER_PROGRESS_PREFIX}${JSON.stringify(payload)}`);
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = input ? Number.parseInt(input, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseWorkplaceTypes(
  raw: string | undefined,
): HiringCafeWorkplaceType[] {
  if (!raw) return ["Remote", "Hybrid", "Onsite"];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ["Remote", "Hybrid", "Onsite"];

    const out: HiringCafeWorkplaceType[] = [];
    const seen = new Set<HiringCafeWorkplaceType>();
    for (const value of parsed) {
      const mapped =
        value === "remote"
          ? "Remote"
          : value === "hybrid"
            ? "Hybrid"
            : value === "onsite"
              ? "Onsite"
              : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(mapped);
    }
    return out.length > 0 ? out : ["Remote", "Hybrid", "Onsite"];
  } catch {
    return ["Remote", "Hybrid", "Onsite"];
  }
}

function encodeSearchState(searchState: unknown): string {
  // Post-2026-05-23: Hiring Cafe deprecated /api/search-jobs* and search
  // state now rides as a URL-encoded JSON `searchState` query param against
  // the SSR-rendered home page. No base64 layer.
  return encodeURIComponent(JSON.stringify(searchState));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toStringOrNull(item))
    .filter((item): item is string => Boolean(item));
}

function firstArrayValue(value: unknown): string | null {
  const values = asStringArray(value);
  return values.length > 0 ? values[0] : null;
}

function formatCompensation(
  processedJobData: Record<string, unknown> | null,
): string | undefined {
  if (!processedJobData) return undefined;

  const min = toNumberOrNull(processedJobData.yearly_min_compensation);
  const max = toNumberOrNull(processedJobData.yearly_max_compensation);
  if (min === null && max === null) return undefined;

  const currency = toStringOrNull(
    processedJobData.listed_compensation_currency,
  );
  const frequency =
    toStringOrNull(processedJobData.listed_compensation_frequency) ?? "Yearly";

  const amount = formatCompensationAmount(min, max);

  const parts = [currency, amount, frequency ? `/ ${frequency}` : ""]
    .filter(Boolean)
    .join(" ")
    .trim();

  return parts || undefined;
}

function formatCompensationAmount(
  min: number | null,
  max: number | null,
): string {
  if (min !== null && max !== null) {
    return `${Math.round(min)}-${Math.round(max)}`;
  }
  if (min !== null) return `${Math.round(min)}+`;
  return `${Math.round(max ?? 0)}`;
}

function buildLocationEvidence(args: {
  formattedLocation?: string | null;
  cities: string[];
  states: string[];
  countries: string[];
}): JobLocationEvidence | undefined {
  const location =
    args.formattedLocation ??
    args.cities[0] ??
    args.states[0] ??
    args.countries[0];

  const city = args.cities[0];
  const country = args.countries[0];

  if (!location && !city && !country) return undefined;

  return {
    location,
    city,
    country,
    source: "hiringcafe",
  };
}

function mapHiringCafeJob(raw: RawHiringCafeJob): ExtractedJob | null {
  const jobInformation = asRecord(raw.job_information);
  const processed = asRecord(raw.v5_processed_job_data);
  const companyInfo = asRecord(jobInformation?.company_info);

  const sourceJobId =
    toStringOrNull(raw.id) ??
    toStringOrNull(raw.objectID) ??
    toStringOrNull(raw.original_source_id) ??
    toStringOrNull(raw.requisition_id) ??
    undefined;

  const jobUrl = toStringOrNull(raw.apply_url);
  if (!jobUrl) return null;

  const title =
    toStringOrNull(jobInformation?.title) ??
    toStringOrNull(jobInformation?.job_title_raw) ??
    toStringOrNull(processed?.core_job_title) ??
    "Unknown Title";

  const employer =
    toStringOrNull(companyInfo?.name) ??
    toStringOrNull(processed?.company_name) ??
    "Unknown Employer";

  const location =
    toStringOrNull(processed?.formatted_workplace_location) ??
    firstArrayValue(processed?.workplace_cities) ??
    firstArrayValue(processed?.workplace_states) ??
    firstArrayValue(processed?.workplace_countries) ??
    undefined;
  const locationEvidence = buildLocationEvidence({
    formattedLocation: toStringOrNull(processed?.formatted_workplace_location),
    cities: asStringArray(processed?.workplace_cities),
    states: asStringArray(processed?.workplace_states),
    countries: asStringArray(processed?.workplace_countries),
  });

  const commitments = asStringArray(processed?.commitment);
  const jobType = commitments.length > 0 ? commitments.join(", ") : undefined;

  return {
    source: "hiringcafe",
    sourceJobId,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location,
    locationEvidence,
    salary: formatCompensation(processed),
    datePosted: toStringOrNull(processed?.estimated_publish_date) ?? undefined,
    jobDescription: toStringOrNull(jobInformation?.description) ?? undefined,
    jobType,
  };
}

function buildCityLocationId(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "_");
  return `city_${normalized}`.slice(0, 32);
}

function toRegionShortName(value: string): string {
  const compact = value
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (compact.length === 0) return "REG";
  if (compact.length === 1) {
    return compact[0].slice(0, 3).toUpperCase();
  }
  return compact
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

async function resolveCityLocationContext(args: {
  city: string;
  countryLong: string;
  countryShort: string;
  radiusMiles: number;
}): Promise<CityLocationContext | null> {
  const query = `${args.city}, ${args.countryLong}`;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "cvclanker-hiringcafe-extractor/1.0",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`geocode failed (${response.status})`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) {
      throw new Error("geocode returned no results");
    }
    const first = payload[0] as NominatimResult;
    const lat = Number(first.lat ?? "");
    const lon = Number(first.lon ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("invalid geocode coordinates");
    }
    const address = asRecord(first.address);
    const regionLong =
      toStringOrNull(address?.state) ??
      toStringOrNull(address?.county) ??
      toStringOrNull(address?.region) ??
      args.countryLong;
    const displayName =
      toStringOrNull(first.display_name) ??
      `${args.city}, ${regionLong}, ${args.countryShort}`;
    return {
      id: buildCityLocationId(args.city),
      city: args.city,
      regionLong,
      regionShort: toRegionShortName(regionLong),
      countryLong: args.countryLong,
      countryShort: args.countryShort,
      lat,
      lon,
      formattedAddress: displayName,
      population: null,
      radiusMiles: args.radiusMiles,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`City geocode failed for '${query}': ${message}`);
    return null;
  }
}

function createCitySearchState(args: {
  searchQuery: string;
  dateFetchedPastNDays: number;
  context: CityLocationContext;
  workplaceTypes: HiringCafeWorkplaceType[];
  sortBy: HiringCafeSortBy;
}): Record<string, unknown> {
  return {
    locations: [
      {
        id: args.context.id,
        types: ["locality"],
        address_components: [
          {
            long_name: args.context.city,
            short_name: args.context.city,
            types: ["locality"],
          },
          {
            long_name: args.context.regionLong,
            short_name: args.context.regionShort,
            types: ["administrative_area_level_1"],
          },
          {
            long_name: args.context.countryLong,
            short_name: args.context.countryShort,
            types: ["country"],
          },
        ],
        geometry: {
          location: {
            lat: args.context.lat,
            lon: args.context.lon,
          },
        },
        formatted_address: args.context.formattedAddress,
        population: args.context.population,
        workplace_types: [],
        options: {
          radius: args.context.radiusMiles,
          radius_unit: "miles",
          ignore_radius: false,
        },
      },
    ],
    workplaceTypes: args.workplaceTypes,
    defaultToUserLocation: true,
    userLocation: null,
    physicalEnvironments: [
      "Office",
      "Outdoor",
      "Vehicle",
      "Industrial",
      "Customer-Facing",
    ],
    physicalLaborIntensity: ["Low", "Medium", "High"],
    physicalPositions: ["Sitting", "Standing"],
    oralCommunicationLevels: ["Low", "Medium", "High"],
    computerUsageLevels: ["Low", "Medium", "High"],
    cognitiveDemandLevels: ["Low", "Medium", "High"],
    currency: { label: "Any", value: null },
    frequency: { label: "Any", value: null },
    minCompensationLowEnd: null,
    minCompensationHighEnd: null,
    maxCompensationLowEnd: null,
    maxCompensationHighEnd: null,
    restrictJobsToTransparentSalaries: false,
    calcFrequency: "Yearly",
    commitmentTypes: [
      "Full Time",
      "Part Time",
      "Contract",
      "Internship",
      "Temporary",
      "Seasonal",
      "Volunteer",
    ],
    jobTitleQuery: "",
    jobDescriptionQuery: "",
    associatesDegreeFieldsOfStudy: [],
    excludedAssociatesDegreeFieldsOfStudy: [],
    bachelorsDegreeFieldsOfStudy: [],
    excludedBachelorsDegreeFieldsOfStudy: [],
    mastersDegreeFieldsOfStudy: [],
    excludedMastersDegreeFieldsOfStudy: [],
    doctorateDegreeFieldsOfStudy: [],
    excludedDoctorateDegreeFieldsOfStudy: [],
    associatesDegreeRequirements: [],
    bachelorsDegreeRequirements: [],
    mastersDegreeRequirements: [],
    doctorateDegreeRequirements: [],
    licensesAndCertifications: [],
    excludedLicensesAndCertifications: [],
    excludeAllLicensesAndCertifications: false,
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
    languageRequirements: [],
    excludedLanguageRequirements: [],
    languageRequirementsOperator: "OR",
    excludeJobsWithAdditionalLanguageRequirements: false,
    airTravelRequirement: ["None", "Minimal", "Moderate", "Extensive"],
    landTravelRequirement: ["None", "Minimal", "Moderate", "Extensive"],
    morningShiftWork: [],
    eveningShiftWork: [],
    overnightShiftWork: [],
    weekendAvailabilityRequired: "Doesn't Matter",
    holidayAvailabilityRequired: "Doesn't Matter",
    overtimeRequired: "Doesn't Matter",
    onCallRequirements: [
      "None",
      "Occasional (once a month or less)",
      "Regular (once a week or more)",
    ],
    benefitsAndPerks: [],
    applicationFormEase: [],
    companyNames: [],
    excludedCompanyNames: [],
    companyHqCountries: [],
    excludedCompanyHqCountries: [],
    usaGovPref: null,
    industries: [],
    excludedIndustries: [],
    companyKeywords: [],
    companyKeywordsBooleanOperator: "OR",
    excludedCompanyKeywords: [],
    hideJobTypes: [],
    encouragedToApply: [],
    searchQuery: args.searchQuery,
    dateFetchedPastNDays: args.dateFetchedPastNDays,
    hiddenCompanies: [],
    user: null,
    searchModeSelectedCompany: null,
    departments: [],
    restrictedSearchAttributes: [],
    sortBy: args.sortBy,
    technologyKeywordsQuery: "",
    requirementsKeywordsQuery: "",
    companyPublicOrPrivate: "all",
    latestInvestmentYearRange: [null, null],
    latestInvestmentSeries: [],
    latestInvestmentAmount: null,
    latestInvestmentCurrency: [],
    investors: [],
    excludedInvestors: [],
    isNonProfit: "all",
    organizationTypes: [],
    excludedOrganizationTypes: [],
    companySizeRanges: [],
    minYearFounded: null,
    maxYearFounded: null,
    excludedLatestInvestmentSeries: [],
  };
}

async function fetchSsrSearchPage(
  page: Page,
  searchStateEncoded: string,
  pageNo: number,
): Promise<SsrSearchPage> {
  // Post-2026-05-23: the JSON `/api/search-jobs*` endpoints are gone (404/405).
  // Search now rides on the SSR home page — Next.js bakes the result set into
  // `__NEXT_DATA__` as `pageProps.ssrHits[]` with `ssrTotalCount` and
  // `ssrIsLastPage` on the same payload. We navigate to the search URL once
  // per page, grab `__NEXT_DATA__` from the rendered DOM, parse, and return.
  const url = `${BASE_URL}/?searchState=${searchStateEncoded}&page=${pageNo}`;
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!response || !response.ok()) {
    const status = response?.status() ?? "unknown";
    throw new Error(`Hiring Cafe SSR fetch failed (status ${status})`);
  }

  const rawNextData = await page.evaluate(() => {
    const el = document.getElementById("__NEXT_DATA__");
    return el?.textContent ?? null;
  });
  if (!rawNextData) {
    throw new Error(
      "Hiring Cafe SSR fetch returned no __NEXT_DATA__ — site shape changed",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawNextData);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Hiring Cafe SSR __NEXT_DATA__ parse failed: ${message}`);
  }

  const pageProps = asRecord(asRecord(asRecord(parsed)?.props)?.pageProps);
  if (!pageProps) {
    throw new Error("Hiring Cafe SSR __NEXT_DATA__ missing pageProps");
  }

  const hitsRaw = pageProps.ssrHits;
  const hits = Array.isArray(hitsRaw)
    ? hitsRaw.filter(
        (item): item is RawHiringCafeJob =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];

  return {
    hits,
    totalCount: toNumberOrNull(pageProps.ssrTotalCount),
    isLastPage: pageProps.ssrIsLastPage === true,
  };
}

interface PageEntry {
  job: ExtractedJob;
  requisitionId: string | null;
}

/**
 * Fill in the descriptions for the jobs this page contributed. Only jobs that
 * survived mapping, dedupe and the term cap get here, so we never pay for a job
 * we then drop.
 *
 * A job whose description cannot be fetched is kept with no description rather
 * than dropped: a transient Cloudflare blip must not silently cost us jobs.
 */
async function enrichPageDescriptions(
  context: BrowserContext,
  entries: PageEntry[],
): Promise<{ fetched: number; missing: number }> {
  // Read `context.request` HERE, never at startup: the Camoufox-instability
  // fallback below closes the browser and reassigns `context`, so a handle
  // captured earlier would point at a closed browser.
  const request = context.request;

  // Skip anything that already has a description — if hiring.cafe ever puts the
  // field back in the search payload, this whole path turns into a no-op.
  const pending = entries.filter((entry) => !entry.job.jobDescription);
  if (pending.length === 0) return { fetched: 0, missing: 0 };

  let cursor = 0;
  let fetched = 0;
  const workerCount = Math.min(DETAIL_FETCH_CONCURRENCY, pending.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor];
      cursor += 1;
      if (!entry.requisitionId) continue;

      const description = await fetchJobDescription(
        request,
        entry.requisitionId,
      );
      if (description) {
        entry.job.jobDescription = description;
        fetched += 1;
      }
    }
  });
  await Promise.all(workers);

  return { fetched, missing: pending.length - fetched };
}

async function run(): Promise<void> {
  const searchTerms = parseSearchTerms(
    process.env.HIRING_CAFE_SEARCH_TERMS,
    DEFAULT_SEARCH_TERM,
  );
  const country = normalizeCountryKey(process.env.HIRING_CAFE_COUNTRY ?? "");
  const maxJobsPerTerm = parsePositiveInt(
    process.env.HIRING_CAFE_MAX_JOBS_PER_TERM,
    DEFAULT_MAX_JOBS_PER_TERM,
  );
  // Zero means "the caller configured no max age" — run.ts only sets the env
  // var when the profile did. The distinction drives the sort, so resolve the
  // configured value first and fall back to the default window after.
  const configuredMaxAgeDays = parsePositiveInt(
    process.env.HIRING_CAFE_DATE_FETCHED_PAST_N_DAYS,
    0,
  );
  const dateFetchedPastNDays =
    configuredMaxAgeDays > 0
      ? configuredMaxAgeDays
      : DEFAULT_DATE_FETCHED_PAST_N_DAYS;
  const sortBy = resolveSortBy(configuredMaxAgeDays);
  const locationQuery = process.env.HIRING_CAFE_LOCATION_QUERY?.trim() ?? "";
  const locationRadiusMiles = parsePositiveInt(
    process.env.HIRING_CAFE_LOCATION_RADIUS_MILES,
    DEFAULT_LOCATION_RADIUS_MILES,
  );
  const outputPath =
    process.env.HIRING_CAFE_OUTPUT_JSON ||
    join(__dirname, "../storage/datasets/default/jobs.json");
  const headless = process.env.HIRING_CAFE_HEADLESS !== "false";
  const workplaceTypes = parseWorkplaceTypes(
    process.env.HIRING_CAFE_WORKPLACE_TYPES,
  );

  let browser = await firefox.launch(
    await launchOptions({
      headless,
      humanize: true,
      geoip: true,
    }),
  );
  let context = await browser.newContext();
  let page = await context.newPage();

  const allJobs: ExtractedJob[] = [];
  const seen = new Set<string>();
  let staleDroppedRun = 0;

  try {
    const initializePage = async () => {
      await page.goto(BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2_000);
    };

    try {
      await initializePage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Camoufox browser startup was unstable, retrying with vanilla Firefox: ${message}`,
      );
      await browser.close();
      browser = await firefox.launch({ headless });
      context = await browser.newContext();
      page = await context.newPage();
      await initializePage();
    }

    const countryLocation = resolveHiringCafeCountryLocation(country);
    const countryLong = countryLocation?.address_components[0]?.long_name ?? "";
    const countryShort =
      countryLocation?.address_components[0]?.short_name ?? "";
    const cityLocationContext = locationQuery
      ? await resolveCityLocationContext({
          city: locationQuery,
          countryLong,
          countryShort,
          radiusMiles: locationRadiusMiles,
        })
      : null;

    for (let i = 0; i < searchTerms.length; i += 1) {
      const searchTerm = searchTerms[i];
      const termIndex = i + 1;

      emitProgress({
        event: "term_start",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
      });

      const searchState = cityLocationContext
        ? createCitySearchState({
            searchQuery: searchTerm,
            dateFetchedPastNDays,
            context: cityLocationContext,
            workplaceTypes,
            sortBy,
          })
        : createDefaultSearchState({
            searchQuery: searchTerm,
            location: countryLocation,
            dateFetchedPastNDays,
            workplaceTypes,
            sortBy,
          });
      const encodedSearchState = encodeSearchState(searchState);

      let pageNo = 0;
      let termCollected = 0;
      let termTarget = maxJobsPerTerm;
      let staleDroppedTerm = 0;

      while (pageNo < PAGE_LIMIT) {
        let pageResult: SsrSearchPage;
        try {
          pageResult = await fetchSsrSearchPage(
            page,
            encodedSearchState,
            pageNo,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `Hiring Cafe SSR fetch failed for term '${searchTerm}' page ${pageNo}: ${message}`,
          );
          break;
        }

        if (pageNo === 0 && pageResult.totalCount !== null) {
          termTarget = Math.min(maxJobsPerTerm, pageResult.totalCount);
        }

        if (pageResult.hits.length === 0) break;

        let mappedOnPage = 0;
        const pageEntries: PageEntry[] = [];
        for (const rawJob of pageResult.hits) {
          if (termCollected >= termTarget) break;
          // Expired postings are dead on arrival — skip before spending a
          // detail fetch on them.
          if (rawJob.is_expired === true) continue;

          const mapped = mapHiringCafeJob(rawJob);
          if (!mapped) continue;

          // `dateFetchedPastNDays` filters on hiring.cafe's INDEX date, so a
          // 7-day search returns postings months old. Drop those here, before
          // they cost a detail fetch and an LLM scoring call downstream.
          if (
            !isWithinPublishWindow({
              estimatedPublishDate: mapped.datePosted,
              windowDays: dateFetchedPastNDays,
            })
          ) {
            staleDroppedTerm += 1;
            continue;
          }

          const dedupeKey = mapped.sourceJobId || mapped.jobUrl;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          allJobs.push(mapped);
          pageEntries.push({
            job: mapped,
            requisitionId: toStringOrNull(rawJob.requisition_id),
          });
          termCollected += 1;
          mappedOnPage += 1;
        }

        // Must run BEFORE the emit below, or the counts are always zero.
        const descriptions = await enrichPageDescriptions(context, pageEntries);

        // The search payload dropped descriptions once already and nobody
        // noticed for weeks. If the detail route dies too, say so loudly in the
        // logs rather than importing a page of unscoreable jobs in silence.
        // `missing` also counts hits with no requisition_id, so name that cause
        // too — otherwise a renamed field reads as a blocked route.
        if (descriptions.missing > 0 && descriptions.fetched === 0) {
          console.warn(
            `Hiring Cafe: 0/${descriptions.missing} descriptions fetched on page ${pageNo + 1} — the job detail route may be blocked or changed, or hits no longer carry requisition_id`,
          );
        }

        emitProgress({
          event: "page_fetched",
          termIndex,
          termTotal: searchTerms.length,
          searchTerm,
          pageNo,
          resultsOnPage: mappedOnPage,
          totalCollected: termCollected,
          descriptionsFetched: descriptions.fetched,
          descriptionsMissing: descriptions.missing,
        });

        if (termCollected >= termTarget) break;
        if (pageResult.isLastPage) break;
        pageNo += 1;
      }

      // Extractor-side drops are invisible to the pipeline's funnel counts, so
      // say how many postings the publish-date window removed and what it cost
      // in extra pages — otherwise a term that pages hard for few jobs reads as
      // hiring.cafe running dry.
      if (staleDroppedTerm > 0) {
        staleDroppedRun += staleDroppedTerm;
        console.log(
          `Hiring Cafe: dropped ${staleDroppedTerm} posting(s) estimated older than ${dateFetchedPastNDays}d (+${PUBLISH_DATE_TOLERANCE_DAYS}d tolerance) for term '${searchTerm}' over ${pageNo + 1} page(s); kept ${termCollected}`,
        );
      }

      emitProgress({
        event: "term_complete",
        termIndex,
        termTotal: searchTerms.length,
        searchTerm,
        jobsFoundTerm: termCollected,
      });
    }
  } finally {
    await browser.close();
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(allJobs, null, 2)}\n`, "utf-8");

  console.log(
    `Hiring Cafe extractor wrote ${allJobs.length} jobs (dropped ${staleDroppedRun} outside the ${dateFetchedPastNDays}d publish-date window)`,
  );
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Hiring Cafe extractor failed: ${message}`);
  process.exitCode = 1;
});

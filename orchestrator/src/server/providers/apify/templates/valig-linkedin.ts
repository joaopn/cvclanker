import { bucketWindowDays } from "@shared/scrape-window.js";
import type { CreateJobInput, JobSource } from "@shared/types";
import type { ProviderActorTemplate } from "../../types";
import {
  FALLBACK_MAX_JOBS_PER_TERM,
  getSearchTerms,
  pickString,
  resolveMaxAgeDays,
  resolveSearchLocations,
  stripHtml,
} from "./mapper-helpers";

/** The actor's `limit` bounds, from its input schema (build 2026-09-26). */
const VALIG_MAX_LIMIT = 1000;

/**
 * The windows the actor's `datePosted` filter accepts, in ascending days; 30
 * is the widest, so a wider request is clamped to it (see `bucketWindowDays`).
 */
const VALIG_MAX_AGE_BUCKETS = [1, 7, 30] as const;

const SECONDS_PER_DAY = 86_400;

/**
 * The actor's own default run timeout is 300s, and a single search scanned
 * to the end of LinkedIn's results measured up to 253s (London, "Data
 * Scientist", one week, 2026-10-05). 1200s leaves over four times that before
 * a run is cut short; a run still going then is stuck, not slow.
 */
const VALIG_RUN_TIMEOUT_SECS = 1200;

function toDatePosted(maxAgeDays: number | undefined): string | undefined {
  if (typeof maxAgeDays !== "number" || maxAgeDays <= 0) return undefined;
  const bucket = bucketWindowDays(maxAgeDays, VALIG_MAX_AGE_BUCKETS);
  return `r${bucket * SECONDS_PER_DAY}`;
}

export const valigLinkedinTemplate: ProviderActorTemplate = {
  id: "valig-linkedin",
  providerId: "apify",
  actorRef: "valig/linkedin-jobs-scraper",
  displayName: "LinkedIn Jobs Scraper (valig)",
  description:
    "valig/linkedin-jobs-scraper. Searches LinkedIn for each search term and keeps only the postings whose TITLE contains every word of that term (any order, any case), so the unrelated postings LinkedIn pads a search with are skipped before they are billed — you pay per matching posting only. Each search term in each configured city is its own actor run (the city qualified with your selected country), so a city listed twice under two names is searched, and billed, twice, and neighbouring cities can return the same posting. The runs start in parallel, up to the Apify term-run concurrency setting. A term's job budget from the Search Profile is split evenly across its cities (each city at least 1, so a term with more cities than budget takes one per city, and at most 1000), and the term reads as capped when any of its cities reached its share. The max job age is bucketed into LinkedIn's date filter (24h / 7d / 30d, rounded up); it cannot look back further than 30 days.",
  defaultInputTemplate: "{}",
  maxAgeBuckets: VALIG_MAX_AGE_BUCKETS,
  maxAgeNote:
    "This actor only accepts 24 hours, 7 days or 30 days, so anything in between rounds UP to the next window. It cannot look back further than 30 days at all.",
  defaultMappings: {
    maxJobsPerTerm: true,
    maxAgeDays: true,
  },
  perTermRuns: true,
  parallelTermRuns: true,
  runTimeoutSecs: VALIG_RUN_TIMEOUT_SECS,
  termRunInputs(context, base) {
    const baseObj =
      base && typeof base === "object" && !Array.isArray(base)
        ? (base as Record<string, unknown>)
        : {};
    const [term] = getSearchTerms(context);
    if (!term) return [];
    const locations = resolveSearchLocations(context.runGlobals);
    const datePosted = toDatePosted(
      resolveMaxAgeDays(context.runGlobals, context.instance.maxAgeDays),
    );
    const budget =
      typeof context.termBudget === "number" && context.termBudget > 0
        ? Math.floor(context.termBudget)
        : FALLBACK_MAX_JOBS_PER_TERM;
    // With no location the search is unscoped: one run, the whole budget.
    const searches: Array<string | undefined> =
      locations.length > 0 ? locations : [undefined];
    // The budget split so the shares add up to it exactly, the remainder
    // going to the first cities. Every city still gets at least one result,
    // so a term with more cities than budget can take one per city.
    const share = Math.floor(budget / searches.length);
    const remainder = budget % searches.length;

    return searches.map((location, index) => {
      const limit = Math.min(
        VALIG_MAX_LIMIT,
        Math.max(1, share + (index < remainder ? 1 : 0)),
      );
      const input: Record<string, unknown> = {
        ...baseObj,
        keywords: term,
        titleInclude: [term],
        limit,
      };
      if (location) input.location = location;
      if (datePosted) input.datePosted = datePosted;
      return { input, cap: limit };
    });
  },
  mapItem(item, context): CreateJobInput | null {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;

    const jobUrl = pickString(obj, ["url", "link", "jobUrl"]);
    const title = pickString(obj, ["title"]);
    if (!jobUrl || !title) return null;

    const result: CreateJobInput = {
      source: context.sourceId as JobSource,
      title,
      employer: pickString(obj, ["companyName"]) ?? "Unknown",
      jobUrl,
    };

    const sourceJobId = pickString(obj, ["id"]);
    if (sourceJobId) result.sourceJobId = sourceJobId;

    const employerUrl = pickString(obj, ["companyUrl"]);
    if (employerUrl) result.employerUrl = employerUrl;

    const location = pickString(obj, ["location"]);
    if (location) result.location = location;

    // The plain `description` runs paragraphs together with no separator, so
    // the HTML one, stripped, is preferred; it keeps the paragraph breaks.
    const htmlDescription = pickString(obj, ["descriptionHtml"]);
    const stripped = htmlDescription ? stripHtml(htmlDescription) : "";
    const description =
      stripped.length > 0 ? stripped : pickString(obj, ["description"]);
    if (description) result.jobDescription = description;

    const datePosted = pickString(obj, ["postedDate"]);
    if (datePosted) result.datePosted = datePosted;

    const jobType = pickString(obj, ["contractType"]);
    if (jobType) result.jobType = jobType;

    const jobLevel = pickString(obj, ["experienceLevel"]);
    if (jobLevel) result.jobLevel = jobLevel;

    // Despite its name the actor's `workType` holds the company's industry
    // ("Software Development", "Financial Services"); `sector` was empty on
    // every row measured.
    const companyIndustry = pickString(obj, ["workType", "sector"]);
    if (companyIndustry) result.companyIndustry = companyIndustry;

    const salary = pickString(obj, ["salary"]);
    if (salary) result.salary = salary;

    const applyUrl = pickString(obj, ["applyUrl"]);
    if (applyUrl && applyUrl !== jobUrl) result.applicationLink = applyUrl;

    return result;
  },
};

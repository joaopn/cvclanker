import { bucketWindowDays } from "@shared/scrape-window.js";
import type { CreateJobInput, JobSource } from "@shared/types";
import type { ProviderActorTemplate } from "../../types";
import {
  getSearchTerms,
  joinSalary,
  pickString,
  resolveDerivedMaxJobs,
  resolveMaxAgeDays,
  resolveSearchLocations,
  stripHtml,
} from "./mapper-helpers";

// The actor caps `maxItems` at "leave empty for unlimited" but enforces a
// minimum of 150 when the field is set. We always set it (uncapped runs bill
// unpredictably under pay-per-result) and clamp up to the floor.
const ACTOR_MIN_MAX_ITEMS = 150;

/**
 * The windows the actor's `publishedAt` filter accepts, in ascending days.
 * 30 is the widest it has, so a wider request is clamped to it rather than
 * rounded up — see `bucketWindowDays`.
 */
const CHEAP_SCRAPER_MAX_AGE_BUCKETS = [1, 7, 30] as const;

const SECONDS_PER_DAY = 86_400;

// The filter is an enum of relative windows expressed in seconds (`r86400` =
// 24h). Derived from the bucket list rather than spelled out, so the list the
// run-window gate reads is the same one the request is built from.
function toPublishedAt(maxAgeDays: number | undefined): string | undefined {
  if (typeof maxAgeDays !== "number" || maxAgeDays <= 0) return undefined;
  const bucket = bucketWindowDays(maxAgeDays, CHEAP_SCRAPER_MAX_AGE_BUCKETS);
  return `r${bucket * SECONDS_PER_DAY}`;
}

export const cheapScraperLinkedinTemplate: ProviderActorTemplate = {
  id: "cheap-scraper-linkedin",
  providerId: "apify",
  actorRef: "cheap_scraper/linkedin-job-scraper",
  displayName: "LinkedIn Jobs Scraper (cheap_scraper)",
  description:
    "cheap_scraper/linkedin-job-scraper. Keyword-and-location search built automatically from your configured search terms + location — no LinkedIn URLs to paste. Each city is sent qualified with your selected country, because LinkedIn resolves a bare city name to whichever one it ranks highest (a plain `Cambridge` returns Toronto-area jobs). The max job age is bucketed into the LinkedIn date filter (24h / 7d / 30d, rounded up), and 30 days is the furthest back it can look at all — a run asking for more is refused rather than silently scraping 30. Pay-per-result: the actor enforces a minimum of 150 results per run, so the effective cap is max(150, your run budget). Duplicate postings are skipped by job id.",
  defaultInputTemplate: JSON.stringify(
    {
      saveOnlyUniqueItems: true,
      enrichCompanyData: false,
    },
    null,
    2,
  ),
  maxAgeBuckets: CHEAP_SCRAPER_MAX_AGE_BUCKETS,
  maxAgeNote:
    "This actor only accepts 24 hours, 7 days or 30 days and offers no newest-first sort, so anything in between rounds UP: a 2-day window buys a week of postings, on an actor that bills per result. It cannot look back further than 30 days at all.",
  defaultMappings: {
    maxJobsPerTerm: true,
    maxAgeDays: true,
  },
  buildInput(context, base) {
    const baseObj =
      base && typeof base === "object" && !Array.isArray(base)
        ? (base as Record<string, unknown>)
        : {};
    const terms = getSearchTerms(context);
    const locations = resolveSearchLocations(context.runGlobals);
    const maxAgeDays = resolveMaxAgeDays(
      context.runGlobals,
      context.instance.maxAgeDays,
    );
    const publishedAt = toPublishedAt(maxAgeDays);

    const input: Record<string, unknown> = {
      ...baseObj,
      keyword: terms,
      maxItems: Math.max(
        ACTOR_MIN_MAX_ITEMS,
        resolveDerivedMaxJobs(
          context.runGlobals,
          terms.length,
          context.instance.maxJobs,
        ),
      ),
    };
    if (locations.length > 0) input.locations = locations;
    if (publishedAt) input.publishedAt = publishedAt;
    return input;
  },
  mapItem(item, context): CreateJobInput | null {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;

    const jobUrl = pickString(obj, ["jobUrl", "url", "link", "job_url"]);
    const title = pickString(obj, ["jobTitle", "title", "job_title", "name"]);
    if (!jobUrl || !title) return null;

    const employer =
      pickString(obj, ["companyName", "company_name", "company", "employer"]) ??
      "Unknown";

    const result: CreateJobInput = {
      source: context.sourceId as JobSource,
      title,
      employer,
      jobUrl,
    };

    const sourceJobId = pickString(obj, ["jobId", "id"]);
    if (sourceJobId) result.sourceJobId = sourceJobId;

    const employerUrl = pickString(obj, ["companyUrl", "company_url"]);
    if (employerUrl) result.employerUrl = employerUrl;

    const location = pickString(obj, ["location", "job_location"]);
    if (location) result.location = location;

    const description = pickString(obj, [
      "jobDescription",
      "descriptionText",
      "description_text",
      "description",
    ]);
    if (description) {
      result.jobDescription = description;
    } else {
      const htmlDescription = pickString(obj, [
        "descriptionHtml",
        "description_html",
      ]);
      if (htmlDescription) {
        const stripped = stripHtml(htmlDescription);
        if (stripped.length > 0) result.jobDescription = stripped;
      }
    }

    // `publishedAt` is an ISO timestamp; `postedTime` is a relative string
    // ("2 days ago") that the ingestion date-normaliser would reject.
    const datePosted = pickString(obj, ["publishedAt", "postedAt"]);
    if (datePosted) result.datePosted = datePosted;

    const jobType = pickString(obj, ["contractType", "employmentType"]);
    if (jobType) result.jobType = jobType;

    const jobLevel = pickString(obj, ["experienceLevel", "seniorityLevel"]);
    if (jobLevel) result.jobLevel = jobLevel;

    const jobFunction = pickString(obj, ["workType", "jobFunction"]);
    if (jobFunction) result.jobFunction = jobFunction;

    const companyIndustry = pickString(obj, [
      "sector",
      "industries",
      "industry",
    ]);
    if (companyIndustry) result.companyIndustry = companyIndustry;

    const companyLogo = pickString(obj, ["companyLogo", "company_logo"]);
    if (companyLogo) result.companyLogo = companyLogo;

    const salary = joinSalary(obj.salaryInfo ?? obj.salary);
    if (salary) result.salary = salary;

    const applyUrl = pickString(obj, ["applyUrl", "apply_url"]);
    if (applyUrl && applyUrl !== jobUrl) result.applicationLink = applyUrl;

    return result;
  },
};

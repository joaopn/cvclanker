import type { CreateJobInput, JobSource } from "@shared/types";
import type { ProviderActorTemplate, ProviderRunContext } from "../../types";
import {
  FALLBACK_MAX_JOBS_PER_TERM,
  resolveSearchLocations,
} from "./mapper-helpers";

// The curious_coder actor rejects count < 10 and silently caps a missing
// count at 10 — so an under-sized count is the source of "only 10 jobs back".
const ACTOR_MIN_COUNT = 10;

function getSearchTerms(context: ProviderRunContext): string[] {
  return context.searchTerms
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

// Resolve the effective max job age in days: the per-instance override when
// set, else the global "Max job age to scrape" setting (runGlobals), else
// undefined (no recency filter).
function resolveMaxAgeDays(
  runGlobals: ProviderRunContext["runGlobals"],
  instanceMaxAgeDays?: number,
): number | undefined {
  if (typeof instanceMaxAgeDays === "number" && instanceMaxAgeDays > 0) {
    return Math.floor(instanceMaxAgeDays);
  }
  const parsed = Number(runGlobals.maxAgeDays);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// LinkedIn encodes the "Date posted" filter in the search URL as
// `f_TPR=r<seconds>` (e.g. r86400 = 24h, r604800 = 7d, r2592000 = 30d). The
// curious_coder actor only consumes search URLs (it has no date input field),
// so the resolved max-age-to-scrape has to ride in the URL here.
function postedWithinSecondsFor(maxAgeDays: number | undefined): number | null {
  if (typeof maxAgeDays !== "number" || maxAgeDays <= 0) return null;
  return maxAgeDays * 86_400;
}

/**
 * Build the LinkedIn jobs-search URLs the curious_coder actor scrapes, from
 * the live run context: one per configured location (each city, else the
 * country), since LinkedIn's `location` param takes a single place. The
 * provider runs this template once per search term, so `terms` normally holds
 * one; more are OR-joined into one quoted query. Values are URL-encoded.
 */
function buildLinkedInSearchUrls(
  terms: string[],
  runGlobals: ProviderRunContext["runGlobals"],
  maxAgeDays: number | undefined,
): string[] {
  const keywords = terms.map((term) => `"${term}"`).join(" OR ");

  const locations = resolveSearchLocations(runGlobals);
  const locationList = locations.length > 0 ? locations : [""];

  const postedWithinSeconds = postedWithinSecondsFor(maxAgeDays);

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const location of locationList) {
    const params: string[] = [];
    if (keywords) params.push(`keywords=${encodeURIComponent(keywords)}`);
    if (location) params.push(`location=${encodeURIComponent(location)}`);
    if (postedWithinSeconds !== null) {
      params.push(`f_TPR=r${postedWithinSeconds}`);
    }
    params.push("pageNum=0");
    const url = `https://www.linkedin.com/jobs/search/?${params.join("&")}`;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls.length > 0
    ? urls
    : ["https://www.linkedin.com/jobs/search/?pageNum=0"];
}

/**
 * The most results one run may return: the term's budget, which the provider
 * hands over because this template runs once per term. Without one (a direct
 * call that is not per term) the run's per-term cap times its term count.
 */
function resolveRunBudget(context: ProviderRunContext, termCount: number) {
  if (typeof context.termBudget === "number" && context.termBudget > 0) {
    return Math.floor(context.termBudget);
  }
  const parsed = Number(context.runGlobals.maxJobsPerTerm);
  const perTerm =
    Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_MAX_JOBS_PER_TERM;
  return Math.floor(perTerm) * Math.max(1, termCount);
}

function pickString(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function joinSalary(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  if (parts.length === 0) return undefined;
  return parts.join(" – ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const linkedinJobsScraperTemplate: ProviderActorTemplate = {
  id: "linkedin-jobs-scraper",
  providerId: "apify",
  actorRef: "curious_coder/linkedin-jobs-scraper",
  displayName: "LinkedIn Jobs Scraper (curious_coder)",
  description:
    "curious_coder/linkedin-jobs-scraper. Search URLs and result count are built automatically from your configured search terms + location — you no longer paste LinkedIn URLs here, and any `urls`/`count` you set are ignored/overridden. Each search term is its own actor run, one after another in the profile's term order, because LinkedIn pads every search with loosely related postings and one OR-joined query spent its whole cap on that padding. Each run is capped at that term's job budget, set on the Search Profile (a default plus per-term overrides; the actor's minimum is 10), and split evenly across one URL per city (else one for the country). Each city is searched qualified with your selected country, because LinkedIn resolves a bare city name to whichever one it ranks highest (a plain `Cambridge` returns Toronto-area jobs). The instance's own max-jobs value is not used. A posting that matches two terms is returned, and billed, by both runs. The global max-job-age-to-scrape setting is applied via the LinkedIn f_TPR date filter on the built URLs when set. Set scrapeCompany=true if you want company-side fields populated (costs more CUs).",
  defaultInputTemplate: JSON.stringify(
    {
      scrapeCompany: false,
    },
    null,
    2,
  ),
  maxAgeNote:
    "Sent exactly, as LinkedIn's f_TPR recency filter (seconds), so any number of days is honoured as-is.",
  defaultMappings: {
    maxJobsPerTerm: true,
    maxAgeDays: true,
  },
  perTermRuns: true,
  buildInput(context, base) {
    // Honor the configured location/terms by computing the search URLs and
    // count here; preserve per-instance knobs (scrapeCompany) from the
    // substituted stored input and override only the computed fields.
    // Self-heals instances created from the old location-pinned default.
    const baseObj =
      base && typeof base === "object" && !Array.isArray(base)
        ? (base as Record<string, unknown>)
        : {};
    const terms = getSearchTerms(context);
    const maxAgeDays = resolveMaxAgeDays(
      context.runGlobals,
      context.instance.maxAgeDays,
    );
    const urls = buildLinkedInSearchUrls(terms, context.runGlobals, maxAgeDays);
    const budget = Math.max(
      ACTOR_MIN_COUNT,
      resolveRunBudget(context, terms.length),
    );
    return {
      ...baseObj,
      urls,
      // Since 2026-08-08 `count` is the actor's GLOBAL run max and
      // `limitPerSource` its per-URL cap. `count` is what holds the run to
      // the budget; `limitPerSource` shares it across the cities so the first
      // one crawled cannot take all of it. It cannot while every city gets at
      // least the actor's minimum of 10: past that (a budget under 10 per
      // city) the per-city floor exceeds the budget and the cities crawled
      // first fill it.
      count: budget,
      limitPerSource: Math.max(
        ACTOR_MIN_COUNT,
        Math.ceil(budget / Math.max(1, urls.length)),
      ),
    };
  },
  mapItem(item, context): CreateJobInput | null {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;

    const jobUrl = pickString(obj, ["link", "url", "job_url", "jobUrl"]);
    const title = pickString(obj, ["title", "job_title", "name"]);
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

    const sourceJobId = pickString(obj, ["id", "jobId"]);
    if (sourceJobId) result.sourceJobId = sourceJobId;

    const employerUrl = pickString(obj, [
      "companyLinkedinUrl",
      "companyUrl",
      "company_url",
    ]);
    if (employerUrl) result.employerUrl = employerUrl;

    const location = pickString(obj, ["location", "job_location"]);
    if (location) result.location = location;

    const description = pickString(obj, [
      "descriptionText",
      "description_text",
      "description",
      "job_description",
    ]);
    if (description) {
      result.jobDescription = description;
    } else {
      // Fall back to HTML if the actor only returned the rich variant.
      const htmlDescription = pickString(obj, [
        "descriptionHtml",
        "description_html",
      ]);
      if (htmlDescription) {
        const stripped = stripHtml(htmlDescription);
        if (stripped.length > 0) result.jobDescription = stripped;
      }
    }

    const datePosted = pickString(obj, [
      "postedAt",
      "posted_date",
      "date_posted",
    ]);
    if (datePosted) result.datePosted = datePosted;

    const jobType = pickString(obj, ["employmentType", "employment_type"]);
    if (jobType) result.jobType = jobType;

    const jobLevel = pickString(obj, ["seniorityLevel", "level", "seniority"]);
    if (jobLevel) result.jobLevel = jobLevel;

    const jobFunction = pickString(obj, ["jobFunction", "job_function"]);
    if (jobFunction) result.jobFunction = jobFunction;

    const companyIndustry = pickString(obj, ["industries", "industry"]);
    if (companyIndustry) result.companyIndustry = companyIndustry;

    const companyLogo = pickString(obj, ["companyLogo", "company_logo"]);
    if (companyLogo) result.companyLogo = companyLogo;

    const companyDescription = pickString(obj, [
      "companyDescription",
      "company_description",
    ]);
    if (companyDescription) result.companyDescription = companyDescription;

    const salary = joinSalary(obj.salaryInfo ?? obj.salary);
    if (salary) result.salary = salary;

    const applyUrl = pickString(obj, ["applyUrl", "apply_url"]);
    if (applyUrl && applyUrl !== jobUrl) result.applicationLink = applyUrl;

    return result;
  },
};

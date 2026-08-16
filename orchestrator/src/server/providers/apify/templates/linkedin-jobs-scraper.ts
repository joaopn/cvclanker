import type { CreateJobInput, JobSource } from "@shared/types";
import type { ProviderActorTemplate, ProviderRunContext } from "../../types";
import { resolveSearchLocations } from "./mapper-helpers";

// The curious_coder actor rejects count < 10 and silently caps a missing
// count at 10 — so an under-sized count is the source of "only 10 jobs back".
const ACTOR_MIN_COUNT = 10;

function getSearchTerms(context: ProviderRunContext): string[] {
  return context.searchTerms
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/**
 * Build the LinkedIn jobs-search URLs the curious_coder actor scrapes, from
 * the live run context. Search terms are OR-joined into a single quoted
 * keyword query (mirroring the jobspy query composition); one URL is emitted
 * per configured location (each city, else the country) so LinkedIn's
 * single-place `location` param is respected. Values are URL-encoded.
 */
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
 * Resolve the actor's budget for the whole run.
 *
 * This used to be the per-URL `count`, but on 2026-08-08 the actor moved that
 * meaning to `limitPerSource` and kept `count` only as a GLOBAL max. The number
 * computed here is therefore the run total; `buildInput` divides it across the
 * search URLs to get the per-URL cap.
 *
 *  - When the instance sets an explicit `maxJobs`, that IS the budget (the
 *    exposed override) — used verbatim, not multiplied by term count.
 *  - Otherwise it's budget-derived: `maxJobsPerTerm` is a per-(term × source)
 *    budget, but the URL builder OR-joins every term into ONE query per
 *    location, so the count is multiplied by the term count or the joined
 *    query returns only a single term's worth (≈ the actor's 10-job floor).
 */
function resolveLinkedInRunBudget(
  runGlobals: ProviderRunContext["runGlobals"],
  termCount: number,
  instanceMaxJobs?: number,
): number {
  if (typeof instanceMaxJobs === "number" && instanceMaxJobs > 0) {
    return Math.max(ACTOR_MIN_COUNT, Math.floor(instanceMaxJobs));
  }
  const parsed = Number(runGlobals.maxJobsPerTerm);
  const perTerm = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  return Math.max(ACTOR_MIN_COUNT, perTerm * Math.max(1, termCount));
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
    "curious_coder/linkedin-jobs-scraper. Search URLs and result count are built automatically from your configured search terms + location (one URL per city, else the country) — you no longer paste LinkedIn URLs here, and any `urls`/`count` you set are ignored/overridden. Each city is searched qualified with your selected country, because LinkedIn resolves a bare city name to whichever one it ranks highest (a plain `Cambridge` returns Toronto-area jobs). The run budget scales with your run budget × number of search terms (the actor enforces a minimum of 10) and is split evenly across those city searches. The global max-job-age-to-scrape setting is applied via the LinkedIn f_TPR date filter on the built URLs when set. Set scrapeCompany=true if you want company-side fields populated (costs more CUs).",
  defaultInputTemplate: JSON.stringify(
    {
      scrapeCompany: false,
    },
    null,
    2,
  ),
  defaultMappings: {
    maxJobsPerTerm: true,
    maxAgeDays: true,
  },
  buildInput(context, base) {
    // Honor the configured location/terms by computing the search URLs and
    // count here; preserve per-instance knobs (scrapeCompany) from the
    // substituted stored input and override only the computed fields.
    // Self-heals instances created from the old location-pinned default and
    // fixes the joined-query count under-sizing (the "only 10 jobs" cap).
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
    const runBudget = resolveLinkedInRunBudget(
      context.runGlobals,
      terms.length,
      context.instance.maxJobs,
    );
    return {
      ...baseObj,
      urls,
      // Both caps are sent on purpose. Since 2026-08-08 `count` is the actor's
      // GLOBAL run max (kept for backward compatibility) and `limitPerSource`
      // is the per-URL one, so this pins the same total spend on either build
      // while splitting it evenly across the cities. Sending only `count`
      // lets the first URL in the list consume the entire run — which is how
      // one mis-resolved city starves every city after it.
      count: runBudget,
      limitPerSource: Math.max(
        1,
        Math.ceil(runBudget / Math.max(1, urls.length)),
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

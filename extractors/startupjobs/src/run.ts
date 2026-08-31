import {
  formatCountryLabel,
  normalizeCountryKey,
} from "@shared/location-support.js";
import { resolveSearchCities } from "@shared/search-cities.js";
import type { CreateJobInput } from "@shared/types/jobs";
import {
  type StartupJobRecord,
  scrapeStartupJobsViaAlgolia,
} from "startup-jobs-scraper";
import {
  beginRateLimitedRun,
  hasExhaustedWaitBudget,
  isRateLimited,
  isRetryableRateLimit,
  registerRateLimit,
  waitForRateLimitWindow,
} from "./rate-limit";

/**
 * How many times one term's scrape is re-attempted through the shared backoff
 * before the source gives up.
 *
 * Three covers the failure the measurements actually show — a short-window
 * limit that clears in seconds — at a cost of one 5s and one 10s wait for the
 * term. Two would let a single blip end a leg that was about to work.
 *
 * This bounds ONE TERM only. The run as a whole is bounded separately by
 * `hasExhaustedWaitBudget`, because a limit that flaps is served on the retry
 * every time and so never reaches the third attempt.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 3;

export type StartupJobsProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      location?: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      location?: string;
      jobsFoundTerm: number;
    };

export interface RunStartupJobsOptions {
  searchTerms?: string[];
  selectedCountry?: string;
  locations?: string[];
  workplaceTypes?: Array<"remote" | "hybrid" | "onsite">;
  maxJobsPerTerm?: number;
  /**
   * How many detail pages the scraper fetches at once. The package defaults to
   * 8, which is the measured-failing rate against startup.jobs' per-IP limit.
   */
  detailConcurrency?: number;
  onProgress?: (event: StartupJobsProgressEvent) => void;
  shouldCancel?: () => boolean;
}

export interface StartupJobsResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Source items this run could not map into a job. */
  droppedCount?: number;
}

type StartupJobsWorkplaceType = "remote" | "hybrid" | "on-site";

function mapWorkplaceTypes(
  workplaceTypes: Array<"remote" | "hybrid" | "onsite"> | undefined,
): StartupJobsWorkplaceType[] | undefined {
  if (!workplaceTypes || workplaceTypes.length === 0) return undefined;

  return workplaceTypes.map((workplaceType) =>
    workplaceType === "onsite" ? "on-site" : workplaceType,
  );
}

function toPositiveIntOrFallback(
  value: number | string | undefined,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function inferJobType(disciplines: string | undefined): string | undefined {
  if (!disciplines) return undefined;
  const segments = disciplines
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : undefined;
}

function mapStartupJob(row: StartupJobRecord): CreateJobInput | null {
  if (!row.jobUrl) return null;

  return {
    source: "startupjobs",
    title: row.title || "Unknown Title",
    employer: row.employer || "Unknown Employer",
    employerUrl: row.employerUrl || undefined,
    jobUrl: row.jobUrl,
    applicationLink: row.applicationLink || row.jobUrl,
    disciplines: row.disciplines || undefined,
    deadline: row.deadline || undefined,
    salary: row.salary || undefined,
    location: row.location || undefined,
    degreeRequired: row.degreeRequired || undefined,
    starting: row.starting || undefined,
    jobDescription: row.jobDescription || undefined,
    jobType: inferJobType(row.disciplines),
    isRemote: row.location?.toLowerCase().includes("remote") ?? undefined,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error while running startup.jobs extractor.";
}

/** "; the N jobs already scraped were kept", or nothing when none were. */
function keptClause(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "; the 1 job already scraped was kept"
    : `; the ${count} jobs already scraped were kept`;
}

/**
 * The message the failed source row carries in the run banner.
 *
 * It names what was kept, because the funnel shows a failed source beside a
 * non-zero Scraped count and that combination otherwise reads as a bug — but
 * only when something actually was kept, since a first-term refusal keeps
 * nothing.
 */
function describeRefusal(args: {
  message: string;
  termsCompleted: number;
  termTotal: number;
  keptCount: number;
  detailConcurrency?: number;
  budgetExhausted?: boolean;
}): string {
  const searches = args.termTotal === 1 ? "term search" : "term searches";
  const scope = `stopped after ${args.termsCompleted} of ${args.termTotal} ${searches}${keptClause(args.keptCount)}`;

  // Only worth suggesting the lever when there is room to move: 1 is the
  // floor, both here and inside the scraper. The floor wording names another
  // lever rather than explaining the failure — "the run is too big for the
  // site's limit" is a cause, and the connection-refusal branch below has just
  // said we cannot tell the cause.
  //
  // "Max jobs discovered" and not the source's own "Max jobs per term": the
  // maxJobsPerTerm global mapping is enabledByDefault, so the run global
  // overwrites that field, and cutting the search-term list RAISES the derived
  // per-term cap proportionally rather than shrinking the run.
  const advice =
    (args.detailConcurrency ?? 1) > 1
      ? ' Lower "Detail concurrency" for this source if it persists.'
      : ' Detail concurrency is already at its floor of 1; to make the run smaller, lower "Max jobs discovered" on the search profile.';

  if (args.budgetExhausted) {
    return `startup.jobs kept rate limiting this machine — ${scope}. Waiting longer stopped being worthwhile, so the source gave up; its scrape window is unchanged and the next run re-covers it.${advice}`;
  }

  return isRetryableRateLimit(args.message)
    ? `startup.jobs is rate limiting this machine (HTTP 429) — ${scope}.${advice}`
    : // Deliberately does not assert a cause: a Cloudflare block and a genuine
      // container connectivity failure are indistinguishable from here, which
      // is the same reason these are not retried.
      `startup.jobs is refusing connections from this machine — ${scope}. That is usually a rate limit escalating, but a connectivity problem in the container looks identical from here.${advice}`;
}

function resolveRunLocations(args: {
  selectedCountry?: string;
  locations?: string[];
}): Array<string | null> {
  const locations = resolveSearchCities({
    list: args.locations,
  });

  const normalizedLocations = locations
    .map((location) => normalizeCountryKey(location))
    .filter((location) => location !== "worldwide" && location !== "usa/ca");

  if (normalizedLocations.length > 0) {
    return normalizedLocations.map((location) => formatCountryLabel(location));
  }

  const countryKey = normalizeCountryKey(args.selectedCountry);
  if (!countryKey || countryKey === "worldwide" || countryKey === "usa/ca") {
    return [null];
  }

  return [formatCountryLabel(countryKey)];
}

export async function runStartupJobs(
  options: RunStartupJobsOptions = {},
): Promise<StartupJobsResult> {
  const searchTerms =
    options.searchTerms && options.searchTerms.length > 0
      ? options.searchTerms
      : ["software engineer"];
  const runLocations = resolveRunLocations({
    selectedCountry: options.selectedCountry,
    locations: options.locations,
  });
  // The scraper substitutes a hardcoded default location (Preston, UK) when
  // it receives no location, so skip the run for broad/worldwide configs
  // rather than silently scraping the wrong place. A worldwide search is a
  // valid config (other sources honour it) — this source just can't serve it,
  // so it yields no jobs instead of erroring the pipeline.
  const usableLocations = runLocations.filter(
    (location): location is string =>
      typeof location === "string" && location.trim().length > 0,
  );
  if (usableLocations.length === 0) {
    return { success: true, jobs: [] };
  }
  const maxJobsPerTerm = toPositiveIntOrFallback(options.maxJobsPerTerm, 50);
  const workplaceType = mapWorkplaceTypes(options.workplaceTypes);
  const termTotal = searchTerms.length * usableLocations.length;
  const jobs: CreateJobInput[] = [];
  let unmappable = 0;
  const seen = new Set<string>();
  let runIndex = 0;

  // The escalation is per run; an already-open window from another leg of the
  // same chain still applies.
  beginRateLimitedRun();
  // Set when startup.jobs refuses the machine. A refusal is per-IP, so every
  // remaining term would only re-prove it at the cost of more requests — stop
  // the whole source and keep what was scraped.
  let stopReason: string | null = null;

  try {
    for (const location of usableLocations) {
      if (stopReason) break;
      for (const searchTerm of searchTerms) {
        runIndex += 1;
        if (options.shouldCancel?.()) {
          return { success: true, jobs, droppedCount: unmappable };
        }

        options.onProgress?.({
          type: "term_start",
          termIndex: runIndex,
          termTotal,
          searchTerm,
          location,
        });

        let records: StartupJobRecord[] | null = null;
        for (
          let attempt = 1;
          attempt <= MAX_RATE_LIMIT_ATTEMPTS;
          attempt += 1
        ) {
          if (!(await waitForRateLimitWindow(options.shouldCancel))) {
            return { success: true, jobs, droppedCount: unmappable };
          }

          try {
            records = await scrapeStartupJobsViaAlgolia({
              query: searchTerm,
              requestedCount: maxJobsPerTerm,
              enrichDetails: true,
              detailConcurrency: options.detailConcurrency,
              location,
              workplaceType,
            });
            break;
          } catch (error) {
            const message = toErrorMessage(error);
            // Anything that is not startup.jobs refusing this machine is a
            // real fault: let it reach the outer catch, which still salvages.
            if (!isRateLimited(message)) throw error;

            registerRateLimit();
            const lastAttempt = attempt === MAX_RATE_LIMIT_ATTEMPTS;
            // Bounds the RUN, where the attempt count only bounds one term: a
            // limit that flaps never exhausts attempts, so without this a long
            // term list can sit in backoff for over an hour.
            const outOfBudget = hasExhaustedWaitBudget();
            // A connection-level refusal opens a window but earns no retry —
            // retrying a genuine connectivity outage just waits into a wall.
            if (!isRetryableRateLimit(message) || lastAttempt || outOfBudget) {
              stopReason = describeRefusal({
                message,
                // runIndex counts the term that just FAILED, so the number of
                // terms actually covered is one fewer.
                termsCompleted: runIndex - 1,
                termTotal,
                keptCount: jobs.length,
                detailConcurrency: options.detailConcurrency,
                budgetExhausted: outOfBudget,
              });
              break;
            }
          }
        }

        if (stopReason) break;
        // The retry loop always exits by assigning `records`, setting
        // `stopReason`, or throwing, so this is unreachable through the loop
        // itself — but it is reachable when the scraper resolves to something
        // that is not an array, which is what a reset-but-unstubbed mock
        // returns. Without it that would read as "this term found nothing",
        // under-reporting a failure as an empty scrape.
        if (!records) {
          stopReason = `startup.jobs returned no result for term ${runIndex} of ${termTotal}${keptClause(jobs.length)}.`;
          break;
        }

        let jobsFoundTerm = 0;
        for (const record of records) {
          const mapped = mapStartupJob(record);
          if (!mapped) {
            // A record the API returned that has no usable url/title. Counted
            // rather than dropped in silence.
            unmappable += 1;
            continue;
          }
          const dedupeKey = mapped.jobUrl;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          jobs.push(mapped);
          jobsFoundTerm += 1;
        }

        options.onProgress?.({
          type: "term_complete",
          termIndex: runIndex,
          termTotal,
          searchTerm,
          location,
          jobsFoundTerm,
        });
      }
    }

    if (stopReason) {
      // Salvage: the jobs collected before the refusal are real and already
      // paid for. The source still reports failure, so its scrape watermark
      // holds and the next run re-covers the same window — the same contract
      // the Apify provider uses for a run that dies mid-flight.
      return {
        success: false,
        jobs,
        droppedCount: unmappable,
        error: stopReason,
      };
    }

    return {
      success: true,
      jobs,
      droppedCount: unmappable,
    };
  } catch (error) {
    const message = toErrorMessage(error);
    const missingBrowser =
      /playwright|browser|executable/i.test(message) &&
      /install/i.test(message);
    // Connectivity failures no longer reach here: the retry loop classifies
    // them first (isConnectionRefusal is a superset of the old test) and stops
    // the source with its own message. What still lands here is a genuine
    // fault — a missing browser, a shape the scraper could not parse — so the
    // raw message is the useful thing to show.
    return {
      // Salvage here too: `jobs` accumulates across every term, so returning
      // an empty array would discard every term that had already succeeded.
      success: false,
      jobs,
      droppedCount: unmappable,
      error: missingBrowser
        ? `${message}. Install browser binaries with 'npx playwright install'.`
        : message,
    };
  }
}

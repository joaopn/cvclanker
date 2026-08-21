import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";

const HIMALAYAS_API_URL = "https://himalayas.app/jobs/api";
// The API clamps `limit` to 20 whatever is requested (verified live
// 2026-08-21: limit=100 echoes back `limit: 20`).
const PAGE_SIZE = 20;
// The API has NO keyword filter, only newest-first paging over ~100k rows, so
// the window is what bounds a run. The page cap is a backstop against a very
// wide window: 50 pages = 1,000 rows read per run at most.
const PAGE_LIMIT = 50;
// Applied when no max-age window is configured, because an unbounded
// newest-first walk has no natural stopping point on this API.
const DEFAULT_MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

export type HimalayasWorkplaceType = "remote" | "hybrid" | "onsite";

export type HimalayasProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    };

export interface RunHimalayasOptions {
  searchTerms?: string[];
  workplaceTypes?: HimalayasWorkplaceType[];
  /** Cap on the joined result set (the board has no per-term search). */
  maxJobs?: number;
  maxAgeDays?: number;
  onProgress?: (event: HimalayasProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
  /** Test hook: the reference "now" for the age window. */
  now?: number;
}

export interface HimalayasResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Source items this run could not map into a job. */
  droppedCount?: number;
}

interface HimalayasJob {
  title?: unknown;
  companyName?: unknown;
  companySlug?: unknown;
  description?: unknown;
  excerpt?: unknown;
  guid?: unknown;
  applicationLink?: unknown;
  locationRestrictions?: unknown;
  timezoneRestrictions?: unknown;
  minSalary?: unknown;
  maxSalary?: unknown;
  currency?: unknown;
  salaryPeriod?: unknown;
  seniority?: unknown;
  employmentType?: unknown;
  categories?: unknown;
  pubDate?: unknown;
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toStringOrNull(item))
    .filter((item): item is string => item !== null);
}

export function stripHtml(value: string): string {
  return (
    value
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      // Decoded LAST so "&amp;lt;" single-decodes to the text "&lt;" instead of
      // double-decoding into markup.
      .replace(/&amp;/gi, "&")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  );
}

/**
 * Whether a job survives the search-term filter. The API cannot search, so
 * terms match client-side: every whitespace-separated word of at least one
 * term must appear in the job's title/excerpt/categories text. No terms = keep
 * everything.
 */
export function matchesSearchTerms(
  haystack: string,
  searchTerms: readonly string[],
): boolean {
  if (searchTerms.length === 0) return true;
  const text = haystack.toLowerCase();
  return searchTerms.some((term) => {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((word) => text.includes(word));
  });
}

function formatSalary(args: {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
}): string | undefined {
  const { min, max, currency, period } = args;
  if (min === null && max === null) return undefined;
  const range =
    min !== null && max !== null
      ? `${Math.round(min)}-${Math.round(max)}`
      : min !== null
        ? `${Math.round(min)}+`
        : `${Math.round(max ?? 0)}`;
  return [currency, range, period ? `/ ${period}` : ""]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function buildLocationEvidence(restrictions: string[]): JobLocationEvidence {
  // No restriction = apply from anywhere. The literal phrase is what the
  // matcher's remote branch recognises as universally eligible.
  const location =
    restrictions.length > 0 ? restrictions.join(", ") : "Anywhere in the World";
  return {
    location,
    country: restrictions.length === 1 ? restrictions[0] : undefined,
    isRemote: true,
    source: "himalayas",
  };
}

/** Epoch seconds, ms, or parseable string → epoch ms; null when unreadable. */
function pubDateMs(value: unknown): number | null {
  const numeric = toNumberOrNull(value);
  if (numeric !== null) {
    // The API emits epoch seconds; tolerate ms in case that ever changes.
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const text = toStringOrNull(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function mapHimalayasJob(raw: HimalayasJob): CreateJobInput | null {
  const title = toStringOrNull(raw.title);
  const jobUrl = toStringOrNull(raw.guid);
  if (!title || !jobUrl) return null;

  const employer = toStringOrNull(raw.companyName) ?? "Unknown Employer";
  const companySlug = toStringOrNull(raw.companySlug);
  const restrictions = toStringArray(raw.locationRestrictions);
  const description = toStringOrNull(raw.description);
  const excerpt = toStringOrNull(raw.excerpt);
  const min = toNumberOrNull(raw.minSalary);
  const max = toNumberOrNull(raw.maxSalary);
  const currency = toStringOrNull(raw.currency);
  const period = toStringOrNull(raw.salaryPeriod);
  const seniority = toStringArray(raw.seniority);
  const jobType = toStringOrNull(raw.employmentType);
  const posted = pubDateMs(raw.pubDate);

  return {
    source: "himalayas",
    sourceJobId: jobUrl,
    title,
    employer,
    employerUrl: companySlug
      ? `https://himalayas.app/companies/${companySlug}`
      : undefined,
    jobUrl,
    applicationLink: toStringOrNull(raw.applicationLink) ?? jobUrl,
    location:
      restrictions.length > 0
        ? restrictions.join(", ")
        : "Anywhere in the World",
    locationEvidence: buildLocationEvidence(restrictions),
    jobDescription: description
      ? stripHtml(description)
      : (excerpt ?? undefined),
    datePosted: posted !== null ? new Date(posted).toISOString() : undefined,
    salary: formatSalary({ min, max, currency, period }),
    salaryMinAmount: min ?? undefined,
    salaryMaxAmount: max ?? undefined,
    salaryCurrency: currency ?? undefined,
    salaryInterval: period ?? undefined,
    jobLevel: seniority.length > 0 ? seniority.join(", ") : undefined,
    jobType: jobType ?? undefined,
    isRemote: true,
  };
}

function searchableText(raw: HimalayasJob): string {
  return [
    toStringOrNull(raw.title) ?? "",
    toStringOrNull(raw.excerpt) ?? "",
    ...toStringArray(raw.categories),
  ].join(" ");
}

export async function runHimalayas(
  options: RunHimalayasOptions = {},
): Promise<HimalayasResult> {
  const workplaceTypes = options.workplaceTypes ?? [];
  // Remote-only board: nothing to contribute when the profile deliberately
  // unticked remote (same guard as Working Nomads).
  if (workplaceTypes.length > 0 && !workplaceTypes.includes("remote")) {
    return { success: true, jobs: [] };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const searchTerms = (options.searchTerms ?? [])
    .map((term) => term.trim())
    .filter(Boolean);
  const maxJobs =
    options.maxJobs !== undefined && Number.isFinite(options.maxJobs)
      ? Math.max(1, Math.floor(options.maxJobs))
      : 50;
  const maxAgeDays =
    options.maxAgeDays !== undefined &&
    Number.isFinite(options.maxAgeDays) &&
    options.maxAgeDays > 0
      ? options.maxAgeDays
      : DEFAULT_MAX_AGE_DAYS;
  const now = options.now ?? Date.now();
  const cutoffMs = now - maxAgeDays * DAY_MS;
  const termLabel = searchTerms.join(" OR ") || "(all jobs)";

  options.onProgress?.({
    type: "term_start",
    termIndex: 1,
    termTotal: 1,
    searchTerm: termLabel,
  });

  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  let dropped = 0;

  try {
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      if (options.shouldCancel?.()) break;
      if (jobs.length >= maxJobs) break;

      const url = `${HIMALAYAS_API_URL}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Himalayas API responded ${response.status}`);
      }
      const payload = (await response.json()) as HimalayasResponse;
      const rows = Array.isArray(payload.jobs) ? payload.jobs : [];
      if (rows.length === 0) break;

      let crossedWindow = false;
      for (const raw of rows) {
        if (jobs.length >= maxJobs) break;

        const posted = pubDateMs(raw.pubDate);
        // Newest-first: the first row older than the window ends the walk.
        // A row with no readable date is exempt from the window check (kept
        // when it matches), never treated as a boundary.
        if (posted !== null && posted < cutoffMs) {
          crossedWindow = true;
          break;
        }

        // Not unmappable: the row is fine, it just isn't about the user's
        // search terms. Only mapper failures count as dropped.
        if (!matchesSearchTerms(searchableText(raw), searchTerms)) continue;

        const mapped = mapHimalayasJob(raw);
        if (!mapped) {
          dropped += 1;
          continue;
        }
        if (seenUrls.has(mapped.jobUrl)) continue;
        seenUrls.add(mapped.jobUrl);
        jobs.push(mapped);
      }

      if (crossedWindow) break;
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex: 1,
      termTotal: 1,
      searchTerm: termLabel,
      jobsFoundTerm: jobs.length,
    });

    return { success: true, jobs, droppedCount: dropped };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, jobs: [], error: message };
  }
}

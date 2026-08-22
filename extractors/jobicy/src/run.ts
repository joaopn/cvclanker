import { normalizeCountryKey } from "@shared/location-support.js";
import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";

const JOBICY_API_URL = "https://jobicy.com/api/v2/remote-jobs";
// The API honors count up to at least 100 (verified live 2026-08-21).
const MAX_COUNT = 100;
const DAY_MS = 86_400_000;

/**
 * Jobicy's geo slug grammar, verified against the live API: lowercase country
 * name with spaces → dashes ("portugal", "new-zealand", "hong-kong") EXCEPT
 * the two short forms below. An unknown slug silently un-filters (the
 * appliedFilters echo just omits geo), which is safe here — the geo field is
 * an opt-in narrowing on top of the remote profile's location blocklist.
 */
const GEO_SLUG_OVERRIDES: Record<string, string> = {
  "united kingdom": "uk",
  "united states": "usa",
  // Jobicy's own spelling (verified live: geo=turkey silently un-filters).
  turkey: "turkiye",
};

export function jobicyGeoSlug(
  selectedCountry: string | undefined,
): string | undefined {
  const key = normalizeCountryKey(selectedCountry);
  if (!key || key === "worldwide") return undefined;
  // usa/ca spans two countries and geo takes one — an unfiltered request
  // keeps the Canada-only rows; the remote profile's blocklist (applied at
  // discovery, before any scoring spend) is where the user trims the rest.
  if (key === "usa/ca") return undefined;
  return GEO_SLUG_OVERRIDES[key] ?? key.replace(/\s+/g, "-");
}

export type JobicyWorkplaceType = "remote" | "hybrid" | "onsite";

export type JobicyProgressEvent =
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

export interface RunJobicyOptions {
  searchTerms?: string[];
  workplaceTypes?: JobicyWorkplaceType[];
  /** The profile's country — sent as Jobicy's server-side geo filter. */
  selectedCountry?: string;
  /** Cap on each per-term request (the API's `count` param, server max 100). */
  maxJobsPerTerm?: number;
  maxAgeDays?: number;
  onProgress?: (event: JobicyProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
  /** Test hook: the reference "now" for the age window. */
  now?: number;
}

export interface JobicyResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Source items this run could not map into a job. */
  droppedCount?: number;
}

interface JobicyJob {
  id?: unknown;
  url?: unknown;
  jobTitle?: unknown;
  companyName?: unknown;
  companyLogo?: unknown;
  jobIndustry?: unknown;
  jobType?: unknown;
  jobGeo?: unknown;
  jobLevel?: unknown;
  jobExcerpt?: unknown;
  jobDescription?: unknown;
  pubDate?: unknown;
  annualSalaryMin?: unknown;
  annualSalaryMax?: unknown;
  salaryCurrency?: unknown;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
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

/** Jobicy emits both plain strings and arrays for classification fields. */
function toJoinedString(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => toStringOrNull(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return toStringOrNull(value);
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

function buildLocationEvidence(geo: string | null): JobLocationEvidence {
  return {
    // "Anywhere" is Jobicy's own unrestricted value; multi-region strings
    // ("APAC, EMEA") are OR-lists the matcher evaluates per comma segment.
    location: geo ?? "Anywhere",
    isRemote: true,
    source: "jobicy",
  };
}

export function mapJobicyJob(raw: JobicyJob): CreateJobInput | null {
  const title = toStringOrNull(raw.jobTitle);
  const jobUrl = toStringOrNull(raw.url);
  if (!title || !jobUrl) return null;

  const geo = toStringOrNull(raw.jobGeo);
  const description = toStringOrNull(raw.jobDescription);
  const excerpt = toStringOrNull(raw.jobExcerpt);
  const min = toNumberOrNull(raw.annualSalaryMin);
  const max = toNumberOrNull(raw.annualSalaryMax);
  const currency = toStringOrNull(raw.salaryCurrency);
  const posted = raw.pubDate ? Date.parse(String(raw.pubDate)) : Number.NaN;

  return {
    source: "jobicy",
    sourceJobId: toStringOrNull(raw.id) ?? jobUrl,
    title,
    employer: toStringOrNull(raw.companyName) ?? "Unknown Employer",
    jobUrl,
    applicationLink: jobUrl,
    location: geo ?? "Anywhere",
    locationEvidence: buildLocationEvidence(geo),
    jobDescription: description
      ? stripHtml(description)
      : excerpt
        ? stripHtml(excerpt)
        : undefined,
    datePosted: Number.isFinite(posted)
      ? new Date(posted).toISOString()
      : undefined,
    salaryMinAmount: min ?? undefined,
    salaryMaxAmount: max ?? undefined,
    salaryCurrency: currency ?? undefined,
    jobLevel: toJoinedString(raw.jobLevel) ?? undefined,
    jobType: toJoinedString(raw.jobType) ?? undefined,
    jobFunction: toJoinedString(raw.jobIndustry) ?? undefined,
    companyLogo: toStringOrNull(raw.companyLogo) ?? undefined,
    isRemote: true,
  };
}

export async function runJobicy(
  options: RunJobicyOptions = {},
): Promise<JobicyResult> {
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
  // No terms configured = one un-tagged request for the newest postings.
  const termQueries: Array<string | null> =
    searchTerms.length > 0 ? searchTerms : [null];
  const maxJobsPerTerm =
    options.maxJobsPerTerm !== undefined &&
    Number.isFinite(options.maxJobsPerTerm)
      ? Math.max(1, Math.floor(options.maxJobsPerTerm))
      : 50;
  const count = Math.min(MAX_COUNT, maxJobsPerTerm);
  const geoSlug = jobicyGeoSlug(options.selectedCountry);
  const cutoffMs =
    options.maxAgeDays !== undefined &&
    Number.isFinite(options.maxAgeDays) &&
    options.maxAgeDays > 0
      ? (options.now ?? Date.now()) - options.maxAgeDays * DAY_MS
      : null;

  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  let dropped = 0;
  let termsSucceeded = 0;
  let lastError: string | null = null;
  let cancelled = false;

  for (let index = 0; index < termQueries.length; index += 1) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const term = termQueries[index];
    const termLabel = term ?? "(all jobs)";

    options.onProgress?.({
      type: "term_start",
      termIndex: index + 1,
      termTotal: termQueries.length,
      searchTerm: termLabel,
    });

    let termFound = 0;
    try {
      const params = new URLSearchParams({ count: String(count) });
      if (term) params.set("tag", term);
      if (geoSlug) params.set("geo", geoSlug);
      const response = await fetchImpl(`${JOBICY_API_URL}?${params}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Jobicy API responded ${response.status}`);
      }
      const payload = (await response.json()) as JobicyResponse;
      const rows = Array.isArray(payload.jobs) ? payload.jobs : [];

      for (const raw of rows) {
        if (cutoffMs !== null) {
          const posted = raw.pubDate ? Date.parse(String(raw.pubDate)) : NaN;
          // Out-of-window rows are skipped, not a boundary — the API has no
          // guaranteed ordering contract across tag/geo filters.
          if (Number.isFinite(posted) && posted < cutoffMs) continue;
        }

        const mapped = mapJobicyJob(raw);
        if (!mapped) {
          dropped += 1;
          continue;
        }
        // Not unmappable: the same posting matching several terms is one job.
        if (seenUrls.has(mapped.jobUrl)) continue;
        seenUrls.add(mapped.jobUrl);
        jobs.push(mapped);
        termFound += 1;
      }
      termsSucceeded += 1;
    } catch (error) {
      // One term failing must not discard the terms that already succeeded —
      // log and move on. A total failure is handled after the loop.
      lastError = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `jobicy: term "${termLabel}" failed, skipping (${lastError})`,
      );
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex: index + 1,
      termTotal: termQueries.length,
      searchTerm: termLabel,
      jobsFoundTerm: termFound,
    });
  }

  // A cancelled run returns whatever it already collected, like the model
  // extractors; only a run where every ATTEMPTED term failed is a failure.
  if (!cancelled && termQueries.length > 0 && termsSucceeded === 0) {
    return {
      success: false,
      jobs: [],
      error: lastError ?? "Jobicy failed for every search term",
    };
  }

  return { success: true, jobs, droppedCount: dropped };
}

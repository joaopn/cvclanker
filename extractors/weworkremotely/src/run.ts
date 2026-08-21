import type { CreateJobInput, JobLocationEvidence } from "@shared/types/jobs";

const FEED_BASE_URL = "https://weworkremotely.com/categories";

/** The four programming feeds; a Search Profile can override the list. */
export const DEFAULT_CATEGORIES = [
  "remote-full-stack-programming-jobs",
  "remote-back-end-programming-jobs",
  "remote-front-end-programming-jobs",
  "remote-devops-sysadmin-jobs",
] as const;

const DAY_MS = 86_400_000;

export type WeWorkRemotelyWorkplaceType = "remote" | "hybrid" | "onsite";

export type WeWorkRemotelyProgressEvent =
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

export interface RunWeWorkRemotelyOptions {
  searchTerms?: string[];
  workplaceTypes?: WeWorkRemotelyWorkplaceType[];
  categories?: string[];
  /** Cap on the joined result set across all feeds. */
  maxJobs?: number;
  /** Optional window; each feed only holds its ~200 newest items anyway. */
  maxAgeDays?: number;
  onProgress?: (event: WeWorkRemotelyProgressEvent) => void;
  shouldCancel?: () => boolean;
  fetchImpl?: typeof fetch;
  /** Test hook: the reference "now" for the age window. */
  now?: number;
}

export interface WeWorkRemotelyResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /** Source items this run could not map into a job. */
  droppedCount?: number;
}

export interface WwrRssItem {
  title: string | null;
  region: string | null;
  category: string | null;
  jobType: string | null;
  pubDate: string | null;
  link: string | null;
  description: string | null;
}

function decodeEntities(value: string): string {
  // &amp; is decoded LAST: decoding it first turns "&amp;lt;" into "&lt;" and
  // a later replace then double-decodes it into a real "<".
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

export function stripHtml(value: string): string {
  return decodeEntities(
    value
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function tagContent(item: string, tag: string): string | null {
  const match = item.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  if (!match) return null;
  const content = match[1].trim();
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) {
    // CDATA is verbatim by definition — decoding it here would turn
    // entity-encoded literal markup in a description ("Vec&lt;T&gt;") into a
    // real tag that stripHtml then deletes.
    const raw = cdata[1].trim();
    return raw ? raw : null;
  }
  const decoded = decodeEntities(content).trim();
  return decoded ? decoded : null;
}

/**
 * Minimal RSS item parser. The WWR feeds are flat, well-formed RSS with
 * CDATA-wrapped descriptions; a tolerant regex pass keeps the extractor free
 * of an XML dependency (the runtime image gets no new npm packages).
 */
export function parseRssItems(feedXml: string): WwrRssItem[] {
  const items = feedXml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return items.map((item) => ({
    title: tagContent(item, "title"),
    region: tagContent(item, "region"),
    category: tagContent(item, "category"),
    jobType: tagContent(item, "type"),
    pubDate: tagContent(item, "pubDate"),
    link: tagContent(item, "link") ?? tagContent(item, "guid"),
    description: tagContent(item, "description"),
  }));
}

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

function buildLocationEvidence(region: string | null): JobLocationEvidence {
  return {
    // No region tag = the board's default unrestricted listing.
    location: region ?? "Anywhere in the World",
    isRemote: true,
    source: "weworkremotely",
  };
}

export function mapWwrItem(item: WwrRssItem): CreateJobInput | null {
  if (!item.title || !item.link) return null;

  // The feed's title grammar is "Company: Job Title".
  const splitIndex = item.title.indexOf(": ");
  const employer =
    splitIndex > 0
      ? item.title.slice(0, splitIndex).trim()
      : "Unknown Employer";
  const title =
    splitIndex > 0 ? item.title.slice(splitIndex + 2).trim() : item.title;
  if (!title) return null;

  const posted = item.pubDate ? Date.parse(item.pubDate) : Number.NaN;

  return {
    source: "weworkremotely",
    sourceJobId: item.link,
    title,
    employer,
    jobUrl: item.link,
    applicationLink: item.link,
    location: item.region ?? "Anywhere in the World",
    locationEvidence: buildLocationEvidence(item.region),
    jobDescription: item.description ? stripHtml(item.description) : undefined,
    datePosted: Number.isFinite(posted)
      ? new Date(posted).toISOString()
      : undefined,
    jobFunction: item.category ?? undefined,
    jobType: item.jobType ?? undefined,
    isRemote: true,
  };
}

function normalizeCategories(categories: string[] | undefined): string[] {
  const raw =
    categories && categories.length > 0 ? categories : [...DEFAULT_CATEGORIES];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.rss$/, "");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export async function runWeWorkRemotely(
  options: RunWeWorkRemotelyOptions = {},
): Promise<WeWorkRemotelyResult> {
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
  const categories = normalizeCategories(options.categories);
  const maxJobs =
    options.maxJobs !== undefined && Number.isFinite(options.maxJobs)
      ? Math.max(1, Math.floor(options.maxJobs))
      : 50;
  const cutoffMs =
    options.maxAgeDays !== undefined &&
    Number.isFinite(options.maxAgeDays) &&
    options.maxAgeDays > 0
      ? (options.now ?? Date.now()) - options.maxAgeDays * DAY_MS
      : null;

  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  let dropped = 0;
  let feedsSucceeded = 0;
  let lastError: string | null = null;

  let cancelled = false;
  for (let index = 0; index < categories.length; index += 1) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      break;
    }
    if (jobs.length >= maxJobs) break;
    const category = categories[index];

    options.onProgress?.({
      type: "term_start",
      termIndex: index + 1,
      termTotal: categories.length,
      searchTerm: category,
    });

    let feedFound = 0;
    try {
      const response = await fetchImpl(`${FEED_BASE_URL}/${category}.rss`, {
        headers: { accept: "application/rss+xml, application/xml, text/xml" },
      });
      if (!response.ok) {
        throw new Error(`feed responded ${response.status}`);
      }
      const xml = await response.text();

      for (const item of parseRssItems(xml)) {
        if (jobs.length >= maxJobs) break;

        if (cutoffMs !== null && item.pubDate) {
          const posted = Date.parse(item.pubDate);
          // Feed items are not strictly date-ordered across reposts, so an
          // out-of-window item is skipped rather than ending the feed.
          if (Number.isFinite(posted) && posted < cutoffMs) continue;
        }

        // Not unmappable: the row is fine, it just isn't about the user's
        // search terms. Only mapper failures count as dropped.
        if (
          !matchesSearchTerms(
            [item.title ?? "", item.category ?? "", item.description ?? ""]
              .join(" ")
              .toLowerCase(),
            searchTerms,
          )
        ) {
          continue;
        }

        const mapped = mapWwrItem(item);
        if (!mapped) {
          dropped += 1;
          continue;
        }
        if (seenUrls.has(mapped.jobUrl)) continue;
        seenUrls.add(mapped.jobUrl);
        jobs.push(mapped);
        feedFound += 1;
      }
      feedsSucceeded += 1;
    } catch (error) {
      // One feed failing must not discard the categories that already
      // succeeded — log and move on. A total failure is handled after the
      // loop (the jobspy per-location pattern).
      lastError = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `weworkremotely: feed "${category}" failed, skipping (${lastError})`,
      );
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex: index + 1,
      termTotal: categories.length,
      searchTerm: category,
      jobsFoundTerm: feedFound,
    });
  }

  // A cancelled run returns whatever it already collected, like the model
  // extractors; only a run where every ATTEMPTED feed failed is a failure.
  if (!cancelled && categories.length > 0 && feedsSucceeded === 0) {
    return {
      success: false,
      jobs: [],
      error: lastError ?? "Every We Work Remotely feed failed",
    };
  }

  return { success: true, jobs, droppedCount: dropped };
}

import { toStringOrNull } from "cvclanker-shared/utils/type-conversion";
import type { APIRequestContext } from "playwright";

export const BASE_URL = "https://hiring.cafe";

/**
 * Post-2026-07: the search SSR payload no longer carries
 * `job_information.description` — the site fetches it per job when a card is
 * opened, so every hit arrives description-less. We re-fetch it from the job's
 * own SSR page, which still bakes the full job into `__NEXT_DATA__`.
 *
 * hiring.cafe also answers `GET /api/job-description?id=<objectID>`, which is
 * ~20x lighter (3 KB vs 62 KB). It is deliberately NOT used: hiring.cafe has
 * killed its JSON endpoints before — that is exactly why search itself had to
 * move to SSR — so we stay on the page we already depend on. Do not "optimize"
 * this into the API.
 *
 * This module is deliberately camoufox-free and side-effect-free so it can be
 * imported by vitest; `main.ts` can never be (top-level camoufox import, and it
 * calls run() at module scope).
 */
const DETAIL_FETCH_TIMEOUT_MS = 20_000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function buildJobDetailUrl(requisitionId: string): string {
  return `${BASE_URL}/job/${encodeURIComponent(requisitionId)}`;
}

/**
 * Pull `__NEXT_DATA__` out of an HTML string. Anchored on the script's `id` —
 * the identifying attribute — while tolerating any others on the tag. Pinning
 * `type="application/json"` as the final attribute would break the moment
 * hiring.cafe enables CSP nonces (Next.js then emits `nonce="…"` here), and
 * every description would silently go missing again. Still strictly anchored:
 * this is not a loose scan of the page.
 */
export function extractNextData(html: string): unknown {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!match) {
    throw new Error(
      "Hiring Cafe page returned no __NEXT_DATA__ — site shape changed",
    );
  }

  try {
    return JSON.parse(match[1]) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Hiring Cafe __NEXT_DATA__ parse failed: ${message}`);
  }
}

export function isExpiredDetailPage(html: string): boolean {
  return /<title[^>]*>\s*HiringCafe\s*-\s*Expired Job\s*<\/title>/i.test(html);
}

/**
 * Walk the detail page's envelope with the same `asRecord` discipline the
 * search path uses, so a site-shape change fails both paths instead of one
 * quietly yielding undefined.
 */
export function readDetailDescription(nextData: unknown): string | null {
  const pageProps = asRecord(asRecord(asRecord(nextData)?.props)?.pageProps);
  const job = asRecord(pageProps?.job);
  const jobInformation = asRecord(job?.job_information);
  return toStringOrNull(jobInformation?.description);
}

/**
 * Fetch one job's description. Returns null — NEVER throws — on every failure
 * (non-2xx, expired posting, Cloudflare interstitial, missing `__NEXT_DATA__`,
 * blank description): a single bad job must not take down a run.
 *
 * The request rides the browser context's `APIRequestContext`, so it reuses the
 * Cloudflare-cleared session's cookies without rendering the page.
 */
export async function fetchJobDescription(
  request: APIRequestContext,
  requisitionId: string,
): Promise<string | null> {
  try {
    const response = await request.get(buildJobDetailUrl(requisitionId), {
      timeout: DETAIL_FETCH_TIMEOUT_MS,
    });
    if (!response.ok()) return null;

    const html = await response.text();
    if (isExpiredDetailPage(html)) return null;

    return readDetailDescription(extractNextData(html));
  } catch {
    return null;
  }
}

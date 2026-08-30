/**
 * Service for inferring job details from a pasted job description.
 */

import { AppError, unprocessableEntity } from "@infra/errors";
import { logger } from "@infra/logger";
import { extractBoard, extractExternalId } from "@shared/duplicate-identity";
import type { ManualJobDraft } from "@shared/types";
import { JSDOM } from "jsdom";
import { type Browser, firefox, type Page } from "playwright";
import { LlmService } from "./llm/service";
import type { JsonSchemaDefinition } from "./llm/types";
import { resolveLlmModel } from "./modelSelection";
import { loadPrompt } from "./prompts";
import { getEffectiveSettings } from "./settings";

export interface ManualJobInferenceResult {
  job: ManualJobDraft;
  warning?: string | null;
  usage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    totalMillions: number | null;
  } | null;
}

export interface FetchedJobContent {
  content: string;
  url: string;
  /**
   * Tier-1 (per-host) or tier-2 (LLM-selector) programmatic extraction. When
   * set, the caller should skip the tier-3 full-LLM call and use this draft
   * directly — its `jobDescription` is a verbatim DOM read, not
   * LLM-generated. Tier 2 still consumes tokens (for the selector call),
   * reported via `programmaticUsage`.
   */
  programmatic?: ManualJobDraft | null;
  programmaticUsage?: ManualJobInferenceResult["usage"];
}

const BROWSER_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Lazy Camoufox singleton — Camoufox is a Firefox fork with anti-fingerprinting
// patches; vanilla Playwright Firefox is rejected by some hosts. camoufox-js
// is imported dynamically because its top-level FingerprintGenerator reads a
// large Bayesian-network JSON at module load, which breaks vitest test
// suites that transitively import this file.
let _browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!_browserPromise) {
    _browserPromise = (async () => {
      const { launchOptions } = await import("camoufox-js");
      // geoip: false — the `true` variant downloads GeoLite.mmdb from
      // P3TERX/GeoLite.mmdb GitHub releases at runtime (URL keyed by today's
      // date). When that release isn't published yet upstream, every browser
      // launch fails with "Failed to download". The fingerprinting layer
      // works without it; we just lose IP-based locale spoofing.
      const options = await launchOptions({
        headless: true,
        humanize: true,
        geoip: false,
      });
      return firefox.launch(options);
    })().catch((err) => {
      _browserPromise = null;
      throw err;
    });
  }
  return _browserPromise;
}

/**
 * Per-host URL rewriting before fetch. Sites that ship SPA frontends often
 * expose a static, crawler-friendly endpoint with the same data — using that
 * dodges JS-rendering, fingerprinting, and authwall redirects entirely.
 *
 * Exported for test: the LinkedIn branch decides whether an import costs a
 * static 78 KB GET or a Camoufox launch into the sign-in wall.
 */
export function rewriteUrlForFetch(input: string): string {
  // LinkedIn: /jobs/view/<id> → /jobs-guest/jobs/api/jobPosting/<id>. The
  // guest endpoint returns a static HTML fragment with the job posting
  // content directly (designed for SEO crawlers). No authwall, no SPA.
  //
  // The id comes from the shared board-identity rule rather than a second
  // regex here. This function used to carry its own `^/jobs/view/(\d+)/?$`,
  // which matched a bare-numeric path only — but LinkedIn's own UI copies a
  // SLUGGED path, so every URL a user actually pastes missed the rewrite,
  // fell through to the browser tier and died on the authwall while the guest
  // endpoint served the posting in full (B56).
  //
  // The board is checked explicitly even though `extractExternalId` only
  // answers for linkedin today: the host below is hardcoded, and that module
  // documents adding a board as a one-line change. Without this gate, the day
  // it learns a second board is the day another board's id is fetched from
  // LinkedIn as though it were a LinkedIn posting.
  if (extractBoard(input) === "linkedin") {
    const linkedinJobId = extractExternalId({ jobUrl: input });
    if (linkedinJobId) {
      return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedinJobId}`;
    }
  }

  return input;
}

// Exported: services/live-status.ts reuses the same fetch tiers (static
// first, Camoufox on failure) for the LinkedIn live-status check. The
// optional `onNonOkStatus` surfaces the HTTP status a null return collapses
// away — live-status needs to tell a 429 (back off, never launch the
// browser) from every other failure (browser tier as usual).
export async function tryStaticFetch(
  url: string,
  signal: AbortSignal,
  options: { onNonOkStatus?: (status: number) => void } = {},
): Promise<{ html: string; finalUrl: string } | null> {
  // Many ATS / job-board hosts (SAP SuccessFactors, etc.) return 204 to
  // requests with no Referer as basic anti-scraping. Synthesize a same-origin
  // Referer so the request looks like internal navigation.
  const origin = new URL(url).origin;
  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": BROWSER_FETCH_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${origin}/`,
    },
  });

  if (!response.ok) {
    // Treat any non-OK static response as "try browser instead". Hosts that
    // gate content on JS / fingerprinting (LinkedIn → 999, Cloudflare → 403,
    // SAP SuccessFactors → 204) all need the Camoufox fallback. The browser
    // tier will surface a real error if it also fails.
    logger.info("manual-fetch static returned non-OK; falling through", {
      url,
      status: response.status,
      statusText: response.statusText,
    });
    options.onNonOkStatus?.(response.status);
    return null;
  }

  const html = await response.text();
  if (!html.trim()) return null;
  return { html, finalUrl: response.url };
}

export async function tryBrowserFetch(
  url: string,
  timeoutMs: number,
  settleMs: number,
): Promise<{ html: string; finalUrl: string }> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    throw new AppError({
      status: 502,
      code: "UPSTREAM_ERROR",
      message:
        err instanceof Error
          ? `Browser fallback failed to launch: ${err.message}`
          : "Browser fallback failed to launch",
      details: {
        hint: "Browser-rendered fallback failed to start; static fetch returned empty body.",
      },
    });
  }

  // Camoufox sets its own UA/locale/timezone; don't pass userAgent here.
  // Allow service workers + accept downloads + skip the subresource-block
  // route handler — anything we suppress is a fingerprint signal sites
  // like LinkedIn read to redirect us to an authwall.
  const context = await browser.newContext({
    javaScriptEnabled: true,
    acceptDownloads: true,
  });
  try {
    const page = await context.newPage();
    page.on("dialog", (d) => {
      d.dismiss().catch(() => {});
    });
    page.on("popup", (p) => {
      p.close().catch(() => {});
    });
    // Same Referer trick as tier-1 — covers ATS hosts that gate on Referer
    // presence (TU Wien / SAP SuccessFactors return 204 to direct hits).
    const origin = new URL(url).origin;
    try {
      await page.goto(url, {
        waitUntil: "load",
        timeout: timeoutMs,
        referer: `${origin}/`,
      });
    } catch (err) {
      // NS_BINDING_ABORTED fires when SPAs trigger an immediate JS redirect
      // before the initial navigation finishes. The page typically still
      // renders; proceed to read content if we got past the initial response.
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("NS_BINDING_ABORTED")) {
        throw err;
      }
    }
    if (settleMs > 0) {
      // Wait up to settleMs for the page's network to go idle (SPA hydration);
      // returns sooner if the network settles. 0 reads the DOM immediately.
      await page
        .waitForLoadState("networkidle", { timeout: settleMs })
        .catch(() => {});
    }
    return { html: await readSettledPageContent(page), finalUrl: page.url() };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * `page.content()` rejects with "Unable to retrieve content because the page
 * is navigating and changing the content" when a JS navigation is replacing
 * the document mid-read. LinkedIn's guest pages fire such redirects, and
 * under bulk live-status checks the race is common (field report: 8 of 37
 * browser-tier reads lost in one run). Wait the navigation out and re-read.
 *
 * Three attempts cover a redirect chain of two navigations; the settle wait
 * is bounded so a page navigating in a loop cannot hang the fetch (worst
 * case adds 2 × SETTLE_TIMEOUT_MS before the last error is rethrown). Any
 * other content() error is rethrown untouched on first sight.
 *
 * Exported for tests only — production callers go through tryBrowserFetch.
 */
export async function readSettledPageContent(page: Page): Promise<string> {
  const CONTENT_ATTEMPTS = 3;
  const SETTLE_TIMEOUT_MS = 2_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < CONTENT_ATTEMPTS; attempt++) {
    try {
      return await page.content();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("Unable to retrieve content")) throw error;
      lastError = error;
      // Let the in-flight navigation finish; a timeout here is fine — the
      // page may have settled anyway, and the next content() attempt is the
      // real test.
      await page
        .waitForLoadState("load", { timeout: SETTLE_TIMEOUT_MS })
        .catch(() => {});
    }
  }
  throw lastError;
}

interface ExtractedJobFields {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  /**
   * Full programmatic draft. When present, the caller can skip the LLM
   * tier entirely — every field below is a verbatim DOM read.
   */
  programmatic?: ManualJobDraft | null;
}

function cleanWhitespace(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function cleanMultilineWhitespace(value: string): string {
  return value
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getTextFromSelectors(
  document: Document,
  selectors: readonly string[],
): string | undefined {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text && text.length > 0) return cleanWhitespace(text);
    } catch {
      // Bad selector — skip.
    }
  }
  return undefined;
}

function getElementFromSelectors(
  document: Document,
  selectors: readonly string[],
): Element | null {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      // Bad selector — skip.
    }
  }
  return null;
}

/**
 * Walk an HTML element and emit a plain-text rendering that preserves
 * paragraph breaks, list bullets, and line breaks verbatim. Used by the
 * per-host programmatic extractors so the description in the saved job
 * matches what the candidate sees on the source page byte-for-byte
 * (modulo HTML markup conversion). No LLM involvement.
 */
function htmlElementToVerbatimText(root: Element): string {
  const out: string[] = [];
  const NODE_TEXT = 3;
  const NODE_ELEMENT = 1;

  function walk(node: Node): void {
    if (node.nodeType === NODE_TEXT) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== NODE_ELEMENT) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "br":
        out.push("\n");
        return;
      case "p":
      case "div": {
        for (const child of Array.from(node.childNodes)) walk(child);
        out.push("\n\n");
        return;
      }
      case "ul":
      case "ol": {
        out.push("\n");
        for (const child of Array.from(node.childNodes)) walk(child);
        out.push("\n");
        return;
      }
      case "li": {
        out.push("- ");
        for (const child of Array.from(node.childNodes)) walk(child);
        out.push("\n");
        return;
      }
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        out.push("\n");
        for (const child of Array.from(node.childNodes)) walk(child);
        out.push("\n\n");
        return;
      }
      case "script":
      case "style":
      case "noscript":
        return;
      default: {
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    }
  }
  walk(root);
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function extractLinkedinCriteria(
  document: Document,
): Record<string, string> {
  const items = document.querySelectorAll("li.description__job-criteria-item");
  const out: Record<string, string> = {};
  for (const item of Array.from(items)) {
    const label = item
      .querySelector(".description__job-criteria-subheader")
      ?.textContent?.trim()
      .toLowerCase();
    const value = item
      .querySelector(".description__job-criteria-text")
      ?.textContent?.trim();
    if (label && value) out[label] = value;
  }
  return out;
}

function extractLinkedinFields(
  document: Document,
  finalUrl: string,
): ExtractedJobFields {
  // LinkedIn's public guest endpoint (jobs-guest/jobs/api/jobPosting/<id>)
  // returns a static HTML fragment with all fields directly addressable.
  // We do a full programmatic extraction here — no LLM involved.
  const title = getTextFromSelectors(document, [
    "h2.top-card-layout__title",
    "h1.top-card-layout__title",
    ".top-card-layout__title",
    ".topcard__title",
  ]);
  const company = getTextFromSelectors(document, [
    "a.topcard__org-name-link",
    ".topcard__org-name-link",
    "[data-tracking-control-name='public_jobs_topcard-org-name']",
  ]);
  const location = getTextFromSelectors(document, [
    ".topcard__flavor.topcard__flavor--bullet",
    ".topcard__flavor--bullet",
  ]);

  const descriptionEl = getElementFromSelectors(document, [
    ".show-more-less-html__markup",
    ".description__text--rich .show-more-less-html__markup",
    "div.description__text",
  ]);
  const description = descriptionEl
    ? htmlElementToVerbatimText(descriptionEl)
    : undefined;

  const titleLinkHref = document
    .querySelector("a.topcard__link")
    ?.getAttribute("href");
  const companyLinkHref = document
    .querySelector("a.topcard__org-name-link")
    ?.getAttribute("href");
  const applyButtonRef = document
    .querySelector("button.apply-button[data-reference-id]")
    ?.getAttribute("data-reference-id");

  const criteria = extractLinkedinCriteria(document);

  // Build a complete ManualJobDraft if the required fields are all present.
  let programmatic: ManualJobDraft | null = null;
  if (title && company && description) {
    programmatic = {
      title,
      employer: company,
      location,
      jobDescription: description,
      jobUrl: titleLinkHref ?? finalUrl,
      jobLevel: criteria["seniority level"],
      jobType: criteria["employment type"],
      jobFunction: criteria["job function"],
      disciplines: criteria.industries,
    };
    if (applyButtonRef) {
      // The Apply button doesn't directly expose the apply URL on the
      // guest endpoint; if useful in the future the data-reference-id
      // could be expanded into the apply URL, but for now we leave it.
    }
    if (companyLinkHref) {
      // employerUrl isn't on ManualJobDraft but it could surface here.
    }
  }

  return { title, company, location, description, programmatic };
}

function getExtractorForHost(host: string):
  | ((doc: Document, finalUrl: string) => ExtractedJobFields)
  | null {
  if (host.endsWith("linkedin.com")) return extractLinkedinFields;
  return null;
}

function extractFromHtml(html: string, finalUrl: string): FetchedJobContent {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const pageTitle = document.querySelector("title")?.textContent?.trim() || "";
  const metaDescription =
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogTitle =
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogDescription =
    document
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogSiteName =
    document
      .querySelector('meta[property="og:site-name"]')
      ?.getAttribute("content")
      ?.trim() || "";

  // Per-host extraction runs BEFORE the strip-then-dump path so it can read
  // elements like <header> / <aside> that the generic stripper removes.
  let hostFields: ExtractedJobFields = {};
  try {
    const host = new URL(finalUrl).hostname.toLowerCase();
    const extractor = getExtractorForHost(host);
    if (extractor) hostFields = extractor(document, finalUrl);
  } catch {
    // Bad finalUrl — fall through to generic extraction.
  }

  const elementsToRemove = document.querySelectorAll(
    "script, style, nav, header, footer, aside, iframe, noscript, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      ".nav, .navbar, .header, .footer, .sidebar, .menu, .cookie, .popup, .modal, .ad, .advertisement",
  );
  elementsToRemove.forEach((el) => {
    el.remove();
  });

  const mainContent =
    document.querySelector(
      'main, [role="main"], article, ' +
        ".job-description, .job-details, .job-content, .vacancy-description, " +
        "#job-description, #job-details, #job-content, " +
        '[class*="job-desc"], [class*="jobDesc"], [class*="vacancy"], [class*="posting"]',
    ) || document.body;

  const textContent = cleanMultilineWhitespace(mainContent?.textContent || "");

  let enrichedContent = "";
  if (hostFields.title)
    enrichedContent += `Job Title: ${hostFields.title}\n`;
  if (hostFields.company)
    enrichedContent += `Company: ${hostFields.company}\n`;
  if (hostFields.location)
    enrichedContent += `Location: ${hostFields.location}\n`;
  if (hostFields.description) {
    enrichedContent += `Job Description:\n${cleanMultilineWhitespace(hostFields.description)}\n`;
  }
  if (pageTitle) enrichedContent += `Page Title: ${pageTitle}\n`;
  if (ogTitle && ogTitle !== pageTitle && ogTitle !== hostFields.title)
    enrichedContent += `OG Title: ${ogTitle}\n`;
  if (ogSiteName) enrichedContent += `Company/Site: ${ogSiteName}\n`;
  if (ogDescription && ogDescription !== hostFields.description)
    enrichedContent += `Summary: ${ogDescription}\n`;
  if (
    metaDescription &&
    metaDescription !== ogDescription &&
    metaDescription !== hostFields.description
  )
    enrichedContent += `Meta Description: ${metaDescription}\n`;
  if (enrichedContent) enrichedContent += "\n---\n\n";
  enrichedContent += textContent;

  return {
    content: enrichedContent,
    url: finalUrl,
    programmatic: hostFields.programmatic ?? null,
  };
}

/**
 * Fetch a job listing URL and return cleaned text + metadata for LLM consumption.
 *
 * Two-tier strategy: static `fetch` first; if it returns empty body / 204, or
 * the JSDOM-extracted text falls below the user-configured minimum, fall
 * through to an in-process Playwright/Firefox render. Throws 408 on outer
 * timeout, 502 on upstream HTTP failures, 422 if the final extracted content
 * exceeds `settings.maxFetchedJobHtmlChars`.
 */
export async function fetchAndExtractJobContent(
  originalUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FetchedJobContent> {
  const settings = await getEffectiveSettings();
  const timeoutMs =
    options.timeoutMs ?? settings.manualJobFetchTimeoutMs.value;
  const minExtracted = settings.manualJobFetchMinExtractedChars.value;
  const settleMs = settings.manualJobFetchBrowserSettleMs.value;
  const sizeCap = settings.maxFetchedJobHtmlChars.value;

  const url = rewriteUrlForFetch(originalUrl);
  if (url !== originalUrl) {
    logger.info("manual-fetch url rewritten", { originalUrl, url });
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    options.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  try {
    let extracted: FetchedJobContent | null = null;
    // Hold onto raw HTML so tier-2 (LLM-selector) can run on it if tier-1
    // (per-host programmatic) doesn't produce a complete draft.
    let rawHtmlForTier2: string | null = null;
    let tier2FinalUrl: string | null = null;

    const staticResult = await tryStaticFetch(url, controller.signal);
    if (staticResult) {
      const tier1 = extractFromHtml(staticResult.html, staticResult.finalUrl);
      logger.info("manual-fetch tier-1", {
        url,
        extractedLength: tier1.content.length,
        threshold: minExtracted,
      });
      if (tier1.content.length >= minExtracted) {
        extracted = tier1;
        rawHtmlForTier2 = staticResult.html;
        tier2FinalUrl = staticResult.finalUrl;
      }
    }

    if (!extracted) {
      if (minExtracted === 0 && !staticResult) {
        // Browser fallback is disabled and static fetch yielded nothing.
        throw new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          message:
            "Static fetch returned empty body and browser fallback is disabled (manualJobFetchMinExtractedChars=0).",
        });
      }
      logger.info("manual-fetch falling back to browser", {
        url,
        reason: staticResult ? "tiny-extract" : "empty-body",
      });
      const browserStart = Date.now();
      const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt));
      const browserResult = await tryBrowserFetch(url, remainingMs, settleMs);
      logger.info("manual-fetch browser-rendered", {
        url,
        durationMs: Date.now() - browserStart,
        htmlBytes: browserResult.html.length,
        finalUrl: browserResult.finalUrl,
        htmlPreview: browserResult.html.slice(0, 500),
      });

      // Detect LinkedIn authwall redirect — no point running tier-2 or
      // tier-3 against a sign-up page.
      if (browserResult.finalUrl.includes("linkedin.com/authwall")) {
        throw new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          message:
            "LinkedIn redirected to its sign-in wall (no public access for this URL). Try Apify-based discovery or paste the job content manually.",
        });
      }

      extracted = extractFromHtml(browserResult.html, browserResult.finalUrl);
      rawHtmlForTier2 = browserResult.html;
      tier2FinalUrl = browserResult.finalUrl;
      logger.info("manual-fetch browser extracted", {
        url,
        extractedLength: extracted.content.length,
        extractedPreview: extracted.content.slice(0, 1000),
      });
    }

    if (extracted.content.length > sizeCap) {
      throw unprocessableEntity(
        `Fetched job HTML exceeds the configured limit (${extracted.content.length} > ${sizeCap} chars).`,
        {
          field: "fetchedJobHtml",
          observed: extracted.content.length,
          max: sizeCap,
        },
      );
    }

    // Return the caller's original URL so the canonical job URL on the
    // saved row stays human-readable (e.g. /jobs/view/<id>), not the
    // SEO/API endpoint we used internally. If the per-host extractor
    // produced a complete programmatic draft, surface it so the caller
    // can skip the LLM tier entirely.
    let programmatic = extracted.programmatic ?? null;
    let programmaticUsage: ManualJobInferenceResult["usage"] = null;
    if (programmatic) {
      logger.info("manual-fetch tier-1 programmatic extraction succeeded", {
        url: originalUrl,
        descriptionLength: programmatic.jobDescription?.length ?? 0,
      });
      programmatic.jobUrl = originalUrl;
    } else {
      // Tier 2: ask the LLM for CSS selectors, then read the text of those
      // nodes verbatim. Content is still a DOM read, not LLM generation.
      const rawHtml = rawHtmlForTier2 ?? "";
      if (rawHtml.length > 0) {
        try {
          const tier2 = await tryLlmSelectorExtraction({
            html: rawHtml,
            finalUrl: tier2FinalUrl ?? originalUrl,
            originalUrl,
            maxHtmlChars: sizeCap,
          });
          if (tier2) {
            programmatic = tier2.draft;
            programmaticUsage = tier2.usage ?? null;
            logger.info(
              "manual-fetch tier-2 selector extraction succeeded",
              {
                url: originalUrl,
                descriptionLength: tier2.draft.jobDescription?.length ?? 0,
              },
            );
          }
        } catch (err) {
          logger.warn("manual-fetch tier-2 errored; falling through", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return {
      content: extracted.content,
      url: originalUrl,
      programmatic,
      programmaticUsage,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new AppError({
        status: 408,
        code: "REQUEST_TIMEOUT",
        message: "Timed out fetching URL",
      });
    }
    throw new AppError({
      status: 502,
      code: "UPSTREAM_ERROR",
      message: error instanceof Error ? error.message : "Failed to fetch URL",
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Raw response type from the API (all fields are strings) */
interface ManualJobApiResponse {
  title: string;
  employer: string;
  location: string;
  salary: string;
  deadline: string;
  jobUrl: string;
  applicationLink: string;
  jobType: string;
  jobLevel: string;
  jobFunction: string;
  disciplines: string;
  degreeRequired: string;
  starting: string;
  jobDescription: string;
}

interface JobSelectors {
  titleSelector: string;
  employerSelector: string;
  locationSelector: string;
  descriptionSelector: string;
  jobTypeSelector: string;
  jobLevelSelector: string;
  applicationLinkSelector: string;
}

const JOB_SELECTORS_SCHEMA: JsonSchemaDefinition = {
  name: "job_selectors",
  schema: {
    type: "object",
    properties: {
      titleSelector: { type: "string" },
      employerSelector: { type: "string" },
      locationSelector: { type: "string" },
      descriptionSelector: { type: "string" },
      jobTypeSelector: { type: "string" },
      jobLevelSelector: { type: "string" },
      applicationLinkSelector: { type: "string" },
    },
    required: [
      "titleSelector",
      "employerSelector",
      "locationSelector",
      "descriptionSelector",
      "jobTypeSelector",
      "jobLevelSelector",
      "applicationLinkSelector",
    ],
    additionalProperties: false,
  },
};

/**
 * Strip scripts/styles/inline data attributes to keep the HTML payload sent
 * to the LLM small. Preserves DOM structure so selectors the LLM returns
 * still match when applied to the original document.
 */
function compactHtmlForSelectorPrompt(html: string): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  for (const el of Array.from(
    document.querySelectorAll(
      "script, style, noscript, link[rel='stylesheet']",
    ),
  )) {
    el.remove();
  }
  return document.documentElement.outerHTML;
}

/**
 * Tier-2 extraction: ask the LLM for CSS selectors that target each field,
 * then read the text of those nodes ourselves (verbatim, no LLM generation).
 * Returns null if the LLM call fails or produces selectors that don't yield
 * the minimum required fields.
 */
async function tryLlmSelectorExtraction(args: {
  html: string;
  finalUrl: string;
  originalUrl: string;
  maxHtmlChars: number;
}): Promise<{
  draft: ManualJobDraft;
  usage: ManualJobInferenceResult["usage"];
} | null> {
  const { html, finalUrl, originalUrl, maxHtmlChars } = args;

  const compactHtml = compactHtmlForSelectorPrompt(html);
  if (compactHtml.length > maxHtmlChars) {
    logger.info(
      "tier-2 skipped — compact HTML exceeds maxFetchedJobHtmlChars",
      {
        compactBytes: compactHtml.length,
        max: maxHtmlChars,
      },
    );
    return null;
  }

  let prompt: Awaited<ReturnType<typeof loadPrompt>>;
  try {
    prompt = await loadPrompt("job-fetch-selectors", { html: compactHtml });
  } catch (error) {
    logger.warn("tier-2 prompt load failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const model = await resolveLlmModel();
  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) messages.push({ role: "system", content: prompt.system });
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<JobSelectors>({
    model,
    messages,
    jsonSchema: JOB_SELECTORS_SCHEMA,
    label: "infer job selectors",
  });

  const usage = result.success ? result.usage : undefined;
  const usagePayload: ManualJobInferenceResult["usage"] = usage
    ? (() => {
        const promptTokens = usage.promptTokens ?? null;
        const completionTokens = usage.completionTokens ?? null;
        const totalTokens =
          promptTokens !== null || completionTokens !== null
            ? (promptTokens ?? 0) + (completionTokens ?? 0)
            : null;
        const totalMillions =
          totalTokens !== null
            ? Number((totalTokens / 1_000_000).toFixed(6))
            : null;
        return { promptTokens, completionTokens, totalTokens, totalMillions };
      })()
    : null;

  if (!result.success) {
    logger.info("tier-2 LLM call failed; falling through to tier-3", {
      error: result.error,
    });
    return null;
  }

  const selectors = result.data;
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const titleText = readTextBySelector(document, selectors.titleSelector);
  const employerText = readTextBySelector(document, selectors.employerSelector);
  const locationText = readTextBySelector(
    document,
    selectors.locationSelector,
  );
  const descriptionEl = trySelector(document, selectors.descriptionSelector);
  const descriptionText = descriptionEl
    ? htmlElementToVerbatimText(descriptionEl)
    : undefined;
  const jobTypeText = readTextBySelector(document, selectors.jobTypeSelector);
  const jobLevelText = readTextBySelector(document, selectors.jobLevelSelector);

  let applicationLink: string | undefined;
  const applyEl = trySelector(document, selectors.applicationLinkSelector);
  const applyHref = applyEl?.getAttribute("href");
  if (applyHref) applicationLink = applyHref;

  logger.info("tier-2 selector extraction", {
    finalUrl,
    titleFound: Boolean(titleText),
    employerFound: Boolean(employerText),
    descriptionLength: descriptionText?.length ?? 0,
    selectors,
  });

  if (!titleText || !employerText || !descriptionText) {
    return null;
  }

  return {
    draft: {
      title: titleText,
      employer: employerText,
      location: locationText,
      jobDescription: descriptionText,
      jobUrl: originalUrl,
      jobType: jobTypeText,
      jobLevel: jobLevelText,
      applicationLink,
    },
    usage: usagePayload,
  };
}

function trySelector(document: Document, selector: string): Element | null {
  const trimmed = selector?.trim();
  if (!trimmed) return null;
  try {
    return document.querySelector(trimmed);
  } catch {
    return null;
  }
}

function readTextBySelector(
  document: Document,
  selector: string,
): string | undefined {
  const el = trySelector(document, selector);
  if (!el) return undefined;
  const text = el.textContent?.trim();
  return text && text.length > 0 ? cleanWhitespace(text) : undefined;
}

/** JSON schema for manual job extraction response */
const MANUAL_JOB_SCHEMA: JsonSchemaDefinition = {
  name: "manual_job_details",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Job title" },
      employer: { type: "string", description: "Company/employer name" },
      location: { type: "string", description: "Job location" },
      salary: { type: "string", description: "Salary information" },
      deadline: { type: "string", description: "Application deadline" },
      jobUrl: { type: "string", description: "URL of the job listing" },
      applicationLink: {
        type: "string",
        description: "Direct application URL",
      },
      jobType: {
        type: "string",
        description: "Employment type (full-time, part-time, etc.)",
      },
      jobLevel: {
        type: "string",
        description: "Seniority level (entry, mid, senior, etc.)",
      },
      jobFunction: { type: "string", description: "Job function/category" },
      disciplines: {
        type: "string",
        description: "Required disciplines or fields",
      },
      degreeRequired: {
        type: "string",
        description: "Required degree or education",
      },
      starting: { type: "string", description: "Start date information" },
      jobDescription: {
        type: "string",
        description:
          "Clean text job description with responsibilities and requirements",
      },
    },
    required: [
      "title",
      "employer",
      "location",
      "salary",
      "deadline",
      "jobUrl",
      "applicationLink",
      "jobType",
      "jobLevel",
      "jobFunction",
      "disciplines",
      "degreeRequired",
      "starting",
      "jobDescription",
    ],
    additionalProperties: false,
  },
};

/**
 * Fetch a URL and produce a job draft — the shared fetch+infer head used by
 * both the batch-URL importer and the per-job rescrape action. Tier 1/2
 * programmatic extraction is a verbatim DOM read (no tier-3 LLM); otherwise the
 * page text is passed to the LLM. Returns the full normalized inference result
 * ({ job, usage, warning }) so batch import keeps its token-usage + warning
 * surfaces; rescrape ignores everything but `job`. Fetch/infer failures throw
 * (AppError), caught by the callers' error mappers.
 */
export async function fetchJobDraft(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<{
  job: ManualJobDraft;
  usage: ManualJobInferenceResult["usage"];
  warning: string | null;
}> {
  const fetched = await fetchAndExtractJobContent(url, options);
  if (fetched.programmatic) {
    return {
      job: fetched.programmatic,
      usage: fetched.programmaticUsage ?? null,
      warning: null,
    };
  }
  const inference = await inferManualJobDetails(fetched.content);
  return {
    job: inference.job,
    usage: inference.usage ?? null,
    warning: inference.warning ?? null,
  };
}

export async function inferManualJobDetails(
  jobDescription: string,
): Promise<ManualJobInferenceResult> {
  const model = await resolveLlmModel();
  const prompt = await loadPrompt("job-fetch-from-url", { jobDescription });

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<ManualJobApiResponse>({
    model,
    messages,
    jsonSchema: MANUAL_JOB_SCHEMA,
    label: "infer job from URL",
  });

  const promptChars = prompt.user.length + (prompt.system?.length ?? 0);

  if (!result.success) {
    // A rate limit is not a configuration problem — saying "key not set" here
    // is the same misdiagnosis that had the scorer keyword-matching jobs.
    if (result.code === "rate_limited") {
      return {
        job: {},
        warning:
          "The LLM provider is rate limiting. Fill details manually, or retry once the limit resets.",
      };
    }
    if (result.code === "auth") {
      return {
        job: {},
        warning: "LLM API key not set. Fill details manually.",
      };
    }
    logger.warn("Manual job inference failed", {
      error: result.error,
      promptChars,
      model,
    });
    return {
      job: {},
      warning: `AI inference failed: ${result.error}`,
    };
  }

  const usage = result.usage;
  const promptTokens = usage?.promptTokens ?? null;
  const completionTokens = usage?.completionTokens ?? null;
  const totalTokens =
    promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null;
  const totalMillions =
    totalTokens !== null ? Number((totalTokens / 1_000_000).toFixed(6)) : null;
  logger.info("manual-fetch llm-tokens", {
    promptChars,
    promptTokens,
    completionTokens,
    totalTokens,
    totalMillions,
  });

  return {
    job: normalizeDraft(result.data),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      totalMillions,
    },
  };
}

function normalizeDraft(parsed: ManualJobApiResponse): ManualJobDraft {
  const out: ManualJobDraft = {};

  // Map each field, only including non-empty strings
  if (parsed.title?.trim()) out.title = parsed.title.trim();
  if (parsed.employer?.trim()) out.employer = parsed.employer.trim();
  if (parsed.location?.trim()) out.location = parsed.location.trim();
  if (parsed.salary?.trim()) out.salary = parsed.salary.trim();
  if (parsed.deadline?.trim()) out.deadline = parsed.deadline.trim();
  if (parsed.jobUrl?.trim()) out.jobUrl = parsed.jobUrl.trim();
  if (parsed.applicationLink?.trim())
    out.applicationLink = parsed.applicationLink.trim();
  if (parsed.jobType?.trim()) out.jobType = parsed.jobType.trim();
  if (parsed.jobLevel?.trim()) out.jobLevel = parsed.jobLevel.trim();
  if (parsed.jobFunction?.trim()) out.jobFunction = parsed.jobFunction.trim();
  if (parsed.disciplines?.trim()) out.disciplines = parsed.disciplines.trim();
  if (parsed.degreeRequired?.trim())
    out.degreeRequired = parsed.degreeRequired.trim();
  if (parsed.starting?.trim()) out.starting = parsed.starting.trim();
  if (parsed.jobDescription?.trim())
    out.jobDescription = parsed.jobDescription.trim();

  return out;
}

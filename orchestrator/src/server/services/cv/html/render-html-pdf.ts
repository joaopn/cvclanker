import { logger } from "@infra/logger";
import { type Browser, type BrowserContext, chromium } from "playwright";

// HTML→PDF for the HTML-CV substrate (the run-tectonic.ts / convert-docx-pdf.ts
// analog), through one lazily launched headless Chromium shared by every
// render, with a fresh context per render.
//
// The page never reaches the network. JavaScript is off, every request the
// page makes is answered from the in-memory bundle under a placeholder origin,
// and any request the bundle cannot answer is aborted AND reported as an
// error — a silently missing stylesheet, font or image would change the PDF
// while the upload gate's text comparison still passed. A file: reference is
// the exception: Chromium blocks it from an http page without a request the
// route could see, so the upload-time reference check, which rejects every
// scheme but data:, is what catches it. Print media is
// emulated from the start, so resources only print styles use are requested
// (and checked) before printing. Interception cannot see everything the
// browser might do (resource hints), so name resolution is also disabled at
// launch, with a dead proxy as a second wall for IP literals; a probe on a
// networked Docker network saw no connection leave with the resolver rule
// alone.
//
// Chromium's own sandbox stays off (Playwright's default): it cannot start in
// this container (root, cap_drop ALL). Containment is the above plus the
// upload-time rejects and the container itself.

// The default margin of CDP's Page.printToPDF (Chrome's headless printing);
// a page's own @page margin overrides it.
const DEFAULT_MARGIN = "1cm";

// Lay the page out, before printing, at the size Chromium evaluates width and
// height media queries against while printing, so a resource behind such a
// rule is requested before printing rather than first needed while printing,
// when it arrives too late to appear. Measured with Chromium headless shell
// 1217, format A4 and these margins: width 720 CSS px, height at least 1049
// and under 1050 — the same with no @page rule, with @page { margin: 0 }, with
// @page { size: letter } and with both.
const VIEWPORT = { width: 720, height: 1049 };

// A stuck-detector for a sub-second operation, the same reasoning as
// convert-docx-pdf's budget: a longer one only keeps a wedged browser alive
// longer.
const DEFAULT_TIMEOUT_MS = 60_000;

const ORIGIN_HOST = "cv.invalid";

const LAUNCH_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
];

// Chromium silently ignores a stylesheet or an SVG image served with the
// wrong type, so those and the usual font and image types are named here.
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export type RenderHtmlPdfErrorCode =
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "UNANSWERED_REQUESTS"
  | "RENDER_FAILED";

export class RenderHtmlPdfError extends Error {
  readonly code: RenderHtmlPdfErrorCode;
  /** The requests the bundle could not answer (UNANSWERED_REQUESTS only). */
  readonly unansweredRequests: string[];
  constructor(
    message: string,
    code: RenderHtmlPdfErrorCode,
    unansweredRequests: string[] = [],
  ) {
    super(message);
    this.name = "RenderHtmlPdfError";
    this.code = code;
    this.unansweredRequests = unansweredRequests;
  }
}

export interface RenderHtmlPdfArgs {
  /** The bundle: posix paths without a leading slash → file bytes. */
  files: ReadonlyMap<string, Uint8Array>;
  /** Path of the HTML page to render, a key of `files`. */
  entry: string;
  /** Timeout in ms for the render, browser launch excluded. Default: 60_000. */
  timeoutMs?: number;
}

let browserPromise: Promise<Browser> | null = null;
// Browsers a timeout or stopHtmlRenderer retired: a render still running on
// one fails because of that, not because of its page.
const retired = new WeakSet<Browser>();

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching: Promise<Browser> = chromium
      .launch({ args: LAUNCH_ARGS })
      .then((browser) => {
        browser.on("disconnected", () => {
          if (browserPromise === launching) browserPromise = null;
        });
        return browser;
      })
      .catch((error: unknown) => {
        if (browserPromise === launching) browserPromise = null;
        throw new RenderHtmlPdfError(
          `Could not start the HTML renderer: ${errorMessage(error)}`,
          "UNAVAILABLE",
        );
      });
    browserPromise = launching;
  }
  return browserPromise;
}

/** Closes the shared browser; the next render launches a fresh one. */
export async function stopHtmlRenderer(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    retired.add(browser);
    await browser.close();
  } catch {
    // Already gone, or never started — nothing left to close.
  }
}

export async function renderHtmlToPdf(
  args: RenderHtmlPdfArgs,
): Promise<Uint8Array> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (args.entry.startsWith("/") || !args.files.has(args.entry)) {
    throw new RenderHtmlPdfError(
      `The bundle has no file "${args.entry}" to render.`,
      "RENDER_FAILED",
    );
  }

  const pending = getBrowser();
  const browser = await pending;
  const unanswered: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let context: BrowserContext | undefined;

  const work = (async () => {
    context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: VIEWPORT,
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      const path = bundlePath(url);
      const body = path === null ? undefined : args.files.get(path);
      if (path === null || body === undefined) {
        unanswered.push(url);
        return route.abort();
      }
      return route.fulfill({
        status: 200,
        contentType: contentTypeFor(path),
        body: Buffer.from(body),
      });
    });
    const page = await context.newPage();
    await page.emulateMedia({ media: "print" });
    await page.goto(`http://${ORIGIN_HOST}/${encodePath(args.entry)}`, {
      waitUntil: "load",
      timeout: 0,
    });
    return page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      format: "A4",
      margin: {
        top: DEFAULT_MARGIN,
        right: DEFAULT_MARGIN,
        bottom: DEFAULT_MARGIN,
        left: DEFAULT_MARGIN,
      },
    });
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new RenderHtmlPdfError(
          `HTML render timed out after ${timeoutMs}ms.`,
          "TIMEOUT",
        ),
      );
    }, timeoutMs);
  });

  try {
    const pdf = await Promise.race([work, deadline]);
    if (unanswered.length > 0) {
      throw new RenderHtmlPdfError(
        `The page asked for ${unanswered.length === 1 ? "a file" : "files"} the upload does not contain: ${unanswered.join(", ")}`,
        "UNANSWERED_REQUESTS",
        [...unanswered],
      );
    }
    return new Uint8Array(pdf);
  } catch (error) {
    if (error instanceof RenderHtmlPdfError) throw error;
    if (retired.has(browser) || !browser.isConnected()) {
      // The browser was retired (another render's timeout, or a stop) — or,
      // best effort, crashed and already reported its disconnection; the
      // renderer, not necessarily the page, is what failed.
      throw new RenderHtmlPdfError(
        `The HTML renderer stopped during this render: ${errorMessage(error)}`,
        "UNAVAILABLE",
      );
    }
    throw new RenderHtmlPdfError(
      `HTML render failed: ${errorMessage(error)}`,
      "RENDER_FAILED",
    );
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      // A render that outlived its budget may have wedged the browser: retire
      // the one THIS render used (never a newer one another render launched
      // meanwhile) without waiting for it to exit, so the next render starts
      // clean and this error is not held up by a stuck close.
      logger.warn("HTML render timed out; restarting the renderer", {
        timeoutMs,
        entry: args.entry,
      });
      if (browserPromise === pending) browserPromise = null;
      retired.add(browser);
      void browser.close().catch(() => undefined);
    } else if (retired.has(browser) || !browser.isConnected()) {
      // Its browser is shutting down; do not wait on that.
      void context?.close().catch(() => undefined);
    } else {
      await context?.close().catch(() => undefined);
    }
  }
}

/** The bundle path a request URL names, or null when it is off-origin. */
function bundlePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== ORIGIN_HOST) return null;
  try {
    return decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

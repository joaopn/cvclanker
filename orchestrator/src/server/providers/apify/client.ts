import { logger } from "@infra/logger";

export interface RunActorArgs {
  token: string;
  actorRef: string;
  input: unknown;
  /** Polled between waits; when it turns true the run is aborted server-side
   * and whatever the dataset already holds is returned. */
  shouldCancel?: () => boolean;
}

/** Statuses the Apify run API reports as terminal. */
const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED-OUT",
  "ABORTED",
]);

export type ApifyRunStatus = "SUCCEEDED" | "FAILED" | "TIMED-OUT" | "ABORTED";

export interface ApifyRunOutcome {
  /** Everything the run's dataset held when it reached a terminal state —
   * Apify writes items incrementally, so a timed-out or aborted run still
   * returns what it scraped before it died. */
  items: unknown[];
  status: ApifyRunStatus;
}

export class ApifyApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ApifyApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

const APIFY_BASE = "https://api.apify.com/v2";

// The long-poll window per status request. 60 is the API's documented maximum
// for `waitForFinish`; anything lower just polls more often for no benefit.
const WAIT_FOR_FINISH_SECS = 60;

// Safety ceiling when the run's own configured timeout cannot be read off the
// start response: the platform default for these actors is 3600s, so waiting
// that long plus the grace below covers every conforming run.
const FALLBACK_RUN_TIMEOUT_SECS = 3600;

// How long past the run's own server-side timeout we keep polling before
// concluding the platform failed to enforce it and aborting from our side.
// One extra long-poll window plus scheduling slack.
const RUN_TIMEOUT_GRACE_SECS = 300;

// Dataset items are fetched in pages of this size; the loop stops on the
// first short page, so the value only shapes request count, not correctness.
const DATASET_PAGE_SIZE = 1000;

// Pause before retrying a failed status poll or dataset page, so an Apify
// outage or rate limit is pinged once per interval instead of hammered in a
// tight loop — the hammering itself can trip their rate limiter. The happy
// path never sleeps: `waitForFinish` paces polling server-side.
const RETRY_DELAY_MS = 5000;

// Attempts per dataset page. A page is retried on retryable errors only; by
// this point the run has finished and been paid for, so giving up on a blip
// would forfeit the whole salvage.
const DATASET_PAGE_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeActorPath(actorRef: string): string {
  // Apify accepts both "username/actor-name" and "actorId". Tilde is the
  // URL-safe separator they document for usernames containing "/" in the
  // path. Replace / with ~ if present so we don't accidentally inject
  // sub-paths.
  return actorRef.replace(/\//g, "~");
}

interface ApifyRunSnapshot {
  id: string;
  status: string;
  defaultDatasetId: string;
  timeoutSecs: number | null;
  statusMessage: string | null;
}

function parseRunSnapshot(body: unknown): ApifyRunSnapshot {
  const data =
    body && typeof body === "object"
      ? ((body as { data?: unknown }).data ?? null)
      : null;
  if (!data || typeof data !== "object") {
    throw new ApifyApiError("Apify run response had no data object", 0, false);
  }
  const run = data as Record<string, unknown>;
  const id = typeof run.id === "string" ? run.id : "";
  const datasetId =
    typeof run.defaultDatasetId === "string" ? run.defaultDatasetId : "";
  if (!id || !datasetId) {
    throw new ApifyApiError(
      "Apify run response was missing id or defaultDatasetId",
      0,
      false,
    );
  }
  const options =
    run.options && typeof run.options === "object"
      ? (run.options as Record<string, unknown>)
      : {};
  return {
    id,
    status: typeof run.status === "string" ? run.status : "",
    defaultDatasetId: datasetId,
    timeoutSecs:
      typeof options.timeoutSecs === "number" ? options.timeoutSecs : null,
    statusMessage:
      typeof run.statusMessage === "string" ? run.statusMessage : null,
  };
}

async function apifyFetch(args: {
  url: string;
  actorRef: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<unknown> {
  const { url, actorRef, method = "GET", body } = args;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApifyApiError(`Network error: ${message}`, 0, true);
  }

  if (!response.ok) {
    const status = response.status;
    let text = "";
    try {
      text = await response.text();
    } catch {
      // ignore body parse failure
    }
    const truncated = text.slice(0, 500);
    // 429 is retryable: the token is shared account-wide, so a rate limit is
    // transient by definition — treating it as fatal forfeits a paid run.
    const retryable = status >= 500 || status === 429;
    logger.warn("Apify API call failed", {
      actorRef,
      status,
      bodyPreview: truncated,
    });
    throw new ApifyApiError(
      `Apify ${status}: ${truncated || response.statusText}`,
      status,
      retryable,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ApifyApiError(
      `Apify response was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      response.status,
      false,
    );
  }
}

async function fetchDatasetItems(args: {
  token: string;
  actorRef: string;
  datasetId: string;
}): Promise<unknown[]> {
  const { token, actorRef, datasetId } = args;
  const items: unknown[] = [];
  let offset = 0;
  for (;;) {
    const url = new URL(`${APIFY_BASE}/datasets/${datasetId}/items`);
    url.searchParams.set("token", token);
    // Deliberately NO `clean=true`: with skipping enabled Apify may return a
    // SHORT page while more items remain, and the short-page stop below would
    // silently truncate the salvage. Unfiltered, a short page means the end,
    // full stop. Junk records are the mappers' problem and are counted as
    // droppedCount — same contract the sync endpoint had.
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(DATASET_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    let page: unknown;
    for (let attempt = 1; ; attempt += 1) {
      try {
        page = await apifyFetch({ url: url.toString(), actorRef });
        break;
      } catch (error) {
        const canRetry =
          error instanceof ApifyApiError &&
          error.retryable &&
          attempt < DATASET_PAGE_ATTEMPTS;
        if (!canRetry) throw error;
        logger.warn("Apify dataset page fetch failed; retrying", {
          actorRef,
          datasetId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(RETRY_DELAY_MS);
      }
    }
    if (!Array.isArray(page)) {
      throw new ApifyApiError(
        "Apify dataset response was not an item array",
        0,
        false,
      );
    }
    items.push(...page);
    if (page.length < DATASET_PAGE_SIZE) return items;
    offset += page.length;
  }
}

async function abortRun(args: {
  token: string;
  actorRef: string;
  runId: string;
}): Promise<void> {
  const url = new URL(`${APIFY_BASE}/actor-runs/${args.runId}/abort`);
  url.searchParams.set("token", args.token);
  try {
    await apifyFetch({
      url: url.toString(),
      actorRef: args.actorRef,
      method: "POST",
    });
  } catch (error) {
    // The abort is best-effort damage control (stop the billing meter); the
    // caller is already on its way out with whatever the dataset holds.
    logger.warn("Failed to abort Apify run", {
      actorRef: args.actorRef,
      runId: args.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Start an actor run asynchronously and poll it to a terminal state, then
 * fetch its dataset. Unlike the run-sync endpoint this used to call — whose
 * platform-hard ~300s connection ceiling aborted every longer run and
 * returned NONE of the rows it had already scraped (B42) — the run is bounded
 * only by its own configured timeout, and a run that ends TIMED-OUT or
 * ABORTED still yields everything its dataset collected.
 */
export async function runApifyActor(
  args: RunActorArgs,
): Promise<ApifyRunOutcome> {
  const { token, actorRef, input, shouldCancel } = args;
  if (!token) {
    throw new ApifyApiError("Apify API token not configured", 401, false);
  }

  const actorPath = normalizeActorPath(actorRef);
  const startUrl = new URL(`${APIFY_BASE}/acts/${actorPath}/runs`);
  startUrl.searchParams.set("token", token);
  // No `timeout` override: the run uses the timeout configured on the actor
  // (instance-tunable on Apify's side). The old hardcoded 290s exists only in
  // the sync endpoint's world; here it would just reintroduce B42.
  const started = parseRunSnapshot(
    await apifyFetch({
      url: startUrl.toString(),
      actorRef,
      method: "POST",
      body: input,
    }),
  );

  // The platform is expected to end the run at its own timeout; this ceiling
  // only catches a run the platform failed to terminate.
  const ceilingMs =
    ((started.timeoutSecs ?? FALLBACK_RUN_TIMEOUT_SECS) +
      RUN_TIMEOUT_GRACE_SECS) *
    1000;
  const startedAtMs = Date.now();

  let run = started;
  while (!TERMINAL_STATUSES.has(run.status)) {
    if (shouldCancel?.()) {
      await abortRun({ token, actorRef, runId: started.id });
      break;
    }
    if (Date.now() - startedAtMs > ceilingMs) {
      logger.warn(
        "Apify run exceeded its own timeout; aborting from our side",
        {
          actorRef,
          runId: started.id,
          timeoutSecs: started.timeoutSecs,
        },
      );
      await abortRun({ token, actorRef, runId: started.id });
      break;
    }
    const pollUrl = new URL(`${APIFY_BASE}/actor-runs/${started.id}`);
    pollUrl.searchParams.set("token", token);
    pollUrl.searchParams.set("waitForFinish", String(WAIT_FOR_FINISH_SECS));
    try {
      run = parseRunSnapshot(
        await apifyFetch({ url: pollUrl.toString(), actorRef }),
      );
    } catch (error) {
      // A transient poll failure must not kill a run that is happily crawling
      // on Apify's side; the ceiling above bounds how long this can go on.
      // A non-retryable answer (bad token, deleted run) is real and rethrown
      // — after a best-effort abort, so the run does not keep billing with
      // nobody left watching it.
      if (error instanceof ApifyApiError && !error.retryable) {
        await abortRun({ token, actorRef, runId: started.id });
        throw error;
      }
      logger.warn("Apify run poll failed; retrying", {
        actorRef,
        runId: started.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(RETRY_DELAY_MS);
    }
  }

  const finalStatus: ApifyRunStatus = TERMINAL_STATUSES.has(run.status)
    ? (run.status as ApifyRunStatus)
    : "ABORTED";

  if (finalStatus === "FAILED") {
    // A failed run produced no usable crawl: surface the actor's own message.
    throw new ApifyApiError(
      `Actor run failed: ${run.statusMessage ?? "no status message"}`,
      0,
      false,
    );
  }

  const items = await fetchDatasetItems({
    token,
    actorRef,
    datasetId: started.defaultDatasetId,
  });
  return { items, status: finalStatus };
}

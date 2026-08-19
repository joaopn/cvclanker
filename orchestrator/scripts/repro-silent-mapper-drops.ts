/**
 * Reproduction: a source returns items its mapper cannot read, and the whole
 * pipeline is silent about it. `jobspy`, `hiringcafe`, `startupjobs` and
 * `workingnomads` each `continue` past such rows with no counter and no log,
 * and the Apify provider counts its drops and then discards the number before
 * returning. The run funnel therefore reports "80 scraped" for a source that
 * returned 100 items, with nothing anywhere saying the other 20 existed.
 *
 * That makes the per-source counts a claim they do not support: a source
 * quietly losing a third of its results looks identical to one that found
 * fewer jobs.
 *
 * COVERAGE: this script reaches the two mappers that can be imported without a
 * database or a live source — jobspy and hiringcafe. startupjobs, workingnomads
 * and the Apify provider carry the same fix and are covered by unit tests
 * instead, as is the funnel plumbing (`discover-jobs.test.ts`), which this
 * script cannot exercise without a database.
 *
 * Exits non-zero while the bug exists.
 */

// `export {}` marks this a module so top-level await is legal.
//
// The imports are dynamic because jobspy has no package.json of its own, so
// Node reads the repo root's (CommonJS) for it while the orchestrator is
// "type": "module" — a static named import lands on the interop `default`
// instead. The unwrap below covers both shapes.
export {};

type Mapper = (rows: unknown) => { jobs: unknown[]; dropped: number };

async function loadMapper(path: string, name: string): Promise<Mapper> {
  const mod = (await import(path)) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const fn = (mod[name] ?? mod.default?.[name]) as Mapper | undefined;
  if (typeof fn !== "function") {
    throw new Error(`${name} is not exported from ${path}`);
  }
  return fn;
}

let mapJobSpyRows: Mapper;
let mapHiringCafeRows: Mapper;
try {
  mapJobSpyRows = await loadMapper(
    "../../extractors/jobspy/src/run",
    "mapJobSpyRows",
  );
  mapHiringCafeRows = await loadMapper(
    "../../extractors/hiringcafe/src/run",
    "mapHiringCafeRows",
  );
} catch (error) {
  // What the base branch does: the mappers report nothing, so there is no
  // drop-reporting entry point to call at all.
  console.error(
    `FAIL: a mapper reports no drop count, so unreadable rows vanish silently — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

type Case = {
  site: string;
  /** Rows a real source could return, half of them unreadable. */
  run: () => { jobs: unknown[]; dropped: number };
  expectJobs: number;
  expectDropped: number;
};

const cases: Case[] = [
  {
    site: "jobspy",
    run: () =>
      mapJobSpyRows([
        { site: "linkedin", job_url: "https://example.com/1", title: "Good" },
        // Unrecognised site — jobspy grew a source we do not map.
        { site: "some-new-board", job_url: "https://example.com/2" },
        // No url at all: nothing to identify the posting by.
        { site: "indeed", title: "No URL" },
      ]),
    expectJobs: 1,
    expectDropped: 2,
  },
  {
    site: "hiringcafe",
    run: () =>
      mapHiringCafeRows([
        { jobUrl: "https://example.com/1", title: "Good", employer: "Acme" },
        // Not an object at all.
        "garbage",
        // An object the mapper cannot read.
        { nothing: "usable" },
      ]),
    expectJobs: 1,
    expectDropped: 2,
  },
];

let failed = false;

for (const c of cases) {
  let result: { jobs: unknown[]; dropped: number };
  try {
    result = c.run();
  } catch (error) {
    console.error(
      `FAIL: ${c.site} — mapper is not reachable/reporting: ${error instanceof Error ? error.message : String(error)}`,
    );
    failed = true;
    continue;
  }

  if (typeof result?.dropped !== "number") {
    console.error(
      `FAIL: ${c.site} — the mapper reports no drop count, so unreadable rows vanish silently.`,
    );
    failed = true;
    continue;
  }

  if (
    result.dropped !== c.expectDropped ||
    result.jobs.length !== c.expectJobs
  ) {
    console.error(
      `FAIL: ${c.site} — expected ${c.expectJobs} job(s) and ${c.expectDropped} dropped, got ${result.jobs.length} and ${result.dropped}.`,
    );
    failed = true;
    continue;
  }

  console.log(
    `ok: ${c.site} kept ${result.jobs.length} and reported ${result.dropped} unreadable`,
  );
}

if (failed) process.exit(1);
console.log(
  "PASS: both reachable mappers report what they could not read (the other three sites are covered by unit tests).",
);

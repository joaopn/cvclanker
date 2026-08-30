/**
 * Reproduction (B56): a LinkedIn job URL that carries a slug — the shape
 * LinkedIn's own "copy link" produces — is never rewritten to the public
 * guest endpoint, so manual import walks into the sign-in wall.
 *
 * `rewriteUrlForFetch` (services/manualJob.ts) used to match
 * `^/jobs/view/(\d+)/?$`: bare digits, anchored at both ends. A slugged path
 * misses it, so no rewrite happens, the static tier fetches the real SPA page
 * (LinkedIn answers 999 to a non-browser UA), that returns null, and the
 * browser tier launches Camoufox straight into `linkedin.com/authwall`. Both
 * tiers "fail" while the guest endpoint — the entire reason the rewrite
 * exists — was never asked.
 *
 * Measured live on 2026-08-30 for the reported posting: the slugged URL
 * answers HTTP 999 in 1,530 bytes, while
 * `/jobs-guest/jobs/api/jobPosting/4460359035` answers HTTP 200 in 78,415
 * bytes, from which the shipped tier-1 selectors read a COMPLETE draft
 * (title, employer, location, a 6,345-character description, 4 criteria) —
 * so the bug costs a guaranteed-failing browser launch where a static GET
 * would have imported the job with no LLM tokens at all.
 *
 * This drives the real entry point, `fetchAndExtractJobContent`, and observes
 * which URL its static tier asks for. `fetch` is stubbed to record the URL and
 * then abort the run, so nothing here touches the network, the browser tier or
 * the LLM — the assertion is purely about where the request was aimed.
 *
 * Exits non-zero while the bug exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The service reaches the settings table, which lives in SQLite and is opened
// at module load. Point that at a throwaway directory so a repro run cannot
// touch the real database, then let migrate build the schema in it.
// `NODE_ENV=test` matches the sibling repro scripts; nothing this script
// reaches branches on it.
process.env.NODE_ENV = "test";
const tempDir = await mkdtemp(join(tmpdir(), "repro-b56-"));
process.env.DATA_DIR = tempDir;
await import("../src/server/db/migrate");

const { fetchAndExtractJobContent } = await import(
  "../src/server/services/manualJob"
);

const GUEST = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

class ReproStop extends Error {}

/**
 * Run one URL through the real fetch path and return the URL the static tier
 * actually requested.
 */
async function requestedUrlFor(input: string): Promise<string | null> {
  let requested: string | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    resource: string | URL | Request,
    ..._rest: unknown[]
  ) => {
    requested =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    // Stop the pipeline here: what happens after the request is aimed is not
    // what this reproduces, and letting it continue would reach the browser
    // tier or the LLM.
    throw new ReproStop("repro: request observed");
  }) as typeof globalThis.fetch;

  try {
    await fetchAndExtractJobContent(input);
  } catch {
    // Every outcome past the stubbed fetch is irrelevant; the recorded URL is
    // the whole observation.
  } finally {
    globalThis.fetch = realFetch;
  }

  return requested;
}

interface Case {
  url: string;
  expected: string;
  why: string;
}

// Every shape that names a LinkedIn posting must reach the guest endpoint.
const MUST_REWRITE: Case[] = [
  {
    url: "https://www.linkedin.com/jobs/view/data-scientist-onsite-london-phd-preferred-at-welltower%E2%84%A2-inc-nyse-well-4460359035/",
    expected: `${GUEST}/4460359035`,
    why: "the reported URL, verbatim from LinkedIn's copy-link",
  },
  {
    url: "https://www.linkedin.com/jobs/view/4460359035/",
    expected: `${GUEST}/4460359035`,
    why: "the bare-numeric shape, which already worked",
  },
  {
    url: "https://www.linkedin.com/jobs/view/4460359035",
    expected: `${GUEST}/4460359035`,
    why: "bare numeric, no trailing slash",
  },
  {
    url: "https://uk.linkedin.com/jobs/view/senior-engineer-at-acme-4460359035",
    expected: `${GUEST}/4460359035`,
    why: "a country subdomain, which the board rule accepts",
  },
  {
    url: "https://www.linkedin.com/jobs/view/engineer-170000-gbp-at-acme-4460359035",
    expected: `${GUEST}/4460359035`,
    why: "a slug containing its own numbers; the id is the anchored tail",
  },
];

// Guards against an over-broad "fix". Widening the rewrite to anything ending
// in digits would send profiles and posts to the job endpoint, and an
// unanchored id capture would read a number out of the slug and fetch another
// posting entirely under this URL's name.
const MUST_NOT_REWRITE: Array<{ url: string; why: string }> = [
  {
    url: "https://www.linkedin.com/in/someone-123456789",
    why: "a profile URL also ends in digits",
  },
  {
    url: "https://www.linkedin.com/posts/someone-activity-7212345678901234567",
    why: "a post URL also ends in digits",
  },
  {
    url: "https://notlinkedin.com/jobs/view/4460359035",
    why: "a lookalike host must not be treated as the board",
  },
  {
    url: "https://boards.greenhouse.io/acme/jobs/4460359035",
    why: "another board's job URL",
  },
];

const failures: string[] = [];
for (const testCase of MUST_REWRITE) {
  const requested = await requestedUrlFor(testCase.url);
  if (requested !== testCase.expected) {
    failures.push(
      `  ${testCase.url}\n    expected request to ${testCase.expected}\n    actual request to   ${requested}   (${testCase.why})`,
    );
  }
}

const overWidened: string[] = [];
for (const testCase of MUST_NOT_REWRITE) {
  const requested = await requestedUrlFor(testCase.url);
  if (requested !== testCase.url) {
    overWidened.push(
      `  ${testCase.url}\n    was redirected to ${requested}   (${testCase.why})`,
    );
  }
}

const { closeDb } = await import("../src/server/db/index");
closeDb();
await rm(tempDir, { recursive: true, force: true });

// Report both blocks before exiting: on the unfixed tree BOTH are non-empty
// (the lookalike host is rewritten by the old `hostname.endsWith` gate), and
// exiting on the first would hide the misrouting this reproduces.
if (failures.length > 0) {
  console.error(
    `FAIL: ${failures.length} LinkedIn job URL(s) were fetched from the SPA page instead of the guest endpoint, so importing them launches the browser into the authwall:\n${failures.join("\n")}`,
  );
}

if (overWidened.length > 0) {
  console.error(
    `FAIL: the rewrite reached URLs that are not LinkedIn job views:\n${overWidened.join("\n")}`,
  );
}

if (failures.length > 0 || overWidened.length > 0) {
  process.exit(1);
}

console.log(
  `PASS: all ${MUST_REWRITE.length} LinkedIn job URL shapes are fetched from the guest endpoint, and all ${MUST_NOT_REWRITE.length} non-job URLs are fetched unchanged.`,
);

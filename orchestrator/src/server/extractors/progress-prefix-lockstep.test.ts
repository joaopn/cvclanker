// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The extractor -> orchestrator progress wire protocol is a plaintext stdout
// prefix duplicated across four source files in two languages: two emitters
// (one Python, one TS) and two TS parsers. Nothing exercises the Python
// emitter, so no other test can prove the four literals still agree — a
// half-rename that lands on three of the four sites leaves scraping working
// while the funnel banner silently goes dark (every progress line fails the
// parser's startsWith and is dropped as null).
//
// This reads the four literals from disk and pins them byte-for-byte. It keys
// on the string VALUE (a quoted UPPER_CASE token ending in "PROGRESS " with the
// trailing separator space), never on the identifier name — the identifier is
// itself renamed alongside the value, so matching it would make this regex an
// extra lockstep site. The trailing space is the payload separator
// (`${PREFIX}${JSON.stringify(...)}` on emit, `slice(PREFIX.length)` on parse),
// so it is captured and compared, never trimmed.
//
// Renaming the wire prefix updates EXACTLY ONE line here: EXPECTED_PROGRESS_PREFIX
// below. Asserting the shared value equals that expected literal (not merely
// that the four files agree with each other) is deliberate: without the
// `extractors/` bind-mount the standard test command reads the stale copy baked
// into the tools image, where all four still agree — a mutual-equality-only test
// would pass vacuously. Pinning the expected value makes a forgotten mount go
// RED once the rename lands.
const EXPECTED_PROGRESS_PREFIX = "JOBOPS_PROGRESS ";

const PREFIX_SITES = [
  "extractors/jobspy/scrape_jobs.py",
  "extractors/jobspy/src/run.ts",
  "extractors/hiringcafe/src/main.ts",
  "extractors/hiringcafe/src/run.ts",
] as const;

// A quoted string literal whose content is an UPPER_CASE token ending in
// "PROGRESS" plus an optional single trailing space. The optional space (rather
// than a required one) means a rename that drops the separator still MATCHES but
// yields a value that differs from its peers, surfacing as a byte-mismatch
// rather than a confusing zero-match.
const PROGRESS_LITERAL = /(['"])([A-Z][A-Z0-9_]*PROGRESS ?)\1/g;

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "extractors", "jobspy", "scrape_jobs.py"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(
    "progress-prefix lockstep: could not locate repo root (extractors/jobspy/scrape_jobs.py) — is the extractors/ mount present?",
  );
}

function extractPrefix(repoRoot: string, relativePath: string): string {
  const source = readFileSync(join(repoRoot, relativePath), "utf8");
  const matches = [...source.matchAll(PROGRESS_LITERAL)].map((m) => m[2]);
  if (matches.length !== 1) {
    throw new Error(
      `progress-prefix lockstep: expected exactly one progress-prefix literal in ${relativePath}, found ${matches.length} (${JSON.stringify(matches)})`,
    );
  }
  return matches[0];
}

describe("progress-prefix wire-protocol lockstep", () => {
  const repoRoot = findRepoRoot();
  const prefixes = PREFIX_SITES.map((site) => ({
    site,
    value: extractPrefix(repoRoot, site),
  }));

  it("all four emitter/parser sites share the same literal", () => {
    const distinct = new Set(prefixes.map((p) => p.value));
    expect(
      distinct.size,
      `progress prefixes diverge: ${JSON.stringify(prefixes)}`,
    ).toBe(1);
  });

  it("the shared literal is the expected brand value with its trailing separator space", () => {
    for (const { site, value } of prefixes) {
      expect(value, `${site} progress prefix`).toBe(EXPECTED_PROGRESS_PREFIX);
      expect(value.endsWith(" "), `${site} trailing separator space`).toBe(
        true,
      );
    }
  });
});

/**
 * Identity evidence for duplicate detection.
 *
 * These are the two things that can say "these rows are the same posting"
 * without inference: the board's own id for the ad, and the ad's text. Both
 * live here as pure functions so the grouping query, its tests and any future
 * import-time use share one definition — a second copy would drift, and the
 * whole point is that two implementations of the same rule must not disagree.
 *
 * Governing rule for every judgement call below: **prefer extra duplicates
 * over incorrectly joining two jobs.** A missed duplicate costs one row in the
 * inbox; a wrong join destroys an opening the user would have applied to.
 */

/**
 * The job board a URL belongs to, lowercased, or null when it is not one we
 * can key an id on.
 *
 * The host is lowercased HERE rather than trusted from storage: rows imported
 * before URL canonicalization shipped keep whatever case the source sent, so a
 * caller reading `job_url` straight from the database can see `WWW.LinkedIn.com`.
 *
 * Only linkedin is recognised today, deliberately. Measured on a real 18k-row
 * database: linkedin covers 2,566 of 2,793 active rows, while indeed produces
 * zero duplicate groups there and smartrecruiters/ashby/greenhouse total 15
 * rows. Adding a board is one entry — but add it because its ids are shown to
 * group something, not on the assumption that they will.
 */
export function extractBoard(jobUrl: string | null | undefined): string | null {
  const trimmed = (jobUrl ?? "").trim();
  if (!trimmed) return null;

  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }

  // `www.linkedin.com`, `uk.linkedin.com`, `at.linkedin.com` — one board, many
  // country subdomains, which is exactly why the URL string alone cannot
  // dedupe these and this function exists.
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    return "linkedin";
  }

  return null;
}

/**
 * LinkedIn puts the job id at the END of the path, either bare
 * (`/jobs/view/4383993915`) or after a slug (`/jobs/view/senior-…-4383993915`).
 *
 * ANCHORED on purpose. An unanchored `(?:.*?-)?(\d+)` captures the first number
 * in the slug instead: a real implementation of that mistake merged seven
 * unrelated postings on `000` from "£170,000", eight on `100` from
 * "100% remoto", and seven on `9` from "9fin". The failure is silent and joins
 * unrelated jobs, so the anchor is load-bearing rather than tidiness.
 */
const LINKEDIN_JOB_PATH = /^\/jobs\/view\//;
const LINKEDIN_PATH_ID = /-(\d{6,})\/?$|\/(\d{6,})\/?$/;

/**
 * `source_job_id` shapes this board actually produces: bare digits, or the
 * `li-` prefix one scraper adds. Anything else belongs to another board and
 * must not be digit-stripped into this namespace — a Workday
 * `…/1234/job/Toronto/R-0000123` would otherwise become a "LinkedIn id", and
 * two such ids differing only in punctuation would collide.
 */
const LINKEDIN_SOURCE_JOB_ID = /^(?:li-)?(\d{6,})$/;

/**
 * The board's own id for this ad, or null when there is none to key on.
 *
 * The URL path is the primary source and `source_job_id` the fallback: the id
 * is always in the path of a job-view URL, whereas `source_job_id` is null on
 * some rows and prefixed (`li-4383255214`) on others depending on which
 * scraper produced it. Where both exist they agree — measured across every row
 * of a real database, zero disagreed — but the precedence still has to be
 * stated, or two implementations could pick differently.
 */
export function extractExternalId(args: {
  jobUrl: string | null | undefined;
  sourceJobId?: string | null;
}): string | null {
  const board = extractBoard(args.jobUrl);
  if (board !== "linkedin") return null;

  const trimmed = (args.jobUrl ?? "").trim();
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    return null;
  }

  // A profile (`/in/someone-123456`) or a post (`/posts/…-7212345678901234567`)
  // also ends in digits, and letting those into the same keyspace as job ids
  // is a wrong join waiting to happen. Every LinkedIn row in a real database is
  // `/jobs/view/…`, so this gate costs nothing measurable.
  if (!LINKEDIN_JOB_PATH.test(pathname)) return null;

  const fromPath = LINKEDIN_PATH_ID.exec(pathname);
  if (fromPath) return fromPath[1] ?? fromPath[2] ?? null;

  // `li-4383255214` and `4383255214` are the same id written two ways.
  const fromSourceId = LINKEDIN_SOURCE_JOB_ID.exec(
    (args.sourceJobId ?? "").trim(),
  );
  return fromSourceId?.[1] ?? null;
}

/**
 * `(board, id)` as one key, or null when the row carries no board identity.
 *
 * Namespaced by BOARD, never by `source`: one LinkedIn posting arrives under
 * `source='linkedin'` and under two different `apify:<uuid>` scrapers, so a
 * key built on the scraper deduplicates none of them.
 */
export function externalIdKey(args: {
  jobUrl: string | null | undefined;
  sourceJobId?: string | null;
}): string | null {
  const board = extractBoard(args.jobUrl);
  if (!board) return null;
  const id = extractExternalId(args);
  return id ? `${board}:${id}` : null;
}

/**
 * True when both rows carry a board id from the SAME board and those ids
 * DIFFER — i.e. the board itself says these are two postings.
 *
 * This is negative evidence, and under the governing rule it outranks any
 * amount of textual similarity: an employer running several requisitions off
 * one ad text produces byte-identical descriptions under distinct ids on the
 * same day (measured live — three Microsoft "Clinical Specialist" rows in
 * London, identical 4,334-character bodies, three ids), and joining those
 * destroys real openings.
 *
 * False when either side has no id: absent evidence is not contrary evidence.
 */
export function hasConflictingExternalIds(
  a: { jobUrl: string | null | undefined; sourceJobId?: string | null },
  b: { jobUrl: string | null | undefined; sourceJobId?: string | null },
): boolean {
  const left = externalIdKey(a);
  const right = externalIdKey(b);
  if (!left || !right) return false;
  return left !== right;
}

/** Below this, a description cannot carry identity. */
export const MIN_FINGERPRINT_CHARS = 100;

/**
 * The ad's visible text, normalized so two boards' renderings of one posting
 * compare equal.
 *
 * Aggressive by necessity: the storage format is source-dependent. hiringcafe
 * stores raw markup (96% of its rows) while both Apify LinkedIn templates strip
 * HTML before insert, so the SAME posting is markup on one row and plain text
 * on another. Tags, entities and every non-alphanumeric run therefore collapse,
 * which also erases the differences that defeat naive comparison — `&#xa0;` vs
 * a space, `<ul>` vs `<ul type="disc">`, an anchor wrapped around an email.
 *
 * Do NOT reuse the extractors' `stripHtml` for this: it preserves whitespace
 * structure and decodes only six named entities, so numeric ones survive as
 * literal text and two renderings of one ad stay unequal.
 *
 * Digits are PRESERVED, and that is load-bearing: employers who post one ad per
 * requisition print the requisition number in the body (Amazon does), and it is
 * the only thing distinguishing 16 measured (title, location) pairs that are
 * genuinely different openings. Normalizing digits away would join them.
 */
export function normalizeDescriptionText(
  description: string | null | undefined,
): string {
  return decodeHtmlEntities((description ?? "").replace(/<[^>]+>/g, " "))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The text fingerprint used as a grouping key, or null when the ad is too
 * short to identify anything.
 *
 * Deliberately the whole normalized string rather than a hash of it. A short
 * or 32-bit fingerprint would eventually collide, and a collision here does not
 * degrade gracefully — it silently joins two unrelated postings, the one
 * outcome this feature must never produce. The keys are only held for the
 * lifetime of an on-demand query over a few thousand rows.
 */
export function descriptionFingerprint(
  description: string | null | undefined,
): string | null {
  const normalized = normalizeDescriptionText(description);
  return normalized.length >= MIN_FINGERPRINT_CHARS ? normalized : null;
}

/** Title, normalized to formatting-insensitive tokens for comparison. */
export function normalizeTitleKey(title: string | null | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Tokens dropped before comparing two locations.
 *
 * Load-bearing, not cosmetic: whether `uk` is here decides the single most
 * common real variant — `London, England, UK` vs `London, England, United
 * Kingdom` — which accounts for 33 of the 36 measured id-groups whose location
 * strings disagree. Workplace words are dropped because `Vienna | Hybrid` and
 * `Vienna | On-site` describe the same place; the workplace difference is not
 * evidence about which posting it is.
 */
const LOCATION_STOPWORDS: ReadonlySet<string> = new Set([
  "or",
  "and",
  "hybrid",
  "onsite",
  "on",
  "site",
  "remote",
  "area",
  "greater",
  "uk",
  "usa",
]);

export function locationTokens(
  location: string | null | undefined,
): Set<string> {
  const tokens = new Set<string>();
  for (const token of (location ?? "").toLowerCase().match(/[a-z0-9]+/g) ??
    []) {
    if (!LOCATION_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/**
 * A location naming several places — "Dublin or London or San Francisco", and
 * also "Rotterdam and The Hague", which occurs on real rows. `and` is a
 * stopword, so the token sets cannot reveal this and the raw string must.
 */
function namesSeveralPlaces(location: string | null | undefined): boolean {
  return / (?:or|and) /i.test(location ?? "");
}

/**
 * Whether two locations are compatible enough for the rows to be the same ad.
 *
 * Subset in either direction, EXCEPT when either side names several places,
 * where equality is required. The reason for the split: the variants worth
 * recovering are administrative-suffix differences on ONE place (`London,
 * England, UK` ⊂ `London, England, United Kingdom`), while containment between
 * two multi-place strings means the ads offer genuinely DIFFERENT location
 * sets — `Dublin or London` inside `Dublin or London or San Francisco` is a
 * real difference in the posting, not a rendering difference.
 *
 * Measured: the strict arm costs nothing in active triage (it fires zero times
 * there) and blocks 13 pairs across all statuses, so it closes a hazard that is
 * dormant rather than absent.
 *
 * An empty token set on either side is never compatible — missing evidence must
 * not buy a match.
 */
export function isLocationCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = locationTokens(a);
  const right = locationTokens(b);
  if (left.size === 0 || right.size === 0) return false;

  if (namesSeveralPlaces(a) || namesSeveralPlaces(b)) {
    return left.size === right.size && isSubsetOf(left, right);
  }

  return isSubsetOf(left, right) || isSubsetOf(right, left);
}

function isSubsetOf(inner: Set<string>, outer: Set<string>): boolean {
  for (const token of inner) {
    if (!outer.has(token)) return false;
  }
  return true;
}

/**
 * Decode the entities that actually appear in scraped job ads — named and
 * numeric alike. `stripHtml` in the extractors handles only six named ones, so
 * a numeric `&#xa0;` reaches storage as literal text on some rows and as a real
 * space on others; both must normalize to the same thing here.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Measured across 18k scraped descriptions: without these, an accented or
  // punctuated word decodes to word-shaped junk ("montr eacute al") on one
  // board and to the real word on another, so two renderings of ONE ad stop
  // matching. Every entity here occurs in that corpus.
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ocirc: "ô",
  ugrave: "ù",
  ccedil: "ç",
  oelig: "œ",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  mdash: "—",
  ndash: "–",
  bull: " ",
  hellip: "…",
  thinsp: " ",
};

/**
 * Decode the entities that occur in scraped job ads, numeric and named.
 *
 * Numeric first, deliberately: that is correct single-pass HTML semantics, so
 * a double-encoded `&amp;#xa;` decodes to the literal text `&#xa;` rather than
 * being decoded twice into a character the other rendering never had.
 *
 * Anything not listed collapses to a space with the rest of the
 * non-alphanumerics, which is safe — it degrades a match, never invents one.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      safeFromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    );
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}

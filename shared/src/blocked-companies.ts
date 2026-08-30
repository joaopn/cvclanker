/**
 * The blocked-companies rule: one home for how a Search Profile's blocked list
 * decides whether a discovered posting's employer is skipped.
 *
 * The match is EXACT — a stored entry blocks the employer whose name IS that
 * entry, and no other. It was a substring test until the maintainer ruled
 * against it: a substring rule silently over-blocks, since an entry like "Nova"
 * also removes "Novartis" and nothing tells the user their inbox is missing
 * postings. Matching only what the user actually named is the safe direction to
 * be wrong in — an unblocked company costs one inbox row the user can blacklist
 * again, where a wrongly blocked one disappears with no trace.
 *
 * Case and surrounding whitespace are ignored, because employer strings come
 * from scrapers and vary in both. Nothing else is normalized: no diacritic
 * folding, no punctuation stripping, no "Ltd"/"GmbH" suffix trimming. Each of
 * those would widen the match back out by guessing that two differently spelled
 * names are the same company, which is the thing this rule exists not to do.
 *
 * The stored field is still called `blockedCompanyKeywords` for the sake of
 * every profile blob already written; read "keyword" there as "company name".
 */

/**
 * Cap on how many companies one profile may block, and how long each name may
 * be. Both are enforced by `profileConfigSchema`, which is also the READ path:
 * a stored array that fails validation falls back to the field's default (an
 * empty list), so a write that overshoots either bound does not error — it
 * silently discards every company the profile had blocked. Any writer must
 * check.
 */
export const MAX_BLOCKED_COMPANY_KEYWORDS = 200;
export const MAX_BLOCKED_COMPANY_KEYWORD_LENGTH = 200;

/** Trimmed and case-folded, the form both sides of the match are compared in. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Whether this employer is one of the companies the profile blocks.
 *
 * A blank entry matches nothing. The schema cannot store one, and an employer
 * that is itself blank is not a company name — treating the two as equal would
 * block every posting whose employer the scraper failed to read.
 */
export function isEmployerBlocked(
  employer: string | null | undefined,
  blockedCompanies: readonly string[] | null | undefined,
): boolean {
  if (!employer || !blockedCompanies || blockedCompanies.length === 0) {
    return false;
  }

  const normalizedEmployer = normalize(employer);
  if (!normalizedEmployer) return false;

  return blockedCompanies.some(
    (company) => normalize(company) === normalizedEmployer,
  );
}

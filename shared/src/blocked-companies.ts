/**
 * The blocked-companies rule: one home for how a Search Profile's
 * `blockedCompanyKeywords` decide whether a discovered posting's employer is
 * skipped.
 *
 * Matching is a case-insensitive SUBSTRING test, not equality — a keyword of
 * "recruit" blocks "Global Recruitment Ltd". That is what makes the field
 * useful for whole families of agencies, and it is why blacklisting one
 * company by name can also cover its siblings.
 */

/**
 * Cap on how many keywords one profile may carry, and how long each may be.
 * Both are enforced by `profileConfigSchema`, which is also the READ path:
 * a stored array that fails validation falls back to the field's default (an
 * empty list), so a write that overshoots either bound does not error — it
 * silently discards every keyword the profile had. Any writer must check.
 */
export const MAX_BLOCKED_COMPANY_KEYWORDS = 200;
export const MAX_BLOCKED_COMPANY_KEYWORD_LENGTH = 200;

/**
 * The keyword blocking this employer, or null when none does.
 *
 * Returns the keyword AS STORED rather than its normalized form, so a caller
 * can name it back to the user ("already blocked by \"recruit\"").
 *
 * A blank keyword matches nothing. `"anything".includes("")` is true, so
 * treating it literally would block every employer; the schema cannot store
 * one, and refusing it here keeps a hand-edited blob from emptying an inbox.
 *
 * Normalization is per call rather than hoisted, so the discovery filter costs
 * rows x keywords with an early return on the first match — immaterial against
 * `MAX_BLOCKED_COMPANY_KEYWORDS`, and the reason to precompute at a call site
 * if that cap is ever raised.
 */
export function findBlockingCompanyKeyword(
  employer: string | null | undefined,
  keywords: readonly string[] | null | undefined,
): string | null {
  if (!employer || !keywords || keywords.length === 0) return null;

  const normalizedEmployer = employer.toLowerCase();
  for (const keyword of keywords) {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) continue;
    if (normalizedEmployer.includes(normalized)) return keyword;
  }
  return null;
}

/**
 * Per-search-term job budgets: how many results one term's search may buy
 * from a source that searches each term on its own (today only the
 * curious_coder LinkedIn actor).
 *
 * A Search Profile holds a default (`termJobBudget`) and per-term overrides
 * (`termJobBudgets`) keyed by `termKey`, so "ML Engineer" and "ml engineer"
 * share one budget, as they share one row in the term matrix.
 */

/** The actor rejects a run cap below 10, so no budget may be smaller. */
export const MIN_TERM_JOB_BUDGET = 10;
export const MAX_TERM_JOB_BUDGET = 5000;
export const DEFAULT_TERM_JOB_BUDGET = 100;

export function termKey(term: string): string {
  return term.trim().toLowerCase();
}

export function isValidTermJobBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TERM_JOB_BUDGET &&
    value <= MAX_TERM_JOB_BUDGET
  );
}

/**
 * The overrides worth keeping: keys normalised to `termKey`, invalid values
 * dropped entry by entry (never the whole map), and only keys naming one of
 * `searchTerms`, so removing a term drops its override. Where two keys
 * normalise to the same term the first one wins.
 *
 * Built on a null-prototype object because a term is free text: one named
 * `__proto__` in a stored blob stays an ordinary key rather than setting the
 * prototype. (The API's zod parse may still drop such a key on the way in.)
 */
export function normalizeTermJobBudgets(
  raw: unknown,
  searchTerms: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const wanted = new Set(searchTerms.map(termKey).filter(Boolean));
  for (const [key, value] of Object.entries(raw)) {
    const normalized = termKey(key);
    if (!wanted.has(normalized) || normalized in out) continue;
    if (isValidTermJobBudget(value)) out[normalized] = value;
  }
  return out;
}

/**
 * Each term's budget for a run: its override, else the default. Keyed by
 * `termKey`, covering exactly `searchTerms` (the terms the run will search,
 * which a run request may set apart from the profile's own).
 */
export function resolveTermJobBudgets(
  searchTerms: readonly string[],
  defaultBudget: number,
  overrides: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const term of searchTerms) {
    const key = termKey(term);
    if (!key || key in out) continue;
    out[key] = Object.hasOwn(overrides, key) ? overrides[key] : defaultBudget;
  }
  return out;
}

/**
 * Whether a job title names a search term — the rule the Stats "Job profile"
 * tab credits jobs to terms by.
 *
 * Content matching rather than recorded provenance, on purpose: most boards OR
 * every term into one query and return one merged list, so which term's query
 * returned a job is unknowable for them. What the title names is knowable for
 * every board, and for every job already stored.
 *
 * A term matches when every one of its words appears in the title, in any
 * order, case- and accent-insensitively. `+` and `#` stay part of a word so
 * "C++" and "C#" do not both reduce to "c".
 */

import { foldDiacritics } from "./location-support";

/** Lowercased, accent-folded words. */
export function titleWords(value: string): string[] {
  return foldDiacritics(value.toLowerCase())
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((word) => word.length > 0);
}

/**
 * `termWords` must come from `titleWords(term)`. A term with no words (blank,
 * or punctuation only) matches nothing rather than everything.
 */
export function titleNamesTerm(
  titleWordSet: ReadonlySet<string>,
  termWords: readonly string[],
): boolean {
  return (
    termWords.length > 0 && termWords.every((word) => titleWordSet.has(word))
  );
}

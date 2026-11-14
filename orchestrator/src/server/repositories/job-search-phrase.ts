import { foldStandaloneLetters } from "@shared/location-support";

/**
 * Turn what was typed into the ctrl+K search into one FTS5 phrase, or null
 * when it holds nothing the index could match.
 *
 * The whole input is ONE quoted phrase, so its words must sit next to each
 * other, in order, inside one column — "senior eng" finds "Senior Engineer"
 * but not a Senior role at an Engineering firm. FTS5 syntax is inert inside
 * the quotes; a literal quote is escaped by doubling it.
 *
 * The fold is the index's own (`jobs_search` in db/migrate.ts): the letters
 * NFD cannot reach, then SQLite's tokenizer strips decomposable accents on
 * both sides.
 */
export function buildJobSearchPhrase(input: string): string | null {
  // FTS5 reads the MATCH argument as a C string, so a NUL would end the
  // phrase mid-quote and fail the whole query.
  const folded = foldStandaloneLetters(input.replaceAll("\u0000", "")).trim();
  if (!/[\p{L}\p{N}]/u.test(folded)) return null;
  return `"${folded.replaceAll('"', '""')}"`;
}

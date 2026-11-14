// The letters the ctrl+K search index folds before SQLite's tokenizer sees
// them: the ones NFD cannot reach, which unicode61's accent stripping
// therefore leaves alone. Mirrors STANDALONE_LETTER_FOLDS in
// shared/src/location-support.ts, which folds the typed query the same way.
// A copy rather than an import because migrate.ts loads no shared code at
// boot; `repositories/jobs.search.test.ts` pins the two equal.
//
// No imports: migrate.ts reads this at boot, and a test can import it without
// opening a database.
export const JOBS_SEARCH_LETTER_FOLDS: Readonly<Record<string, string>> = {
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ħ: "h",
  Ħ: "H",
  ı: "i",
};

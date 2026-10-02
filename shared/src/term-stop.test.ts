import { describe, expect, it } from "vitest";
import {
  MAX_TERM_STOP_MIN_MATCHES,
  searchHasRunDry,
  TERM_STOP_STALL_MS,
  TERM_STOP_WINDOW,
  type TermStopResult,
  TermStopTracker,
} from "./term-stop";

const window = (named: number, extra = 0) => [
  ...Array.from({ length: extra }, () => true),
  ...Array.from({ length: TERM_STOP_WINDOW }, (_, i) => i < named),
];

/** `count` results of one search, ranked from `from`, the first `named` naming the term. */
const results = (args: {
  search: string;
  count: number;
  named: number;
  from?: number;
}): TermStopResult[] =>
  Array.from({ length: args.count }, (_, i) => ({
    search: args.search,
    rank: (args.from ?? 1) + i,
    title: i < args.named ? "Senior Data Scientist" : "Account Manager",
  }));

const tracker = (
  searches: string[],
  overrides: { searchCap?: number; minMatches?: number; term?: string } = {},
) =>
  new TermStopTracker({
    term: overrides.term ?? "Data Scientist",
    searches,
    searchCap: overrides.searchCap ?? 200,
    minMatches: overrides.minMatches ?? 2,
  });

describe("searchHasRunDry", () => {
  it("never judges a search holding less than a window", () => {
    expect(searchHasRunDry(window(0).slice(1), 2)).toBe(false);
  });

  it("is dry when fewer than minMatches of the last window name the term", () => {
    expect(searchHasRunDry(window(1), 2)).toBe(true);
    expect(searchHasRunDry(window(2), 2)).toBe(false);
  });

  it("looks at the deepest window only", () => {
    // Every earlier result matched; only the last window decides.
    expect(searchHasRunDry(window(1, 40), 2)).toBe(true);
  });

  it("caps the setting at the window", () => {
    expect(MAX_TERM_STOP_MIN_MATCHES).toBe(TERM_STOP_WINDOW);
  });
});

describe("TermStopTracker", () => {
  it("never stops when the setting is off", () => {
    const t = tracker(["a"], { minMatches: 0 });
    expect(t.observe(results({ search: "a", count: 60, named: 0 }), 1)).toBe(
      false,
    );
  });

  it("stops a single search whose tail stopped naming the term", () => {
    const t = tracker(["a"]);
    expect(t.observe(results({ search: "a", count: 60, named: 15 }), 1)).toBe(
      true,
    );
  });

  it("keeps going while the tail still names the term", () => {
    const t = tracker(["a"]);
    expect(t.observe(results({ search: "a", count: 60, named: 60 }), 1)).toBe(
      false,
    );
  });

  it("waits for a search that has not started yet", () => {
    const t = tracker(["a", "b"]);
    expect(t.observe(results({ search: "a", count: 60, named: 0 }), 1)).toBe(
      false,
    );
  });

  it("never counts a search with no result as done, however long the run goes", () => {
    // It may simply not have started; stopping would lose its postings.
    const t = tracker(["a", "b"]);
    t.observe(results({ search: "a", count: 30, named: 0 }), 1);
    const later = results({ search: "a", count: 30, named: 0, from: 31 });
    expect(t.observe(later, 10 * TERM_STOP_STALL_MS)).toBe(false);
  });

  it("counts a search that stopped short of a window as finished once quiet", () => {
    const t = tracker(["a", "b"]);
    t.observe(results({ search: "b", count: 12, named: 12 }), 1);
    t.observe(results({ search: "a", count: 40, named: 0 }), 1000);
    expect(t.observe([], TERM_STOP_STALL_MS)).toBe(false);
    const more = results({ search: "a", count: 20, named: 0, from: 41 });
    expect(t.observe(more, TERM_STOP_STALL_MS + 1)).toBe(true);
  });

  it("never reads every search as finished when nothing in the run moves", () => {
    // Both still matching at their tails, both quiet: the run is wrapping up
    // and ends by itself; no search ran dry, so nothing is stopped.
    const t = tracker(["a", "b"]);
    t.observe(results({ search: "a", count: 30, named: 30 }), 1);
    t.observe(results({ search: "b", count: 30, named: 30 }), 1);
    expect(t.observe([], 10 * TERM_STOP_STALL_MS)).toBe(false);
  });

  it("needs every search done, judging each on its own ranks", () => {
    const t = tracker(["a", "b"]);
    t.observe(results({ search: "a", count: 60, named: 0 }), 1);
    expect(t.observe(results({ search: "b", count: 60, named: 60 }), 2)).toBe(
      false,
    );
    const u = tracker(["a", "b"]);
    u.observe(results({ search: "a", count: 60, named: 0 }), 1);
    expect(u.observe(results({ search: "b", count: 60, named: 5 }), 2)).toBe(
      true,
    );
  });

  it("counts a search at its own cap as done whatever its tail holds", () => {
    const t = tracker(["a", "b"], { searchCap: 30 });
    t.observe(results({ search: "a", count: 30, named: 30 }), 1);
    expect(t.observe(results({ search: "b", count: 25, named: 0 }), 2)).toBe(
      true,
    );
  });

  it("does not stop a run whose searches all hit their cap", () => {
    const t = tracker(["a"], { searchCap: 30 });
    expect(t.observe(results({ search: "a", count: 30, named: 0 }), 1)).toBe(
      false,
    );
  });

  it("orders each search by rank, not by arrival", () => {
    // The actor writes a page deepest-first; reversed, the matches sit at the
    // top ranks and the tail is the 40 that do not match.
    const t = tracker(["a"]);
    const arrived = results({ search: "a", count: 60, named: 20 }).reverse();
    expect(t.observe(arrived, 1)).toBe(true);
  });

  it("matches titles by the shared word rule, ignoring case and accents", () => {
    const t = tracker(["a"]);
    const titles = Array.from({ length: TERM_STOP_WINDOW }, (_, i) => ({
      search: "a",
      rank: i + 1,
      title: i < 2 ? "DATA SCIENTÍST (m/w/d)" : "Barista",
    }));
    expect(t.observe(titles, 1)).toBe(false);
  });

  it("ignores results from a search the run did not send", () => {
    // "a" is dry; a still-matching search nobody sent must not hold it up.
    const t = tracker(["a"]);
    t.observe(results({ search: "z", count: 60, named: 60 }), 1);
    expect(t.observe(results({ search: "a", count: 60, named: 0 }), 2)).toBe(
      true,
    );
  });
});

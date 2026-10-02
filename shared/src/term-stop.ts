/**
 * Early stop for a search term's LinkedIn run: once results stop naming the
 * term, the rest of the run is paid-for noise.
 *
 * LinkedIn ranks a single-term search by relevance and keeps going well past
 * the postings that match: measured on curious_coder (2026-10-02, ten
 * single-term searches of 200 in London and Vienna), a Vienna search that is
 * 72% matches in its top 25 is 0% from rank 26 on, and a London one decays
 * from 52% to 10%. Stopping each of those searches once fewer than 2 of its
 * last 20 ranked results named the term would have bought 51% of their rows
 * and kept 97% of the matching ones. That is a per-search figure: a run
 * searches one URL per city and stops only once every city is done, so a run
 * saves less when its cities run dry at very different depths. (The actor
 * crawls a run's cities at the same time, measured on a three-city run.)
 *
 * A city that has returned nothing never counts as done: it may not have
 * started yet, and a run that stopped before reaching it would lose that
 * city's postings while reporting success. So a city with no results at all
 * keeps its term's run going to the budget, as it did before this rule.
 */

import { titleNamesTerm, titleWords } from "./term-title-match";

/**
 * How many of a search's deepest-ranked results the rule looks at: two of
 * the 10-result pages LinkedIn serves after its first 60.
 */
export const TERM_STOP_WINDOW = 20;

/** The setting cannot ask for more matches than the window holds. */
export const MAX_TERM_STOP_MIN_MATCHES = TERM_STOP_WINDOW;

export const DEFAULT_TERM_STOP_MIN_MATCHES = 2;

/**
 * How long a city search that has returned results may go without a new one,
 * while another city in the same run is still gaining them, before it counts
 * as finished (it ran out). Measured on curious_coder, a running search paused
 * for up to about 20s, so 60s leaves three times that; a city that pauses
 * longer while still finding matches would lose them.
 */
export const TERM_STOP_STALL_MS = 60_000;

/** One result as the rule sees it. */
export interface TermStopResult {
  /** Which search (city URL) returned it. */
  search: string;
  /** Its rank within that search, 1 first. */
  rank: number;
  /** Its title; a result without one counts toward its search's cap only. */
  title: string | null;
}

/**
 * Whether one search has run dry: it holds at least a window of ranked
 * results and fewer than `minMatches` of its deepest-ranked window name the
 * term. `matches` must be ordered by rank.
 */
export function searchHasRunDry(
  matches: readonly boolean[],
  minMatches: number,
): boolean {
  if (matches.length < TERM_STOP_WINDOW) return false;
  let named = 0;
  for (const match of matches.slice(-TERM_STOP_WINDOW)) if (match) named += 1;
  return named < minMatches;
}

interface SearchState {
  /** Every result from this search, titled or not: its cap counts all. */
  rows: number;
  ranked: { rank: number; match: boolean }[];
  /** When `rows` last grew; null while it has none. */
  grewAtMs: number | null;
}

/**
 * Decides, one observation at a time, when a term's run can stop: when every
 * one of its searches is done, meaning run dry, at its own cap, or finished
 * (it has results, and none new for `TERM_STOP_STALL_MS` while another search
 * gained one), and at least one of them ran dry.
 *
 * Feed it each batch of new results as it arrives; it keeps what it has seen,
 * so each result is matched once.
 */
export class TermStopTracker {
  private readonly termWords: string[];
  private readonly searches = new Map<string, SearchState>();

  constructor(
    private readonly args: {
      term: string;
      /** The URLs the run searches, as the actor reports them on results. */
      searches: readonly string[];
      /** Each search's own result cap, when it has one. */
      searchCap: number | undefined;
      minMatches: number;
    },
  ) {
    this.termWords = titleWords(args.term);
    for (const search of args.searches) {
      this.searches.set(search, { rows: 0, ranked: [], grewAtMs: null });
    }
  }

  /** Add newly arrived results and say whether the run can stop now. */
  observe(results: readonly TermStopResult[], nowMs: number): boolean {
    for (const result of results) {
      const state = this.searches.get(result.search);
      if (!state) continue;
      state.rows += 1;
      state.grewAtMs = nowMs;
      if (result.title !== null) {
        state.ranked.push({
          rank: result.rank,
          match: titleNamesTerm(
            new Set(titleWords(result.title)),
            this.termWords,
          ),
        });
      }
    }
    return this.canStop();
  }

  private canStop(): boolean {
    const { minMatches, searchCap } = this.args;
    if (minMatches <= 0 || this.searches.size === 0) return false;
    let lastGrowthMs = Number.NEGATIVE_INFINITY;
    for (const state of this.searches.values()) {
      if (state.grewAtMs !== null && state.grewAtMs > lastGrowthMs) {
        lastGrowthMs = state.grewAtMs;
      }
    }
    let anyDry = false;
    for (const state of this.searches.values()) {
      if (state.grewAtMs === null) return false;
      if (searchCap !== undefined && state.rows >= searchCap) continue;
      // Finished: quiet for the stall window, measured to the run's latest
      // growth, so a run where nothing moves (the actor wrapping up) does not
      // read every search as finished.
      if (lastGrowthMs - state.grewAtMs >= TERM_STOP_STALL_MS) continue;
      const ranked = [...state.ranked].sort((a, b) => a.rank - b.rank);
      if (
        !searchHasRunDry(
          ranked.map((row) => row.match),
          minMatches,
        )
      ) {
        return false;
      }
      anyDry = true;
    }
    // Every search capped or finished, none dry: nothing is left to save and
    // the run ends by itself, as `capped` or `under` rather than `stopped`.
    return anyDry;
  }
}

import type { ExtractorSourceId } from "@shared/extractors";
import { bucketWindowDays } from "@shared/scrape-window.js";
import type { RunOptionSource } from "@shared/types";

/** What the menu will send, derived from the user's ticks. */
export interface RunMenuSelection {
  /**
   * Platform ids for `sources`, or undefined for "everything the Profile
   * pins". Undefined is meaningfully different from the full list: an omitted
   * list follows the Profile, while an explicit one freezes this moment's set
   * and is validated against enablement and location compatibility.
   */
  sources?: ExtractorSourceId[];
  providerInstanceIds?: string[];
}

/** Sources a run can actually use — the rest are shown, disabled, with a reason. */
export function runnableSources(
  sources: readonly RunOptionSource[],
): RunOptionSource[] {
  return sources.filter(
    (source) =>
      source.kind === "provider_instance" || source.platforms.length > 0,
  );
}

/**
 * Turn ticked keys into request fields.
 *
 * Everything ticked sends NOTHING, so the run follows the Profile. Sending the
 * full list instead would freeze the source set at whatever the menu last
 * fetched, and turn a Sources-page toggle in another tab into a failed run.
 */
export function buildRunSelection(
  sources: readonly RunOptionSource[],
  selectedKeys: ReadonlySet<string>,
): RunMenuSelection {
  const runnable = runnableSources(sources);
  const selected = runnable.filter((source) => selectedKeys.has(source.key));
  // `0 === 0` would otherwise make "nothing selectable" mean "send no scoping",
  // i.e. run everything the Profile pins — the opposite of what was asked.
  if (runnable.length > 0 && selected.length === runnable.length) return {};

  return {
    sources: selected
      .filter((source) => source.kind === "extractor")
      .flatMap((source) => source.platforms),
    providerInstanceIds: selected
      .filter((source) => source.kind === "provider_instance")
      .map((source) => source.key.slice(source.key.indexOf(":") + 1)),
  };
}

export interface RunWindowIssue {
  sourceKey: string;
  label: string;
  /** A refusal: the run cannot start until it is resolved. */
  blocking: boolean;
  message: string;
}

/**
 * What a requested window means for each selected source.
 *
 * Mirrors the server's gate so the menu can refuse before sending, but the
 * server refuses too — this is the affordance, not the guard. It also surfaces
 * the non-blocking round-UP case, which costs money on a pay-per-result actor
 * without losing coverage.
 */
export function findWindowIssues(args: {
  windowDays: number | null;
  sources: readonly RunOptionSource[];
  selectedKeys: ReadonlySet<string>;
}): RunWindowIssue[] {
  const { windowDays } = args;
  if (windowDays === null) return [];

  const issues: RunWindowIssue[] = [];
  for (const source of runnableSources(args.sources)) {
    if (!args.selectedKeys.has(source.key)) continue;
    // A source the run window never reaches cannot be violated by it.
    if (source.windowSupport !== "run_window") continue;

    if (typeof source.capDays === "number" && windowDays > source.capDays) {
      issues.push({
        sourceKey: source.key,
        label: source.label,
        blocking: true,
        message: `only allows ${source.capDays} days`,
      });
      continue;
    }

    if (!source.maxAgeBuckets || source.maxAgeBuckets.length === 0) continue;
    const bucketed = bucketWindowDays(windowDays, source.maxAgeBuckets);
    if (bucketed < windowDays) {
      issues.push({
        sourceKey: source.key,
        label: source.label,
        blocking: true,
        message: `cannot look back past ${bucketed} days`,
      });
    } else if (bucketed > windowDays) {
      // Not a refusal: more than asked for, which is a cost rather than a loss.
      issues.push({
        sourceKey: source.key,
        label: source.label,
        blocking: false,
        message: `rounds up to ${bucketed} days, and bills per result`,
      });
    }
  }
  return issues;
}

/** "2d ago" / "never", for the age each source button carries. */
export function describeLastScraped(
  lastScrapedAt: string | null,
  now: number = Date.now(),
): string {
  if (!lastScrapedAt) return "never";
  const parsed = Date.parse(lastScrapedAt);
  if (!Number.isFinite(parsed)) return "never";
  const days = Math.floor((now - parsed) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

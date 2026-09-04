/**
 * A tailoring failure is stored as ONE string in `jobs.tailoring_failure_reason`
 * carrying two parts: a one-line summary the user reads first, and an optional
 * diagnostic detail block behind a blank line.
 *
 * One column rather than a second `tailoring_failure_detail` one, deliberately.
 * A second column would need the whole `Job` cascade (schema → shared types →
 * factories → repo mapper → PATCH zod) AND a new lockstep at every site that
 * NULLs the reason — miss one and a stale detail attaches itself to a fresh
 * failure, which is exactly B7's shape. Every existing writer and clearer
 * already moves this column, so folding the detail into it needs no new
 * bookkeeping and cannot drift out of step.
 *
 * The convention is deliberately degrading: a reason with no blank line has no
 * detail, which is what every reason stored before this existed looks like, and
 * what the reasons written outside the tailoring path ("Tailoring interrupted
 * (server restart)") still look like.
 *
 * `splitTailoringFailure` is total over strings, but "a detail block appears
 * only where one was put" is NOT a property of the system: three writers reach
 * the column without passing through `composeTailoringFailure` — the generic
 * catch in `processJob`, `reconcileTransientStatuses` in `repositories/jobs.ts`,
 * and the PATCH zod at `api/routes/jobs.ts`, which still accepts a
 * client-supplied reason. Any of them could store a string whose own blank line
 * renders as a disclosure. Cosmetic, and worth knowing before trusting the
 * split as an invariant.
 */

/**
 * Cap on the detail block. `tailoringFailureReason` is on `JobListItem`, so it
 * rides on EVERY row of every jobs-list payload — an uncapped tectonic log or
 * model dump would be multiplied across the list. 2000 characters is roughly
 * 25-30 lines of a LaTeX log, enough to carry an error plus its surrounding
 * context. Half that would routinely cut a tectonic error away from the line it
 * names; ten times it would add megabytes to a list payload in the case that
 * matters most — a systemic failure, where every listed row carries a detail.
 *
 * Call sites choose WHICH window they pass (a compile log's useful part is its
 * tail, a model payload's is its head); this only bounds it.
 */
export const TAILORING_FAILURE_DETAIL_MAX_CHARS = 2000;

/** Ids listed in a detail block before the list is cut. */
export const MAX_DETAIL_LIST_IDS = 25;

const SEPARATOR = "\n\n";
const TRUNCATION_NOTE = "\n… (truncated)";

export interface TailoringFailureParts {
  /** The one-line summary. Always present, possibly empty for an empty reason. */
  summary: string;
  /** The diagnostic block, or null when the reason carries none. */
  detail: string | null;
}

/**
 * Build the stored string. Returns the summary alone when there is no detail,
 * so a failure with nothing to add is byte-identical to what it stored before.
 */
export function composeTailoringFailure(
  summary: string,
  detail?: string | null,
): string {
  const trimmedSummary = summary.trim();
  const trimmedDetail = detail?.trim();
  if (!trimmedDetail) return trimmedSummary;

  const bounded =
    trimmedDetail.length > TAILORING_FAILURE_DETAIL_MAX_CHARS
      ? trimmedDetail.slice(0, TAILORING_FAILURE_DETAIL_MAX_CHARS) +
        TRUNCATION_NOTE
      : trimmedDetail;

  // A summary that already contains a blank line would make the split
  // ambiguous — collapse it so the first blank line is always the separator
  // this function inserted.
  return `${collapseBlankLines(trimmedSummary)}${SEPARATOR}${bounded}`;
}

/**
 * Split a stored reason back into its parts. Total: every string maps to a
 * result, and a reason with no blank line yields `detail: null`.
 */
export function splitTailoringFailure(
  reason: string | null | undefined,
): TailoringFailureParts {
  if (!reason) return { summary: "", detail: null };

  const match = reason.match(/\n[ \t]*\n/);
  if (!match || match.index === undefined) {
    return { summary: reason.trim(), detail: null };
  }

  const summary = reason.slice(0, match.index).trim();
  const detail = reason.slice(match.index + match[0].length).trim();
  return { summary, detail: detail.length > 0 ? detail : null };
}

/**
 * The summary alone. For surfaces with no room for a detail block — a row
 * badge's `title` tooltip, a dialog's one-line chip — where rendering the whole
 * stored string would produce a multi-paragraph blob.
 */
export function tailoringFailureSummary(
  reason: string | null | undefined,
): string {
  return splitTailoringFailure(reason).summary;
}

function collapseBlankLines(value: string): string {
  // The `(?:...)+` is load-bearing: `/\n[ \t]*\n+/` collapses only ONE blank
  // line per match position, so "A\n \n \nB" came out still holding a blank
  // line and the summary lost its tail to the detail on the next split.
  return value.replace(/\n(?:[ \t]*\n)+/g, "\n");
}

/**
 * Render a list of ids for a detail block: one indented id per line, with the
 * cut marked. The marker matters — a silently truncated list reads as the whole
 * set, and these lists exist to be compared against each other.
 *
 * Pass the FULL list: a pre-sliced argument can never be marked as cut.
 */
export function formatIdList(
  ids: string[],
  max = MAX_DETAIL_LIST_IDS,
): string[] {
  const shown = ids.slice(0, max).map((id) => `  ${id}`);
  return ids.length > max
    ? [...shown, `  … (${ids.length - max} more)`]
    : shown;
}

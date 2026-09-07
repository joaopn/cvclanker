/**
 * Pure half of the tailor-time duplicate-application guard: given the jobs a
 * user is about to tailor and the jobs already in flight, work out which
 * employers overlap.
 *
 * The same opening is routinely scraped twice under two board URLs. Duplicate
 * review cannot join those — it groups on the BOARD's own posting id
 * (`shared/duplicate-identity.ts`), deliberately, because a wrong join destroys
 * a real opening. So the two rows sit in the Inbox looking unrelated, and
 * tailoring the second one ends in two applications to one employer for what is
 * probably one role. This is what notices.
 */

import type { JobListItem, JobStatus } from "@shared/types.js";

/**
 * Work the user has started and not concluded. `processing` covers both a
 * tailor running right now and a failed one awaiting retry; `ready` is tailored
 * and awaiting an apply. `discovered`/`backlog`/`stale` are untouched rows and
 * `skipped`/`closed` are concluded — neither is a double-application risk.
 */
export const IN_FLIGHT_STATUSES: readonly JobStatus[] = [
  "processing",
  "ready",
  "applied",
  "in_progress",
];

/** The minimum a caller must know about a job to be checked. */
export interface TailorCandidate {
  id: string;
  employer: string;
}

export interface CompanyConflictGroup {
  /** Rendered verbatim — the candidate's spelling, not the in-flight row's. */
  employer: string;
  /** The about-to-be-tailored jobs at this employer. */
  candidates: TailorCandidate[];
  /** Jobs already in flight at this employer, in the order the API sent them. */
  inFlight: JobListItem[];
}

/**
 * Exact match, case- and whitespace-insensitive, and nothing else normalized —
 * the same rule `isEmployerBlocked` and the company panel use. No diacritic
 * folding, no `Ltd`/`GmbH` trimming: each of those guesses that two spellings
 * are one company, and over-matching here HIDES a real second opening behind a
 * warning about an unrelated one.
 */
function employerKey(employer: string | null | undefined): string {
  return (employer ?? "").trim().toLowerCase();
}

/**
 * Groups the selection by employer, keeping only employers that already have
 * something ELSE in flight.
 *
 * A job in the selection is never its own conflict, and neither is a sibling
 * the same press is about to tailor: both are "what you are doing right now",
 * not "what you already have running".
 *
 * That is reachable, not defensive. A FAILED tailor sits at `processing` with a
 * reason set (`isFailedProcessing`), which makes it simultaneously in flight by
 * the rule above AND a legitimate Tailor target — `canMoveToReady` admits it as
 * the retry. Without the exclusion, retrying a failed Acme tailor would warn
 * about itself, and retrying two together would warn about each other and
 * nothing else. (A `ready` row is NOT such a case: `MOVE_TO_READY_STATUSES` is
 * discovered/backlog/stale, and re-tailoring a `ready` row is the separate
 * `retailor` action, which is deliberately not guarded.)
 *
 * A job with no employer never conflicts: an empty name is unknown, not a
 * match. That rule has ONE home — the skip while bucketing `inFlight`. With no
 * empty bucket to find, a blank-employer candidate cannot resolve to one, so
 * re-asserting it on the candidate side would be a second implementation that
 * makes each individually deletable with the suite green.
 *
 * Groups and their candidates come back in the selection's own order.
 */
export function buildCompanyConflicts(
  candidates: readonly TailorCandidate[],
  inFlight: readonly JobListItem[],
): CompanyConflictGroup[] {
  const inFlightByEmployer = new Map<string, JobListItem[]>();
  for (const job of inFlight) {
    const key = employerKey(job.employer);
    if (!key) continue;
    const existing = inFlightByEmployer.get(key);
    if (existing) existing.push(job);
    else inFlightByEmployer.set(key, [job]);
  }

  const candidatesByEmployer = new Map<string, TailorCandidate[]>();
  for (const candidate of candidates) {
    const key = employerKey(candidate.employer);
    if (!inFlightByEmployer.has(key)) continue;
    const existing = candidatesByEmployer.get(key);
    if (existing) existing.push(candidate);
    else candidatesByEmployer.set(key, [candidate]);
  }

  const groups: CompanyConflictGroup[] = [];
  for (const [key, groupCandidates] of candidatesByEmployer) {
    const selectedIds = new Set(groupCandidates.map((c) => c.id));
    const others = (inFlightByEmployer.get(key) ?? []).filter(
      (job) => !selectedIds.has(job.id),
    );
    if (others.length === 0) continue;
    groups.push({
      employer: groupCandidates[0].employer.trim(),
      candidates: groupCandidates,
      inFlight: others,
    });
  }

  return groups;
}

/** The ids in `candidates` that no group claims — safe to tailor as-is. */
export function nonConflictingIds(
  candidates: readonly TailorCandidate[],
  groups: readonly CompanyConflictGroup[],
): string[] {
  const conflicting = new Set(
    groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.id),
    ),
  );
  return candidates
    .map((candidate) => candidate.id)
    .filter((id) => !conflicting.has(id));
}

/**
 * Asks the duplicate-application guard whether a tailor may proceed. Resolves
 * the ids to dispatch, or `null` if the user cancelled; with the setting off it
 * resolves every id without asking the server anything.
 *
 * Threaded as a REQUIRED prop rather than through a context: a missing context
 * provider would fall back to a no-op and silently disable a safety feature in
 * production with no type error, whereas a missing prop does not compile.
 */
export type ConfirmTailor = (
  jobs: readonly TailorCandidate[],
) => Promise<string[] | null>;

/**
 * The single-job form of the guard, and the ONE definition of what counts as
 * approval. Four surfaces tailor one job at a time (the Inbox detail's Start
 * Tailoring, the backlog/stale row button, the More-actions item, and the
 * keyboard shortcut with nothing selected); without a shared helper each
 * carries its own copy of "null or empty means don't", which is exactly the
 * kind of rule that drifts.
 *
 * Empty counts as a refusal, not just `null`: "Tailor the other N" on an
 * all-conflicting selection approves nothing, and a caller that only checked
 * for `null` would tailor anyway.
 */
export async function tailorApproved(
  confirmTailor: ConfirmTailor,
  job: TailorCandidate,
): Promise<boolean> {
  const approved = await confirmTailor([job]);
  return approved !== null && approved.length > 0;
}

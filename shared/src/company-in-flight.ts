/**
 * "Do I already have work in flight at this company?" — one rule, used by the
 * tailor-time guard on the client and by the jobs-list hydration on the server.
 *
 * Deliberately EMPLOYER-ONLY and exact. An earlier design scored title and
 * employer similarity (the dormant `AppliedDuplicateMatch`, B73); the PI's
 * ruling on 2026-09-07 replaced it: *"it is not about title+employer, but
 * EMPLOYER ONLY. Very simple: if there are tailoring/live applications to the
 * same company, show the box."*
 *
 * Why the exact-match discipline that governs duplicate GROUPING does not
 * govern this, in the PI's words: *"it is not about erasing good data, but
 * avoiding duplication."* Duplicate review joins two rows into one and can
 * destroy a real opening, so it must never guess. This only tells the user what
 * their own pipeline already contains — a false positive costs a glance.
 */

import type { JobStatus } from "./types/jobs";

/**
 * Work the user has started and not concluded: the Tailoring, Live and
 * Interviewing tabs. `processing` covers both a tailor running right now and a
 * failed one awaiting retry; `ready` is tailored and awaiting an apply.
 * `discovered`/`backlog`/`stale` are untouched rows and `skipped`/`closed` are
 * concluded — neither is a double-application risk.
 */
export const IN_FLIGHT_STATUSES: readonly JobStatus[] = [
  "processing",
  "ready",
  "applied",
  "in_progress",
];

const IN_FLIGHT_STATUS_SET: ReadonlySet<JobStatus> = new Set(
  IN_FLIGHT_STATUSES,
);

export function isInFlightStatus(status: JobStatus): boolean {
  return IN_FLIGHT_STATUS_SET.has(status);
}

/**
 * The grouping key for an employer: exact, case- and whitespace-insensitive,
 * and nothing else normalized — the same rule `isEmployerBlocked` uses.
 *
 * No diacritic folding, no `Ltd`/`GmbH` trimming: each of those guesses that
 * two spellings are one company. Over-matching here would hide a real second
 * opening behind a warning about an unrelated one, which is the failure this
 * warning exists to prevent.
 *
 * An empty name yields an empty key, and callers must treat that as "unknown",
 * never as a company two rows have in common.
 */
export function employerKey(employer: string | null | undefined): string {
  return (employer ?? "").trim().toLowerCase();
}

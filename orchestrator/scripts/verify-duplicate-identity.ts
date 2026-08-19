/**
 * Re-derives the duplicate-detection numbers through the REAL shared identity
 * module, against a profile database passed as PROFILE_DB.
 *
 * Not a test: it needs a real 18k-row database, which the suite has no business
 * depending on. It exists so the plan's measured figures can be re-checked
 * against the shipped code rather than against the throwaway scripts they were
 * first measured with — the two disagreeing is exactly how a plan starts
 * describing something the code does not do.
 *
 *   PROFILE_DB=/path/to/profile.db npm --workspace orchestrator run verify:dup-identity
 */

import {
  descriptionFingerprint,
  externalIdKey,
  hasConflictingExternalIds,
  isLocationCompatible,
  normalizeTitleKey,
} from "@shared/duplicate-identity";
import Database from "better-sqlite3";

const dbPath = process.env.PROFILE_DB;
if (!dbPath) {
  console.error("PROFILE_DB is required (path to a profile .db, read-only).");
  process.exit(2);
}

type Row = {
  id: string;
  title: string | null;
  job_url: string | null;
  source_job_id: string | null;
  location: string | null;
  job_description: string | null;
};

const ACTIVE_TRIAGE = ["discovered", "selected", "processing", "ready"];
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `select id, title, job_url, source_job_id, location, job_description
     from jobs where status in (${ACTIVE_TRIAGE.map(() => "?").join(",")})
     order by discovered_at desc`,
  )
  .all(...ACTIVE_TRIAGE) as Row[];

/** The DB rows are snake_case; the identity helpers read camelCase. */
function idArgs(row: Row): {
  jobUrl: string | null;
  sourceJobId: string | null;
} {
  return { jobUrl: row.job_url, sourceJobId: row.source_job_id };
}

const byExternalId = new Map<string, Row[]>();
const byTextAndTitle = new Map<string, Row[]>();

for (const row of rows) {
  const idKey = externalIdKey(idArgs(row));
  if (idKey) byExternalId.set(idKey, [...(byExternalId.get(idKey) ?? []), row]);

  const fingerprint = descriptionFingerprint(row.job_description);
  if (fingerprint) {
    // NUL, not a space: normalized titles contain spaces, so a space separator
    // would let a different (text, title) split collide.
    const key = `${fingerprint}\u0000${normalizeTitleKey(row.title)}`;
    byTextAndTitle.set(key, [...(byTextAndTitle.get(key) ?? []), row]);
  }
}

let idGroups = 0;
let idRows = 0;
let idTitleDisagreements = 0;
for (const members of byExternalId.values()) {
  if (members.length < 2) continue;
  idGroups += 1;
  idRows += members.length - 1;
  if (new Set(members.map((m) => normalizeTitleKey(m.title))).size > 1) {
    idTitleDisagreements += 1;
  }
}

let textGroups = 0;
let textRows = 0;
let textRedundant = 0;
let textConflicting = 0;
let textOnlyEvidence = 0;
for (const members of byTextAndTitle.values()) {
  if (members.length < 2) continue;
  const [keeper, ...rest] = members;
  const losers = rest.filter((m) =>
    isLocationCompatible(keeper.location, m.location),
  );
  if (losers.length > 0) {
    textGroups += 1;
    textRows += losers.length;
    for (const loser of losers) {
      const keeperId = idArgs(keeper);
      const loserId = idArgs(loser);
      if (hasConflictingExternalIds(keeperId, loserId)) textConflicting += 1;
      else if (externalIdKey(keeperId) && externalIdKey(loserId))
        textRedundant += 1;
      else textOnlyEvidence += 1;
    }
  }
}

console.log(`active-triage rows              : ${rows.length}`);
console.log(
  `layer 2 (board + id)            : ${idGroups} groups, ${idRows} rows`,
);
console.log(
  `  ...of which titles disagree   : ${idTitleDisagreements} (review-only, never bulk-swept)`,
);
console.log(
  `\nnot shipped — text identity (dropped 2026-08-19): ${textGroups} groups, ${textRows} rows`,
);
console.log(`  ...same board id (already proposed): ${textRedundant}`);
console.log(`  ...CONFLICTING board ids          : ${textConflicting}`);
console.log(`  ...no id, text is only evidence   : ${textOnlyEvidence}`);

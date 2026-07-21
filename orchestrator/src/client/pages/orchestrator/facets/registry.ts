import type { Job, JobListItem } from "@shared/types";

// A job as seen by a facet predicate. List rows in the common case; the full
// Job once a `requiresFullView` facet forces the inbox to refetch view:"full".
// Predicates read only the fields their facet declares and guard for absence.
export type FacetJob = JobListItem | Job;

export type FacetType = "text";

export interface FacetDef {
  id: string;
  label: string;
  type: FacetType;
  // True when matching needs a field absent from JobListItem (e.g.
  // jobDescription), so the list must be refetched with view:"full" before the
  // facet can apply. No Tier-1 facet sets this.
  requiresFullView?: boolean;
  placeholder?: string;
  // Build a predicate from the raw user value. Returns null when the value is
  // blank ⇒ the facet is present-but-inactive (a chip with no text filters
  // nothing).
  buildPredicate: (value: string) => ((job: FacetJob) => boolean) | null;
}

export interface ActiveFacet {
  id: string;
  value: string;
}

// Case-insensitive substring match; `|` splits the value into OR'd terms
// ("phd|doctorate"). A loaded-but-empty field (null) never matches, so an
// active facet excludes rows that lack the value. A wholly-absent field
// (undefined — a Tier-2 field on a list row before the view:"full" upgrade
// lands) is treated as inert so the list doesn't flash empty mid-upgrade.
function textContains(
  accessor: (job: FacetJob) => string | null | undefined,
): FacetDef["buildPredicate"] {
  return (value: string) => {
    const terms = value
      .toLowerCase()
      .split("|")
      .map((term) => term.trim())
      .filter(Boolean);
    if (terms.length === 0) return null;
    return (job) => {
      const raw = accessor(job);
      if (raw === undefined) return true; // not loaded yet ⇒ inert
      if (raw === null) return false; // loaded, empty ⇒ no match
      const haystack = raw.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    };
  };
}

// Reads a field that only exists on the full Job (absent from JobListItem). A
// list row lacks the key entirely (→ undefined at runtime), which textContains
// treats as inert until the view:"full" payload lands.
function fullField(
  key: "jobDescription" | "degreeRequired" | "jobLevel",
): (job: FacetJob) => string | null | undefined {
  return (job) => (job as Job)[key];
}

// Remote is two sparse full-only fields: the `workFromHomeType` string
// (remote/hybrid/onsite/…) and the `isRemote` boolean. Match the typed terms
// against the string, and also treat isRemote===true as "remote" so a job that
// only carries the boolean still matches. Both absent ⇒ inert (list row).
function remotePredicate(value: string): ((job: FacetJob) => boolean) | null {
  const terms = value
    .toLowerCase()
    .split("|")
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return null;
  return (job) => {
    const full = job as Job;
    const wfh = full.workFromHomeType as string | null | undefined;
    const flag = full.isRemote as boolean | null | undefined;
    if (wfh === undefined && flag === undefined) return true; // not loaded ⇒ inert
    const haystack = (wfh ?? "").toLowerCase();
    return terms.some(
      (term) => haystack.includes(term) || (term === "remote" && flag === true),
    );
  };
}

// Tier-1 facets: every field is present on JobListItem, so these filter the
// list payload client-side with no refetch. Tier-2 facets (jobDescription,
// degreeRequired, …) are added in a later slice with `requiresFullView: true`.
export const FACET_DEFS: FacetDef[] = [
  {
    id: "employer",
    label: "Company",
    type: "text",
    placeholder: "e.g. acme | globex",
    buildPredicate: textContains((job) => job.employer),
  },
  {
    id: "title",
    label: "Title",
    type: "text",
    placeholder: "e.g. senior | staff",
    buildPredicate: textContains((job) => job.title),
  },
  {
    id: "location",
    label: "Location",
    type: "text",
    placeholder: "e.g. berlin | remote",
    buildPredicate: textContains((job) => job.location),
  },
  // Tier-2 facets: these fields are absent from JobListItem, so activating any
  // of them flips useFacetFilters.requiresFullView, which makes the inbox
  // refetch view:"full" before the predicate can match.
  {
    id: "description",
    label: "Description",
    type: "text",
    requiresFullView: true,
    placeholder: "e.g. phd|doctorate",
    buildPredicate: textContains(fullField("jobDescription")),
  },
  {
    id: "degreeRequired",
    label: "Degree required",
    type: "text",
    requiresFullView: true,
    placeholder: "e.g. phd|master",
    buildPredicate: textContains(fullField("degreeRequired")),
  },
  {
    id: "jobLevel",
    label: "Job level",
    type: "text",
    requiresFullView: true,
    placeholder: "e.g. senior|lead",
    buildPredicate: textContains(fullField("jobLevel")),
  },
  {
    id: "remote",
    label: "Remote",
    type: "text",
    requiresFullView: true,
    placeholder: "e.g. remote|hybrid",
    buildPredicate: remotePredicate,
  },
];

export const FACET_DEFS_BY_ID: Record<string, FacetDef> = Object.fromEntries(
  FACET_DEFS.map((def) => [def.id, def]),
);

// Predicates for the active facets, skipping unknown ids and blank values.
export function buildFacetPredicates(
  activeFacets: ActiveFacet[],
): Array<(job: FacetJob) => boolean> {
  const predicates: Array<(job: FacetJob) => boolean> = [];
  for (const active of activeFacets) {
    const def = FACET_DEFS_BY_ID[active.id];
    if (!def) continue;
    const predicate = def.buildPredicate(active.value);
    if (predicate) predicates.push(predicate);
  }
  return predicates;
}

// True when any active facet needs the full job payload (view:"full").
export function facetRequiresFullView(activeFacets: ActiveFacet[]): boolean {
  return activeFacets.some(
    (active) => FACET_DEFS_BY_ID[active.id]?.requiresFullView === true,
  );
}

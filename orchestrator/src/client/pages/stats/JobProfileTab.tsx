/**
 * Job profile: for each Search Profile, how many of its jobs have titles
 * naming each of its search terms, how many of those are any good and how many
 * were applied to — so a term that rarely shows up, or shows up on bad fits,
 * stands out.
 */

import type {
  StatsSearchTerms,
  StatsTermProfile,
  StatsYield,
} from "@shared/types";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { count, percent, plural } from "./format";
import { Bar, Caveat, EmptyNote, Panel, StatsTable } from "./StatsPrimitives";
import {
  nextTermSort,
  sortTerms,
  type TermSort,
  type TermSortKey,
} from "./termSort";

const COLUMNS: Array<{ key: TermSortKey; label: string; numeric: boolean }> = [
  { key: "term", label: "Term", numeric: false },
  { key: "scored", label: "Scored jobs", numeric: true },
  { key: "goodFit", label: "Good+", numeric: true },
  { key: "applied", label: "Applied", numeric: true },
  { key: "appliedRate", label: "Applied rate", numeric: true },
  { key: "fitRate", label: "Fit rate", numeric: false },
];

const SortHeader: React.FC<{
  column: (typeof COLUMNS)[number];
  sort: TermSort;
  onSort: (key: TermSortKey) => void;
}> = ({ column, sort, onSort }) => {
  // The default order IS Term ascending, so say so rather than "none".
  const direction =
    sort === null
      ? column.key === "term"
        ? "asc"
        : null
      : sort.key === column.key
        ? sort.direction
        : null;
  const Icon =
    direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : null;
  const icon = Icon ? (
    <Icon className="h-3 w-3" aria-hidden="true" />
  ) : (
    <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden="true" />
  );
  return (
    <th
      scope="col"
      aria-sort={
        direction === "asc"
          ? "ascending"
          : direction === "desc"
            ? "descending"
            : undefined
      }
      className={cn(
        "py-1.5 font-medium",
        column.numeric ? "pr-3 text-right" : "text-left",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground",
          direction ? "text-foreground" : undefined,
        )}
      >
        {/* Right-aligned columns carry the icon on the left, so the label
            lines up with the numbers under it. */}
        {column.numeric ? icon : null}
        {column.label}
        {column.numeric ? null : icon}
      </button>
    </th>
  );
};

const YieldCells: React.FC<{ row: StatsYield }> = ({ row }) => (
  <>
    <td className="py-1.5 pr-3 text-right tabular-nums">{count(row.scored)}</td>
    <td className="py-1.5 pr-3 text-right tabular-nums">
      {count(row.goodFit)}
    </td>
    <td className="py-1.5 pr-3 text-right tabular-nums">
      {count(row.applied)}
    </td>
    <td className="py-1.5 pr-3 text-right text-xs tabular-nums">
      {percent(row.applied, row.scored, 1)}
    </td>
    <td className="w-40 py-1.5">
      <div className="flex items-center gap-2">
        <Bar value={row.goodFit} max={row.scored || 1} />
        <span className="w-12 shrink-0 text-right text-xs tabular-nums">
          {percent(row.goodFit, row.scored, 1)}
        </span>
      </div>
    </td>
  </>
);

const ProfileTerms: React.FC<{
  profile: StatsTermProfile;
  sort: TermSort;
  onSort: (key: TermSortKey) => void;
}> = ({ profile, sort, onSort }) => (
  <Panel
    title={profile.name}
    note={`${plural(profile.jobs, "job")}, ${count(profile.scored)} scored · ${percent(
      profile.goodFit,
      profile.scored,
      1,
    )} good fit`}
  >
    <div className="space-y-3">
      {profile.termsFrom === "all_profiles" ? (
        <Caveat>
          These jobs have no recorded profile, or one since deleted, so their
          titles are matched against every current profile's terms.
        </Caveat>
      ) : null}
      <StatsTable
        head={COLUMNS.map((column) => (
          <SortHeader
            key={column.key}
            column={column}
            sort={sort}
            onSort={onSort}
          />
        ))}
      >
        {sortTerms(profile.terms, sort).map((row) => (
          <tr key={row.term} className="border-border/50 border-b">
            <th scope="row" className="py-1.5 pr-3 text-left font-normal">
              {row.term}
              {row.jobs === 0 ? (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                  no title names it
                </span>
              ) : row.scored === 0 ? (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                  {plural(row.jobs, "job")}, none scored
                </span>
              ) : null}
            </th>
            <YieldCells row={row} />
          </tr>
        ))}
        <tr className="border-border/50 border-b text-muted-foreground">
          <th scope="row" className="py-1.5 pr-3 text-left font-normal italic">
            No term in title
          </th>
          <YieldCells row={profile.unmatched} />
        </tr>
      </StatsTable>
    </div>
  </Panel>
);

export const JobProfileTab: React.FC<{ data: StatsSearchTerms }> = ({
  data,
}) => {
  // One sort for every profile's table, so a click compares like with like
  // across all of them.
  const [sort, setSort] = useState<TermSort>(null);
  const onSort = (key: TermSortKey) =>
    setSort((current) => nextTermSort(current, key));

  return (
    <div className="space-y-4">
      <Panel title="Search terms">
        <div className="space-y-2">
          {data.profiles.length === 0 ? (
            <EmptyNote>No jobs found by a search in this range.</EmptyNote>
          ) : null}
          <Caveat>
            A job counts under every term whose words all appear in its title,
            in any order — whichever board found it, and however that board ran
            the search. This measures what titles say, not which query returned
            a job: a term's own results land under "No term in title" when their
            titles word it differently (an "ML Engineer" search returning
            "Machine Learning Engineer"). Terms are the profile's current ones,
            so a term removed since is not listed. A title naming two terms
            counts under both, so a profile's rows can add up to more than its
            total.
          </Caveat>
          <Caveat>
            Every column counts SCORED jobs only: Applied is the scored jobs you
            applied to at any point, so a job applied to but never scored is not
            in it. Fit rate and applied rate are shares of scored jobs, and show
            a dash when nothing is scored. Click a column heading to sort every
            table by it — ascending, then descending, then back to alphabetical
            (Term just flips between Z–A and A–Z); "No term in title" always
            stays last.
          </Caveat>
          {data.manualJobs > 0 ? (
            <Caveat>
              Not shown: {plural(data.manualJobs, "manual import")}, which no
              search found.
            </Caveat>
          ) : null}
        </div>
      </Panel>

      {data.profiles.map((profile) => (
        <ProfileTerms
          key={profile.profileId ?? "unattributed"}
          profile={profile}
          sort={sort}
          onSort={onSort}
        />
      ))}
    </div>
  );
};

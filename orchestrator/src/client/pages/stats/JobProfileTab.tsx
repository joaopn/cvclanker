/**
 * Job profile: for each Search Profile, how many of its jobs have titles
 * naming each of its search terms, and how many of those are any good — so a
 * term that rarely shows up, or shows up on bad fits, stands out.
 */

import type {
  StatsSearchTerms,
  StatsTermProfile,
  StatsYield,
} from "@shared/types";
import type React from "react";
import { count, percent, plural } from "./format";
import { Bar, Caveat, EmptyNote, Panel, StatsTable } from "./StatsPrimitives";

const YieldCells: React.FC<{ row: StatsYield }> = ({ row }) => (
  <>
    <td className="py-1.5 text-right tabular-nums">{count(row.jobs)}</td>
    <td className="py-1.5 text-right tabular-nums">{count(row.scored)}</td>
    <td className="py-1.5 pr-4 text-right tabular-nums">
      {count(row.goodFit)}
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

const ProfileTerms: React.FC<{ profile: StatsTermProfile }> = ({ profile }) => (
  <Panel
    title={profile.name}
    note={`${plural(profile.jobs, "job")} · ${percent(
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
        head={
          <>
            <th scope="col" className="py-1.5 text-left font-medium">
              Term
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Jobs
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Scored
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium">
              Good+
            </th>
            <th scope="col" className="py-1.5 text-left font-medium">
              Fit rate
            </th>
          </>
        }
      >
        {profile.terms.map((row) => (
          <tr key={row.term} className="border-border/50 border-b">
            <th scope="row" className="py-1.5 pr-3 text-left font-normal">
              {row.term}
              {row.jobs === 0 ? (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                  no title names it
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
}) => (
  <div className="space-y-4">
    <Panel title="Search terms">
      <div className="space-y-2">
        {data.profiles.length === 0 ? (
          <EmptyNote>No jobs found by a search in this range.</EmptyNote>
        ) : null}
        <Caveat>
          A job counts under every term whose words all appear in its title, in
          any order — whichever board found it, and however that board ran the
          search. This measures what titles say, not which query returned a job:
          a term's own results land under "No term in title" when their titles
          word it differently (an "ML Engineer" search returning "Machine
          Learning Engineer"). Terms are the profile's current ones, so a term
          removed since is not listed. A title naming two terms counts under
          both, so a profile's rows can add up to more than its total. Fit rate
          is the share of SCORED jobs rated good fit or better, and shows a dash
          when nothing is scored.
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
      />
    ))}
  </div>
);

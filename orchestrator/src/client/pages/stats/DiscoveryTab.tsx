/**
 * Discovery: which boards and which Search Profiles are earning their place.
 */

import type { StatsDiscovery } from "@shared/types";
import type React from "react";
import { count, percent } from "./format";
import { Bar, Caveat, EmptyNote, Panel, StatsTable } from "./StatsPrimitives";

export const DiscoveryTab: React.FC<{ data: StatsDiscovery }> = ({ data }) => {
  const totalScored = data.sources.reduce((sum, row) => sum + row.scored, 0);
  const totalGood = data.sources.reduce((sum, row) => sum + row.goodFit, 0);

  return (
    <div className="space-y-4">
      <Panel
        title="Boards"
        note={
          totalScored > 0
            ? `${percent(totalGood, totalScored, 1)} good fit across all boards`
            : undefined
        }
      >
        {data.sources.length === 0 ? (
          <EmptyNote>No jobs in this range.</EmptyNote>
        ) : (
          <div className="space-y-3">
            <StatsTable
              head={
                <>
                  <th scope="col" className="py-1.5 text-left font-medium">
                    Board
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Jobs
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Scored
                  </th>
                  <th
                    scope="col"
                    className="py-1.5 pr-4 text-right font-medium"
                  >
                    Good+
                  </th>
                  <th scope="col" className="py-1.5 text-left font-medium">
                    Fit rate
                  </th>
                </>
              }
            >
              {data.sources.map((row) => (
                <tr key={row.source} className="border-border/50 border-b">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {row.label}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {count(row.jobs)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {count(row.scored)}
                  </td>
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
                </tr>
              ))}
            </StatsTable>
            <Caveat>
              Fit rate is the share of a board's SCORED jobs rated good fit or
              better — the same denominator in every table on this page. Across
              all boards that is {count(totalGood)} of {count(totalScored)}{" "}
              scored jobs ({percent(totalGood, totalScored, 1)}), which is a
              pooled rate, not the average of the column. A board with nothing
              scored shows a dash, not a zero.
            </Caveat>
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Search Profiles" note="which profile found the job">
          {data.profiles.length === 0 ? (
            <EmptyNote>No jobs in this range.</EmptyNote>
          ) : (
            <div className="space-y-3">
              <StatsTable
                head={
                  <>
                    <th scope="col" className="py-1.5 text-left font-medium">
                      Profile
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Jobs
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 pr-4 text-right font-medium"
                    >
                      Good+
                    </th>
                    <th scope="col" className="py-1.5 text-right font-medium">
                      Scored
                    </th>
                    <th scope="col" className="py-1.5 text-left font-medium">
                      Fit rate
                    </th>
                  </>
                }
              >
                {data.profiles.map((row) => (
                  <tr
                    key={row.profileId ?? "unattributed"}
                    className="border-border/50 border-b"
                  >
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          row.profileId === null
                            ? "text-muted-foreground italic"
                            : undefined
                        }
                      >
                        {row.name}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {count(row.jobs)}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {count(row.goodFit)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {count(row.scored)}
                    </td>
                    <td className="w-28 py-1.5">
                      <div className="flex items-center gap-2">
                        <Bar value={row.goodFit} max={row.scored || 1} />
                        <span className="w-10 shrink-0 text-right text-xs tabular-nums">
                          {percent(row.goodFit, row.scored, 1)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </StatsTable>
              <Caveat>
                A job is attributed to the profile that first discovered it, and
                only from the day that attribution shipped — anything older
                counts as Unattributed.
              </Caveat>
            </div>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="Search terms">
            {data.termAttributionAvailable ? (
              <EmptyNote>
                Term statistics are available but this panel has not been built
                yet.
              </EmptyNote>
            ) : (
              <EmptyNote>
                Not available. No job records which of a profile's search terms
                found it: extractors are handed the whole list and return a flat
                set of jobs, and four of them combine every term into a single
                query, so for those the answer cannot exist even in principle.
                Reporting it would mean stamping the term at import for the
                boards that do search one at a time, and showing nothing for the
                rest.
              </EmptyNote>
            )}
          </Panel>

          <Panel title="Yield per run">
            {data.perRunYieldAvailable ? (
              <EmptyNote>
                Per-run yield is available but this panel has not been built
                yet.
              </EmptyNote>
            ) : (
              <EmptyNote>
                Not available. A run counts what each board returned, what the
                location filter dropped and what could not be read, but those
                counters live in memory and are gone when the container restarts
                — only the jobs themselves are stored. Answering "is this board
                getting worse" needs those counts persisted per run.
              </EmptyNote>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
};

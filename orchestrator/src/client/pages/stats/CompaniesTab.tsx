/**
 * Companies: who is worth your time, and which postings are not really open.
 */

import type { StatsCompanies } from "@shared/types";
import type React from "react";
import { count, percent, plural } from "./format";
import { Bar, Caveat, EmptyNote, Panel, StatsTable } from "./StatsPrimitives";

export const CompaniesTab: React.FC<{ data: StatsCompanies }> = ({ data }) => (
  <div className="space-y-4">
    <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr] lg:items-start">
      <Panel
        title="Companies"
        note={
          data.companiesTotal > data.companies.length
            ? `top ${count(data.companies.length)} of ${count(data.companiesTotal)} by good fit`
            : data.companies.length > 0
              ? `${count(data.companiesTotal)} by good fit`
              : undefined
        }
      >
        {data.companies.length === 0 ? (
          <EmptyNote>No jobs in this range.</EmptyNote>
        ) : (
          <div className="space-y-3">
            <StatsTable
              head={
                <>
                  <th scope="col" className="py-1.5 text-left font-medium">
                    Company
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Postings
                  </th>
                  <th
                    scope="col"
                    className="py-1.5 pr-4 text-right font-medium"
                  >
                    Good+
                  </th>
                  <th scope="col" className="py-1.5 text-left font-medium">
                    Hit rate
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    Applied
                  </th>
                </>
              }
            >
              {data.companies.map((row) => (
                <tr key={row.key} className="border-border/50 border-b">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    {row.employer}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {count(row.jobs)}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">
                    {count(row.goodFit)}
                  </td>
                  <td className="w-28 py-1.5">
                    <div className="flex items-center gap-2">
                      <Bar value={row.goodFit} max={row.scored || 1} />
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums">
                        {percent(row.goodFit, row.scored, 0)}
                      </span>
                    </div>
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                    {count(row.applied)}
                  </td>
                </tr>
              ))}
            </StatsTable>
            <Caveat>
              Companies are grouped the same way the jobs list filters them — by
              name, ignoring case only — so a count here is exactly what
              clicking through would show. Hit rate is the share of that
              company's SCORED postings rated good fit or better. Two spellings
              of one company stay two rows, which is usually a scraper telling
              on itself.
            </Caveat>
          </div>
        )}
      </Panel>

      <Panel
        title="Posting churn"
        note="signals a role that is not really open"
      >
        {data.totalJobs === 0 ? (
          <EmptyNote>No jobs in this range.</EmptyNote>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">Re-posted at least once</span>
                <span className="text-sm tabular-nums">
                  {count(data.repostedJobs)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">Board now reports closed</span>
                <span className="text-sm tabular-nums">
                  {count(data.liveClosedJobs)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  Checked for live status
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {count(data.liveStatusChecked)}
                </span>
              </div>
            </div>
            <Caveat>
              Live status is only available for LinkedIn postings and only once
              something has checked them, so both figures are a floor rather
              than a survey of {plural(data.totalJobs, "job")}.
            </Caveat>
          </div>
        )}
      </Panel>
    </div>
  </div>
);

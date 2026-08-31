/**
 * Overview: how much came in, where it stops, and whether the scorer's verdict
 * matches what the user actually did with each job.
 */

import type { StatsOverview } from "@shared/types";
import type React from "react";
import { cn } from "@/lib/utils";
import { count, dayLabel, heatStep, percent, plural } from "./format";
import {
  Bar,
  Caveat,
  EmptyNote,
  Panel,
  StatsTable,
  StatTile,
} from "./StatsPrimitives";

const HEAT_CLASSES = [
  "bg-muted",
  "bg-chart-1/25",
  "bg-chart-1/50",
  "bg-chart-1/75",
  "bg-chart-1",
] as const;

const FIT_LABELS: Record<string, string> = {
  great_fit: "Great fit",
  very_good_fit: "Very good fit",
  good_fit: "Good fit",
  bad_fit: "Bad fit",
  unscored: "Unscored",
};

export const OverviewTab: React.FC<{ data: StatsOverview }> = ({ data }) => {
  const funnelMax = Math.max(...data.funnel.map((step) => step.count), 1);
  const busiestDay = Math.max(...data.activity.map((day) => day.count), 0);
  const scoredShare = percent(data.goodFit, data.scored, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Jobs found"
          value={count(data.found)}
          detail={
            data.found === 0
              ? "nothing in this range"
              : data.unscored > 0
                ? `${plural(data.unscored, "job")} not scored yet`
                : "all scored"
          }
        />
        <StatTile
          label="Good fit or better"
          value={count(data.goodFit)}
          detail={
            data.scored > 0
              ? `${scoredShare} of what has been scored`
              : "nothing scored yet"
          }
        />
        <StatTile
          label="Tailored"
          value={count(data.tailored)}
          // Deliberately NOT a share of good fits: a bad-fit job can be
          // tailored, so the two are not nested and the ratio would be a
          // number with no meaning — and above 100% whenever the user tailors
          // outside the good-fit set.
          detail={
            data.tailored === 0 ? "nothing tailored yet" : "CVs generated"
          }
        />
        <StatTile
          label="Applied"
          value={count(data.applied)}
          // Applying does not require tailoring — the apply route writes the
          // status alone — so this is a count, never a share of Tailored.
          detail={data.applied === 0 ? "no applications recorded yet" : "sent"}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Where jobs stop"
          note={data.found === 0 ? undefined : "every stage"}
        >
          {data.found === 0 ? (
            <EmptyNote>
              No jobs in this range. Widen the range, or run the pipeline.
            </EmptyNote>
          ) : (
            <div className="space-y-2.5">
              {data.funnel.map((step, index) => {
                const previous = index > 0 ? data.funnel[index - 1] : null;
                const widensUnexpectedly =
                  previous !== null &&
                  !step.nested &&
                  step.count > previous.count;
                return (
                  <div key={step.key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm">{step.label}</span>
                      <span className="font-medium text-sm tabular-nums">
                        {count(step.count)}
                        {previous && step.nested ? (
                          <span className="ml-2 font-normal text-muted-foreground text-xs">
                            {percent(step.count, previous.count, 0)} of previous
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <Bar value={step.count} max={funnelMax} />
                    {widensUnexpectedly ? (
                      <Caveat>
                        Larger than the step above because tailoring and
                        applying are not limited to good fits.
                      </Caveat>
                    ) : null}
                  </div>
                );
              })}
              <Caveat>
                Scored and Good fit describe the jobs as they stand now — a
                rescore overwrites the old verdict. Tailored and Applied are
                permanent marks.
              </Caveat>
            </div>
          )}
        </Panel>

        <Panel title="Scorer versus you" note="what each rating led to">
          {data.scored === 0 ? (
            <EmptyNote>
              Nothing has been scored in this range yet, so there is no verdict
              to compare your decisions against.
            </EmptyNote>
          ) : (
            <div className="space-y-3">
              <StatsTable
                head={
                  <>
                    <th className="py-1.5 text-left font-medium">Rating</th>
                    <th className="py-1.5 text-right font-medium">Skipped</th>
                    <th className="py-1.5 text-right font-medium">Applied</th>
                    <th className="py-1.5 text-right font-medium">Tailored</th>
                    <th className="py-1.5 text-right font-medium">Inbox</th>
                  </>
                }
              >
                {data.calibration.map((row) => (
                  <tr key={row.category} className="border-border/50 border-b">
                    <td className="py-1.5">
                      <div>{FIT_LABELS[row.category] ?? row.category}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Bar
                          value={row.skipped}
                          max={row.total || 1}
                          title={`${percent(row.skipped, row.total, 0)} skipped`}
                        />
                      </div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {count(row.skipped)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {count(row.applied)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {count(row.tailored)}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                      {count(row.inInbox)}
                    </td>
                  </tr>
                ))}
              </StatsTable>
              <Caveat>
                The bar is the share of that rating you skipped by hand. Each
                column means "got this far and no further", so a job you applied
                to is not also counted as tailored.
              </Caveat>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Activity"
        note={
          data.activity.length > 0
            ? `${plural(data.activity.length, "active day")} · UTC`
            : undefined
        }
      >
        {data.activity.length === 0 ? (
          <EmptyNote>No jobs were found in this range.</EmptyNote>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {data.activity.map((day) => (
                <div
                  key={day.date}
                  role="img"
                  aria-label={`${dayLabel(day.date)}: ${plural(day.count, "job")}`}
                  title={`${dayLabel(day.date)}: ${plural(day.count, "job")}`}
                  className={cn(
                    "h-6 w-6 rounded-sm",
                    HEAT_CLASSES[heatStep(day.count, busiestDay)],
                  )}
                />
              ))}
            </div>
            <Caveat>
              One square per day that found something, oldest first. Days are
              UTC.
            </Caveat>
          </div>
        )}
      </Panel>
    </div>
  );
};

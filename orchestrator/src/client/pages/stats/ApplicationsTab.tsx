/**
 * Applications: how many went out, how many came back, and how long that took.
 */

import { GHOSTED_AFTER_DAYS, type StatsApplications } from "@shared/types";
import type React from "react";
import { count, days, percent, plural } from "./format";
import {
  Bar,
  Caveat,
  EmptyNote,
  Panel,
  StatsTable,
  StatTile,
} from "./StatsPrimitives";

/**
 * Outcome states use the reserved status colours, which is what they are — a
 * rejection is a bad state, an interview a good one. No other chart on this
 * page borrows them.
 */
const OUTCOME_TONES = {
  advanced: "bg-status-good",
  rejected: "bg-status-bad",
  waiting: "bg-status-warn",
  quiet: "bg-muted-foreground/40",
} as const;

/** English needs a real plural here; `plural()` only appends a suffix. */
function replies(value: number): string {
  return `${count(value)} ${value === 1 ? "reply" : "replies"}`;
}

export const ApplicationsTab: React.FC<{ data: StatsApplications }> = ({
  data,
}) => {
  if (data.applied === 0) {
    return (
      <Panel title="Applications">
        <EmptyNote>
          No applications recorded in this range. A job is counted here once it
          is marked applied — the mark is permanent, so this fills in as you
          apply.
        </EmptyNote>
      </Panel>
    );
  }

  const outcomes = [
    { key: "advanced", label: "Advanced to interview", value: data.advanced },
    { key: "rejected", label: "Rejected", value: data.rejected },
    { key: "waiting", label: "Still waiting", value: data.stillWaiting },
    {
      key: "quiet",
      label: `No answer in ${GHOSTED_AFTER_DAYS} days`,
      value: data.ghostedDerived,
    },
    { key: "quiet", label: "Marked ghosted", value: data.ghostedRecorded },
    {
      key: "quiet",
      label: "Closed for another reason",
      value: data.closedOther,
    },
    { key: "quiet", label: "Moved out of applications", value: data.movedOn },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Applications" value={count(data.applied)} />
        <StatTile
          label="Heard back"
          value={percent(data.heardBack, data.applied, 0)}
          detail={`${count(data.heardBack)} of ${count(data.applied)}`}
        />
        <StatTile
          label="Median reply"
          value={days(data.medianReplyDays)}
          detail={
            data.replyTimeSampleSize === 0
              ? "no closed applications yet"
              : `from ${replies(data.replyTimeSampleSize)}`
          }
        />
        <StatTile
          label="Outstanding"
          value={count(data.outstandingTotal)}
          detail={
            data.ghostedDerived > 0
              ? `${count(data.ghostedDerived)} past ${GHOSTED_AFTER_DAYS} days`
              : "all still fresh"
          }
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="What happened" note={plural(data.applied, "application")}>
          <div className="space-y-2.5">
            {outcomes
              .filter((row) => row.value > 0)
              .map((row) => (
                <div key={row.label} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm">{row.label}</span>
                    <span className="text-sm tabular-nums">
                      {count(row.value)}
                    </span>
                  </div>
                  <Bar
                    value={row.value}
                    max={data.applied}
                    className={OUTCOME_TONES[row.key]}
                  />
                </div>
              ))}
            <Caveat>
              Heard back counts rejections and jobs now at Interviewing. It is a
              floor: nothing records when a job changed stage, so one that
              reached Interviewing and was later closed for another reason can
              no longer be seen to have had a reply.
            </Caveat>
          </div>
        </Panel>

        <Panel
          title="How long replies took"
          note={
            data.replyTimeSampleSize > 0
              ? replies(data.replyTimeSampleSize)
              : undefined
          }
        >
          {data.replyTimeSampleSize === 0 ? (
            <EmptyNote>
              Nothing to measure yet. Reply time is the gap between applying and
              closing a job, so it fills in once applications start closing.
            </EmptyNote>
          ) : (
            <div className="space-y-2.5">
              {data.replyTimeBuckets.map((bucket) => (
                <div key={bucket.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm">{bucket.label} days</span>
                    <span className="text-sm tabular-nums">
                      {count(bucket.count)}
                    </span>
                  </div>
                  <Bar value={bucket.count} max={data.replyTimeSampleSize} />
                </div>
              ))}
              <Caveat>
                Measured only where an application was closed, and only over
                applications SENT in this range — so a narrower range reads
                faster than reality, because slow replies have not arrived yet.
              </Caveat>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Waiting on"
        note={
          data.outstandingTotal > data.outstanding.length
            ? `oldest ${count(data.outstanding.length)} of ${count(data.outstandingTotal)}`
            : "oldest first"
        }
      >
        {data.outstanding.length === 0 ? (
          <EmptyNote>
            Nothing outstanding — every application has an answer.
          </EmptyNote>
        ) : (
          <StatsTable
            head={
              <>
                <th className="py-1.5 text-left font-medium">Job</th>
                <th className="py-1.5 text-left font-medium">Company</th>
                <th className="py-1.5 text-right font-medium">Waiting</th>
                <th className="py-1.5 text-right font-medium">Posting</th>
              </>
            }
          >
            {data.outstanding.map((row) => (
              <tr key={row.id} className="border-border/50 border-b">
                <td className="py-1.5 pr-3">{row.title}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {row.employer}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  <span
                    className={
                      row.daysWaiting >= GHOSTED_AFTER_DAYS
                        ? "text-status-bad-text"
                        : undefined
                    }
                  >
                    {days(row.daysWaiting)}
                  </span>
                </td>
                <td className="py-1.5 text-right text-xs">
                  {row.liveClosed === null ? (
                    <span className="text-muted-foreground">not checked</span>
                  ) : row.liveClosed ? (
                    <span className="text-status-bad-text">closed</span>
                  ) : (
                    <span className="text-status-good-text">live</span>
                  )}
                </td>
              </tr>
            ))}
          </StatsTable>
        )}
      </Panel>
    </div>
  );
};

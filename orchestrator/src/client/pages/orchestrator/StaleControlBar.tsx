import * as api from "@client/api";
import type { JobStatus } from "@shared/types";
import { Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "@client/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface StaleControlBarProps {
  thresholdDays: number;
  onThresholdChange: (value: number) => void;
  onSwept: () => Promise<void> | void;
}

type SweepScope = "shelf" | "tailoring" | "liveClosed";

const MIN_DAYS = 1;
const MAX_DAYS = 365;

const clampDays = (value: number): number =>
  Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(value)));

// Friendly tab labels for the toast breakdown, covering every status the bar's
// three sweeps can report: shelf and liveClosed both draw from {discovered,
// selected, backlog}, tailoring from {ready}. `selected` is a retired status
// with no tab of its own, so it falls through to describeBreakdown's
// raw-status fallback.
const STATUS_LABELS: Partial<Record<JobStatus, string>> = {
  discovered: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
};

function describeBreakdown(
  breakdown: Partial<Record<JobStatus, number>>,
): string | undefined {
  const byLabel = new Map<string, number>();
  for (const [status, count] of Object.entries(breakdown)) {
    if (!count) continue;
    const label = STATUS_LABELS[status as JobStatus] ?? status;
    byLabel.set(label, (byLabel.get(label) ?? 0) + count);
  }
  if (byLabel.size === 0) return undefined;
  return [...byLabel.entries()]
    .map(([label, count]) => `${count} from ${label}`)
    .join(" · ");
}

export const StaleControlBar = ({
  thresholdDays,
  onThresholdChange,
  onSwept,
}: StaleControlBarProps) => {
  const [busyScope, setBusyScope] = useState<SweepScope | null>(null);
  const busy = busyScope !== null;

  const runSweep = async (scope: SweepScope) => {
    if (busy) return;
    const days = clampDays(thresholdDays);
    if (scope !== "liveClosed" && !Number.isFinite(days)) {
      toast.error("Enter a valid number of days (1-365).");
      return;
    }
    setBusyScope(scope);
    try {
      const result =
        scope === "liveClosed"
          ? await api.sweepLiveClosedJobs()
          : await api.sweepStaleJobs(days, scope);
      if (result.moved === 0) {
        toast.message(
          scope === "liveClosed"
            ? "No jobs whose posting closed."
            : "No rows older than the threshold.",
        );
      } else {
        toast.success(`${result.moved} jobs moved to Stale`, {
          description: describeBreakdown(result.breakdown),
        });
      }
      await onSwept();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to sweep stale rows";
      toast.error(message);
    } finally {
      setBusyScope(null);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runSweep("shelf");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 border-b border-border/40 px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="stale-threshold-days"
          className="text-xs text-muted-foreground"
        >
          Older than
        </label>
        <Input
          id="stale-threshold-days"
          type="number"
          inputMode="numeric"
          min={MIN_DAYS}
          max={MAX_DAYS}
          value={thresholdDays}
          onChange={(event) => {
            const raw = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(raw)) {
              onThresholdChange(clampDays(raw));
            }
          }}
          className="h-7 w-20 px-2 text-xs"
          disabled={busy}
        />
        <span className="text-xs text-muted-foreground">days</span>
        <Button
          type="submit"
          size="sm"
          variant="default"
          disabled={busy}
          className="ml-auto h-7 px-3 text-xs"
        >
          {busyScope === "shelf" ? (
            <>
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              Sweeping...
            </>
          ) : (
            "Move stale rows"
          )}
        </Button>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void runSweep("tailoring")}
        className="h-7 px-3 text-xs sm:ml-auto sm:w-auto"
      >
        {busyScope === "tailoring" ? (
          <>
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            Sweeping...
          </>
        ) : (
          "Move Tailoring"
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void runSweep("liveClosed")}
        className="h-7 px-3 text-xs sm:ml-auto sm:w-auto"
        title='Moves Inbox/Backlog jobs whose live LinkedIn check found "No longer accepting applications". Run Live status on a selection first to populate the check.'
      >
        {busyScope === "liveClosed" ? (
          <>
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            Sweeping...
          </>
        ) : (
          "Move closed postings"
        )}
      </Button>
    </form>
  );
};

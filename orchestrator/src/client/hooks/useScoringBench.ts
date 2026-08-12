import type { BenchRun, BenchStreamEvent } from "@shared/types";
import { useEffect, useState } from "react";
import { subscribeToEventSource } from "@/client/lib/sse";

interface UseScoringBenchResult {
  run: BenchRun | null;
  connected: boolean;
}

/**
 * Mirrors the server's single in-memory benchmark run. The stream replays a
 * full snapshot on every (re)connect, so a page reload mid-run picks the grid
 * back up instead of losing it — the run belongs to the server, not to this
 * component.
 */
export function useScoringBench(): UseScoringBenchResult {
  const [run, setRun] = useState<BenchRun | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeToEventSource<BenchStreamEvent>(
      "/api/scoring-bench/stream",
      {
        onOpen: () => setConnected(true),
        onMessage: (event) => {
          if (event.type === "snapshot") {
            setRun(event.run);
            return;
          }
          setRun((previous) => {
            // Events for a run we don't hold are dropped rather than applied to
            // the current one: a stale frame from a superseded run would
            // otherwise write cells into the new grid.
            if (!previous || previous.id !== event.runId) return previous;
            if (event.type === "status") {
              return {
                ...previous,
                status: event.status,
                stoppedReason: event.stoppedReason,
                finishedAt: event.finishedAt,
              };
            }
            const cells = [...previous.cells];
            const index = cells.findIndex(
              (cell) =>
                cell.jobId === event.cell.jobId &&
                cell.configId === event.cell.configId,
            );
            if (index === -1) cells.push(event.cell);
            else cells[index] = event.cell;
            return { ...previous, cells };
          });
        },
        onError: () => setConnected(false),
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, []);

  return { run, connected };
}

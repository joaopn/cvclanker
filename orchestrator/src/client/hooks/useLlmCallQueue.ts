import type { LlmCallRecord, LlmCallStreamEvent } from "@shared/types";
import { useEffect, useState } from "react";
import { subscribeToEventSource } from "@/client/lib/sse";

/**
 * Mirror of the server's record window (services/llm/observer.ts). The stream
 * only ever adds and updates, so without a matching cap this copy grows for
 * the life of the page: a scoring run books two records per job under two-step
 * classification, and every finished one would sit in "Recent" forever, being
 * re-rendered on the 500ms tick for as long as anything is in flight.
 *
 * Running calls are never dropped — a spinning row is the one thing the user
 * needs to see, and their number is capped by the LLM concurrency setting.
 */
const MAX_FINISHED = 50;

function capFinished(calls: LlmCallRecord[]): LlmCallRecord[] {
  let excess = calls.filter((call) => call.status !== "running").length;
  excess -= MAX_FINISHED;
  if (excess <= 0) return calls;
  // `calls` is in arrival order, so dropping from the front drops the oldest.
  return calls.filter((call) => {
    if (call.status === "running" || excess === 0) return true;
    excess -= 1;
    return false;
  });
}

interface UseLlmCallQueueResult {
  active: LlmCallRecord[];
  recent: LlmCallRecord[];
  total: number;
  connected: boolean;
}

export function useLlmCallQueue(enabled = true): UseLlmCallQueueResult {
  const [calls, setCalls] = useState<LlmCallRecord[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeToEventSource<LlmCallStreamEvent>(
      "/api/llm/calls/stream",
      {
        onOpen: () => setConnected(true),
        onMessage: (event) => {
          if (event.type === "snapshot") {
            setCalls(capFinished(event.calls));
          } else if (event.type === "update") {
            setCalls((prev) => {
              const existingIndex = prev.findIndex(
                (entry) => entry.id === event.call.id,
              );
              if (existingIndex === -1)
                return capFinished([...prev, event.call]);
              const next = [...prev];
              next[existingIndex] = event.call;
              return capFinished(next);
            });
          }
        },
        onError: () => setConnected(false),
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [enabled]);

  const active: LlmCallRecord[] = [];
  const recent: LlmCallRecord[] = [];
  for (const call of calls) {
    if (call.status === "running") active.push(call);
    else recent.push(call);
  }
  active.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  recent.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return {
    active,
    recent,
    total: calls.length,
    connected,
  };
}

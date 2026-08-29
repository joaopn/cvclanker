/**
 * The ONE progress subscription the app holds, fanned out to every consumer.
 *
 * `/api/pipeline/progress` had two independent subscribers on `/jobs` — the
 * orchestrator data hook and the run banner — so the page opened two sockets to
 * the same endpoint, each with its own reconnect loop and its own server-side
 * response plus heartbeat. That was survivable while the banner only subscribed
 * during a run; it stopped being survivable when the banner started subscribing
 * always (so a finished run stays visible), against a browser cap of about six
 * per origin that also has to carry the jobs poll, the LLM queue and the
 * detached-batch viewer.
 *
 * The last payload is REPLAYED to every new subscriber. The server already
 * replays on connect, but a component mounting after the socket is open would
 * otherwise wait for the next event — which, for a run that has already ended,
 * never comes. That replay is what makes the banner survive a reopened page.
 */

import { subscribeToEventSource } from "@client/lib/sse";
import type { PipelineProgressEvent } from "@shared/types";

interface Watcher {
  onEvent: (event: PipelineProgressEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

const watchers = new Set<Watcher>();
let unsubscribe: (() => void) | null = null;
let lastEvent: PipelineProgressEvent | null = null;
let connected = false;

function setConnected(next: boolean): void {
  connected = next;
  for (const watcher of watchers) watcher.onConnectionChange?.(next);
}

function open(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeToEventSource<PipelineProgressEvent>(
    "/api/pipeline/progress",
    {
      onOpen: () => setConnected(true),
      onMessage: (payload) => {
        if (!payload || typeof payload !== "object") return;
        lastEvent = payload;
        for (const watcher of watchers) watcher.onEvent(payload);
      },
      onError: () => setConnected(false),
    },
  );
}

/**
 * Watch pipeline progress. The socket opens on the first subscriber and closes
 * when the last one leaves; the most recent event is delivered immediately.
 */
export function subscribeToPipelineProgress(watcher: Watcher): () => void {
  watchers.add(watcher);
  open();
  if (lastEvent) watcher.onEvent(lastEvent);
  watcher.onConnectionChange?.(connected);

  return () => {
    watchers.delete(watcher);
    if (watchers.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
    connected = false;
    // Deliberately keeping `lastEvent`: a remount replays it at once rather
    // than showing an empty banner until the server's next event, which for a
    // finished run would be never.
  };
}

/** Test-only: drop the socket and forget the last event. */
export function resetPipelineProgressStream(): void {
  unsubscribe?.();
  unsubscribe = null;
  watchers.clear();
  lastEvent = null;
  connected = false;
}

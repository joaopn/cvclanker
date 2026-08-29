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
 * The feed carries BOTH run partitions (a manual run and a scheduled one each
 * keep their own retained table), so every watcher names the one it renders and
 * receives nothing else. The server's own fan-out has no partition filter — it
 * delivers every event to every listener — so this is the only place the two
 * are held apart, and a watcher that could see both would blank its table the
 * moment the other partition emitted.
 *
 * The last payload OF EACH PARTITION is REPLAYED to every new subscriber. The
 * server already replays on connect, but a component mounting after the socket
 * is open would otherwise wait for the next event — which, for a run that has
 * already ended, never comes. That replay is what makes the banner survive a
 * reopened page, and it is per-partition for the same reason the delivery is: a
 * single slot would let a scheduled run overwrite the manual table's last
 * event and leave a manual watcher replaying someone else's run, or nothing.
 */

import { subscribeToEventSource } from "@client/lib/sse";
import {
  type PipelineProgressEvent,
  RUN_TRIGGERS,
  type RunTrigger,
} from "@shared/types";

interface Watcher {
  /** Which run partition this consumer renders. It receives no other. */
  trigger: RunTrigger;
  onEvent: (event: PipelineProgressEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

const watchers = new Set<Watcher>();
let unsubscribe: (() => void) | null = null;
const lastEventByTrigger = new Map<RunTrigger, PipelineProgressEvent>();
let connected = false;

/**
 * An event the client cannot classify is treated as the manual table's.
 *
 * Unreachable in practice — `trigger` is required on the shared type and both
 * server writers stamp it — so this only decides how a bug behaves. Dropping
 * the event would fail silently, on the one surface whose entire reason for
 * existing is that a run must not vanish; landing it on the partition every
 * consumer already watches is wrong loudly instead.
 */
function normalizeTrigger(value: unknown): RunTrigger {
  return (RUN_TRIGGERS as readonly string[]).includes(value as string)
    ? (value as RunTrigger)
    : "manual";
}

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
        const trigger = normalizeTrigger(payload.trigger);
        lastEventByTrigger.set(trigger, payload);
        for (const watcher of watchers) {
          if (watcher.trigger === trigger) watcher.onEvent(payload);
        }
      },
      onError: () => setConnected(false),
    },
  );
}

/**
 * Watch one partition's pipeline progress. The socket opens on the first
 * subscriber and closes when the last one leaves; that partition's most recent
 * event is delivered immediately.
 */
export function subscribeToPipelineProgress(watcher: Watcher): () => void {
  watchers.add(watcher);
  open();
  const replayed = lastEventByTrigger.get(watcher.trigger);
  if (replayed) watcher.onEvent(replayed);
  watcher.onConnectionChange?.(connected);

  return () => {
    watchers.delete(watcher);
    if (watchers.size > 0) return;
    unsubscribe?.();
    unsubscribe = null;
    connected = false;
    // Deliberately keeping the retained events: a remount replays at once
    // rather than showing an empty banner until the server's next event, which
    // for a finished run would be never.
  };
}

/** Test-only: drop the socket and forget every partition's last event. */
export function resetPipelineProgressStream(): void {
  unsubscribe?.();
  unsubscribe = null;
  watchers.clear();
  lastEventByTrigger.clear();
  connected = false;
}

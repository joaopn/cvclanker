/**
 * The lazy SSE viewer shared by every detached-batch surface.
 *
 * Three properties took three review rounds to get right, and each is the kind
 * a second copy would have to re-earn:
 *
 *  - **Lazy.** On `/jobs` during a pipeline run the app already holds three
 *    streams to the progress endpoint plus the LLM queue, against a browser cap
 *    of about six per origin that also has to carry the jobs poll. A viewer that
 *    nothing is watching closes.
 *  - **The close is deferred a microtask.** One network read can carry several
 *    frames, and the shared reader drains them all before re-checking whether it
 *    was closed — so a close decided on frame one still lets frame two through,
 *    and closing synchronously can strand whatever that frame announced.
 *  - **Only a FATAL error re-subscribes.** The helper gives up permanently on a
 *    401 and backs off on everything else; tearing down and re-subscribing on a
 *    transient failure aborts that pending backoff and turns a broken stream
 *    route into a request storm.
 */

import { subscribeToEventSource } from "@client/lib/sse";

export interface LazyEventStream {
  /** Open if not already open, or replace a subscription abandoned for good. */
  ensureOpen: () => void;
  /** Close when the caller says nothing needs it any more. */
  closeIfIdle: () => void;
  /** Test-only: drop the subscription and forget its health. */
  reset: () => void;
}

export function createLazyEventStream<TEvent>(config: {
  url: string;
  onEvent: (event: TEvent) => void;
  /** Whether the stream can be dropped — no live work, nobody waiting. */
  isIdle: () => boolean;
}): LazyEventStream {
  let unsubscribe: (() => void) | null = null;
  let healthy = false;

  const closeIfIdle = () => {
    if (!unsubscribe) return;
    if (!config.isIdle()) return;
    unsubscribe();
    unsubscribe = null;
  };

  const ensureOpen = () => {
    if (unsubscribe && healthy) return;
    // Replacing a subscription the helper has abandoned (a 401): its loop has
    // returned, so it must be released explicitly before a new one takes over.
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    healthy = true;
    unsubscribe = subscribeToEventSource<TEvent>(config.url, {
      onOpen: () => {
        healthy = true;
      },
      onError: ({ fatal }) => {
        if (!fatal) return;
        healthy = false;
      },
      onMessage: (event) => {
        config.onEvent(event);
        queueMicrotask(closeIfIdle);
      },
    });
  };

  return {
    ensureOpen,
    closeIfIdle,
    reset: () => {
      unsubscribe?.();
      unsubscribe = null;
      healthy = false;
    },
  };
}

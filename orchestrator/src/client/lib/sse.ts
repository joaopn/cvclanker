import {
  getCachedAuthHeader,
  recoverAuthHeaderAfterUnauthorized,
} from "@client/api/client";

interface EventSourceSubscriptionHandlers<T> {
  onOpen?: () => void;
  onMessage: (payload: T) => void;
  /**
   * `fatal` distinguishes "this subscription is over" from "backing off and
   * will retry". Only a 401 is fatal; every other failure is followed by the
   * reconnect loop below, so a caller that tears down and re-subscribes on one
   * would abort the pending backoff and hammer the server instead.
   */
  onError?: (info: { fatal: boolean }) => void;
}

function parseSseFrame(frame: string): string | null {
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

// Wait `ms`, resolving early if `signal` aborts (i.e. the caller unsubscribed).
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function subscribeToEventSource<T>(
  url: string,
  handlers: EventSourceSubscriptionHandlers<T>,
): () => void {
  const controller = new AbortController();
  let isClosed = false;

  void (async () => {
    const authHeader = getCachedAuthHeader();
    let reconnectDelay = RECONNECT_BASE_DELAY_MS;

    // Reconnect indefinitely until the caller unsubscribes. The progress route
    // replays the current state as the first frame on every (re)connect, so a
    // dropped stream self-heals to the latest server state rather than freezing
    // the UI on the last event it happened to receive.
    while (!isClosed) {
      try {
        const response = await fetch(url, {
          headers: authHeader ? { Authorization: authHeader } : undefined,
          signal: controller.signal,
        });

        if (response.status === 401) {
          await recoverAuthHeaderAfterUnauthorized();
          handlers.onError?.({ fatal: true });
          return;
        }

        if (!response.ok || !response.body) {
          handlers.onError?.({ fatal: false });
          await delay(reconnectDelay, controller.signal);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          continue;
        }

        // Connection is live again — reset backoff for the next drop.
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        handlers.onOpen?.();

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";

        try {
          while (!isClosed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let separatorIndex = buffer.indexOf("\n\n");
            while (separatorIndex !== -1) {
              const frame = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);

              const data = parseSseFrame(frame);
              if (data) {
                try {
                  handlers.onMessage(JSON.parse(data) as T);
                } catch {
                  // Ignore malformed events to keep stream resilient.
                }
              }

              separatorIndex = buffer.indexOf("\n\n");
            }
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancellation errors when stream is already closed.
          }
        }

        // Stream ended without an explicit unsubscribe (server closed it or the
        // connection dropped) — surface disconnected state and reconnect.
        if (!isClosed) {
          handlers.onError?.({ fatal: false });
          await delay(reconnectDelay, controller.signal);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
        }
      } catch {
        if (isClosed || controller.signal.aborted) return;
        handlers.onError?.({ fatal: false });
        await delay(reconnectDelay, controller.signal);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  })();

  return () => {
    isClosed = true;
    controller.abort();
  };
}

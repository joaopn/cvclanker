/**
 * A per-attempt deadline for an LLM request, folded together with whatever
 * abort signal the caller already had.
 *
 * Two things it must keep apart, which is why this exists instead of a bare
 * `AbortSignal.any([signal, AbortSignal.timeout(ms)])`: a caller aborting (the
 * ghostwriter's cancel button) and the deadline firing look identical once
 * fetch rejects with an AbortError, and reporting a user cancellation as
 * "timed out after 300000ms" would send someone hunting a provider problem
 * that never happened. `timedOut()` is the only reliable way to tell them
 * apart after the fact.
 */
export interface RequestDeadline {
  /** Pass to fetch / any abortable child work. */
  signal: AbortSignal;
  /** True only when THIS deadline aborted the work — not a caller's abort. */
  timedOut: () => boolean;
  /** Always call: clears the timer and unsubscribes from the caller's signal. */
  dispose: () => void;
}

export function startDeadline(args: {
  signal?: AbortSignal;
  timeoutMs: number;
}): RequestDeadline {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`LLM request deadline of ${args.timeoutMs}ms`));
  }, args.timeoutMs);

  const parent = args.signal;
  const onParentAbort = () => {
    controller.abort(parent?.reason);
  };

  if (parent) {
    if (parent.aborted) {
      onParentAbort();
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * The message a timed-out attempt fails with. Shaped to say what was exceeded
 * and by whom: it reaches the user as a job's scoring failure reason, and it is
 * also what `shouldRetryAttempt` matches on ("timed out") to spend a retry —
 * the one recovery that helps when a provider stalls mid-request.
 */
export function deadlineErrorMessage(args: {
  timeoutMs: number;
  provider: string;
}): string {
  return `LLM request timed out after ${args.timeoutMs}ms (${args.provider}). Raise "LLM request timeout" in Settings → Pipeline Behavior if this model legitimately needs longer.`;
}

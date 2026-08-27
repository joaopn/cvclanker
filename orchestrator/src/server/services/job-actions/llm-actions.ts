import type { JobAction } from "@shared/types";

/**
 * Actions that actually drive LLM work. Only these clear the global
 * rate-limit stop latch: triage actions (skip, move_to_backlog, the Swipe
 * deck's every-swipe calls) touch no provider, and letting them reset would
 * silently resume a run the limit had stopped.
 *
 * Lives here rather than in the jobs route because the CLI-update guard reads
 * it too — reinstalling the `claude` binary is only hazardous while a batch is
 * spawning it, which is exactly this set.
 */
export const LLM_DRIVING_ACTIONS = new Set<JobAction>([
  "rescore",
  "rescrape",
  "move_to_ready",
  "retailor",
]);

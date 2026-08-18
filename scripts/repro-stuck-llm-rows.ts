/**
 * Reproduction: an LLM call that is still running when the observer's record
 * window overflows gets evicted, and its finalize is then silently dropped —
 * so the UI, which only learns about completions from `update` events, keeps
 * showing the call as running until a page refresh replaces the whole list
 * from a fresh snapshot.
 *
 * Two-step classification is what makes this show up: every job registers a
 * pre-filter call AND a main call, so the window churns twice as fast and a
 * slower call is far more likely to be pushed out mid-flight.
 *
 * Exits non-zero while the bug exists.
 */

import { llmCallObserver } from "../orchestrator/src/server/services/llm/observer";

const seen = new Map<string, string>();
llmCallObserver.on("update", (call) => seen.set(call.id, call.status));

function idsBefore(): Set<string> {
  return new Set(llmCallObserver.snapshot().map((entry) => entry.id));
}

function register(label: string, model: string) {
  const before = idsBefore();
  const handle = llmCallObserver.register({ label, model });
  const record = llmCallObserver
    .snapshot()
    .find((entry) => !before.has(entry.id));
  if (!record) throw new Error(`no snapshot entry for ${label}`);
  return { handle, id: record.id };
}

// The slow pre-filter call the user watches spin forever.
const slow = register("score job", "filter-model");

// A pipeline scoring run churns through the window while it is in flight:
// with the two-step classifier every job books two records.
for (let i = 0; i < 60; i += 1) {
  const filter = register("score job", "filter-model");
  filter.handle.succeed({ promptTokens: 10, completionTokens: 2 });
  const main = register("score job", "main-model");
  main.handle.succeed({ promptTokens: 100, completionTokens: 20 });
}

// It finishes, like any other call.
slow.handle.succeed({ promptTokens: 50, completionTokens: 5 });

const lastSeen = seen.get(slow.id);
if (lastSeen !== "succeeded") {
  console.error(
    `FAIL: the UI was last told the call was "${lastSeen}" — it never hears it finished, so the row spins until a refresh.`,
  );
  process.exit(1);
}

console.log("PASS: the finished call was reported to the UI as succeeded.");

/**
 * Reproduction: an LLM request whose provider accepts the request and then
 * never finishes the response has no ceiling on it, so `callJson` never
 * settles. One such call is enough to freeze a whole pipeline run — the
 * scoring pool awaits its workers, so a worker stuck here keeps the run in
 * "scoring" until the process restarts, and cancellation (polled between
 * tasks) never gets a turn.
 *
 * The stall is deliberately the CHATTY kind: headers go out immediately and a
 * byte keeps arriving, so undici's own headers/body timeouts re-arm forever
 * and never rescue the call. That is what a provider trickling keep-alive
 * padding while a model sits queued looks like.
 *
 * Exits non-zero while the bug exists.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resetRateLimitBudget } from "../src/server/services/llm/rate-limit-budget";
import { LlmService } from "../src/server/services/llm/service";
import type { JsonSchemaDefinition } from "../src/server/services/llm/types";

const TIMEOUT_MS = 3_000;
/** Generous multiple of the timeout: this firing at all means nothing bounded the call. */
const WATCHDOG_MS = 20_000;

const SCHEMA: JsonSchemaDefinition = {
  name: "repro",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
};

const stalledProvider = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  const trickle = setInterval(() => res.write(" "), 250);
  req.on("close", () => clearInterval(trickle));
});

await new Promise<void>((resolve) => {
  stalledProvider.listen(0, "127.0.0.1", resolve);
});
const { port } = stalledProvider.address() as AddressInfo;

// The setting reaches the LLM path as an env var (registry envKey), so this is
// exactly what a user typing 3000 into Settings → Pipeline Behavior produces.
process.env.LLM_REQUEST_TIMEOUT_MS = String(TIMEOUT_MS);
// Marks the global rate-limit budget initialized, so callJson does not reach
// for the settings table (and a database) just to seed it.
resetRateLimitBudget(0);

const llm = new LlmService({
  provider: "openai_compatible",
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "repro",
});

const watchdog = setTimeout(() => {
  console.error(
    `FAIL: the call was still running ${WATCHDOG_MS}ms in, with a ${TIMEOUT_MS}ms timeout configured — a stalled provider holds the scoring pool forever.`,
  );
  process.exit(1);
}, WATCHDOG_MS);

const startedAt = Date.now();
const result = await llm.callJson({
  model: "repro-model",
  messages: [{ role: "user", content: "score this" }],
  jsonSchema: SCHEMA,
  label: "repro",
});
const elapsedMs = Date.now() - startedAt;

clearTimeout(watchdog);
stalledProvider.close();

if (result.success) {
  console.error("FAIL: the stalled provider somehow produced a result.");
  process.exit(1);
}

console.log(`PASS: the call gave up after ${elapsedMs}ms — ${result.error}`);

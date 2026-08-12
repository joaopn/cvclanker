/**
 * Model benchmark: classify a random sample of live jobs under several model
 * configurations at once, so a cheaper model can be compared against an
 * expensive one before it is trusted with the real pipeline.
 *
 * The run lives in memory only — no job row is written, no table is added.
 */

import { randomUUID } from "node:crypto";
import { badRequest, conflict } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import { executeBenchRun } from "@server/services/scoring-bench/run";
import {
  claimBenchRun,
  getCurrentBenchRun,
  requestBenchCancel,
  subscribeToBenchRun,
} from "@server/services/scoring-bench/store";
import { CLAUDE_CODE_EFFORT_LEVELS } from "@shared/settings-registry";
import {
  type BenchConfig,
  type BenchStreamEvent,
  SUITABILITY_CATEGORIES,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const scoringBenchRouter = Router();

const SAMPLE_CATEGORIES = [...SUITABILITY_CATEGORIES, "unscored"] as const;

const startRunSchema = z.object({
  // Deliberately uncapped: the user picks the sample size and owns the cost.
  // "Positive integer" is validation, not a limit.
  sampleSize: z.number().int().positive(),
  // Which saved fit categories the sample may be drawn from. Omitted means no
  // restriction; an explicit empty array is refused rather than being read as
  // "everything", because the two are opposite intentions.
  categories: z.array(z.enum(SAMPLE_CATEGORIES)).min(1).optional(),
  configs: z
    .array(
      z.object({
        label: z.string().trim().max(120).optional(),
        // Blank is allowed and means "whatever model scoring uses today" — on
        // claude_code the configured model is legitimately empty (the CLI
        // picks), which is exactly the case where comparing efforts alone
        // matters. The runner resolves it before any call is made.
        model: z.string().trim(),
        effort: z.enum(CLAUDE_CODE_EFFORT_LEVELS).nullish(),
        // Per-million prices, purely for the summary's estimate. Non-negative
        // and finite; absent means this column shows no cost.
        inputCostPerMillion: z.number().nonnegative().finite().nullish(),
        outputCostPerMillion: z.number().nonnegative().finite().nullish(),
      }),
    )
    .min(1),
});

scoringBenchRouter.post("/runs", (req: Request, res: Response) => {
  const parsed = startRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(
      res,
      badRequest("Invalid benchmark request", parsed.error.flatten()),
    );
  }

  const configs: BenchConfig[] = parsed.data.configs.map((config, index) => ({
    id: randomUUID(),
    label: config.label?.trim() || `Config ${index + 1}`,
    model: config.model,
    effort: config.effort ?? null,
    inputCostPerMillion: config.inputCostPerMillion ?? null,
    outputCostPerMillion: config.outputCostPerMillion ?? null,
  }));

  // Deduped before the "is this everything?" comparison, or a payload that
  // repeats one category would count its way to the full length and silently
  // widen the draw.
  const requestedCategories = parsed.data.categories
    ? SAMPLE_CATEGORIES.filter((category) =>
        parsed.data.categories?.includes(category),
      )
    : [...SAMPLE_CATEGORIES];
  // Every category selected is the same draw as no filter at all, so it is not
  // passed down — that keeps the query free of a redundant IN over the whole
  // enum plus an IS NULL.
  const categoryFilter =
    requestedCategories.length === SAMPLE_CATEGORIES.length
      ? undefined
      : requestedCategories;

  // Claimed synchronously, before any await: a read-then-act check would let
  // two concurrent POSTs both see "idle" and start overlapping runs.
  const run = claimBenchRun(configs, requestedCategories);
  if (!run) {
    return fail(res, conflict("A benchmark run is already in progress."));
  }

  void executeBenchRun({
    run,
    sampleSize: parsed.data.sampleSize,
    ...(categoryFilter ? { categories: categoryFilter } : {}),
  }).catch((error: unknown) => {
    // executeBenchRun finishes the run itself on failure; this only catches
    // the impossible case so an unhandled rejection can't take the process
    // down.
    logger.error("Model benchmark rejected unexpectedly", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  ok(res, { run });
});

scoringBenchRouter.post("/cancel", (_req: Request, res: Response) => {
  const cancelled = requestBenchCancel();
  ok(res, { cancelled });
});

scoringBenchRouter.get("/stream", (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  setupSse(res, {
    cacheControl: "no-cache, no-transform",
    disableBuffering: true,
    flushHeaders: true,
  });
  const stopHeartbeat = startSseHeartbeat(res);

  let clientDisconnected = false;
  const isWritable = () =>
    !clientDisconnected && !res.writableEnded && !res.destroyed;

  const sendEvent = (event: BenchStreamEvent) => {
    if (!isWritable()) return;
    writeSseData(res, event);
  };

  // The stream is a viewer, not the run's owner: a reload re-subscribes and
  // replays the snapshot, and a disconnect cancels nothing.
  sendEvent({ type: "snapshot", run: getCurrentBenchRun() });

  const unsubscribe = subscribeToBenchRun(sendEvent);

  const cleanup = () => {
    clientDisconnected = true;
    stopHeartbeat();
    unsubscribe();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  res.on("close", () => {
    logger.debug("Model benchmark stream client disconnected", { requestId });
    cleanup();
  });
  req.on("close", cleanup);
});

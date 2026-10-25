/**
 * Pipeline run repository.
 */

import { randomUUID } from "node:crypto";
import type {
  PipelineRun,
  PipelineRunConfigSnapshot,
  PipelineRunResultSummary,
  PipelineRunSavedDetails,
} from "@shared/types";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index";

const { pipelineRuns } = schema;

function mapRowToPipelineRun(
  row: typeof schema.pipelineRuns.$inferSelect,
): PipelineRun {
  return {
    id: row.id,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    status: row.status as PipelineRun["status"],
    jobsDiscovered: row.jobsDiscovered,
    jobsProcessed: row.jobsProcessed,
    errorMessage: row.errorMessage,
    configSnapshot: parseConfigSnapshot(row.configSnapshot),
  };
}

function serializeConfigSnapshot(
  value: PipelineRunConfigSnapshot | null | undefined,
): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function parseConfigSnapshot(
  value: string | null | undefined,
): PipelineRunConfigSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as PipelineRunConfigSnapshot;
  } catch {
    return null;
  }
}

/**
 * Create a new pipeline run.
 */
export async function createPipelineRun(args?: {
  configSnapshot?: PipelineRunConfigSnapshot | null;
  savedDetails?: PipelineRunSavedDetails | null;
}): Promise<PipelineRun> {
  const id = randomUUID();
  const now = new Date().toISOString();

  await db.insert(pipelineRuns).values({
    id,
    startedAt: now,
    status: "running",
    configSnapshot: serializeConfigSnapshot(args?.configSnapshot ?? null),
    requestedConfig: args?.savedDetails?.requestedConfig ?? null,
    effectiveConfig: args?.savedDetails?.effectiveConfig ?? null,
    resultSummary: args?.savedDetails?.resultSummary ?? null,
  });

  return {
    id,
    startedAt: now,
    completedAt: null,
    status: "running",
    jobsDiscovered: 0,
    jobsProcessed: 0,
    errorMessage: null,
    configSnapshot: args?.configSnapshot ?? null,
  };
}

/**
 * Update a pipeline run.
 */
export async function updatePipelineRun(
  id: string,
  update: Partial<{
    completedAt: string;
    status: "running" | "completed" | "failed" | "cancelled";
    jobsDiscovered: number;
    jobsProcessed: number;
    errorMessage: string;
    configSnapshot: PipelineRunConfigSnapshot | null;
    resultSummary: PipelineRunResultSummary | null;
  }>,
): Promise<void> {
  const { configSnapshot, resultSummary, ...rest } = update;
  await db
    .update(pipelineRuns)
    .set({
      ...rest,
      ...(Object.hasOwn(update, "configSnapshot")
        ? {
            configSnapshot: serializeConfigSnapshot(configSnapshot ?? null),
          }
        : {}),
      ...(Object.hasOwn(update, "resultSummary")
        ? { resultSummary: resultSummary ?? null }
        : {}),
    })
    .where(eq(pipelineRuns.id, id));
}

/**
 * Get the latest pipeline run.
 */
export async function getLatestPipelineRun(): Promise<PipelineRun | null> {
  const [row] = await db
    .select()
    .from(pipelineRuns)
    .orderBy(desc(pipelineRuns.startedAt))
    .limit(1);

  if (!row) return null;

  return mapRowToPipelineRun(row);
}

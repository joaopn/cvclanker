import { randomUUID } from "node:crypto";
import { db, schema } from "@server/db/index";
import {
  type CreateRunScheduleInput,
  RUN_SCHEDULE_STATUSES,
  type RunSchedule,
  type RunScheduleStatus,
  type UpdateRunScheduleInput,
} from "@shared/types";
import { asc, eq } from "drizzle-orm";

/**
 * Storage for run schedules. CRUD plus the write-back the tick does after a
 * fire; no cadence maths (that is `services/scheduler/next-fire`) and no
 * decisions about when to run.
 */

type Row = typeof schema.runSchedules.$inferSelect;

function isRunScheduleStatus(value: string | null): value is RunScheduleStatus {
  return (
    value !== null &&
    (RUN_SCHEDULE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Tolerant, like `parseProfileConfig`: a stored JSON column can hold anything a
 * restored snapshot or a hand-edited DB put there, and a read path that throws
 * takes the whole list down with it.
 */
function parseStringList(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

/**
 * A stored weekday mask.
 *
 * An empty result is PRESERVED rather than collapsed to null: null means "every
 * day" and `[]` means "no day", so folding one into the other would turn a user
 * who unticked every weekday into a schedule that runs daily. Unreadable JSON
 * still falls back to null — the column's own default — because a value that
 * was never a list says nothing about which days were wanted.
 */
function parseDayList(value: string | null): number[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry): entry is number =>
        typeof entry === "number" && Number.isInteger(entry),
    );
  } catch {
    return null;
  }
}

function mapRow(row: Row): RunSchedule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    cadenceKind: row.cadenceKind,
    intervalHours: row.intervalHours,
    timeOfDay: row.timeOfDay,
    daysOfWeek: parseDayList(row.daysOfWeek),
    // A corrupt list reads as "no profiles", which the run assembly refuses
    // loudly, rather than as a silent partial chain.
    profileIds: parseStringList(row.profileIds) ?? [],
    sourceMode: row.sourceMode,
    sources: parseStringList(row.sources),
    providerInstanceIds: parseStringList(row.providerInstanceIds),
    scrapeWindowDays: row.scrapeWindowDays,
    scrapeSinceLastRun: row.scrapeSinceLastRun,
    enableAutoTailoring: row.enableAutoTailoring,
    autoResolveDuplicates: row.autoResolveDuplicates,
    nextFireAt: row.nextFireAt,
    lastFiredAt: row.lastFiredAt,
    // Validated, not cast: the column has no CHECK, and handing a client's
    // exhaustive switch a literal outside the union is how a hand-edited row
    // becomes a rendering bug.
    lastStatus: isRunScheduleStatus(row.lastStatus) ? row.lastStatus : null,
    lastDetail: row.lastDetail,
    lastRunId: row.lastRunId,
    lastDuplicatesClosed: row.lastDuplicatesClosed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const serializeList = (value: string[] | number[] | null | undefined) =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * Force an instant column to ISO-8601 UTC.
 *
 * `next_fire_at` is both ORDERED and COMPARED as text, and SQLite compares text
 * lexically — so one `+02:00`-offset write would silently break both. The
 * callers are routes whose zod can only say "a string", so the normalising
 * happens here rather than being asked of every writer. An unparseable value
 * becomes null (not scheduled) rather than a row that sorts anywhere.
 */
function normalizeInstant(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Every schedule, soonest fire first.
 *
 * SQLite sorts NULLs FIRST, so a schedule with no computed fire leads the list.
 * That is deliberate: it is the one the caller most needs to look at, because
 * it cannot be due until something computes a target for it.
 */
export async function getAllRunSchedules(): Promise<RunSchedule[]> {
  const rows = await db
    .select()
    .from(schema.runSchedules)
    .orderBy(asc(schema.runSchedules.nextFireAt));
  return rows.map(mapRow);
}

export async function getRunSchedule(id: string): Promise<RunSchedule | null> {
  const rows = await db
    .select()
    .from(schema.runSchedules)
    .where(eq(schema.runSchedules.id, id))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createRunSchedule(
  input: CreateRunScheduleInput,
): Promise<RunSchedule> {
  const id = randomUUID();
  // Written explicitly rather than left to `DEFAULT (datetime('now'))`, which
  // stores a SPACE-separated string. `created_at` is the phase anchor an
  // `every_n_hours` cadence is computed from, and `new Date("2026-08-30
  // 12:22:33")` parses in the HOST zone — the same invisible-under-TZ=UTC leak
  // the weekday derivation goes out of its way to avoid. It would also leave
  // two formats in one column, since every later write is ISO.
  const now = new Date().toISOString();
  await db.insert(schema.runSchedules).values({
    id,
    createdAt: now,
    updatedAt: now,
    name: input.name,
    enabled: input.enabled,
    cadenceKind: input.cadenceKind,
    intervalHours: input.intervalHours,
    timeOfDay: input.timeOfDay,
    daysOfWeek: serializeList(input.daysOfWeek),
    profileIds: JSON.stringify(input.profileIds),
    sourceMode: input.sourceMode,
    sources: serializeList(input.sources),
    providerInstanceIds: serializeList(input.providerInstanceIds),
    scrapeWindowDays: input.scrapeWindowDays,
    scrapeSinceLastRun: input.scrapeSinceLastRun,
    enableAutoTailoring: input.enableAutoTailoring,
    autoResolveDuplicates: input.autoResolveDuplicates,
    nextFireAt: normalizeInstant(input.nextFireAt),
  });
  const created = await getRunSchedule(id);
  if (!created) throw new Error("Failed to create run schedule");
  return created;
}

export async function updateRunSchedule(
  id: string,
  updates: UpdateRunScheduleInput,
): Promise<RunSchedule | null> {
  const { daysOfWeek, profileIds, sources, providerInstanceIds, ...rest } =
    updates;
  await db
    .update(schema.runSchedules)
    .set({
      ...rest,
      ...(daysOfWeek !== undefined
        ? { daysOfWeek: serializeList(daysOfWeek) }
        : {}),
      ...(profileIds !== undefined
        ? { profileIds: JSON.stringify(profileIds) }
        : {}),
      ...(sources !== undefined ? { sources: serializeList(sources) } : {}),
      ...(providerInstanceIds !== undefined
        ? { providerInstanceIds: serializeList(providerInstanceIds) }
        : {}),
      ...(rest.nextFireAt !== undefined
        ? { nextFireAt: normalizeInstant(rest.nextFireAt) }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.runSchedules.id, id));
  return getRunSchedule(id);
}

export async function deleteRunSchedule(id: string): Promise<void> {
  await db.delete(schema.runSchedules).where(eq(schema.runSchedules.id, id));
}

/** How many duplicate copies the last run's automatic sweep closed. */
export async function recordRunScheduleDuplicates(
  id: string,
  duplicatesClosed: number,
): Promise<void> {
  await db
    .update(schema.runSchedules)
    .set({ lastDuplicatesClosed: duplicatesClosed })
    .where(eq(schema.runSchedules.id, id));
}

/**
 * Update just the outcome of the fire already recorded.
 *
 * Separate from `recordRunScheduleFire` because the chain finishes long after
 * it started: the target was advanced at start time and must not be rewritten
 * from a stale value here.
 */
export async function recordRunScheduleOutcome(
  id: string,
  outcome: { status: RunScheduleStatus; detail?: string | null },
): Promise<void> {
  await db
    .update(schema.runSchedules)
    .set({
      lastStatus: outcome.status,
      lastDetail: outcome.detail ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.runSchedules.id, id));
}

/**
 * Record how a fire went and when the next one is due.
 *
 * `nextFireAt` is written as ISO-8601 UTC because the column is both ordered
 * and compared as text.
 */
export async function recordRunScheduleFire(
  id: string,
  result: {
    firedAt: Date;
    status: RunScheduleStatus;
    detail?: string | null;
    runId?: string | null;
    duplicatesClosed?: number | null;
    nextFireAt: Date | null;
  },
): Promise<void> {
  await db
    .update(schema.runSchedules)
    .set({
      lastFiredAt: result.firedAt.toISOString(),
      lastStatus: result.status,
      lastDetail: result.detail ?? null,
      lastRunId: result.runId ?? null,
      lastDuplicatesClosed: result.duplicatesClosed ?? null,
      nextFireAt: result.nextFireAt?.toISOString() ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.runSchedules.id, id));
}

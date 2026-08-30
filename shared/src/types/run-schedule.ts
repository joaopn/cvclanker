/**
 * A run schedule: what the scheduler fires, and how its last fire went.
 *
 * In `shared/` because the Runs tab reads and writes these; the cadence maths
 * that consumes them stays server-side.
 */

export const RUN_SCHEDULE_CADENCE_KINDS = [
  "every_n_hours",
  "daily_at",
] as const;
export type RunScheduleCadenceKind =
  (typeof RUN_SCHEDULE_CADENCE_KINDS)[number];

export const RUN_SCHEDULE_SOURCE_MODES = [
  "profile",
  "free_only",
  "custom",
] as const;
export type RunScheduleSourceMode = (typeof RUN_SCHEDULE_SOURCE_MODES)[number];

export const RUN_SCHEDULE_STATUSES = ["success", "failed", "skipped"] as const;
export type RunScheduleStatus = (typeof RUN_SCHEDULE_STATUSES)[number];

export interface RunSchedule {
  id: string;
  name: string;
  enabled: boolean;
  cadenceKind: RunScheduleCadenceKind;
  /** `every_n_hours` only. */
  intervalHours: number | null;
  /** `HH:MM`, `daily_at` only. */
  timeOfDay: string | null;
  /** 0 = Sunday. Null means every day. Applies to BOTH cadence kinds. */
  daysOfWeek: number[] | null;
  /** Search-Profile ids, in run order. */
  profileIds: string[];
  sourceMode: RunScheduleSourceMode;
  /** `custom` only; ignored by the other modes. */
  sources: string[] | null;
  /** `custom` only; ignored by the other modes. */
  providerInstanceIds: string[] | null;
  scrapeWindowDays: number | null;
  scrapeSinceLastRun: boolean | null;
  /** Null means "follow the app setting" — the run config's `?? setting`. */
  enableAutoTailoring: boolean | null;
  autoResolveDuplicates: boolean;
  /**
   * When this schedule should next fire, ISO-8601 in UTC.
   *
   * Null means no fire has been computed yet. The tick must compute one rather
   * than reading null as "due now": a schedule re-enabled after a fortnight
   * would otherwise fire the instant it is switched on, which for a schedule
   * driving paid actors is unbudgeted spend from flipping a toggle.
   */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastStatus: RunScheduleStatus | null;
  lastDetail: string | null;
  lastRunId: string | null;
  lastDuplicatesClosed: number | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateRunScheduleInput = Omit<
  RunSchedule,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "nextFireAt"
  | "lastFiredAt"
  | "lastStatus"
  | "lastDetail"
  | "lastRunId"
  | "lastDuplicatesClosed"
> & {
  /**
   * Optional at creation: whoever creates the schedule owns computing the
   * first target (it needs the app's time zone, which storage does not know).
   * Left null the schedule simply never becomes due — deliberately, rather
   * than reading as "due now" and firing a paid run the moment it is saved.
   */
  nextFireAt?: string | null;
};

export type UpdateRunScheduleInput = Partial<
  Omit<RunSchedule, "id" | "createdAt" | "updatedAt">
>;

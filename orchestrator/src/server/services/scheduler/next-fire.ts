/**
 * When a schedule should next run.
 *
 * Pure: no clock, no DB, no settings — every input is a parameter, so the whole
 * thing is testable against a fixed instant. Deliberately in `services/` rather
 * than `shared/`, because `shared/tsconfig.json` excludes shared test files
 * from type-checking and this is the one piece of the feature that most needs
 * its tests type-checked.
 *
 * No date library (that would be a new dependency for one function). Zone maths
 * goes through `Intl.DateTimeFormat`.
 *
 * TOTAL: returns `null` rather than throwing for any input it cannot satisfy —
 * an unknown zone, a malformed time, a mask that admits no day, a non-positive
 * interval. These values come from TEXT columns that a restored snapshot or a
 * hand-edited DB can hold in any shape, and the caller is a `setInterval` where
 * an uncaught throw leaves scheduling silently dead until a restart. Same
 * reasoning as `parseProfileConfig`, which never throws for the same reason.
 */

export type Cadence =
  | {
      kind: "every_n_hours";
      intervalHours: number;
      daysOfWeek: number[] | null;
    }
  | { kind: "daily_at"; timeOfDay: string; daysOfWeek: number[] | null };

export interface NextFireOptions {
  /** The instant to search after. The result is STRICTLY later than this. */
  from: Date;
  /** IANA zone the schedule's wall-clock times and weekdays are expressed in. */
  timeZone: string;
  /**
   * Phase anchor for `every_n_hours` — the schedule's `created_at`.
   *
   * Anchoring on a FIXED point rather than on the last fire is what makes the
   * cadence drift-free: `last_fired_at` lags its target by up to one tick, so
   * anchoring there would add that lag to every subsequent fire, for ever.
   */
  anchor?: Date | null;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/**
 * Ceiling on the weekday-cycle search, for a pathologically small interval.
 * An hourly cadence satisfies any usable mask within 168 slots, so this is
 * only ever reached by a mask nothing can satisfy.
 */
const MAX_CYCLE_SLOTS = 4000;
/**
 * How far ahead the masked-interval search looks, in wall time: over a year,
 * so every DST transition a zone makes falls inside it.
 */
const DST_SEARCH_HORIZON_MS = 400 * MS_PER_DAY;
/**
 * How far `daily_at` will look. A usable mask is satisfied within 7 days (a
 * mask that admits NO day never gets here — `normalizeMask` rejects it up
 * front), so this is pure slack against an unforeseen calendar case rather
 * than the thing that makes the loop terminate.
 */
const MAX_DAY_STEPS = 400;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y > 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * How many slots to try before calling a masked interval unsatisfiable.
 *
 * The weekday pattern repeats after `7 days / gcd(step, 7 days)` slots while
 * the zone's offset holds — but a DST change moves every later slot by an hour,
 * which can make a weekday reachable that the arithmetic says never occurs.
 * Measured: "every 28 hours, Sundays only" in America/New_York has a six-slot
 * cycle that never lands on Sunday, until the November transition shifts it
 * and it does. So the search also covers a year of wall time, which is enough
 * to include every transition a zone makes.
 */
function weekdayCycleSlots(step: number): number {
  const stepMs = Math.max(1, Math.round(step));
  const cycle = Math.ceil(MS_PER_WEEK / gcd(stepMs, MS_PER_WEEK)) + 8;
  const aYearOfSlots = Math.ceil(DST_SEARCH_HORIZON_MS / stepMs);
  return Math.min(MAX_CYCLE_SLOTS, Math.max(cycle, aYearOfSlots));
}

/**
 * A Date, or null when the arithmetic left the range a Date can hold.
 *
 * `new Date(huge)` is an Invalid Date whose `toISOString()` THROWS, and the
 * repository writes this value straight into a column — so an absurd interval
 * (a restored snapshot, a hand-edited row) would take down the tick that this
 * module promises never to throw from.
 */
function finiteDate(instant: number): Date | null {
  const date = new Date(instant);
  return Number.isFinite(date.getTime()) ? date : null;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * `hourCycle: "h23"` rather than `hour12: false`: the latter can yield hour
 * "24" at midnight in some locales, silently shifting a midnight schedule.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    // An unknown zone throws RangeError here. The schedule cannot fire.
    return null;
  }
}

function wallClockAt(
  formatter: Intl.DateTimeFormat,
  instant: number,
): WallClock {
  const parts = formatter.formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : Number.NaN;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** How far the zone is ahead of UTC at a given instant, in ms. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const wall = wallClockAt(formatter, instant);
  return (
    Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    ) - instant
  );
}

/**
 * The instant at which a given wall clock occurs in the zone.
 *
 * Candidate-and-verify, NOT the guess-and-correct two-pass that suggests
 * itself: measured against Europe/Vienna, that two-pass answers a fall-back
 * ambiguity with the SECOND occurrence and a spring-forward gap with an instant
 * an hour past the gap — the opposite of both rules below. So both candidates
 * (the offsets either side of a possible transition) are formatted back, and
 * only those that really produce the requested wall clock are kept.
 *
 * - Ambiguous (the clock ran through this time twice): the FIRST occurrence.
 * - Nonexistent (the clock jumped over it): the requested wall clock SHIFTED
 *   FORWARD BY THE WIDTH OF THE GAP — the instant it would have been under the
 *   pre-transition offset. Measured across 18 zones: an hour later in most,
 *   half an hour on Australia/Lord_Howe, two on Antarctica/Troll, always
 *   forward, never earlier than asked. Not "the gap's near edge": only a
 *   request landing on the gap's first minute resolves there. The run happens
 *   once, later on the wall clock than asked, one day a year — skipping the day
 *   would lose a scrape instead.
 */
function instantForWallClock(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const before = naive - offsetAt(formatter, naive - MS_PER_DAY);
  const after = naive - offsetAt(formatter, naive + MS_PER_DAY);

  const verified: number[] = [];
  for (const candidate of before === after ? [before] : [before, after]) {
    const wall = wallClockAt(formatter, candidate);
    if (
      wall.year === year &&
      wall.month === month &&
      wall.day === day &&
      wall.hour === hour &&
      wall.minute === minute
    ) {
      verified.push(candidate);
    }
  }
  if (verified.length > 0) return Math.min(...verified);
  // The gap. `before` carries the PRE-transition offset, so it lands the width
  // of the gap past the requested wall clock; `after` would land before the
  // gap, i.e. earlier than the time the user asked for.
  return before;
}

/**
 * The weekday (0 = Sunday, matching `Date.getDay()`) of a wall-clock date.
 *
 * Derived from the DATE FIELDS, never from `date.getDay()` — that reads the
 * HOST zone. The container runs `TZ=Etc/UTC`, so such a leak would be invisible
 * both here and in production, and would misfire only for someone running the
 * image with `TZ` set.
 */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `null` = every day; `false` = a mask that admits nothing, so never. */
function normalizeMask(daysOfWeek: number[] | null): number[] | null | false {
  if (daysOfWeek === null || daysOfWeek === undefined) return null;
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return false;
  const days = daysOfWeek.filter(
    (day) => Number.isInteger(day) && day >= 0 && day <= 6,
  );
  return days.length > 0 ? days : false;
}

function parseTimeOfDay(
  timeOfDay: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeOfDay ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function nextFireAt(
  cadence: Cadence,
  options: NextFireOptions,
): Date | null {
  const from = options.from.getTime();
  if (!Number.isFinite(from)) return null;

  const formatter = zoneFormatter(options.timeZone);
  if (!formatter) return null;

  const mask = normalizeMask(cadence.daysOfWeek);
  if (mask === false) return null;

  const allowed = (instant: number): boolean => {
    if (mask === null) return true;
    const wall = wallClockAt(formatter, instant);
    return mask.includes(weekdayOf(wall.year, wall.month, wall.day));
  };

  if (cadence.kind === "every_n_hours") {
    const { intervalHours } = cadence;
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null;
    const step = intervalHours * MS_PER_HOUR;
    const anchorMs = options.anchor?.getTime();
    const base =
      anchorMs !== undefined && Number.isFinite(anchorMs) ? anchorMs : from;
    // Arithmetic, not iteration: a schedule anchored six months ago at one-hour
    // intervals would otherwise step ~4,400 times on every pass.
    const steps = Math.max(1, Math.floor((from - base) / step) + 1);
    let candidate = base + steps * step;
    // An invariant assertion, not a branch any test reaches: `floor(x) + 1 > x`
    // holds in exact arithmetic, and a sweep over six zones and six cadences
    // (fractional intervals included) never takes this. It stays because the
    // quotient is a double — for a fractional interval a value a hair under a
    // whole number floors one slot short, and the result would be the slot the
    // tick just fired, which loops for ever.
    if (candidate <= from) candidate += step;
    // The mask filters slots rather than shifting them, so the cadence keeps
    // its phase across a skipped day.
    //
    // The bound is the length of the WEEKDAY CYCLE in slots, not the number of
    // slots in a week. Once the interval exceeds a day the weekday advances by
    // more than one per slot, so "a week of slots" gives up before the first
    // allowed weekday and reports a perfectly good schedule as unsatisfiable —
    // "every 3 days, Mondays only" would simply never fire. The weekday
    // sequence repeats after `7 days / gcd(step, 7 days)` slots, which is 1
    // when the interval is a whole week (only one weekday is ever reachable,
    // so an excluded one really is never) and 168 for an hourly cadence.
    const cycleSlots = weekdayCycleSlots(step);
    for (let i = 0; i < cycleSlots; i += 1) {
      if (allowed(candidate)) return finiteDate(candidate);
      candidate += step;
    }
    return null;
  }

  const time = parseTimeOfDay(cadence.timeOfDay);
  if (!time) return null;

  // Stepping the LOCAL CALENDAR DATE, not the instant: a `+24h` instant step
  // across a DST boundary lands an hour either side of the target wall clock,
  // which then never matches.
  const start = wallClockAt(formatter, from);
  let { year, month, day } = start;
  if (!Number.isFinite(year)) return null;
  for (let i = 0; i < MAX_DAY_STEPS; i += 1) {
    if (mask === null || mask.includes(weekdayOf(year, month, day))) {
      const candidate = instantForWallClock(
        formatter,
        year,
        month,
        day,
        time.hour,
        time.minute,
      );
      if (candidate > from) return finiteDate(candidate);
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return null;
}

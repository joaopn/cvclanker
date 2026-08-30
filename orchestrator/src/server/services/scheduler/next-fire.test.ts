// @vitest-environment node

import { describe, expect, it } from "vitest";
import { type Cadence, nextFireAt } from "./next-fire";

const at = (iso: string) => new Date(iso);
const iso = (value: Date | null) => value?.toISOString() ?? null;

const everyHours = (
  intervalHours: number,
  daysOfWeek: number[] | null = null,
): Cadence => ({ kind: "every_n_hours", intervalHours, daysOfWeek });

const dailyAt = (
  timeOfDay: string,
  daysOfWeek: number[] | null = null,
): Cadence => ({ kind: "daily_at", timeOfDay, daysOfWeek });

describe("nextFireAt — every N hours", () => {
  const anchor = at("2026-08-30T00:00:00.000Z");

  it("keeps the anchor's phase rather than drifting from the last fire", () => {
    // Firing is always a little late; anchoring on the ACTUAL fire would add
    // that lateness to every slot after it, for ever.
    expect(
      iso(
        nextFireAt(everyHours(6), {
          from: at("2026-08-30T06:04:37.000Z"),
          timeZone: "UTC",
          anchor,
        }),
      ),
    ).toBe("2026-08-30T12:00:00.000Z");
  });

  it("returns an instant STRICTLY after a `from` sitting exactly on a slot", () => {
    // The tick calls this with the target that just came due. Returning that
    // same instant would re-fire the slot it just handled, for ever.
    expect(
      iso(
        nextFireAt(everyHours(6), {
          from: at("2026-08-30T06:00:00.000Z"),
          timeZone: "UTC",
          anchor,
        }),
      ),
    ).toBe("2026-08-30T12:00:00.000Z");
  });

  it("catches up ONCE after a long outage instead of backfilling", () => {
    // 40 days down at hourly cadence: the next fire is the next future slot,
    // not the ~960 that were missed.
    expect(
      iso(
        nextFireAt(everyHours(1), {
          from: at("2026-10-09T05:30:00.000Z"),
          timeZone: "UTC",
          anchor,
        }),
      ),
    ).toBe("2026-10-09T06:00:00.000Z");
  });

  it("falls back to `from` when no anchor is stored", () => {
    expect(
      iso(
        nextFireAt(everyHours(3), {
          from: at("2026-08-30T07:15:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-08-30T10:15:00.000Z");
  });

  it("steps a fixed UTC duration across a DST transition, not a wall-clock hour", () => {
    // Vienna's clocks go forward at 01:00Z. Twelve hours after 20:00Z is
    // 08:00Z whatever the wall clock did in between.
    expect(
      iso(
        nextFireAt(everyHours(12), {
          from: at("2026-03-28T21:00:00.000Z"),
          timeZone: "Europe/Vienna",
          anchor: at("2026-03-28T20:00:00.000Z"),
        }),
      ),
    ).toBe("2026-03-29T08:00:00.000Z");
  });

  it("filters slots by the weekday mask without shifting the phase", () => {
    // Sunday 2026-08-30 is excluded; the Monday slots keep the same phase.
    expect(
      iso(
        nextFireAt(everyHours(6, [1, 2, 3, 4, 5]), {
          from: at("2026-08-30T06:04:00.000Z"),
          timeZone: "UTC",
          anchor,
        }),
      ),
    ).toBe("2026-08-31T00:00:00.000Z");
  });

  it("evaluates the mask in the schedule's zone, not UTC", () => {
    // 2026-08-31T22:30Z is still Monday in UTC but already Tuesday in Auckland,
    // so a Monday-only schedule must NOT fire at the 23:00Z slot.
    const mondayOnly = nextFireAt(everyHours(1, [1]), {
      from: at("2026-08-31T22:30:00.000Z"),
      timeZone: "Pacific/Auckland",
      anchor: at("2026-08-31T00:00:00.000Z"),
    });
    // Monday in Auckland resumes a week later.
    expect(iso(mondayOnly)).toBe("2026-09-06T12:00:00.000Z");
  });

  it("refuses an interval that could never terminate", () => {
    // The large-finite cases are the ones that do NOT throw here but produce
    // an Invalid Date, whose `toISOString()` throws in the repository writing
    // the result back — from inside the tick this module promises never to
    // throw out of.
    for (const interval of [
      0,
      -6,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_400_000_000,
      1e300,
      Number.MAX_VALUE,
    ]) {
      expect(
        nextFireAt(everyHours(interval), {
          from: at("2026-08-30T00:00:00.000Z"),
          timeZone: "UTC",
          anchor,
        }),
      ).toBeNull();
    }
  });
});

describe("nextFireAt — daily at a wall-clock time", () => {
  it("fires later today when the time is still ahead", () => {
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-08-30T03:00:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-08-30T06:00:00.000Z");
  });

  it("rolls to tomorrow once today's time has passed", () => {
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-08-30T06:00:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-08-31T06:00:00.000Z");
  });

  it("holds the wall-clock time across a DST change rather than the offset", () => {
    // 06:00 Vienna is 05:00Z in winter and 04:00Z in summer.
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-03-28T12:00:00.000Z"),
          timeZone: "Europe/Vienna",
        }),
      ),
    ).toBe("2026-03-29T04:00:00.000Z");
  });

  it("fires the FIRST of two occurrences when the clock repeats an hour", () => {
    // Vienna falls back at 01:00Z: local 02:30 happens at 00:30Z and again at
    // 01:30Z. The guess-and-correct two-pass answers 01:30Z here, which is why
    // this module verifies its candidates instead.
    expect(
      iso(
        nextFireAt(dailyAt("02:30"), {
          from: at("2026-10-25T00:00:00.000Z"),
          timeZone: "Europe/Vienna",
        }),
      ),
    ).toBe("2026-10-25T00:30:00.000Z");
  });

  it("fires just past the gap when the clock skips the hour entirely", () => {
    // Vienna springs forward at 01:00Z; local 02:30 never happens that day.
    // The run still happens, once, a little later on the wall clock.
    expect(
      iso(
        nextFireAt(dailyAt("02:30"), {
          from: at("2026-03-29T00:00:00.000Z"),
          timeZone: "Europe/Vienna",
        }),
      ),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("handles a zone whose offset is not a whole number of hours", () => {
    // Asia/Kolkata is +05:30 year-round.
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-08-30T00:00:00.000Z"),
          timeZone: "Asia/Kolkata",
        }),
      ),
    ).toBe("2026-08-30T00:30:00.000Z");
  });

  it("handles a zone whose standard offset is not a whole hour", () => {
    // Australia/Lord_Howe sits at +10:30 outside DST.
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-08-30T00:00:00.000Z"),
          timeZone: "Australia/Lord_Howe",
        }),
      ),
    ).toBe("2026-08-30T19:30:00.000Z");
  });

  it("shifts by the gap when a zone's DST jump is only half an hour", () => {
    // Lord Howe springs forward THIRTY minutes on 2026-10-04, so local 02:15
    // does not exist and the fire shifts by exactly that half hour — the gap
    // policy has to follow the zone's own jump, not assume an hour.
    expect(
      iso(
        nextFireAt(dailyAt("02:15"), {
          from: at("2026-10-03T00:00:00.000Z"),
          timeZone: "Australia/Lord_Howe",
        }),
      ),
    ).toBe("2026-10-03T15:45:00.000Z");
  });

  it("crosses a southern-hemisphere transition, where DST runs the other way", () => {
    // Auckland ENDS daylight saving on 2026-04-05, going +13 -> +12, so the
    // same 06:00 local costs an hour more UTC on the far side. A zone-blind
    // implementation that held the OFFSET rather than the wall clock would
    // answer 16:00Z here.
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-04-04T20:00:00.000Z"),
          timeZone: "Pacific/Auckland",
        }),
      ),
    ).toBe("2026-04-05T18:00:00.000Z");
  });

  it("skips to the next allowed weekday", () => {
    // 2026-08-30 is a Sunday; a Monday-only schedule waits a day.
    expect(
      iso(
        nextFireAt(dailyAt("06:00", [1]), {
          from: at("2026-08-30T00:00:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-08-31T06:00:00.000Z");
  });

  it("waits a full week when today is the only allowed day but its time has gone", () => {
    expect(
      iso(
        nextFireAt(dailyAt("06:00", [1]), {
          from: at("2026-08-31T09:00:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-09-07T06:00:00.000Z");
  });

  it("catches up to ONE future slot after a long outage", () => {
    expect(
      iso(
        nextFireAt(dailyAt("06:00"), {
          from: at("2026-10-09T09:00:00.000Z"),
          timeZone: "UTC",
        }),
      ),
    ).toBe("2026-10-10T06:00:00.000Z");
  });

  it("evaluates the weekday in the schedule's zone near local midnight", () => {
    // 2026-08-30T22:00Z is Sunday in UTC but already Monday in Auckland, so a
    // Monday-only schedule fires that same UTC day.
    expect(
      iso(
        nextFireAt(dailyAt("06:00", [1]), {
          from: at("2026-08-30T00:00:00.000Z"),
          timeZone: "Pacific/Auckland",
        }),
      ),
    ).toBe("2026-08-30T18:00:00.000Z");
  });
});

describe("nextFireAt — inputs it cannot satisfy", () => {
  const from = at("2026-08-30T00:00:00.000Z");

  it("returns null rather than throwing on an unknown zone", () => {
    // An unknown zone makes `Intl.DateTimeFormat` throw a RangeError, and the
    // caller is a setInterval where that would kill scheduling until restart.
    expect(
      nextFireAt(dailyAt("06:00"), { from, timeZone: "Not/AZone" }),
    ).toBeNull();
  });

  it("returns null on a malformed time of day", () => {
    for (const value of ["6:00", "0600", "25:00", "06:61", "", "abc"]) {
      expect(nextFireAt(dailyAt(value), { from, timeZone: "UTC" })).toBeNull();
    }
  });

  it("returns null on a mask that admits no weekday", () => {
    for (const mask of [[], [7], [-1], [1.5]]) {
      expect(
        nextFireAt(dailyAt("06:00", mask), { from, timeZone: "UTC" }),
      ).toBeNull();
      expect(
        nextFireAt(everyHours(6, mask), { from, timeZone: "UTC" }),
      ).toBeNull();
    }
  });

  it("returns null on an invalid `from`", () => {
    expect(
      nextFireAt(dailyAt("06:00"), {
        from: new Date(Number.NaN),
        timeZone: "UTC",
      }),
    ).toBeNull();
  });

  it("ignores out-of-range entries in an otherwise usable mask", () => {
    expect(
      iso(nextFireAt(dailyAt("06:00", [1, 9]), { from, timeZone: "UTC" })),
    ).toBe("2026-08-31T06:00:00.000Z");
  });
});

describe("nextFireAt — properties that must hold everywhere", () => {
  const zones = [
    "UTC",
    "Europe/Vienna",
    "Pacific/Auckland",
    "Asia/Kolkata",
    "Australia/Lord_Howe",
    "America/Santiago",
  ];
  const cadences: Cadence[] = [
    everyHours(1),
    everyHours(6),
    everyHours(5, [1, 3, 5]),
    // Long intervals WITH a mask are the case a slot bound counted in "slots
    // per week" silently reports as unsatisfiable: past 24h the weekday
    // advances by more than one per slot, so the search gives up before the
    // first allowed day and a perfectly good schedule never fires.
    everyHours(48, [3]),
    everyHours(72, [1]),
    everyHours(25, [0]),
    // Fractional intervals are where the slot arithmetic can round a hair
    // short of a whole slot, which is the one case the strictly-after guard
    // in the implementation exists for.
    everyHours(0.5),
    everyHours(1.5),
    everyHours(0.1),
    dailyAt("00:00"),
    dailyAt("06:00"),
    dailyAt("23:59", [0, 6]),
  ];

  it("always returns an instant strictly after `from`", () => {
    // A single result at or before `from` is an infinite re-fire loop in the
    // tick, so this sweeps a year of starting points rather than trusting the
    // handful of cases above.
    const anchor = at("2026-01-01T00:00:00.000Z");
    for (const timeZone of zones) {
      for (const cadence of cadences) {
        for (let day = 0; day < 366; day += 7) {
          for (const minutes of [0, 37, 90, 750, 1439]) {
            const from = new Date(
              anchor.getTime() + day * 86_400_000 + minutes * 60_000,
            );
            const next = nextFireAt(cadence, { from, timeZone, anchor });
            expect(next).not.toBeNull();
            expect((next as Date).getTime()).toBeGreaterThan(from.getTime());
          }
        }
      }
    }
  });

  it("never moves backwards as `from` moves forwards", () => {
    const anchor = at("2026-01-01T00:00:00.000Z");
    for (const timeZone of zones) {
      for (const cadence of cadences) {
        let previous = 0;
        for (let step = 0; step < 400; step += 1) {
          const from = new Date(anchor.getTime() + step * 3_600_000 * 5);
          const next = nextFireAt(cadence, { from, timeZone, anchor });
          const value = (next as Date).getTime();
          expect(value).toBeGreaterThanOrEqual(previous);
          previous = value;
        }
      }
    }
  });
});

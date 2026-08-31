/**
 * Pure formatting helpers for the Stats surface.
 *
 * Kept out of the components so the rules that decide what a number LOOKS like
 * — above all, when a number should not be shown at all — can be tested without
 * rendering anything.
 */

/**
 * A share, or a dash when there is nothing to take a share of.
 *
 * Returning "0%" for an empty denominator is the failure this exists to
 * prevent: on a stats page "0% good fit" reads as a measured verdict about a
 * source, when the truth is that nothing has been scored yet.
 */
export function percent(part: number, whole: number, digits = 0): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return "—";
  }
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** A bar width in percent, clamped so a value above its reference cannot overflow. */
export function barWidth(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/** `1,234`, using the viewer's locale grouping. */
export function count(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/** `9d`, or `—` when there is no measurement. */
export function days(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value}d`;
}

/**
 * `12 Aug` for an ISO date. These are UTC days, bucketed server-side by
 * SQLite, so the label is built from the UTC fields rather than the viewer's
 * local ones — formatting `2026-08-12` as a local date shows 11 Aug to anyone
 * west of Greenwich.
 */
export function dayLabel(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return `${parsed.getUTCDate()} ${
    [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ][parsed.getUTCMonth()]
  }`;
}

/**
 * Five heat steps for the activity strip. Step 0 means "nothing happened",
 * which must stay visually distinct from "a little happened" — so a non-zero
 * count never returns 0 however small it is next to the busiest day.
 */
export function heatStep(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** Pluralise a count: `1 job`, `2 jobs`, `0 jobs`. */
export function plural(value: number, singular: string, suffix = "s"): string {
  return `${count(value)} ${singular}${value === 1 ? "" : suffix}`;
}

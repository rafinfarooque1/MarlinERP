/**
 * Local-calendar date helpers.
 *
 * NEVER derive a business date from `toISOString()` — it converts to UTC, so
 * in India (UTC+5:30) every local time before 05:30 lands on YESTERDAY's date.
 * Sale dates, "today" filters and date arithmetic must all stay in the
 * device's local calendar.
 */

/** Format a Date as local YYYY-MM-DD. */
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a YYYY-MM-DD string by whole days, in local calendar time. */
export function shiftYmd(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00`);
  dt.setDate(dt.getDate() + days);
  return localYmd(dt);
}

import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * The ONE rule that turns a day's attendance into a fraction of a day's pay.
 *
 * This used to live inline inside `POST /hr/payroll/generate`, which meant the
 * daily accrual engine had no way to ask "what was this day worth?" and instead
 * charged a flat `monthly_salary / days_in_month` for every calendar day. The
 * books therefore recognised a full day's salary for days the employee was
 * absent, and only month-end approval corrected it.
 *
 * Extracting it here is the point of the change, not a tidy-up: payroll and
 * accrual must answer that question identically or the month-end true-up stops
 * being a rounding difference and becomes a real, unexplainable adjustment.
 * There is exactly one implementation, and both callers use it.
 *
 * The rule itself is unchanged from what payroll has always applied — no new
 * thresholds are invented here.
 */

export interface AttendanceThresholds {
  fullDayHours: number;
  halfDayHours: number;
}

/** Falls back to a 9-hour full day / 4.5-hour half day, as payroll always has. */
export const ATTENDANCE_THRESHOLD_DEFAULTS: AttendanceThresholds = {
  fullDayHours: 9,
  halfDayHours: 4.5,
};

/** The subset of an attendance row the rule actually reads. */
export interface AttendanceDay {
  status?: string | null;
  checkIn?: Date | string | null;
  checkOut?: Date | string | null;
  /**
   * Total hours across the day's CLOSED punch pairs, when the day has punch
   * rows at all. A day can now hold several work sessions, and first-in →
   * last-out overstates it (the span includes the breaks between sessions), so
   * when this figure exists it replaces the span. Null/undefined — the day has
   * no punch rows — falls back to the span, which is what keeps every
   * pre-punch attendance row worth exactly what it always was.
   */
  punchedHours?: number | string | null;
}

/**
 * SQL fragment: total closed-punch hours per (employee, date). Every reader of
 * attendance that feeds `dayFactor` must LEFT JOIN this on its attendance
 * alias, or payroll, the accrual and the register would disagree about what a
 * multi-punch day is worth. Usage:
 *   `... FROM attendance a ${PUNCHED_HOURS_JOIN("a")} ...`
 * then select `ap.punched_hours AS "punchedHours"`.
 */
export const PUNCHED_HOURS_JOIN = (attAlias: string) => `
  LEFT JOIN (
    SELECT employee_id, date,
           SUM(EXTRACT(EPOCH FROM (punch_out - punch_in)) / 3600.0) AS punched_hours
      FROM attendance_punches
     WHERE punch_out IS NOT NULL
     GROUP BY employee_id, date
  ) ap ON ap.employee_id = ${attAlias}.employee_id AND ap.date = ${attAlias}.date`;

export async function loadAttendanceThresholds(pool: Pool): Promise<AttendanceThresholds> {
  const { rows: [row] } = await pool.query(
    `SELECT general_settings FROM company_settings LIMIT 1`,
  );
  const gs = (row?.general_settings as Record<string, any>) ?? {};
  return {
    fullDayHours: Number(gs.fullDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.fullDayHours),
    halfDayHours: Number(gs.halfDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.halfDayHours),
  };
}

/**
 * What one day of attendance is worth, as a fraction of a paid day.
 *
 * `undefined` — no attendance row for that date — is 0, matching payroll: its
 * present-day total sums over the rows that exist, so a day with no row has
 * never contributed anything. See `monthHasAttendance` for the one case where a
 * missing row means "not tracked" rather than "absent".
 */
export function dayFactor(
  a: AttendanceDay | undefined | null,
  t: AttendanceThresholds,
): number {
  if (!a) return 0;
  // Approved leave is paid, so it earns a full day without a check-in.
  if (a.status === "leave") return 1;
  if (a.checkIn && a.checkOut) {
    // Total punched hours when the day has punch rows (breaks excluded);
    // first-in → last-out span otherwise. See AttendanceDay.punchedHours.
    const hrs = a.punchedHours != null
      ? Number(a.punchedHours)
      : (new Date(a.checkOut).getTime() - new Date(a.checkIn).getTime()) / 3_600_000;
    if (hrs >= t.fullDayHours) return 1;
    if (hrs >= t.halfDayHours) return 0.5;
    return 0; // under the half-day threshold — loss of pay
  }
  // Checked in but not yet out: the day is still open, so it is provisionally
  // whole. Check-out re-evaluates it against the hours actually worked.
  if (a.checkIn) return 1;
  if (a.status === "present") return 1;
  if (a.status === "half_day") return 0.5;
  return 0; // absent
}

/**
 * Does this employee-month have attendance at all?
 *
 * Payroll's rule is all-or-nothing per month: a month with no attendance rows
 * whatsoever is treated as full attendance, because the business is not
 * tracking that employee rather than because they never turned up. As soon as
 * ONE row exists for the month, the month is considered tracked and every day
 * is judged on its own row — a day with no row is then genuinely absent.
 *
 * The accrual engine has to apply the same test, or a single check-in on the
 * 3rd would leave the other 30 days of an untracked month unpaid.
 */
export function monthHasAttendance(rowsInMonth: readonly AttendanceDay[]): boolean {
  return rowsInMonth.length > 0;
}

/**
 * Paid days for a whole month — the figure payroll feeds to `computePayroll`
 * as `presentDays`.
 */
export function monthPresentDays(
  rowsInMonth: readonly AttendanceDay[],
  workingDays: number,
  t: AttendanceThresholds,
): number {
  if (!monthHasAttendance(rowsInMonth)) return workingDays; // not tracked → full attendance
  let pd = 0;
  for (const a of rowsInMonth) pd += dayFactor(a, t);
  return pd;
}

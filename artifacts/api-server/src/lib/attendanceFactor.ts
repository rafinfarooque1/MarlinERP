import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * The ONE rule that turns a day's attendance into pay.
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
 * Since Aug 2026 the rule is a company-wide LEAVE POLICY, not just an hours
 * threshold: a day decomposes into a WORKED fraction and a LEAVE fraction
 * (`dayContribution`), and the month-level summary (`monthLeaveSummary`)
 * applies the paid-casual-leave allowance — leave within the allowance is
 * paid, leave beyond it is loss of pay.
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

/**
 * Company-wide payroll leave policy.
 *
 * Stored as keys of `company_settings.general_settings` (JSONB), so future
 * leave types — sick leave, earned leave, maternity/paternity, comp off,
 * department-specific policies — are new keys (or a nested object) on the same
 * blob plus code, never a schema redesign. Every employee is priced on the
 * company policy; per-employee overrides would be a future policy layer read
 * in `loadPayrollSettings`, not a different formula.
 */
export interface PayrollLeavePolicy {
  /** Working-days-per-month basis: per-day pay = monthly salary / this. 1–31. */
  workingDays: number;
  /** Casual-leave days paid per month before loss of pay starts. */
  paidCasualLeavesPerMonth: number;
  /** OFF = attendance never reduces pay (no LOP deduction at all). */
  lopEnabled: boolean;
}

export const PAYROLL_POLICY_DEFAULTS: PayrollLeavePolicy = {
  workingDays: 30,
  paidCasualLeavesPerMonth: 4,
  lopEnabled: true,
};

export interface PayrollSettings {
  thresholds: AttendanceThresholds;
  policy: PayrollLeavePolicy;
}

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
 * attendance that feeds `dayContribution` must LEFT JOIN this on its attendance
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
  return (await loadPayrollSettings(pool)).thresholds;
}

/**
 * Thresholds + leave policy in one read, from `company_settings.general_settings`.
 *
 * Values are sanitised here, once, so no caller prices a month on a malformed
 * setting: working days clamps to 1–31 (integer), the allowance to 0–workingDays.
 */
export async function loadPayrollSettings(pool: Pool): Promise<PayrollSettings> {
  const { rows: [row] } = await pool.query(
    `SELECT general_settings FROM company_settings LIMIT 1`,
  );
  const gs = (row?.general_settings as Record<string, any>) ?? {};
  const wdRaw = Number(gs.payrollWorkingDays ?? PAYROLL_POLICY_DEFAULTS.workingDays);
  const workingDays = Number.isFinite(wdRaw)
    ? Math.min(31, Math.max(1, Math.round(wdRaw)))
    : PAYROLL_POLICY_DEFAULTS.workingDays;
  const plRaw = Number(gs.paidCasualLeavesPerMonth ?? PAYROLL_POLICY_DEFAULTS.paidCasualLeavesPerMonth);
  // Both branches clamp to workingDays — the DEFAULT allowance (4) can exceed
  // a small working-days setting (e.g. 1), and the 0..workingDays invariant
  // must hold whatever garbage the blob carries.
  const paidCasualLeavesPerMonth = Math.min(
    workingDays,
    Math.max(0, Number.isFinite(plRaw) ? plRaw : PAYROLL_POLICY_DEFAULTS.paidCasualLeavesPerMonth),
  );
  return {
    thresholds: {
      fullDayHours: Number(gs.fullDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.fullDayHours),
      halfDayHours: Number(gs.halfDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.halfDayHours),
    },
    policy: {
      workingDays,
      paidCasualLeavesPerMonth,
      lopEnabled: gs.lopEnabled === undefined ? PAYROLL_POLICY_DEFAULTS.lopEnabled : gs.lopEnabled !== false,
    },
  };
}

/** How one day of attendance splits into worked time and casual leave taken. */
export interface DayContribution {
  /** Fraction of a day actually worked (0, 0.5 or 1). */
  work: number;
  /**
   * Fraction of a day of casual leave taken (0, 0.5 or 1). Counts against the
   * monthly paid-leave allowance; within the allowance it is paid, beyond it
   * it becomes loss of pay.
   */
  leave: number;
}

/**
 * Decompose one day of attendance.
 *
 * `undefined` — no attendance row for that date — is `{0, 0}`: neither worked
 * nor leave, so in a tracked month it is straight loss of pay and does NOT
 * consume the paid-leave allowance. Approved leave is `{0, 1}`. A half day is
 * `{0.5, 0.5}` — the missing half counts as half a day of casual leave (owner's
 * rule), so it is paid while the allowance lasts. A worked day under the
 * half-day hours threshold is `{0, 0}`: too short to count as work, and never
 * requested as leave, so it is loss of pay outright.
 */
export function dayContribution(
  a: AttendanceDay | undefined | null,
  t: AttendanceThresholds,
): DayContribution {
  if (!a) return { work: 0, leave: 0 };
  // Approved leave: a full day of casual leave, paid if the allowance covers it.
  if (a.status === "leave") return { work: 0, leave: 1 };
  if (a.checkIn && a.checkOut) {
    // Total punched hours when the day has punch rows (breaks excluded);
    // first-in → last-out span otherwise. See AttendanceDay.punchedHours.
    const hrs = a.punchedHours != null
      ? Number(a.punchedHours)
      : (new Date(a.checkOut).getTime() - new Date(a.checkIn).getTime()) / 3_600_000;
    if (hrs >= t.fullDayHours) return { work: 1, leave: 0 };
    if (hrs >= t.halfDayHours) return { work: 0.5, leave: 0.5 };
    return { work: 0, leave: 0 }; // under the half-day threshold — loss of pay
  }
  // Checked in but not yet out: the day is still open, so it is provisionally
  // whole. Check-out re-evaluates it against the hours actually worked.
  if (a.checkIn) return { work: 1, leave: 0 };
  if (a.status === "present") return { work: 1, leave: 0 };
  if (a.status === "half_day") return { work: 0.5, leave: 0.5 };
  return { work: 0, leave: 0 }; // absent
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

/** Month-level outcome of the leave policy — what payroll pays and shows. */
export interface MonthLeaveSummary {
  /** Whether the month had any attendance rows (untracked = full attendance). */
  tracked: boolean;
  /** Days actually worked (sum of worked fractions). */
  workedDays: number;
  /** Casual leave taken (leave days + half-day halves). */
  leaveTaken: number;
  /** Leave paid under the allowance: min(leaveTaken, allowance). */
  paidLeaveUsed: number;
  /** Days the salary is paid for — feeds computePayroll as presentDays. */
  payableDays: number;
  /** Days lost to LOP: workingDays − payableDays (0 when LOP is disabled). */
  lopDays: number;
}

/**
 * Apply the leave policy to a whole month of attendance.
 *
 *   payableDays = min(workingDays, worked + min(leaveTaken, allowance))
 *   lopDays     = max(0, workingDays − payableDays)
 *
 * With LOP disabled the month is always payable in full — the worked/leave
 * figures are still reported honestly for display. An untracked month is full
 * attendance, exactly as payroll has always treated it.
 */
export function monthLeaveSummary(
  rowsInMonth: readonly AttendanceDay[],
  policy: PayrollLeavePolicy,
  t: AttendanceThresholds,
): MonthLeaveSummary {
  const wd = policy.workingDays;
  if (!monthHasAttendance(rowsInMonth)) {
    return { tracked: false, workedDays: wd, leaveTaken: 0, paidLeaveUsed: 0, payableDays: wd, lopDays: 0 };
  }
  let worked = 0, leave = 0;
  for (const a of rowsInMonth) {
    const c = dayContribution(a, t);
    worked += c.work;
    leave += c.leave;
  }
  const paidLeaveUsed = Math.min(leave, policy.paidCasualLeavesPerMonth);
  const cappedPayable = Math.min(wd, worked + paidLeaveUsed);
  const payableDays = policy.lopEnabled ? cappedPayable : wd;
  const lopDays = policy.lopEnabled ? Math.max(0, wd - cappedPayable) : 0;
  return { tracked: true, workedDays: worked, leaveTaken: leave, paidLeaveUsed, payableDays, lopDays };
}

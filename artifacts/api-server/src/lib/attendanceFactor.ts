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
 * threshold: a day decomposes into worked / casual-leave / sick-leave /
 * paid-off fractions (`dayContribution`), and the month-level summary
 * (`monthLeaveSummary`) applies the per-type paid-leave allowances — leave
 * within its allowance is paid, leave beyond it is loss of pay. Company
 * holidays and configured weekly offs are paid days that consume no leave
 * (unless a weekly-off rule says it deducts a casual leave).
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
 * One configured weekly off.
 *
 * `day` is the JS weekday (0 = Sunday … 6 = Saturday). `weeks` selects which
 * occurrences of that weekday in the month it applies to: 'all', or a list of
 * occurrence numbers (1–5, so "second Saturday" is `{ day: 6, weeks: [2] }`).
 * `policy` decides what the day costs: 'paid' is a full paid day that consumes
 * nothing; 'casual_leave' deducts one casual leave from the monthly allowance
 * (beyond the allowance it becomes loss of pay, exactly like any other excess
 * casual leave).
 */
export interface WeeklyOffRule {
  day: number;
  weeks: "all" | number[];
  policy: "paid" | "casual_leave";
}

/**
 * Company-wide payroll leave policy.
 *
 * Stored as keys of `company_settings.general_settings` (JSONB), so future
 * leave types — earned leave, maternity/paternity, comp off,
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
  /** Sick-leave days paid per month before loss of pay starts. */
  paidSickLeavesPerMonth: number;
  /** OFF = attendance never reduces pay (no LOP deduction at all). */
  lopEnabled: boolean;
  /** Configured weekly offs (empty = none, behaviour identical to before). */
  weeklyOffs: WeeklyOffRule[];
  /**
   * What Fix Attendance does when marking a casual-leave weekly off and the
   * month's casual-leave allowance is already used up: 'ask' makes the save
   * require explicit confirmation (the day then prices as loss of pay);
   * 'absent' saves without asking — the formula prices the excess as loss of
   * pay either way, so this setting only gates the manual save, never the math.
   */
  weeklyOffExhaustedAction: "ask" | "absent";
}

export const PAYROLL_POLICY_DEFAULTS: PayrollLeavePolicy = {
  workingDays: 30,
  paidCasualLeavesPerMonth: 4,
  paidSickLeavesPerMonth: 0,
  lopEnabled: true,
  weeklyOffs: [],
  weeklyOffExhaustedAction: "ask",
};

export interface PayrollSettings {
  thresholds: AttendanceThresholds;
  policy: PayrollLeavePolicy;
}

/** The subset of an attendance row the rule actually reads. */
export interface AttendanceDay {
  status?: string | null;
  /** 'casual' | 'sick' when status is 'leave'; NULL/absent means casual (legacy). */
  leaveType?: string | null;
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
  /** Business date (YYYY-MM-DD or Date) — needed for calendar-aware months. */
  date?: Date | string | null;
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

/** Sanitise one weekly-off rule from the settings blob; null = drop it. */
function sanitizeWeeklyOff(raw: any): WeeklyOffRule | null {
  if (!raw || typeof raw !== "object") return null;
  const day = Number(raw.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return null;
  const policy = raw.policy === "casual_leave" ? "casual_leave" : "paid";
  let weeks: "all" | number[] = "all";
  if (Array.isArray(raw.weeks)) {
    const w = raw.weeks.map(Number).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 5);
    if (w.length === 0) return null; // a rule that matches no week is a mistake, not "all"
    weeks = [...new Set(w)].sort() as number[];
  } else if (raw.weeks !== "all" && raw.weeks !== undefined && raw.weeks !== null) {
    return null;
  }
  return { day, weeks, policy };
}

/**
 * Thresholds + leave policy in one read, from `company_settings.general_settings`.
 *
 * Values are sanitised here, once, so no caller prices a month on a malformed
 * setting: working days clamps to 1–31 (integer), each allowance to
 * 0–workingDays, weekly-off rules to well-formed entries only.
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
  // Both branches clamp to workingDays — the DEFAULT allowance (4) can exceed
  // a small working-days setting (e.g. 1), and the 0..workingDays invariant
  // must hold whatever garbage the blob carries.
  const clampAllowance = (raw: unknown, dflt: number) => {
    const n = Number(raw ?? dflt);
    return Math.min(workingDays, Math.max(0, Number.isFinite(n) ? n : dflt));
  };
  const weeklyOffs = Array.isArray(gs.weeklyOffs)
    ? (gs.weeklyOffs.map(sanitizeWeeklyOff).filter(Boolean) as WeeklyOffRule[])
    : [];
  return {
    thresholds: {
      fullDayHours: Number(gs.fullDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.fullDayHours),
      halfDayHours: Number(gs.halfDayHours ?? ATTENDANCE_THRESHOLD_DEFAULTS.halfDayHours),
    },
    policy: {
      workingDays,
      paidCasualLeavesPerMonth: clampAllowance(
        gs.paidCasualLeavesPerMonth, PAYROLL_POLICY_DEFAULTS.paidCasualLeavesPerMonth),
      paidSickLeavesPerMonth: clampAllowance(
        gs.paidSickLeavesPerMonth, PAYROLL_POLICY_DEFAULTS.paidSickLeavesPerMonth),
      lopEnabled: gs.lopEnabled === undefined ? PAYROLL_POLICY_DEFAULTS.lopEnabled : gs.lopEnabled !== false,
      weeklyOffs,
      weeklyOffExhaustedAction:
        gs.weeklyOffExhaustedAction === "absent" ? "absent" : "ask",
    },
  };
}

// ── Company calendar (holidays + weekly offs) ────────────────────────────────

/** Which weekly-off rule (if any) covers this date. First matching rule wins. */
export function weeklyOffRuleFor(dateStr: string, policy: PayrollLeavePolicy): WeeklyOffRule | null {
  if (!policy.weeklyOffs.length) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const nth = Math.floor((d - 1) / 7) + 1; // 1st..5th occurrence of this weekday
  for (const r of policy.weeklyOffs) {
    if (r.day !== dow) continue;
    if (r.weeks === "all" || r.weeks.includes(nth)) return r;
  }
  return null;
}

/** What the company calendar says about one date. */
export interface DayCalendarInfo {
  holiday: boolean;
  weeklyOff: WeeklyOffRule | null;
}

export function calendarDayInfo(
  dateStr: string,
  policy: PayrollLeavePolicy,
  holidays: ReadonlySet<string>,
): DayCalendarInfo {
  return {
    holiday: holidays.has(dateStr),
    weeklyOff: weeklyOffRuleFor(dateStr, policy),
  };
}

/** Company holiday dates in [from, to] as a set of YYYY-MM-DD strings. */
export async function loadHolidaySet(pool: Pool, from: string, to: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d
       FROM company_holidays
      WHERE holiday_date >= $1 AND holiday_date <= $2`,
    [from, to],
  );
  return new Set(rows.map((r: any) => String(r.d)));
}

// ── Day decomposition ────────────────────────────────────────────────────────

/** How one day of attendance splits into worked time, leave taken and paid offs. */
export interface DayContribution {
  /** Fraction of a day actually worked (0, 0.5 or 1). */
  work: number;
  /**
   * Fraction of a day of casual leave taken (0, 0.5 or 1). Counts against the
   * monthly casual allowance; within it paid, beyond it loss of pay.
   */
  casualLeave: number;
  /** Fraction of a day of sick leave taken, against the sick allowance. */
  sickLeave: number;
  /** Paid day that consumes no leave: company holiday or a paid weekly off. */
  paidOff: number;
}

const ZERO: DayContribution = { work: 0, casualLeave: 0, sickLeave: 0, paidOff: 0 };

/**
 * Decompose one day of attendance.
 *
 * `undefined` — no attendance row for that date — falls back to the company
 * CALENDAR when one is supplied: a holiday or weekly off needs no row to be
 * paid (nobody checks in on a holiday). Without calendar cover it is `{0,…}`:
 * neither worked nor leave, so in a tracked month it is straight loss of pay
 * and does NOT consume any leave allowance.
 *
 * A stored row always outvotes the calendar — that is what makes admin
 * overrides work: correcting a holiday to 'present' or 'absent' prices the day
 * on the correction. Approved leave is one day of its leave type. A half day
 * is half worked + half casual leave (owner's rule). A worked day under the
 * half-day hours threshold is loss of pay outright.
 */
export function dayContribution(
  a: AttendanceDay | undefined | null,
  t: AttendanceThresholds,
  cal?: DayCalendarInfo | null,
): DayContribution {
  if (!a) {
    if (cal?.holiday) return { ...ZERO, paidOff: 1 };
    if (cal?.weeklyOff) {
      return cal.weeklyOff.policy === "casual_leave"
        ? { ...ZERO, casualLeave: 1 }
        : { ...ZERO, paidOff: 1 };
    }
    return ZERO;
  }
  // Explicit calendar statuses stamped by Fix Attendance.
  if (a.status === "company_holiday") return { ...ZERO, paidOff: 1 };
  if (a.status === "weekly_off") {
    // The rule for that date decides paid vs casual-deducting; a stored
    // weekly_off on a date no rule covers any more defaults to paid — the
    // admin marked it an off, and "paid" is the variant that consumes nothing.
    return cal?.weeklyOff?.policy === "casual_leave"
      ? { ...ZERO, casualLeave: 1 }
      : { ...ZERO, paidOff: 1 };
  }
  // Approved leave: a full day of its type, paid while the allowance lasts.
  if (a.status === "leave") {
    return a.leaveType === "sick"
      ? { ...ZERO, sickLeave: 1 }
      : { ...ZERO, casualLeave: 1 };
  }
  if (a.checkIn && a.checkOut) {
    // Total punched hours when the day has punch rows (breaks excluded);
    // first-in → last-out span otherwise. See AttendanceDay.punchedHours.
    const hrs = a.punchedHours != null
      ? Number(a.punchedHours)
      : (new Date(a.checkOut).getTime() - new Date(a.checkIn).getTime()) / 3_600_000;
    if (hrs >= t.fullDayHours) return { ...ZERO, work: 1 };
    if (hrs >= t.halfDayHours) return { ...ZERO, work: 0.5, casualLeave: 0.5 };
    return ZERO; // under the half-day threshold — loss of pay
  }
  // Checked in but not yet out: the day is still open, so it is provisionally
  // whole. Check-out re-evaluates it against the hours actually worked.
  if (a.checkIn) return { ...ZERO, work: 1 };
  if (a.status === "present") return { ...ZERO, work: 1 };
  if (a.status === "half_day") return { ...ZERO, work: 0.5, casualLeave: 0.5 };
  return ZERO; // absent
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
 * 3rd would leave the other 30 days of an untracked month unpaid. Calendar
 * days (holidays/weekly offs) are deliberately NOT synthesised into untracked
 * months — the month is already paid in full, and a synthetic row would flip
 * it to tracked and unpay every other day.
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
  /** Casual leave taken (leave days + half-day halves + casual weekly offs). */
  leaveTaken: number;
  /** Casual leave paid under the allowance: min(leaveTaken, allowance). */
  paidLeaveUsed: number;
  /** Sick leave taken. */
  sickLeaveTaken: number;
  /** Sick leave paid under its allowance: min(sickLeaveTaken, allowance). */
  paidSickLeaveUsed: number;
  /** Paid days that consumed no leave: company holidays + paid weekly offs. */
  paidOffDays: number;
  /** Days the salary is paid for — feeds computePayroll as presentDays. */
  payableDays: number;
  /** Days lost to LOP: workingDays − payableDays (0 when LOP is disabled). */
  lopDays: number;
}

/** Calendar context for one month, for synthesising rowless holidays/offs. */
export interface MonthCalendarContext {
  year: number;
  /** 1-based month. */
  month: number;
  /** Holiday dates (YYYY-MM-DD) anywhere in the month. */
  holidays: ReadonlySet<string>;
  /**
   * Last date (YYYY-MM-DD) the calendar may synthesise a rowless day for.
   * The mid-month leave-balance view sets this to today so a weekly off that
   * has not happened yet is not reported as leave already taken. Payroll and
   * accrual never set it — a generated month is judged whole, and stored rows
   * (leave approved in advance) always count regardless of this bound.
   */
  until?: string;
}

const dayStr = (d: AttendanceDay): string | null => {
  const raw = d.date;
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Apply the leave policy to a whole month of attendance.
 *
 *   payableDays = min(workingDays, worked + paidOff
 *                     + min(casualTaken, casualAllowance)
 *                     + min(sickTaken, sickAllowance))
 *   lopDays     = max(0, workingDays − payableDays)
 *
 * With a `calendar`, days that have NO attendance row but are company holidays
 * or configured weekly offs contribute as the calendar says (tracked months
 * only). Rows always outvote the calendar for their own date. Without a
 * calendar the behaviour is exactly the pre-holiday formula.
 *
 * With LOP disabled the month is always payable in full — the worked/leave
 * figures are still reported honestly for display. An untracked month is full
 * attendance, exactly as payroll has always treated it.
 */
export function monthLeaveSummary(
  rowsInMonth: readonly AttendanceDay[],
  policy: PayrollLeavePolicy,
  t: AttendanceThresholds,
  calendar?: MonthCalendarContext,
): MonthLeaveSummary {
  const wd = policy.workingDays;
  if (!monthHasAttendance(rowsInMonth)) {
    return {
      tracked: false, workedDays: wd, leaveTaken: 0, paidLeaveUsed: 0,
      sickLeaveTaken: 0, paidSickLeaveUsed: 0, paidOffDays: 0,
      payableDays: wd, lopDays: 0,
    };
  }
  let worked = 0, casual = 0, sick = 0, paidOff = 0;
  const rowDates = new Set<string>();
  for (const a of rowsInMonth) {
    const ds = dayStr(a);
    if (ds) rowDates.add(ds);
    const cal = calendar && ds ? calendarDayInfo(ds, policy, calendar.holidays) : null;
    const c = dayContribution(a, t, cal);
    worked += c.work;
    casual += c.casualLeave;
    sick += c.sickLeave;
    paidOff += c.paidOff;
  }
  // Rowless holidays / weekly offs — the calendar pays them without a row.
  if (calendar) {
    const daysInMonth = new Date(calendar.year, calendar.month, 0).getDate();
    const mm = String(calendar.month).padStart(2, "0");
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${calendar.year}-${mm}-${String(d).padStart(2, "0")}`;
      if (rowDates.has(ds)) continue;
      if (calendar.until && ds > calendar.until) continue;
      const c = dayContribution(undefined, t, calendarDayInfo(ds, policy, calendar.holidays));
      casual += c.casualLeave;
      paidOff += c.paidOff;
    }
  }
  const paidLeaveUsed = Math.min(casual, policy.paidCasualLeavesPerMonth);
  const paidSickLeaveUsed = Math.min(sick, policy.paidSickLeavesPerMonth);
  const cappedPayable = Math.min(wd, worked + paidOff + paidLeaveUsed + paidSickLeaveUsed);
  const payableDays = policy.lopEnabled ? cappedPayable : wd;
  const lopDays = policy.lopEnabled ? Math.max(0, wd - cappedPayable) : 0;
  return {
    tracked: true, workedDays: worked, leaveTaken: casual, paidLeaveUsed,
    sickLeaveTaken: sick, paidSickLeaveUsed, paidOffDays: paidOff,
    payableDays, lopDays,
  };
}

import { pool as _pool } from "@workspace/db";
import { provisionSalaryLedgers } from "./payrollLedgers";
import {
  dayFactor, loadAttendanceThresholds,
  type AttendanceDay, type AttendanceThresholds,
} from "./attendanceFactor";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/** Anything that can run a query — the pool, or a client inside a transaction. */
export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Daily salary accrual, driven by attendance.
 *
 * Salary is recognised as it is *earned*, not when payroll is approved and not
 * merely because a calendar day passed. Each open day books
 *
 *     attendance factor for that day  ×  monthly_salary / working_days
 *
 * as expense against the employee's own Salary Payable. A full day earns a full
 * day's pay, a half day earns half, an absent or loss-of-pay day earns nothing.
 *
 * Both halves of that formula are deliberately payroll's, not this module's:
 *
 *  - the factor comes from `dayFactor` in ./attendanceFactor, the single rule
 *    `POST /hr/payroll/generate` also uses;
 *  - the per-day rate divides by `working_days` (the employee's
 *    working-days-per-month basis, default 26), which is exactly the
 *    `baseSalary / workingDays` that `computePayroll` prices loss of pay at.
 *
 * That is what makes the two agree. A fully-attended month accrues to precisely
 * the `effectiveBasic` payroll computes, so month-end approval has only
 * allowances and employer statutory contributions left to true up rather than a
 * real, unexplainable correction. The previous engine divided by *calendar*
 * days and ignored attendance entirely, so it did neither.
 *
 * Three things make this safe to run on a timer:
 *
 *  - It is a **catch-up**, not a tick. It evaluates every open day between the
 *    employee's join date and today, so a server that was asleep for a week
 *    produces the same result as one that ran every night.
 *  - It is **idempotent**. The unique index on (employee_id, accrual_date)
 *    means a day is one row; running the sweep twice in a minute recomputes
 *    that row to the same value rather than charging it twice.
 *  - It **recomputes rather than appends**. Attendance for an open day can
 *    change after the fact — a check-out lands, a leave is approved, a manager
 *    corrects the record — so an open day is re-priced in place. The old engine
 *    inserted each day once and never looked at it again, which is why a
 *    correction could not reach the books at all.
 *
 * An approved or paid employee-month is **locked**: the sweep never touches a
 * day inside it, an attendance correction never re-prices one, and a salary
 * revision never recalculates it. That is what makes an approved period
 * financially final, and it is also what keeps history intact — months approved
 * before daily accrual existed carry their original full-value voucher and gain
 * no accrual rows at all.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** pg hands back a JS Date for `date` columns; normalise to a YYYY-MM-DD string. */
function ymd(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};

const addDays = (s: string, n: number): string => {
  const { y, m, d } = parse(s);
  return ymd(new Date(Date.UTC(y, m - 1, d + n)))!;
};

const maxDate = (...xs: (string | null)[]) => xs.filter(Boolean).sort().pop() as string | undefined;

const monthStart = (s: string) => {
  const { y, m } = parse(s);
  return `${y}-${String(m).padStart(2, "0")}-01`;
};

const monthEnd = (s: string) => {
  const { y, m } = parse(s);
  return `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
};

/** Default working-days-per-month basis, matching payroll's `pay_components` default. */
export const DEFAULT_WORKING_DAYS = 26;

/**
 * What one full attended day is worth.
 *
 * Divides by the working-days basis, not by calendar days: this is the rate
 * payroll prices a day of loss of pay at, and accrual has to use the same one
 * or a fully-attended month cannot reconcile to the payroll figure.
 */
export const dailyAccrualRate = (monthly: number, workingDays: number) =>
  round2(workingDays > 0 ? monthly / workingDays : 0);

const monthKey = (y: number, m: number) => `${y}-${m}`;

/**
 * Advisory-lock class for salary accrual, one lock per employee.
 *
 * Three writers touch an employee's accrual rows — the hourly sweep, a salary
 * revision, and the approval true-up — and two of them read the accrued total
 * before deciding what to write. Without a lock, an approval that reads "₹3,225
 * accrued" and a sweep that inserts one more day can interleave, and the month
 * ends up recognised twice for that day. Serialising per employee costs nothing
 * (no two writers ever want the same employee) and removes the whole class of
 * interleaving.
 */
const LOCK_CLASS = 8201;

/** Take the per-employee accrual lock for the rest of the caller's transaction. */
export async function lockSalaryAccrual(q: Querier, employeeId: number): Promise<void> {
  await q.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [LOCK_CLASS, employeeId]);
}

/**
 * Run `fn` in a transaction holding that employee's accrual lock.
 *
 * Exported because attendance writers need it too: attendance now decides what a
 * day earns, so an attendance write is a writer of the same figure as the sweep
 * and the approval true-up, and has to queue in the same line.
 */
export async function withEmployeeAccrualLock<T>(
  pool: Pool,
  employeeId: number,
  fn: (client: Querier) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSalaryAccrual(client as unknown as Querier, employeeId);
    const out = await fn(client as unknown as Querier);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SalaryAccrualResult {
  daysAccrued: number;
  employeesTouched: number;
  totalAmount: number;
}

interface EmployeeRow {
  id: number;
  name: string;
  salary: string | number;
  join_date: unknown;
  created_at: unknown;
  salary_accrual_resume_from: unknown;
  working_days: number | null;
}

/**
 * The working-days basis payroll will price this employee's month at.
 *
 * Read from the same `pay_components` row `POST /hr/payroll/generate` reads,
 * with the same default, so the two cannot drift apart.
 */
const WORKING_DAYS_SELECT = `COALESCE(pc.working_days_per_month, ${DEFAULT_WORKING_DAYS}) AS working_days`;
const WORKING_DAYS_JOIN = `LEFT JOIN pay_components pc ON pc.employee_id = e.id`;

const workingDaysOf = (row: { working_days?: number | null }) => {
  const wd = Number(row.working_days ?? DEFAULT_WORKING_DAYS);
  return wd > 0 ? wd : DEFAULT_WORKING_DAYS;
};

/**
 * The day attendance-driven pricing takes over from the old flat calendar rule.
 *
 * Days before it are left exactly as the previous engine wrote them. Re-pricing
 * them would restate months of financial history unprompted, for periods whose
 * attendance was never recorded because nothing depended on it at the time.
 * Bringing those periods over is a deliberate act, not a side effect of a deploy.
 */
export async function loadAccrualCutover(pool: Pool): Promise<string> {
  const { rows: [row] } = await pool.query(
    `SELECT attendance_from FROM salary_accrual_config WHERE id = 1`,
  );
  // No row means the migration has not run yet. Refusing to accrue is safer than
  // silently re-pricing everything, so fall back to the start of this month —
  // the same boundary the migration would have chosen.
  return ymd(row?.attendance_from) ?? monthStart(ymd(new Date())!);
}

/** Employee-months already signed off, which the sweep must leave alone. */
async function lockedMonths(q: Querier, employeeId: number): Promise<Set<string>> {
  const { rows } = await q.query(
    `SELECT year, month FROM payroll
      WHERE employee_id = $1 AND status IN ('approved', 'paid')`,
    [employeeId],
  );
  return new Set(rows.map((r) => monthKey(Number(r.year), Number(r.month))));
}

/**
 * Accrue every outstanding day up to and including `asOf` (default: today).
 *
 * `monthly_salary / days_in_month` does not divide evenly (₹20,000 over 31 days
 * is ₹645.16, and 31 of those is ₹19,999.96). The last day an employee covers in
 * a month therefore absorbs the rounding remainder, so a fully-covered month
 * totals the monthly salary to the paisa. The "last covered day" is derived from
 * the calendar — never from today — otherwise accruing mid-month would dump the
 * whole remainder onto the current day.
 */
export async function runSalaryAccrual(
  pool: Pool,
  opts: { asOf?: string; employeeId?: number; fromDate?: string } = {},
): Promise<SalaryAccrualResult> {
  const asOf = opts.asOf ?? ymd(new Date())!;

  const params: unknown[] = [];
  let only = "";
  if (opts.employeeId !== undefined) {
    params.push(opts.employeeId);
    only = ` AND id = $${params.length}`;
  }
  // Inactive employees are excluded outright rather than bounded to a stop date:
  // the employees table records no "inactive from" day, so there is nothing to
  // accrue up to. Deactivation therefore stops future accrual and leaves every
  // day already accrued untouched.
  const { rows: employees } = await pool.query<EmployeeRow>(
    `SELECT e.id, e.name, e.salary, e.join_date, e.created_at, e.salary_accrual_resume_from,
            ${WORKING_DAYS_SELECT}
       FROM employees e
       ${WORKING_DAYS_JOIN}
      WHERE e.is_active = TRUE AND e.salary > 0${only.replace(" AND id =", " AND e.id =")}
      ORDER BY e.id`,
    params,
  );

  // One read for the whole sweep: both are company-wide and re-reading them per
  // employee would only add round-trips.
  const thresholds = await loadAttendanceThresholds(pool);
  const attendanceFrom = await loadAccrualCutover(pool);

  const result: SalaryAccrualResult = { daysAccrued: 0, employeesTouched: 0, totalAmount: 0 };

  for (const e of employees) {
    // Fall back to the row's creation date so an employee saved without a join
    // date still accrues from a defensible day instead of silently never.
    //
    // `salary_accrual_resume_from` is stamped when someone is reactivated, and
    // wins over the join date: without it the sweep would backfill every month
    // the employee spent deactivated, recognising salary for a period they were
    // not on the payroll at all.
    const employedFrom = ymd(e.join_date) ?? ymd(e.created_at);
    const startDate = maxDate(employedFrom, ymd(e.salary_accrual_resume_from)) ?? null;
    if (!startDate || startDate > asOf) continue;

    const monthlySalary = Number(e.salary);
    if (!(monthlySalary > 0)) continue;

    // Ledgers are provisioned outside the lock: it needs its own writes, and
    // doing it here means a failure to provision skips the employee before any
    // accrual row exists that could never reach the books.
    const { expenseLedgerId, payableLedgerId } = await provisionSalaryLedgers(pool, e.id, e.name);
    if (!expenseLedgerId || !payableLedgerId) {
      console.error(`[salary] could not provision salary ledgers for employee ${e.id}; skipping`);
      continue;
    }

    const perEmployee = await withEmployeeAccrualLock(pool, e.id, (q) =>
      accrueEmployee(
        q,
        { id: e.id, startDate, monthlySalary, workingDays: workingDaysOf(e) },
        { asOf, thresholds, attendanceFrom },
      ),
    );

    // Counted on rows actually written, not on days evaluated: the sweep now
    // re-reads the whole open span every pass, so "days it looked at" would log
    // a large number every hour and mean nothing.
    if (perEmployee.changed > 0) {
      result.daysAccrued += perEmployee.changed;
      result.totalAmount = round2(
        result.totalAmount + round2(perEmployee.total - perEmployee.previousTotal),
      );
      result.employeesTouched++;
    }
  }

  return result;
}

export interface AccrueOutcome {
  /** Open days that earned something. */
  days: number;
  /** What the recomputed span is now worth. */
  total: number;
  /** Rows actually inserted or re-priced. */
  changed: number;
  /** What the same span was worth before this pass. */
  previousTotal: number;
}

/**
 * Price every open day for one employee from attendance.
 *
 * The caller must already hold that employee's accrual lock, which is what lets
 * the revision and attendance-correction paths reuse this inside their own
 * transaction instead of calling the sweep and deadlocking against themselves.
 *
 * This re-evaluates the whole open span rather than appending from a cursor.
 * Attendance for a day that has already been accrued can still change — a
 * check-out lands hours after the check-in, leave is approved retrospectively, a
 * manager corrects a record — and the books have to follow it. Re-pricing in
 * place is also what keeps the correction path from double-charging: there is
 * one row per day, so a corrected day is updated, never added to.
 *
 * Days inside an approved or paid month are skipped untouched.
 */
async function accrueEmployee(
  q: Querier,
  e: { id: number; startDate: string; monthlySalary: number; workingDays: number },
  opts: { asOf: string; thresholds: AttendanceThresholds; attendanceFrom: string },
): Promise<AccrueOutcome> {
  const locked = await lockedMonths(q, e.id);

  // Attendance is loaded for whole MONTHS, not just the accrued span. Whether a
  // month counts as tracked is a property of the month as a whole (see
  // `monthHasAttendance`), and leave approved in advance puts rows on days the
  // sweep has not reached yet — both need to be visible.
  const { rows: attRows } = await q.query(
    `SELECT date, status, check_in AS "checkIn", check_out AS "checkOut"
       FROM attendance
      WHERE employee_id = $1 AND date >= $2 AND date <= $3`,
    [e.id, monthStart(e.startDate), monthEnd(opts.asOf)],
  );
  const attByDate = new Map<string, AttendanceDay>();
  const trackedMonths = new Set<string>();
  for (const r of attRows) {
    const d = ymd(r.date);
    if (!d) continue;
    attByDate.set(d, r as AttendanceDay);
    const { y, m } = parse(d);
    trackedMonths.add(monthKey(y, m));
  }

  // Existing rows for the span, so a day whose price has not moved costs no
  // write at all. Without this the hourly sweep would rewrite every historical
  // row on every pass.
  const { rows: existingRows } = await q.query(
    `SELECT accrual_date, amount, attendance_factor, working_days, attendance_basis
       FROM salary_accruals
      WHERE employee_id = $1 AND accrual_date >= $2 AND accrual_date <= $3`,
    [e.id, e.startDate, opts.asOf],
  );
  const existing = new Map<string, { amount: number; factor: number; workingDays: number | null; basis: string | null }>();
  for (const r of existingRows) {
    const d = ymd(r.accrual_date);
    if (!d) continue;
    existing.set(d, {
      amount: Number(r.amount ?? 0),
      factor: Number(r.attendance_factor ?? 1),
      workingDays: r.working_days == null ? null : Number(r.working_days),
      basis: r.attendance_basis ?? null,
    });
  }

  // UNROUNDED, deliberately. Payroll divides the monthly salary by the working
  // days and only rounds the finished loss-of-pay figure, so rounding the rate
  // here first would price every partial month a paisa or two away from the
  // payroll number the same month is eventually approved against.
  const perDayRate = e.workingDays > 0 ? e.monthlySalary / e.workingDays : 0;

  let days = 0;
  let total = 0;
  let changed = 0;
  let previousTotal = 0;

  // Per-month running state: the cumulative paid-day count and the rounded
  // earned total it produced, both reset at each month boundary.
  let curMonth = "";
  let cumFactor = 0;
  let prevExpected = 0;

  for (let day = e.startDate; day <= opts.asOf; day = addDays(day, 1)) {
    const { y, m } = parse(day);
    const mk = monthKey(y, m);
    if (mk !== curMonth) { curMonth = mk; cumFactor = 0; prevExpected = 0; }
    if (locked.has(mk)) continue;

    // Before the cutover the old flat-calendar rows stand untouched. Their value
    // and their implied paid day still seed the month's running totals, so if the
    // boundary is ever moved into the middle of a month the days after it carry
    // on from where the old rows left off instead of restarting the cap and the
    // rounding from zero.
    if (day < opts.attendanceFrom) {
      const old = existing.get(day);
      if (old) {
        cumFactor += old.factor;
        prevExpected = round2(prevExpected + old.amount);
        previousTotal = round2(previousTotal + old.amount);
        total = round2(total + old.amount);
        if (old.amount > 0.004) days++;
      }
      continue;
    }

    const tracked = trackedMonths.has(mk);
    const att = attByDate.get(day);
    // An untracked month is full attendance, exactly as payroll treats it. Once
    // any row exists for the month, a day without one is genuinely absent.
    const factor = tracked ? dayFactor(att, opts.thresholds) : 1;
    const basis = !tracked ? "untracked"
      : !att ? "absent"
      : att.status === "leave" ? "leave"
      : factor === 1 ? "full_day"
      : factor === 0.5 ? "half_day"
      : "lop";

    // Cumulative-difference pricing: a day is charged the *increase* in the
    // month's earned total, so no per-day rounding accumulates.
    //
    // The total is payroll's own expression, not an equivalent of it —
    // `effectiveBasic = monthly − round2(lopDays × rate)` with the paid days so
    // far standing in for presentDays. Computing it the other way round, as
    // round2(paidDays × rate), looks identical and is not: at ₹20,000 over 26
    // days it lands on ₹19,230.75 where payroll says ₹19,230.77. Approval would
    // then true up a two-paisa difference that nothing in the books explains.
    //
    // The cap falls out of the same expression: `max(0, workingDays − paidDays)`
    // floors loss of pay at zero, so attendance beyond the working-days basis
    // earns nothing extra and a 31-day month attended in full costs exactly one
    // monthly salary.
    cumFactor += factor;
    const lopDays = Math.max(0, e.workingDays - cumFactor);
    const expected = round2(e.monthlySalary - round2(lopDays * perDayRate));
    const amount = round2(expected - prevExpected);
    prevExpected = expected;

    const prev = existing.get(day);
    previousTotal = round2(previousTotal + (prev?.amount ?? 0));
    total = round2(total + amount);
    if (amount > 0.004) days++;

    const unchanged = prev
      && Math.abs(prev.amount - amount) < 0.005
      && Math.abs(prev.factor - factor) < 0.005
      && prev.workingDays === e.workingDays
      && prev.basis === basis;
    if (unchanged) continue;

    // A zero-value day is still written. It is the audit record that the day was
    // evaluated and earned nothing, and it is what a later correction updates
    // instead of inserting alongside. The derived-posting stream skips amounts
    // at or below zero, so it reaches the books as no entry at all.
    await q.query(
      `INSERT INTO salary_accruals
         (employee_id, accrual_date, year, month, amount, monthly_salary, days_in_month,
          attendance_factor, working_days, attendance_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (employee_id, accrual_date) DO UPDATE
          SET amount            = EXCLUDED.amount,
              monthly_salary    = EXCLUDED.monthly_salary,
              days_in_month     = EXCLUDED.days_in_month,
              attendance_factor = EXCLUDED.attendance_factor,
              working_days      = EXCLUDED.working_days,
              attendance_basis  = EXCLUDED.attendance_basis`,
      [e.id, day, y, m, amount, e.monthlySalary, daysInMonth(y, m), factor, e.workingDays, basis],
    );
    changed++;
  }

  return { days, total, changed, previousTotal };
}

/**
 * What an employee-month has accrued so far.
 *
 * Takes a Querier so the approval can read it inside its own transaction, under
 * the accrual lock — reading it on the pool would let the sweep insert another
 * day between the read and the true-up.
 */
export async function accruedForMonth(
  q: Querier,
  employeeId: number,
  year: number,
  month: number,
): Promise<number> {
  const { rows: [row] } = await q.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM salary_accruals
      WHERE employee_id = $1 AND year = $2 AND month = $3`,
    [employeeId, year, month],
  );
  return round2(Number(row?.total ?? 0));
}

export interface RecalcResult {
  monthsRecalculated: Array<{ year: number; month: number }>;
  entriesReversed: number;
  entriesRegenerated: number;
  previousTotal: number;
  newTotal: number;
}

/**
 * Rebuild every unapproved month for one employee at their current salary.
 *
 * A mid-month salary revision does not create a second rate for the rest of the
 * month: the owner's rule is that an unapproved month is recalculated *in full*
 * at the revised amount, so July at ₹30,000 revised to ₹60,000 on the 25th
 * accrues all of July at ₹60,000. Approved months are excluded by the same lock
 * the sweep respects, so a revision can never restate a signed-off period.
 *
 * Deleting and regenerating rather than adjusting keeps one rule for what a day
 * is worth. Both halves run in ONE transaction under the employee's accrual lock:
 * between them the month reads as empty, and an approval that landed in that gap
 * would true itself up against nothing, post an oversized voucher and then lock
 * the month — leaving the deleted days permanently unrecoverable, because the
 * sweep skips approved months.
 *
 * The rebuild starts from the earliest day it deleted, not from the sweep's usual
 * cursor: the newest surviving accrual may belong to a LATER approved month, and
 * the cursor would then resume past everything just removed.
 */
export async function recalcUnapprovedSalaryAccruals(
  pool: Pool,
  employeeId: number,
  opts: { asOf?: string } = {},
): Promise<RecalcResult> {
  const asOf = opts.asOf ?? ymd(new Date())!;
  const empty: RecalcResult = {
    monthsRecalculated: [], entriesReversed: 0, entriesRegenerated: 0, previousTotal: 0, newTotal: 0,
  };

  // Ledgers are provisioned outside the lock because that needs its own writes.
  // A failure is logged rather than fatal: these accrual rows already existed, so
  // rebuilding them creates nothing that could not already reach the books.
  const { rows: [head] } = await pool.query<{ name: string }>(
    `SELECT name FROM employees WHERE id = $1`, [employeeId],
  );
  if (!head) return empty;
  const ledgers = await provisionSalaryLedgers(pool, employeeId, head.name);
  if (!ledgers.expenseLedgerId || !ledgers.payableLedgerId) {
    console.error(`[salary] could not provision salary ledgers for employee ${employeeId}`);
  }

  return withEmployeeAccrualLock(pool, employeeId, async (q) => {
    // Read the employee inside the lock: this runs straight after the PATCH that
    // changed the salary, and the revised figure is the whole point of rebuilding.
    const { rows } = await q.query(
      `SELECT id, name, salary, join_date, created_at, salary_accrual_resume_from, is_active
         FROM employees WHERE id = $1`,
      [employeeId],
    );
    const e = rows[0] as (EmployeeRow & { is_active: boolean }) | undefined;
    // Nothing is deleted for someone no longer on the payroll. The employees table
    // records no "inactive from" day, so a rebuild could only guess how far to
    // accrue — and deactivation is defined to leave the days already accrued
    // exactly as they stand.
    if (!e || !e.is_active) return empty;

    const employedFrom = ymd(e.join_date) ?? ymd(e.created_at);
    const startDate = maxDate(employedFrom, ymd(e.salary_accrual_resume_from)) ?? null;
    const monthlySalary = Number(e.salary);
    // With no defensible start date there is nothing to rebuild from, so nothing
    // may be torn down either.
    if (!startDate) return empty;

    // Which open months exist to be restated, read before the rebuild so the
    // audit entry can name them even when the rebuild leaves a month unchanged.
    const { rows: openMonths } = await q.query(
      `SELECT DISTINCT a.year, a.month
         FROM salary_accruals a
        WHERE a.employee_id = $1
          AND a.accrual_date >= $2
          AND NOT EXISTS (
            SELECT 1 FROM payroll p
             WHERE p.employee_id = a.employee_id AND p.year = a.year AND p.month = a.month
               AND p.status IN ('approved', 'paid')
          )`,
      [employeeId, startDate],
    );

    // A salary of zero is a real answer: the open days are worth nothing. There
    // is no rebuild to run, so they are cleared outright rather than left at the
    // old rate. Scoped to this stint — `salary_accrual_resume_from` stops the
    // clear reaching days accrued during an earlier one, which could never be
    // regenerated.
    if (!(monthlySalary > 0)) {
      const { rows: removed } = await q.query(
        `DELETE FROM salary_accruals a
          WHERE a.employee_id = $1
            AND a.accrual_date >= $2
            AND NOT EXISTS (
              SELECT 1 FROM payroll p
               WHERE p.employee_id = a.employee_id AND p.year = a.year AND p.month = a.month
                 AND p.status IN ('approved', 'paid')
            )
          RETURNING amount`,
        [employeeId, startDate],
      );
      return {
        monthsRecalculated: openMonths
          .map((r: any) => ({ year: Number(r.year), month: Number(r.month) }))
          .sort((a, b) => a.year - b.year || a.month - b.month),
        entriesReversed: removed.length,
        entriesRegenerated: 0,
        previousTotal: round2(removed.reduce((s: number, r: any) => s + Number(r.amount), 0)),
        newTotal: 0,
      };
    }

    if (startDate > asOf) return empty;

    // Re-price in place rather than delete-then-regenerate. The engine already
    // recomputes every open day from the current salary and attendance, so the
    // delete bought nothing and cost a window in which the month read as empty —
    // an approval landing there would true itself up against nothing, post an
    // oversized voucher and lock the month, stranding the deleted days for good.
    const { rows: [pc] } = await q.query(
      `SELECT COALESCE(working_days_per_month, ${DEFAULT_WORKING_DAYS}) AS working_days
         FROM pay_components WHERE employee_id = $1 LIMIT 1`,
      [employeeId],
    );
    const thresholds = await loadAttendanceThresholds(pool);
    const attendanceFrom = await loadAccrualCutover(pool);
    const rebuilt = await accrueEmployee(
      q,
      { id: employeeId, startDate, monthlySalary, workingDays: workingDaysOf(pc ?? {}) },
      { asOf, thresholds, attendanceFrom },
    );

    return {
      monthsRecalculated: openMonths
        .map((r: any) => ({ year: Number(r.year), month: Number(r.month) }))
        .sort((a, b) => a.year - b.year || a.month - b.month),
      entriesReversed: rebuilt.changed,
      entriesRegenerated: rebuilt.changed,
      previousTotal: rebuilt.previousTotal,
      newTotal: rebuilt.total,
    };
  });
}

/**
 * Re-price an employee's open days after their attendance changed.
 *
 * Every attendance write path calls this — check-in, check-out, leave sync,
 * leave approval, and the correction route. Without it an attendance change is
 * a record-keeping event that never reaches the books, which is precisely the
 * gap this module was rebuilt to close.
 *
 * It is deliberately the *same* engine the sweep runs, not a targeted patch of
 * the one date: pricing is cumulative within a month (see `accrueEmployee`), so
 * correcting the 3rd shifts the rounding on every later day of that month.
 *
 * Failures are logged and swallowed by the caller, never surfaced: attendance
 * must still be recordable when accounting is momentarily unavailable, and the
 * hourly sweep re-prices the day anyway. That is what makes this a latency
 * optimisation over the sweep rather than the only path to correctness.
 */
export async function reaccrueForAttendanceChange(
  pool: Pool,
  employeeId: number,
): Promise<void> {
  await runSalaryAccrual(pool, { employeeId });
}

let timer: NodeJS.Timeout | null = null;

/**
 * Run the accrual now, then hourly.
 *
 * Hourly rather than a single midnight alarm: the run is a cheap idempotent
 * catch-up, and an hourly cadence means a restart, a clock change or a few hours
 * of downtime all self-heal on the next pass instead of silently losing a day.
 */
export function startSalaryAccrualScheduler(pool: Pool): void {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await runSalaryAccrual(pool);
      if (r.daysAccrued > 0) {
        console.log(
          `[salary] re-priced ${r.daysAccrued} day(s) across ${r.employeesTouched} employee(s), net change ${r.totalAmount}`,
        );
      }
    } catch (e) {
      console.error("[salary] accrual run failed:", e);
    }
  };
  void tick();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
}

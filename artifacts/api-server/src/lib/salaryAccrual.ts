import { pool as _pool } from "@workspace/db";
import { provisionSalaryLedgers } from "./payrollLedgers";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/** Anything that can run a query — the pool, or a client inside a transaction. */
export interface Querier {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/**
 * Daily salary accrual.
 *
 * Salary is recognised as it is earned, not when payroll is approved: every day
 * each active employee books `monthly_salary / days_in_month` as expense against
 * their own Salary Payable. The P&L therefore shows the salary that belongs to
 * the period from the first day of the month, instead of nothing until someone
 * signs the run off.
 *
 * Approval does not re-recognise that cost. It trues the month up to the figure
 * payroll actually computed (attendance, loss of pay, allowances, statutory
 * contributions) and splits the payable into what is owed to whom — see
 * `postSalaryApproval`. Payment then only clears the payable.
 *
 * Two things make this safe to run on a timer:
 *
 *  - It is a **catch-up**, not a tick. It accrues every missing day between the
 *    employee's join date and today, so a server that was asleep for a week
 *    produces the same result as one that ran every night.
 *  - It is **idempotent**, guaranteed by the unique index on
 *    (employee_id, accrual_date) rather than by remembering when it last ran.
 *    Running it twice in a minute cannot double-charge a day.
 *
 * An approved or paid employee-month is **locked**: the sweep never adds a day
 * to it and a salary revision never recalculates it. That is what makes an
 * approved period financially final, and it is also what keeps history intact —
 * the months already approved before daily accrual existed carry their original
 * full-value voucher and gain no accrual rows at all.
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

/** The per-day figure a monthly amount produces in a given month. */
export const dailyAccrualRate = (monthly: number, year: number, month: number) =>
  round2(monthly / daysInMonth(year, month));

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

/** Run `fn` in a transaction holding that employee's accrual lock. */
async function withEmployeeAccrualLock<T>(
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
    `SELECT id, name, salary, join_date, created_at, salary_accrual_resume_from
       FROM employees
      WHERE is_active = TRUE AND salary > 0${only}
      ORDER BY id`,
    params,
  );

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
      accrueEmployee(q, { id: e.id, startDate, monthlySalary }, { asOf, fromDate: opts.fromDate }),
    );

    if (perEmployee.days > 0) {
      result.daysAccrued += perEmployee.days;
      result.totalAmount = round2(result.totalAmount + perEmployee.total);
      result.employeesTouched++;
    }
  }

  return result;
}

/**
 * Accrue one employee. The caller must already hold that employee's accrual lock,
 * which is what lets the revision path reuse this inside its own transaction
 * instead of calling the sweep and deadlocking against itself.
 */
async function accrueEmployee(
  q: Querier,
  e: { id: number; startDate: string; monthlySalary: number },
  opts: { asOf: string; fromDate?: string },
): Promise<{ days: number; total: number }> {
  const locked = await lockedMonths(q, e.id);

  // Resume from the day after the newest accrual rather than rescanning from
  // the join date every run. Days inside a locked month are skipped without
  // writing anything, so a locked month never advances this cursor past
  // itself — the months after it still get their turn.
  //
  // `fromDate` overrides that cursor, and a rebuild MUST pass it: the newest
  // accrual can belong to a locked month that sits AFTER the month being
  // rebuilt (August approved, July still draft), and the cursor would then
  // resume past July and leave the days just deleted gone for good. Existing
  // days are protected by the unique index, so an earlier start is safe.
  const { rows: [last] } = await q.query(
    `SELECT MAX(accrual_date) AS last FROM salary_accruals WHERE employee_id = $1`,
    [e.id],
  );
  const cursor = opts.fromDate ?? (last?.last ? addDays(ymd(last.last)!, 1) : null);
  const resumeFrom = maxDate(e.startDate, cursor)!;

  let days = 0;
  let total = 0;
  for (let day = resumeFrom; day <= opts.asOf; day = addDays(day, 1)) {
    const { y, m } = parse(day);
    if (locked.has(monthKey(y, m))) continue;

    const dim = daysInMonth(y, m);
    const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(dim).padStart(2, "0")}`;

    let amount: number;
    if (day === monthEnd) {
      // Absorb the remainder so the covered span totals exactly. A mid-month
      // joiner covers only part of the month, so the expected total is
      // pro-rated over the days actually covered.
      const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
      const firstCovered = maxDate(monthStart, e.startDate)!;
      const coveredDays = Math.round(
        (Date.parse(`${monthEnd}T00:00:00Z`) - Date.parse(`${firstCovered}T00:00:00Z`)) / 86_400_000,
      ) + 1;
      const expectedTotal = round2((e.monthlySalary * coveredDays) / dim);
      // Only days from this employment stint count towards that total. A re-hire
      // mid-month leaves earlier days in the same month accrued under the previous
      // stint, and counting those here would swallow the remainder.
      const { rows: [sofar] } = await q.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM salary_accruals
          WHERE employee_id = $1 AND year = $2 AND month = $3 AND accrual_date >= $4`,
        [e.id, y, m, e.startDate],
      );
      amount = round2(expectedTotal - Number(sofar?.total ?? 0));
    } else {
      amount = round2(e.monthlySalary / dim);
    }

    if (amount <= 0) continue;

    const { rowCount } = await q.query(
      `INSERT INTO salary_accruals (employee_id, accrual_date, year, month, amount, monthly_salary, days_in_month)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (employee_id, accrual_date) DO NOTHING`,
      [e.id, day, y, m, amount, e.monthlySalary, dim],
    );
    if (rowCount) {
      days++;
      total = round2(total + amount);
    }
  }

  return { days, total };
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

    // Scoped to this employment stint. `salary_accrual_resume_from` is stamped on
    // re-hire and stops the rebuild reaching days before it — deleting them
    // unscoped would destroy expense that was genuinely accrued during the
    // earlier stint and can never be regenerated.
    const { rows: removed } = await q.query(
      `DELETE FROM salary_accruals a
        WHERE a.employee_id = $1
          AND a.accrual_date >= $2
          AND NOT EXISTS (
            SELECT 1 FROM payroll p
             WHERE p.employee_id = a.employee_id AND p.year = a.year AND p.month = a.month
               AND p.status IN ('approved', 'paid')
          )
        RETURNING amount, accrual_date, year, month`,
      [employeeId, startDate],
    );

    const seen = new Map<string, { year: number; month: number }>();
    let previousTotal = 0;
    let earliest: string | null = null;
    for (const r of removed) {
      previousTotal = round2(previousTotal + Number(r.amount));
      seen.set(monthKey(Number(r.year), Number(r.month)), { year: Number(r.year), month: Number(r.month) });
      const d = ymd(r.accrual_date);
      if (d && (!earliest || d < earliest)) earliest = d;
    }

    // A salary of zero is a real answer: the open months are worth nothing and
    // stay empty after the delete.
    const regenerated = startDate && startDate <= asOf && monthlySalary > 0
      ? await accrueEmployee(q, { id: employeeId, startDate, monthlySalary },
          { asOf, fromDate: earliest ?? undefined })
      : { days: 0, total: 0 };

    return {
      monthsRecalculated: [...seen.values()].sort((a, b) => a.year - b.year || a.month - b.month),
      entriesReversed: removed.length,
      entriesRegenerated: regenerated.days,
      previousTotal,
      newTotal: regenerated.total,
    };
  });
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
          `[salary] accrued ${r.daysAccrued} day(s) across ${r.employeesTouched} employee(s), total ${r.totalAmount}`,
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

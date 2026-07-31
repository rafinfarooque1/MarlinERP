import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Daily salary accrual schema.
 *
 * One table, deliberately shaped like `rent_accruals`: both modules answer the
 * same question ("how much of this month's fixed monthly cost has been incurred
 * so far?") and both feed the books through the same derived-posting stream, so
 * keeping the two registers structurally identical means one mental model and
 * one set of query patterns rather than two.
 *
 * `monthly_salary` and `days_in_month` are stored per row rather than looked up
 * later: they are the basis the amount was computed from, and once a month is
 * approved the row must stay explainable even after the employee's salary
 * changes. Without them an approved accrual becomes an unexplainable number.
 *
 * Note on `CREATE TABLE IF NOT EXISTS`: constraints written inside the CREATE
 * only ever apply the first time, so the uniqueness rule is a separate
 * `CREATE UNIQUE INDEX IF NOT EXISTS` — it still lands on a database where an
 * earlier version of the table already exists.
 */
export async function addSalaryAccrual(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_accruals (
      id             SERIAL PRIMARY KEY,
      employee_id    INTEGER NOT NULL,
      accrual_date   DATE    NOT NULL,
      year           INTEGER NOT NULL,
      month          INTEGER NOT NULL,
      amount         NUMERIC(15,2) NOT NULL,
      monthly_salary NUMERIC(15,2) NOT NULL,
      days_in_month  INTEGER NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // This index is what makes the hourly catch-up idempotent: re-running it for a
  // day already accrued is a no-op rather than a double charge.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_accrual_emp_date
       ON salary_accruals (employee_id, accrual_date)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_salary_accrual_period
       ON salary_accruals (employee_id, year, month)`,
  );

  // The sweep resumes from the day after an employee's newest accrual, which is
  // wrong for someone deactivated for a while and then brought back: the gap
  // would be backfilled as though they had been employed throughout. The
  // employees table has no "inactive from" day to bound that with, so
  // reactivation stamps the day accrual may resume from instead.
  //
  // This column is added by raw SQL and is therefore invisible to Drizzle — it
  // must be read and written by raw SQL too, or it silently reads as undefined.
  await pool.query(
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS salary_accrual_resume_from DATE`,
  );

  // Attendance-driven accrual. A day is now worth `attendance_factor` of a paid
  // day (1 / 0.5 / 0), priced at `monthly_salary / working_days` rather than
  // over calendar days — the same per-day rate payroll uses, so the month-end
  // true-up stays a rounding difference instead of a real adjustment.
  //
  // Both are stored per row for the same reason `monthly_salary` already is:
  // once a month is approved the amount must stay explainable even after the
  // employee's salary, working-days basis or attendance record changes. Without
  // them an approved accrual is an unexplainable number.
  //
  // `working_days` is nullable and `attendance_factor` defaults to 1 so that
  // rows written by the previous flat-calendar engine keep reading correctly:
  // they were, in effect, full-day accruals with no working-days basis.
  //
  // Raw-SQL columns are invisible to Drizzle — read and write them via raw SQL.
  await pool.query(
    `ALTER TABLE salary_accruals
       ADD COLUMN IF NOT EXISTS attendance_factor NUMERIC(4,2) NOT NULL DEFAULT 1`,
  );
  await pool.query(
    `ALTER TABLE salary_accruals ADD COLUMN IF NOT EXISTS working_days INTEGER`,
  );
  // Why the day earned what it did, for the audit trail behind a payslip query
  // ("leave", "present", "half_day", "absent", "untracked", ...).
  await pool.query(
    `ALTER TABLE salary_accruals ADD COLUMN IF NOT EXISTS attendance_basis TEXT`,
  );

  // The engine now recomputes an open day in place when attendance changes, so
  // a day can legitimately fall to zero. The old engine only ever inserted
  // positive amounts, and a stale CHECK from an earlier revision would block
  // that — assert the column simply allows it.
  await pool.query(
    `ALTER TABLE salary_accruals ALTER COLUMN amount DROP NOT NULL`,
  ).catch(() => {});
  await pool.query(
    `UPDATE salary_accruals SET amount = 0 WHERE amount IS NULL`,
  );

  await addAttendanceUniqueness(pool);
  await addAttendanceAccrualCutover(pool);
}

/**
 * One attendance row per employee per day, enforced by the database.
 *
 * The whole system has always *assumed* this — check-in looks a row up by
 * (employee, date) and overwrites it, payroll sums the rows for a month, and the
 * correction route upserts on it — but nothing enforced it, so two concurrent
 * check-ins could create two rows for one day and payroll would then pay for
 * both. Now that a day of attendance decides a day of salary, that is a
 * duplicated expense rather than a cosmetic glitch.
 *
 * Duplicates are MERGED, never dropped on the floor: the survivor takes the
 * earliest check-in and latest check-out seen for the day, and the most
 * informative status. Deleting the extras outright would silently shorten
 * somebody's working day.
 */
async function addAttendanceUniqueness(pool: Pool): Promise<void> {
  await pool.query(`
    UPDATE attendance a SET
      check_in  = COALESCE(a.check_in,  agg.min_in),
      check_out = COALESCE(a.check_out, agg.max_out),
      status    = COALESCE(NULLIF(a.status, 'absent'), agg.best_status, a.status)
    FROM (
      SELECT employee_id, date,
             MIN(check_in) AS min_in, MAX(check_out) AS max_out,
             MIN(NULLIF(status, 'absent')) AS best_status
        FROM attendance
       GROUP BY employee_id, date
      HAVING COUNT(*) > 1
    ) agg
    WHERE a.employee_id = agg.employee_id
      AND a.date = agg.date
      AND a.id = (SELECT MIN(b.id) FROM attendance b
                   WHERE b.employee_id = a.employee_id AND b.date = a.date)
  `);
  await pool.query(`
    DELETE FROM attendance a
     WHERE a.id > (SELECT MIN(b.id) FROM attendance b
                    WHERE b.employee_id = a.employee_id AND b.date = a.date)
  `);
  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_emp_date
         ON attendance (employee_id, date)`,
    );
  } catch (e) {
    // Loud, not fatal: without it the correction route's ON CONFLICT has no
    // arbiter and every correction fails, which is far easier to diagnose from
    // this line than from the 500s.
    console.error("[migration] CRITICAL: could not make attendance (employee_id, date) unique:", e);
  }
}

/**
 * The day attendance-driven accrual takes over.
 *
 * Salary used to accrue at a flat `monthly_salary / calendar days`, ignoring
 * attendance. Every one of those rows is still in the table, and re-pricing them
 * would rewrite months of financial history the moment this version booted —
 * without anybody asking for it, and for periods whose attendance was never
 * recorded because it did not affect anything at the time.
 *
 * So the new engine starts at a boundary instead. Days before `attendance_from`
 * keep exactly the amounts they were given and are never touched again; days on
 * or after it are priced from attendance. The boundary is the first of the month
 * in which this migration first runs, so no single month is ever half old-rule
 * and half new-rule — a month that straddled the change could not reconcile to
 * payroll under either.
 *
 * It is a stored, editable date rather than a constant precisely so that the
 * historical periods can be brought over later, deliberately, once someone has
 * looked at what that would restate.
 */
async function addAttendanceAccrualCutover(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salary_accrual_config (
      id              INTEGER PRIMARY KEY,
      attendance_from DATE NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `INSERT INTO salary_accrual_config (id, attendance_from)
     VALUES (1, date_trunc('month', CURRENT_DATE)::date)
     ON CONFLICT (id) DO NOTHING`,
  );
}

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
}

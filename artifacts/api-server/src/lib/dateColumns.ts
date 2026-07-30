/**
 * Structural type instead of `import type { Pool } from "pg"`: this package
 * reaches Postgres through @workspace/db and does not depend on `pg` directly,
 * so naming the driver here would add a dependency for a type alone.
 */
type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Every column that holds a calendar date and must be a real PostgreSQL `date`.
 *
 * Kept in one place because three things have to agree on the list: the boot
 * conversion, the /api/healthz/schema census that proves the conversion landed,
 * and anyone auditing the schema by hand. A column added to the database but
 * not to this list is invisible to all three.
 */
export const DATE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["cash_deposits", "deposit_date"],
  ["coupons", "expiry_date"],
  ["employees", "date_of_birth"],
  ["expenses", "expense_date"],
  ["journal_vouchers", "voucher_date"],
  ["payments", "payment_date"],
  ["productions", "expiry_date"],
  ["productions", "mfg_date"],
  ["purchase_returns", "return_date"],
  ["receipts", "receipt_date"],
  ["reconciliation_batches", "settlement_date"],
  ["sale_payments", "payment_date"],
  ["sales_returns", "return_date"],
  ["stock_batches", "expiry_date"],
  ["stock_batches", "mfg_date"],
  ["stock_verifications", "verify_date"],
] as const;

export type DateColumnCensus = {
  total: number;
  date: number;
  pending: string[];
  missing: string[];
};

/**
 * Report the LIVE type of each date column.
 *
 * `table_schema = 'public'` is not optional: this database also carries a
 * `backup_meta` schema, and an unqualified information_schema lookup can match
 * a same-named column in another schema and answer for the wrong table.
 */
export async function censusDateColumns(pool: Queryable): Promise<DateColumnCensus> {
  const pending: string[] = [];
  const missing: string[] = [];
  let date = 0;

  for (const [table, col] of DATE_COLUMNS) {
    const {
      rows: [meta],
    } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, col],
    );
    if (!meta) {
      missing.push(`${table}.${col}`);
    } else if (meta.data_type === "date") {
      date++;
    } else {
      pending.push(`${table}.${col} (${meta.data_type})`);
    }
  }

  return { total: DATE_COLUMNS.length, date, pending, missing };
}

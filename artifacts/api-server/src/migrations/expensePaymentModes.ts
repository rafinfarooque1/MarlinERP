import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Location expenses gain a payment method: Cash, Bank or Credit.
 *
 * Until now a location expense was *defined* by its funding: a payment voucher
 * whose `paid_from` was that location's cash ledger. Every read — the list, the
 * all-locations view, the per-location summary and the delete guard — recognised
 * one by joining `warehouses`/`outlets` on `cash_ledger_id`.
 *
 * That definition cannot survive Bank and Credit expenses, which are funded from
 * a company bank ledger or from Expense Payable and so match no location's till.
 * Keyed on funding alone they would be invisible on the page that created them
 * and undeletable by the guard.
 *
 * So identity moves off the funding and onto an explicit flag. Three columns:
 *
 * - `is_location_expense` — the discriminator every read now filters on. It has
 *   to be explicit rather than derived: `location_type` defaults to
 *   `'headoffice'` and `location_id` to `0` on *every* payment row, so "has a
 *   location stamp and pays an expense ledger" would silently swallow ordinary
 *   Head Office payment vouchers that happen to pay an expense ledger.
 * - `payment_mode` — 'cash' | 'bank' | 'credit'. Stored, not inferred from the
 *   funding ledger, so re-pointing a location's cash ledger later cannot
 *   retroactively reclassify historical vouchers.
 * - `notes` — free-form, kept out of `narration` because narration is what the
 *   day book, ledger statements and printed voucher render.
 *
 * The backfill also *repairs* the location stamp. The stamp was never read for
 * these rows (every query derived location from the cash-ledger join), and at
 * least one live voucher drifted: paid from Indiranagar Outlet's till while
 * stamped `warehouse/3`. Now that reads key on the stamp it has to be true, so
 * it is rewritten from the funding ledger — the ledger is the fact, the stamp
 * was decoration. Display does not move: the all-locations view already showed
 * these rows under their cash ledger's location.
 *
 * Guarded by `migration_log`: a re-run on every boot would re-stamp rows and
 * overwrite any later legitimate correction.
 */
export async function addExpensePaymentModes(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_location_expense BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_mode TEXT`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes TEXT`);

  // Reads filter on the flag first, so give it an index alongside the existing
  // location index rather than relying on a full scan of payments.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_payments_location_expense
       ON payments (location_type, location_id)
     WHERE is_location_expense = true`,
  );

  // ── Expense Payable ────────────────────────────────────────────────────────
  // The credit side of an unpaid expense. A vendor bill has its own party
  // ledger; this is for the everyday unpaid expense with no vendor record —
  // the brief's "Accounts Payable / Expense Payable".
  const { rows: [curl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-CURL'`);
  if (curl) {
    await pool.query(
      `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
       SELECT $1, 'liability', 'STD-EXP-PAY', 'balance_sheet', $2, false, $3
       WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = 'STD-EXP-PAY')`,
      [
        'Expense Payable',
        curl.id,
        'Expenses recorded but not yet paid — cleared when the expense is settled from cash or bank',
      ],
    );
  }

  const { rows: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'location_expense_flag_v1'`,
  );
  if (done.length > 0) return;

  const { rowCount } = await pool.query(`
    WITH RECURSIVE exp AS (
      SELECT id FROM account_ledgers WHERE code IN ('SYS-DIREXP', 'SYS-INDEXP')
      UNION ALL
      SELECT l.id FROM account_ledgers l JOIN exp e ON l.parent_id = e.id
    ),
    loc AS (
      SELECT cash_ledger_id AS cash_id, 'warehouse' AS ltype, id AS lid
        FROM warehouses WHERE cash_ledger_id IS NOT NULL
      UNION ALL
      SELECT cash_ledger_id, 'outlet', id
        FROM outlets     WHERE cash_ledger_id IS NOT NULL
    )
    UPDATE payments p
       SET is_location_expense = true,
           payment_mode        = 'cash',
           location_type       = loc.ltype,
           location_id         = loc.lid
      FROM loc
     WHERE p.paid_from_ledger_id = loc.cash_id
       AND p.paid_to_ledger_id IN (SELECT id FROM exp)
       AND p.is_location_expense = false
  `);

  await pool.query(`INSERT INTO migration_log (name) VALUES ('location_expense_flag_v1')`);
  console.log(`[migration] location_expense_flag_v1: flagged ${rowCount ?? 0} existing location expense(s)`);
}

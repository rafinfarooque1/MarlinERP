import type { PgPool } from "@workspace/db";

/**
 * One-time repair of money vouchers stamped to the wrong location.
 *
 * Before resolveMoneyVoucherLocation() (lib/moneyScope.ts), manual receipt and
 * payment vouchers were always stamped with the CALLER's own location — so an
 * Admin or Head Office user recording money for a branch produced a voucher
 * stamped Head Office even though the cash moved through the branch's till.
 * Located cash books, trial balances and dashboards then showed the money
 * under Head Office while the branch's voucher list (which also matches on the
 * ledger leg) showed it under the branch: the same rupee in two places.
 *
 * The new rule — the till's owner speaks for the voucher — is applied here to
 * the rows the old writers got wrong:
 *
 *  - receipts stamped headoffice/NULL whose `received_in` ledger is a branch
 *    till (warehouse/outlet cash ledger or a branch-assigned Cash & Bank
 *    account) are re-stamped to the till's owner;
 *  - payments likewise on `paid_from`, EXCLUDING location-expense rows: their
 *    stamp is deliberate expense ATTRIBUTION (which location the spend belongs
 *    to), not derived from the paying till — see the location-expense design.
 *
 * Mirror locations (one place kept as both warehouse and outlet, sharing one
 * till) resolve to the warehouse identity — the same deterministic preference
 * resolveMoneyVoucherLocation() and the read-side dedupes apply.
 *
 * Branch-stamped rows are never touched: branch users could only ever write
 * through their own till, so those stamps are correct by construction.
 * One-shot via migration_log marker, written in the same transaction as the
 * updates. Safe in every environment — it's a re-stamp, nothing is deleted.
 */
const GUARD = "money_voucher_location_restamp_v1";

// Every branch-owned till with ONE deterministic owner (warehouse preferred
// for mirror locations) — the same ownership set locationOwnedLedgerMap()
// serves the application at runtime.
const TILL_OWNER_CTE = `
  WITH owners AS (
    SELECT cash_ledger_id AS ledger_id, 'warehouse' AS lt, id AS lid FROM warehouses WHERE cash_ledger_id IS NOT NULL
    UNION
    SELECT cash_ledger_id, 'outlet', id FROM outlets WHERE cash_ledger_id IS NOT NULL
    UNION
    SELECT ledger_id, location_type, location_id FROM cash_bank_accounts
     WHERE ledger_id IS NOT NULL AND location_id IS NOT NULL AND location_type IN ('warehouse','outlet')
  ),
  pick AS (
    SELECT DISTINCT ON (ledger_id) ledger_id, lt, lid
      FROM owners
     ORDER BY ledger_id, CASE WHEN lt = 'warehouse' THEN 0 ELSE 1 END, lid
  )
`;

export async function restampMoneyVoucherLocations(pool: PgPool): Promise<void> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount: rec } = await client.query(`
      ${TILL_OWNER_CTE}
      UPDATE receipts r
         SET location_type = p.lt, location_id = p.lid
        FROM pick p
       WHERE p.ledger_id = r.received_in_ledger_id
         AND COALESCE(r.location_type, 'headoffice') = 'headoffice'
    `);

    const { rowCount: pay } = await client.query(`
      ${TILL_OWNER_CTE}
      UPDATE payments y
         SET location_type = p.lt, location_id = p.lid
        FROM pick p
       WHERE p.ledger_id = y.paid_from_ledger_id
         AND COALESCE(y.location_type, 'headoffice') = 'headoffice'
         AND COALESCE(y.is_location_expense, false) = false
    `);

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD],
    );
    await client.query("COMMIT");

    if ((rec ?? 0) + (pay ?? 0) > 0) {
      console.log(
        `[migration] money voucher location restamp: ${rec ?? 0} receipt(s) and ` +
        `${pay ?? 0} payment(s) re-stamped from Head Office to their till's own location`,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

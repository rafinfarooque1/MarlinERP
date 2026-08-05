import type { PgPool } from "@workspace/db";

/**
 * One-time backfill of missing payment-history rows for counter-settled cash
 * sales (ERP audit finding M-2).
 *
 * The earliest production cash sales were recorded before the settlement-legs
 * producer shipped: `sales.amount_paid` was set (the sale settled at the
 * counter, as the settlement model requires) but no `sale_payments` row was
 * written. Their Payment History tabs are blank and method-level payment
 * reports cannot see them.
 *
 * This recreates ONLY the missing history record — one `sale_payments` row per
 * sale, method 'cash', amount = the already-stored `amount_paid`, dated the
 * sale date. It writes NO receipts, NO vouchers and touches NO ledger-facing
 * column: the books derive a cash sale's postings from the sale row itself
 * (buildDerivedPostings never reads sale_payments for these), so the trial
 * balance, cash book and every statement are unchanged by construction.
 *
 * Scope is deliberately tight — a row qualifies only when ALL hold:
 *   - payment_mode = 'cash'  (settled at the counter; no clearing receipt to
 *     reconcile, unlike UPI/card, so a bare history row is the complete truth)
 *   - payment_status = 'paid' (legacy rows with amount_paid but status
 *     'unpaid' are contradictory pre-settlement-model data; inventing history
 *     for them would assert a collection nobody recorded)
 *   - amount_paid > 0, no existing sale_payments row, not cancelled, and not
 *     a branch-transfer document (those settle through the transfer flow).
 *
 * One-shot via migration_log marker, written in the same transaction.
 */
const GUARD = "sale_payment_legs_backfill_v1";

export async function backfillSalePaymentLegs(pool: PgPool): Promise<void> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(`
      INSERT INTO sale_payments
        (sale_id, payment_date, method, amount, notes,
         reconciliation_status, clearing_receipt_id, outlet_id, created_by)
      SELECT s.id, s.sale_date, 'cash', s.amount_paid,
             'Settled at counter — history backfilled (predates payment-history records)',
             NULL, NULL, s.outlet_id, 'system'
        FROM sales s
       WHERE s.payment_mode = 'cash'
         AND s.payment_status = 'paid'
         AND COALESCE(s.amount_paid, 0)::numeric > 0
         AND s.cancelled_at IS NULL
         AND s.branch_transfer_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)
    `);

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD],
    );
    await client.query("COMMIT");

    if ((rowCount ?? 0) > 0) {
      console.log(
        `[migration] sale payment legs backfill: ${rowCount} counter-settled cash sale(s) ` +
        `given their missing payment-history row (no accounting entries written)`,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

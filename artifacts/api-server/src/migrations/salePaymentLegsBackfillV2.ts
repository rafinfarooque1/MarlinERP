import type { PgPool } from "@workspace/db";

/**
 * Counter-settlement payment history, round two (audit finding F-1, Aug 10 2026).
 *
 * The v1 backfill (salePaymentLegsBackfill.ts) repaired the cash sales that
 * predated the settlement model, but the PRODUCER gap stayed open: a sale
 * settled at the counter set `amount_paid` without writing its `sale_payments`
 * history row. Books were never wrong — the derived postings treat the
 * `amount_paid − Σ legs` remainder as counter money — but the Payment History
 * tab stayed blank and reconciliation could not see counter collections.
 *
 * The producer is fixed alongside this migration (sale create, sale edit and
 * the import path now write a `source = 'counter'` settlement leg). This
 * migration brings the EXISTING rows up to the same shape:
 *
 *   1. `sale_payments.source` column (raw column — schema.ts does not know it,
 *      so it must always be read and written via raw SQL).
 *   2. v1-backfilled rows are stamped `source = 'counter'`: they represent the
 *      same counter settlement, and the stamp is what lets cancellation treat
 *      them as till money (refundable across the counter) rather than banked
 *      collections. Matched on the v1 marker fields (created_by 'system' plus
 *      the exact v1 note), which no user-created row carries.
 *   3. Every remaining settled-mode paid sale whose `amount_paid` exceeds its
 *      recorded legs gets ONE counter leg for exactly the remainder — never a
 *      duplicate of an existing collection. Electronic modes (legacy bank/upi/
 *      card rows) enter as 'pending' so reconciliation can finally settle
 *      them; cash needs no reconciliation and stays NULL.
 *
 * No receipts, no vouchers, no ledger-facing column is touched: the postings
 * derivation replaces its remainder slice with the identical leg-driven slice
 * (same date, same amount, same cash/clearing ledger), so the trial balance
 * and every statement are unchanged by construction.
 *
 * Credit-mode sales with a paid/legs gap are deliberately EXCLUDED: for them a
 * missing leg means a collection nobody recorded, and inventing history would
 * assert money movement on a date we cannot know (same rationale as v1).
 */
const GUARD = "sale_payment_legs_backfill_v2";

/** Modes settled across the counter, including the legacy spellings. */
const SETTLED_MODES_SQL = `('cash', 'bank', 'upi', 'card', 'bank_transfer')`;

export async function backfillSalePaymentLegsV2(pool: PgPool): Promise<void> {
  // The column ships regardless of the one-shot guard: the producers write it
  // on every new counter sale, so it must exist even after the backfill ran.
  await pool.query(`ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS source text`);

  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. Stamp the v1 rows — same settlement, now carrying its provenance.
    const { rowCount: stamped } = await client.query(`
      UPDATE sale_payments
         SET source = 'counter'
       WHERE source IS NULL
         AND created_by = 'system'
         AND notes = 'Settled at counter — history backfilled (predates payment-history records)'
    `);

    // 3. One remainder leg per short-changed settled sale. The remainder is
    //    measured against ALL existing legs (advance adjustments included), so
    //    a sale that already has partial history gets topped up, never doubled.
    const { rowCount: inserted } = await client.query(`
      INSERT INTO sale_payments
        (sale_id, payment_date, method, amount, notes,
         reconciliation_status, clearing_receipt_id, outlet_id, created_by, source)
      SELECT s.id, s.sale_date, s.payment_mode,
             (s.amount_paid::numeric - COALESCE(sp.total, 0)),
             'Settled at counter — history backfilled (audit F-1)',
             CASE WHEN s.payment_mode = 'cash' THEN NULL ELSE 'pending' END,
             NULL, s.outlet_id, 'system', 'counter'
        FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(amount::numeric) AS total
                     FROM sale_payments GROUP BY sale_id) sp ON sp.sale_id = s.id
       WHERE s.payment_mode IN ${SETTLED_MODES_SQL}
         AND s.payment_status = 'paid'
         AND s.cancelled_at IS NULL
         AND s.branch_transfer_id IS NULL
         AND (s.amount_paid::numeric - COALESCE(sp.total, 0)) > 0.004
    `);

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD],
    );
    await client.query("COMMIT");

    if ((stamped ?? 0) > 0 || (inserted ?? 0) > 0) {
      console.log(
        `[migration] sale payment legs backfill v2: ${stamped ?? 0} v1 row(s) stamped as counter, ` +
        `${inserted ?? 0} missing counter-settlement history row(s) created (no accounting entries written)`,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

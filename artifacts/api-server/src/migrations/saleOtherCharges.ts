import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so this helper stays injectable. */
type Pool = typeof _pool;

/**
 * Other Charges on POS sales — Packing & Transport, Freight, Hamali, Courier
 * and the like, mirroring `purchases.other_charges`: a jsonb array of
 * { ledgerId, amount } rows validated against postable expense ledgers.
 *
 * Semantics differ from purchases in ONE deliberate way: on a sale the charge
 * is money the CUSTOMER owes, so it is folded into `total_amount` (the invoice
 * grand total that dues, receipts, credit checks and the customer's Dr leg all
 * key off). `subtotal` and `tax_total` stay goods-only — charges carry no GST,
 * so the GSTR-1 taxable value is untouched while the invoice value correctly
 * includes them. The derived postings credit each charge's expense ledger
 * (an expense RECOVERY), and the sales-revenue credit derives as
 * total − tax − charges so the P&L never inflates.
 *
 * Raw column: drizzle's schema cannot see it, so every reader and writer uses
 * raw SQL. Historical sales backfill to the empty array.
 */
export async function addSaleOtherCharges(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS other_charges jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
}

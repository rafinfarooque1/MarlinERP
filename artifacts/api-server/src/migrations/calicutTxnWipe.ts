import type { PgPool } from "@workspace/db";

/**
 * One-time production wipe of ALL transactional data belonging to the
 * warehouse "Frozen Hub - Calicut" (warehouse id 2, cash ledger 159),
 * requested by the owner on 2026-08-07 with explicit confirmation of the
 * FULL scope: every sales invoice, purchase bill, receipt voucher and
 * payment voucher stamped to that warehouse — including expense, loan,
 * investment and bank-deposit vouchers — plus all dependent rows, so the
 * warehouse's books restart from zero. Masters (customers, vendors, items,
 * chart of accounts, warehouses, users/HR) and every other location's data
 * are untouched.
 *
 * Scoped against the production replica on 2026-08-07:
 *   261 sales (₹272,887.18), 16 purchases (₹383,641.00),
 *   435 receipts (₹1,204,302.15), 142 payments (₹813,645.62),
 *   62 stock_entries (878 units), 86 purchase batches, 2,088 stock_ledger
 *   rows, 1 sale_payment leg (+1 reconciliation match), 1 share link,
 *   1 converted quotation. Zero returns, zero transfers touching Calicut,
 *   zero advance consumptions, zero cross-location settlements, zero
 *   opening balances on the till. Stock and cash both net to exactly zero
 *   by construction. A full JSON backup of every affected table was taken
 *   from the replica before this migration was written
 *   (backups/calicut-wipe-2026-08-07/ in the workspace).
 *
 * The books (TB, P&L, BS, GST, party balances) are DERIVED from these
 * source rows via buildDerivedPostings, so deleting them inside one
 * transaction reverses every posting atomically — there is no stored
 * ledger to correct. Stored state that IS unwound explicitly here, each
 * mirroring the application's own delete/cancel paths:
 *   - customers.total_purchases (decremented per wiped sale, floored at 0)
 *   - items.production_stock (decremented per wiped purchase line, floored
 *     at 0 — the same GREATEST(0, …) the purchase DELETE route uses; the
 *     Calicut lines are all materialType 'item', enforced by a gate below)
 *   - the quotation converted into a wiped sale reverts to 'sent'
 *
 * Safety gates, ALL of which must pass or nothing is deleted:
 *  1. migration_log marker absent (one-shot; written in the SAME
 *     transaction as the deletes).
 *  2. Environment gate: deletion runs ONLY when NODE_ENV === 'production'.
 *     The development database also holds Frozen Hub - Calicut data (a
 *     near-copy pinned by regression fixtures) and must never be wiped:
 *     in non-production, anchor matches → skip WITHOUT a marker; zero
 *     anchor matches → mark done (stop probing a database this cleanup
 *     was never for).
 *  3. Identity pin: warehouse 2 must be "Frozen Hub - Calicut" with
 *     cash_ledger_id 159, AND four anchor documents must match on id +
 *     number + amount + Calicut stamp (verified absent from development).
 *  4. Volume bounds: refuse if any stamped count exceeds a generous cap —
 *     a wildly larger dataset means this is not the database that was
 *     scoped, or the warehouse came back into heavy use before publish.
 *  5. Entanglement gates: refuse if any Calicut sale/purchase carries a
 *     branch_transfer_id (transfer legs must never be deleted here), if
 *     any purchase line is not materialType 'item', or if any
 *     sales_returns/purchase_returns row references a wiped document
 *     (returns were zero at scoping; one appearing means re-scope).
 *  6. In-transaction verification: zero stamped rows remain, zero stock
 *     rows remain at Calicut, no money voucher touches the Calicut till,
 *     and global orphan checks over every dependent table — any failure
 *     throws and rolls the whole transaction back.
 */
const GUARD = "calicut_txn_wipe_2026_08_v1";

const WH_ID = 2;
const WH_NAME = "Frozen Hub - Calicut";
const TILL_LEDGER_ID = 159;

/** Anchor fingerprints pinned from the production replica on 2026-08-07. */
const ANCHORS = {
  sale: { id: 283, number: "SB2C/2026-27/000258", amount: 1270.0 },
  receipt: { id: 300, number: "REC/2026-27/0015", amount: 525109.0 },
  payment: { id: 10, number: "PAY/2026-27/0010", amount: 150000.0 },
  purchase: { id: 2, number: "PE/4885/26-27", amount: 25220.0 },
};

/** Generous caps over the scoped counts (261/16/435/142). */
const MAX_COUNTS = { sales: 400, purchases: 50, receipts: 650, payments: 250 };

const SALES_WHERE = `location_type = 'warehouse' AND location_id = ${WH_ID}`;
const PURCH_WHERE = `((location_type = 'warehouse' AND location_id = ${WH_ID}) OR (branch_type = 'warehouse' AND branch_id = ${WH_ID}))`;
const MONEY_WHERE = `location_type = 'warehouse' AND location_id = ${WH_ID}`;
const STOCK_WHERE = `branch_type = 'warehouse' AND branch_id = ${WH_ID}`;

async function countAnchorMatches(pool: PgPool): Promise<number> {
  const near = (a: string | null, b: number) => Math.abs(Number(a ?? NaN) - b) < 0.005;
  let matches = 0;

  const { rows: [wh] } = await pool.query(
    `SELECT name, cash_ledger_id FROM warehouses WHERE id = $1`, [WH_ID]);
  if (wh && wh.name === WH_NAME && Number(wh.cash_ledger_id) === TILL_LEDGER_ID) matches++;

  const { rows: [s] } = await pool.query(
    `SELECT invoice_number, total_amount::text AS amt FROM sales
      WHERE id = $1 AND ${SALES_WHERE}`, [ANCHORS.sale.id]);
  if (s && s.invoice_number === ANCHORS.sale.number && near(s.amt, ANCHORS.sale.amount)) matches++;

  const { rows: [r] } = await pool.query(
    `SELECT voucher_number, amount::text AS amt FROM receipts
      WHERE id = $1 AND ${MONEY_WHERE}`, [ANCHORS.receipt.id]);
  if (r && r.voucher_number === ANCHORS.receipt.number && near(r.amt, ANCHORS.receipt.amount)) matches++;

  const { rows: [p] } = await pool.query(
    `SELECT voucher_number, amount::text AS amt FROM payments
      WHERE id = $1 AND ${MONEY_WHERE}`, [ANCHORS.payment.id]);
  if (p && p.voucher_number === ANCHORS.payment.number && near(p.amt, ANCHORS.payment.amount)) matches++;

  const { rows: [b] } = await pool.query(
    `SELECT invoice_number, total_amount::text AS amt FROM purchases
      WHERE id = $1 AND ${PURCH_WHERE}`, [ANCHORS.purchase.id]);
  if (b && b.invoice_number === ANCHORS.purchase.number && near(b.amt, ANCHORS.purchase.amount)) matches++;

  return matches; // out of 5
}

export async function wipeCalicutTransactions(pool: PgPool): Promise<string> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD]);
  if (done) return `${GUARD}: already applied`;

  const matches = await countAnchorMatches(pool);

  if (process.env.NODE_ENV !== "production") {
    if (matches === 0) {
      await pool.query(
        `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD]);
      return `${GUARD}: no anchor matches in this non-production database — marked done, nothing deleted`;
    }
    return `${GUARD}: skipped (${matches}/5 anchors present but NODE_ENV is not production) — nothing deleted, no marker written`;
  }

  // Production: identity must be exact, or refuse loudly (no marker → retries).
  if (matches !== 5) {
    return `${GUARD}: REFUSED — only ${matches}/5 identity anchors match; this is not the scoped database, nothing deleted`;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize against anything else touching this warehouse.
    await client.query(`SELECT id FROM warehouses WHERE id = $1 FOR UPDATE`, [WH_ID]);

    // ── Capture the target sets ────────────────────────────────────────────
    await client.query(`CREATE TEMP TABLE wipe_sales ON COMMIT DROP AS
      SELECT id, customer_id, total_amount::numeric AS total_amount, branch_transfer_id
        FROM sales WHERE ${SALES_WHERE}`);
    await client.query(`CREATE TEMP TABLE wipe_purchases ON COMMIT DROP AS
      SELECT id, line_items, branch_transfer_id FROM purchases WHERE ${PURCH_WHERE}`);
    await client.query(`CREATE TEMP TABLE wipe_receipts ON COMMIT DROP AS
      SELECT id FROM receipts WHERE ${MONEY_WHERE}`);
    await client.query(`CREATE TEMP TABLE wipe_payments ON COMMIT DROP AS
      SELECT id FROM payments WHERE ${MONEY_WHERE}`);

    const { rows: [n] } = await client.query(`SELECT
      (SELECT COUNT(*) FROM wipe_sales)::int AS sales,
      (SELECT COUNT(*) FROM wipe_purchases)::int AS purchases,
      (SELECT COUNT(*) FROM wipe_receipts)::int AS receipts,
      (SELECT COUNT(*) FROM wipe_payments)::int AS payments,
      (SELECT COUNT(*) FROM wipe_sales WHERE branch_transfer_id IS NOT NULL)::int AS transfer_sales,
      (SELECT COUNT(*) FROM wipe_purchases WHERE branch_transfer_id IS NOT NULL)::int AS transfer_purchases,
      (SELECT COUNT(*) FROM sales_returns sr WHERE sr.sale_id IN (SELECT id FROM wipe_sales))::int AS sales_returns,
      (SELECT COUNT(*) FROM purchase_returns pr WHERE pr.purchase_id IN (SELECT id FROM wipe_purchases))::int AS purchase_returns,
      (SELECT COUNT(*) FROM wipe_purchases p, jsonb_array_elements(p.line_items::jsonb) li
        WHERE COALESCE(li->>'materialType', 'item') <> 'item')::int AS non_item_lines,
      (SELECT COUNT(*) FROM payment_bill_allocations pba
        WHERE (pba.payment_id IN (SELECT id FROM wipe_payments)) <>
              (pba.purchase_id IN (SELECT id FROM wipe_purchases)))::int AS mixed_allocations,
      (SELECT COUNT(*) FROM advance_consumptions ac
        WHERE (ac.source_receipt_id IN (SELECT id FROM wipe_receipts)
            OR ac.source_payment_id IN (SELECT id FROM wipe_payments)
            OR ac.consumer_sale_id IN (SELECT id FROM wipe_sales)
            OR ac.consumer_purchase_id IN (SELECT id FROM wipe_purchases))
          AND NOT (
            COALESCE(ac.source_receipt_id IN (SELECT id FROM wipe_receipts), true)
            AND COALESCE(ac.source_payment_id IN (SELECT id FROM wipe_payments), true)
            AND COALESCE(ac.consumer_sale_id IN (SELECT id FROM wipe_sales), true)
            AND COALESCE(ac.consumer_purchase_id IN (SELECT id FROM wipe_purchases), true)))::int AS mixed_advances,
      (SELECT COUNT(*) FROM stock_ledger
        WHERE ${STOCK_WHERE}
          AND txn_type NOT IN ('purchase','purchase_reversal','sale','sale_cancellation'))::int AS unscoped_stock_txns,
      (SELECT COUNT(*) FROM rent_payments rp
        WHERE rp.voucher_id IN (SELECT id FROM wipe_payments))::int AS rent_refs,
      (SELECT COUNT(*) FROM stock_transfers st
        WHERE st.sale_id IN (SELECT id FROM wipe_sales)
           OR st.purchase_id IN (SELECT id FROM wipe_purchases)
           OR st.dispatch_voucher_id IN (SELECT id FROM wipe_payments)
           OR st.receive_voucher_id IN (SELECT id FROM wipe_receipts))::int AS transfer_refs`);

    // ── Gates 4 & 5 ────────────────────────────────────────────────────────
    if (n.sales > MAX_COUNTS.sales || n.purchases > MAX_COUNTS.purchases ||
        n.receipts > MAX_COUNTS.receipts || n.payments > MAX_COUNTS.payments) {
      throw new Error(
        `volume bound exceeded (sales=${n.sales}, purchases=${n.purchases}, ` +
        `receipts=${n.receipts}, payments=${n.payments}) — dataset differs from scoping, refusing`);
    }
    if (n.transfer_sales > 0 || n.transfer_purchases > 0) {
      throw new Error(
        `${n.transfer_sales + n.transfer_purchases} transfer-linked invoice(s) stamped to Calicut — ` +
        `transfer legs must never be wiped, refusing (re-scope required)`);
    }
    if (n.sales_returns > 0 || n.purchase_returns > 0) {
      throw new Error(
        `${n.sales_returns + n.purchase_returns} return(s) reference wiped documents — ` +
        `returns were zero at scoping, refusing (re-scope required)`);
    }
    if (n.non_item_lines > 0) {
      throw new Error(
        `${n.non_item_lines} purchase line(s) are not materialType 'item' — ` +
        `material/raw-material unwind was not scoped, refusing`);
    }
    if (n.mixed_allocations > 0 || n.mixed_advances > 0) {
      throw new Error(
        `${n.mixed_allocations} bill allocation(s) / ${n.mixed_advances} advance consumption(s) ` +
        `link Calicut documents to other locations — deleting them would alter another ` +
        `location's settlement state, refusing (re-scope required)`);
    }
    if (n.unscoped_stock_txns > 0) {
      throw new Error(
        `${n.unscoped_stock_txns} Calicut stock ledger row(s) have transaction types outside ` +
        `purchase/sale (e.g. transfers, adjustments, production) that were zero at scoping, refusing`);
    }
    if (n.rent_refs > 0 || n.transfer_refs > 0) {
      throw new Error(
        `${n.rent_refs} rent payment(s) / ${n.transfer_refs} stock transfer(s) reference wiped ` +
        `vouchers — these were zero at scoping, refusing (re-scope required)`);
    }

    const removed: string[] = [];
    const del = async (label: string, sql: string) => {
      const r = await client.query(sql);
      removed.push(`${label}=${r.rowCount ?? 0}`);
      return r.rowCount ?? 0;
    };

    // ── Children before parents ────────────────────────────────────────────
    await del("reconciliation_batch_items", `
      DELETE FROM reconciliation_batch_items WHERE sale_payment_id IN
        (SELECT id FROM sale_payments WHERE sale_id IN (SELECT id FROM wipe_sales))`);
    await del("invoice_share_links", `
      DELETE FROM invoice_share_links WHERE sale_id IN (SELECT id FROM wipe_sales)`);
    await del("sale_payments", `
      DELETE FROM sale_payments WHERE sale_id IN (SELECT id FROM wipe_sales)`);
    await del("advance_consumptions", `
      DELETE FROM advance_consumptions
       WHERE source_receipt_id IN (SELECT id FROM wipe_receipts)
          OR source_payment_id IN (SELECT id FROM wipe_payments)
          OR consumer_sale_id IN (SELECT id FROM wipe_sales)
          OR consumer_purchase_id IN (SELECT id FROM wipe_purchases)`);
    await del("payment_bill_allocations", `
      DELETE FROM payment_bill_allocations
       WHERE payment_id IN (SELECT id FROM wipe_payments)
          OR purchase_id IN (SELECT id FROM wipe_purchases)`);
    await del("purchase_advance_applications", `
      DELETE FROM purchase_advance_applications
       WHERE purchase_id IN (SELECT id FROM wipe_purchases)`);
    await del("cash_deposits", `
      DELETE FROM cash_deposits
       WHERE transit_payment_id IN (SELECT id FROM wipe_payments)
          OR bank_receipt_id IN (SELECT id FROM wipe_receipts)
          OR (warehouse_id = ${WH_ID} AND outlet_id IS NULL)
          OR source_cash_ledger_id = ${TILL_LEDGER_ID}`);

    // Quotation converted into a wiped sale reverts to a plain sent quote.
    await del("quotations_unconverted", `
      UPDATE quotations SET converted_sale_id = NULL, converted_invoice_number = NULL, status = 'sent'
       WHERE converted_sale_id IN (SELECT id FROM wipe_sales)`);

    // ── Stored aggregates, mirroring the app's own unwind paths ────────────
    await del("customers_totals_reduced", `
      UPDATE customers c SET total_purchases = GREATEST(0, c.total_purchases::numeric - w.sum_total)
        FROM (SELECT customer_id, SUM(total_amount) AS sum_total FROM wipe_sales
               WHERE customer_id IS NOT NULL GROUP BY customer_id) w
       WHERE c.id = w.customer_id`);
    await del("items_production_stock_reduced", `
      UPDATE items i SET production_stock = GREATEST(0, i.production_stock::numeric - w.qty)
        FROM (SELECT (li->>'materialId')::int AS item_id, SUM((li->>'quantity')::numeric) AS qty
                FROM wipe_purchases p, jsonb_array_elements(p.line_items::jsonb) li
               GROUP BY 1) w
       WHERE i.id = w.item_id`);

    // ── The documents themselves ───────────────────────────────────────────
    await del("receipts", `DELETE FROM receipts WHERE id IN (SELECT id FROM wipe_receipts)`);
    await del("payments", `DELETE FROM payments WHERE id IN (SELECT id FROM wipe_payments)`);
    await del("sales", `DELETE FROM sales WHERE id IN (SELECT id FROM wipe_sales)`);
    await del("purchases", `DELETE FROM purchases WHERE id IN (SELECT id FROM wipe_purchases)`);

    // ── Stock state at Calicut (nets to zero by scoping; wiped wholesale) ──
    await del("stock_batches", `DELETE FROM stock_batches WHERE ${STOCK_WHERE}`);
    await del("stock_entries", `DELETE FROM stock_entries WHERE ${STOCK_WHERE}`);
    await del("stock_ledger", `DELETE FROM stock_ledger WHERE ${STOCK_WHERE}`);
    await del("stock_reservations", `DELETE FROM stock_reservations WHERE ${STOCK_WHERE}`);

    // ── In-transaction verification (throws → full rollback) ──────────────
    const { rows: [chk] } = await client.query(`SELECT
      (SELECT COUNT(*) FROM sales WHERE ${SALES_WHERE})::int AS sales_left,
      (SELECT COUNT(*) FROM purchases WHERE ${PURCH_WHERE})::int AS purchases_left,
      (SELECT COUNT(*) FROM receipts WHERE ${MONEY_WHERE})::int AS receipts_left,
      (SELECT COUNT(*) FROM payments WHERE ${MONEY_WHERE})::int AS payments_left,
      (SELECT COUNT(*) FROM stock_entries WHERE ${STOCK_WHERE})::int
        + (SELECT COUNT(*) FROM stock_batches WHERE ${STOCK_WHERE})::int
        + (SELECT COUNT(*) FROM stock_ledger WHERE ${STOCK_WHERE})::int AS stock_left,
      (SELECT COUNT(*) FROM receipts WHERE received_in_ledger_id = ${TILL_LEDGER_ID}
          OR received_from_ledger_id = ${TILL_LEDGER_ID})::int
        + (SELECT COUNT(*) FROM payments WHERE paid_from_ledger_id = ${TILL_LEDGER_ID}
          OR paid_to_ledger_id = ${TILL_LEDGER_ID})::int AS till_touches,
      (SELECT COUNT(*) FROM sale_payments sp
         WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = sp.sale_id))::int AS orphan_sale_payments,
      (SELECT COUNT(*) FROM invoice_share_links l
         WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = l.sale_id))::int AS orphan_share_links,
      (SELECT COUNT(*) FROM payment_bill_allocations pba
         WHERE NOT EXISTS (SELECT 1 FROM payments pm WHERE pm.id = pba.payment_id)
            OR NOT EXISTS (SELECT 1 FROM purchases p WHERE p.id = pba.purchase_id))::int AS orphan_allocations,
      (SELECT COUNT(*) FROM reconciliation_batch_items rbi
         WHERE NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.id = rbi.sale_payment_id))::int AS orphan_recon,
      (SELECT COUNT(*) FROM advance_consumptions ac
         WHERE (ac.source_receipt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.id = ac.source_receipt_id))
            OR (ac.source_payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments pm WHERE pm.id = ac.source_payment_id))
            OR (ac.consumer_sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = ac.consumer_sale_id))
            OR (ac.consumer_purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.id = ac.consumer_purchase_id)))::int AS orphan_adv,
      (SELECT COUNT(*) FROM quotations q
         WHERE q.converted_sale_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = q.converted_sale_id))::int AS orphan_quotes,
      (SELECT COUNT(*) FROM cash_deposits cd
         WHERE (cd.transit_payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments pm WHERE pm.id = cd.transit_payment_id))
            OR (cd.bank_receipt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.id = cd.bank_receipt_id)))::int AS orphan_deposits,
      (SELECT COUNT(*) FROM rent_payments rp
         WHERE rp.voucher_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM payments pm WHERE pm.id = rp.voucher_id))::int AS orphan_rent,
      (SELECT COUNT(*) FROM stock_transfers st
         WHERE (st.sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = st.sale_id))
            OR (st.purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.id = st.purchase_id)))::int AS orphan_transfers`);

    const failures = Object.entries(chk).filter(([, v]) => Number(v) !== 0);
    if (failures.length > 0) {
      throw new Error(
        `post-wipe verification failed (${failures.map(([k, v]) => `${k}=${v}`).join(", ")}) — rolling back`);
    }

    // Marker in the SAME transaction as the deletes — all-or-nothing.
    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [GUARD]);
    await client.query("COMMIT");

    return `${GUARD} applied — removed { ${removed.join(", ")} }; all post-wipe checks passed (Calicut stock, till and documents all zero)`;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

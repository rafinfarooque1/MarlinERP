/**
 * Preserve the three historical vendor payment vouchers while correcting the
 * bill-wise allocation error found by the accounting audit.
 *
 * The excess remains money paid to the vendor: it is moved from the bill
 * allocation into the existing vendor-advance model. The migration is guarded
 * by both invoice numbers and the exact audited allocation shape, so it cannot
 * rewrite an already-correct or unrelated database.
 */
import type { PgPool as Pool } from "@workspace/db";
import { ensureAdvanceLedger } from "../lib/advanceLedgers";

const MIGRATION_NAME = "vendor_allocation_correction_2026_09";

export async function correctVendorAllocations(pool: Pool): Promise<void> {
  const { rowCount: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [MIGRATION_NAME],
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);
    const { rows: bills } = await client.query(`
      SELECT id, invoice_number, vendor_id, total_amount::numeric AS total_amount
        FROM purchases
       WHERE invoice_number IN ('5052', '5408')
       ORDER BY invoice_number
       FOR UPDATE
    `);
    if (bills.length !== 2 || bills.some((b: any) => Number(b.vendor_id) !== 22)) {
      await client.query("ROLLBACK");
      console.warn(`[migration] ${MIGRATION_NAME}: audited invoices not present; no correction applied`);
      return;
    }
    const byInvoice = new Map(bills.map((b: any) => [String(b.invoice_number), b]));
    const b5052 = byInvoice.get("5052");
    const b5408 = byInvoice.get("5408");
    const { rows: allocations } = await client.query(`
      SELECT a.payment_id, a.purchase_id, a.amount::numeric AS amount, p.amount::numeric AS payment_amount
        FROM payment_bill_allocations a
        JOIN payments p ON p.id = a.payment_id
       WHERE a.purchase_id = ANY($1::int[])
       ORDER BY a.purchase_id, a.payment_id
       FOR UPDATE OF a, p
    `, [[b5052.id, b5408.id]]);
    const shape = allocations.map((a: any) =>
      `${Number(a.purchase_id)}:${Number(a.payment_id)}:${Number(a.amount)}`,
    );
    const expected = [
      `${Number(b5052.id)}:184:23279`,
      `${Number(b5408.id)}:186:12500`,
      `${Number(b5408.id)}:187:730`,
    ];
    if (shape.join("|") !== expected.join("|")) {
      await client.query("ROLLBACK");
      console.warn(`[migration] ${MIGRATION_NAME}: audited allocation shape changed; no correction applied`);
      return;
    }

    const advanceLedgerId = await ensureAdvanceLedger(
      client, "vendor", 22, "MANDAR FOOD PRODUCTS",
    );
    await client.query(
      `UPDATE payment_bill_allocations SET amount = $1 WHERE payment_id = 184 AND purchase_id = $2`,
      [22019, b5052.id],
    );
    await client.query(
      `UPDATE payments SET advance_amount = $1, advance_ledger_id = $2 WHERE id = 184`,
      [1260, advanceLedgerId],
    );
    await client.query(
      `UPDATE payment_bill_allocations SET amount = $1 WHERE payment_id = 186 AND purchase_id = $2`,
      [11870, b5408.id],
    );
    await client.query(
      `UPDATE payments SET advance_amount = $1, advance_ledger_id = $2 WHERE id = 186`,
      [630, advanceLedgerId],
    );
    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: moved ₹1,890 into vendor advance VADV-22`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migration] ${MIGRATION_NAME} FAILED — will retry next boot:`, error);
  } finally {
    client.release();
  }
}
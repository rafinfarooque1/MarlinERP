import type { PgPool } from "@workspace/db";
import { computePaymentPosition, loadPaymentPosition } from "../lib/salePaymentPosition";

/**
 * One-time production cleanup of ten settlement ("allocation") receipt
 * vouchers, requested by the owner on 2026-08-05. These were created through
 * the bill-wise settlement UI against the "CASH SALE" customer (CUST-78) at
 * Frozen Hub - Calicut and must be removed as if they never existed.
 *
 * This deliberately reuses the SAME unwind the application performs in
 * DELETE /accounts/receipts/:id for allocation vouchers (routes/accounts.ts):
 * delete each linked sale_payments leg, recompute the invoice's amount_paid
 * and payment_status via computePaymentPosition, then delete the receipt row.
 * The books (trial balance, cash/bank book, customer ledger) are DERIVED from
 * these rows, so removing them inside one transaction reverses every posting
 * atomically — there is no stored ledger to correct and no possibility of a
 * half-reversed voucher. Voucher numbering is allocator-based and is never
 * renumbered by a delete.
 *
 * Safety gates, all of which must pass or nothing is deleted:
 *  1. migration_log marker absent (one-shot; written in the SAME transaction
 *     as the deletes so a data-shape probe can never re-fire it).
 *  2. Environment gate: deletion runs ONLY when NODE_ENV === 'production'.
 *     A non-production database with fingerprint matches (e.g. a restored
 *     production clone in development) is SKIPPED without a marker — it
 *     neither deletes nor suppresses the pending production cleanup.
 *  3. Identity pin: each voucher must match on primary-key id AND
 *     voucher_number AND amount AND source='allocation' AND payer ledger
 *     code 'CUST-78'. The id makes the fingerprint database-specific — a
 *     different database with a same-numbered voucher cannot line all five
 *     up. (Development's unrelated REC/2026-27/0017 — ₹50, sale-trail,
 *     STD-SALES, different id — was verified excluded.)
 *  4. All-or-nothing: anything other than exactly 10 full matches (including
 *     ZERO on an unmarked production database) throws — nothing is deleted,
 *     the marker is NOT written, the failure lands in stderr + boot_status,
 *     and it retries next boot after re-inspection. Zero matches marks done
 *     only on non-production databases, where the pending production cleanup
 *     is not at stake.
 *  5. Re-verified inside the transaction, under row locks: no advance money
 *     on any voucher, no advance_consumptions referencing it, no
 *     reconciliation_batch_items referencing any of its payment legs, and
 *     each voucher's legs sum to its amount.
 *
 * Verified against the production replica on 2026-08-05 before writing this:
 * 10 receipts, 22 sale_payments legs across 13 invoices, ₹4,320.00 total,
 * zero advance amounts, zero advance consumptions, zero reconciliation refs.
 */
const GUARD = "allocation_receipt_cleanup_2026_08_v1";

const REASON =
  "One-time production cleanup of unwanted system-generated settlement receipts — " +
  "requested by the owner on 2026-08-05.";

export interface CleanupSpec {
  id: number;           // primary key in the TARGET database — the identity pin
  voucherNumber: string;
  amount: number;       // exact rupee amount
}

/** Fingerprints pinned from the production replica on 2026-08-05. */
const SPEC: CleanupSpec[] = [
  { id: 439, voucherNumber: "REC/2026-27/0017", amount: 300.0 },
  { id: 441, voucherNumber: "REC/2026-27/0019", amount: 280.0 },
  { id: 443, voucherNumber: "REC/2026-27/0021", amount: 580.0 },
  { id: 444, voucherNumber: "REC/2026-27/0022", amount: 315.0 },
  { id: 445, voucherNumber: "REC/2026-27/0023", amount: 100.0 },
  { id: 447, voucherNumber: "REC/2026-27/0025", amount: 210.0 },
  { id: 449, voucherNumber: "REC/2026-27/0027", amount: 320.0 },
  { id: 450, voucherNumber: "REC/2026-27/0028", amount: 710.0 },
  { id: 453, voucherNumber: "REC/2026-27/0031", amount: 320.0 },
  { id: 456, voucherNumber: "REC/2026-27/0034", amount: 1185.0 },
];

const PAYER_LEDGER_CODE = "CUST-78";

const money2 = (n: number) => Math.round(n * 100) / 100;

function specMatches(row: any, spec: CleanupSpec[], payerLedgerCode: string): CleanupSpec | undefined {
  const s = spec.find((x) => x.id === Number(row.id));
  if (!s) return undefined;
  const ok = row.voucher_number === s.voucherNumber
    && row.source === "allocation"
    && row.from_code === payerLedgerCode
    && Math.abs(Number(row.amount) - s.amount) < 0.005;
  return ok ? s : undefined;
}

async function countFingerprintMatches(
  pool: PgPool, spec: CleanupSpec[], payerLedgerCode: string,
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT r.id, r.voucher_number, r.amount::numeric AS amount, r.source, lf.code AS from_code
       FROM receipts r
       LEFT JOIN account_ledgers lf ON lf.id = r.received_from_ledger_id
      WHERE r.id = ANY($1::int[])`,
    [spec.map((s) => s.id)],
  );
  return rows.filter((r: any) => specMatches(r, spec, payerLedgerCode) !== undefined).length;
}

export async function cleanupAllocationReceipts(pool: PgPool): Promise<string> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return `${GUARD}: already applied`;

  const matches = await countFingerprintMatches(pool, SPEC, PAYER_LEDGER_CODE);

  if (process.env.NODE_ENV !== "production") {
    if (matches === 0) {
      // Not the database this cleanup targets — stop probing on every boot.
      await pool.query(
        `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD],
      );
      return `${GUARD}: no fingerprint matches in this non-production database — marked done, nothing deleted`;
    }
    // A production clone restored into a non-production environment: touch
    // nothing, write no marker — the real cleanup must still run in prod.
    return `${GUARD}: skipped (${matches} fingerprint match(es) present but NODE_ENV is not production) — nothing deleted, no marker written`;
  }

  if (matches === 0) {
    // Production with no marker and no vouchers: this is not the state that
    // was verified on 2026-08-05. Never guess — refuse loudly, retry next
    // boot, leave the trail in boot_status for investigation.
    throw new Error(
      `${GUARD}: production database has NO fingerprint matches and no completion marker — ` +
      `refusing to mark done; investigate before publishing again`,
    );
  }

  return runAllocationReceiptCleanup(pool, SPEC, GUARD, REASON, PAYER_LEDGER_CODE);
}

/**
 * Parameterised core so the exact code path can be rehearsed in development
 * against fixture vouchers before it ever runs in production. Environment
 * policy lives in cleanupAllocationReceipts() above — this core is the
 * all-or-nothing executor: EXACTLY spec.length full-fingerprint matches or
 * it throws without deleting anything.
 */
export async function runAllocationReceiptCleanup(
  pool: PgPool,
  spec: CleanupSpec[],
  guard: string,
  reason: string,
  payerLedgerCode: string,
): Promise<string> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [guard],
  );
  if (done) return `${guard}: already applied`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the pinned rows in a deterministic order and verify every
    // fingerprint component under the lock. All-or-nothing: any shortfall or
    // mismatch aborts the whole batch.
    const ids = spec.map((s) => s.id).sort((a, b) => a - b);
    const { rows: locked } = await client.query(
      `SELECT r.id, r.voucher_number, r.receipt_date, r.amount::numeric AS amount,
              r.source, r.advance_amount::numeric AS advance_amount,
              r.received_from_ledger_id, r.received_in_ledger_id, lf.code AS from_code
         FROM receipts r
         LEFT JOIN account_ledgers lf ON lf.id = r.received_from_ledger_id
        WHERE r.id = ANY($1::int[])
        ORDER BY r.id
          FOR UPDATE OF r`,
      [ids],
    );
    const verified = locked.filter((r: any) => specMatches(r, spec, payerLedgerCode) !== undefined);
    if (verified.length !== spec.length) {
      throw new Error(
        `${guard}: expected ${spec.length} full fingerprint matches under lock, found ${verified.length} ` +
        `(${verified.map((m: any) => m.voucher_number).join(", ") || "none"}) — refusing to delete anything`,
      );
    }
    for (const row of verified) {
      if (Number(row.advance_amount ?? 0) > 0.004) {
        throw new Error(`${guard}: ${row.voucher_number} carries advance money — refusing (needs the app's advance guards)`);
      }
    }

    // No advance slice of any of these vouchers may have been consumed.
    const { rows: [cons] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM advance_consumptions WHERE source_receipt_id = ANY($1::int[])`,
      [ids],
    );
    if (cons.n > 0) {
      throw new Error(`${guard}: ${cons.n} advance consumption(s) reference these vouchers — refusing`);
    }

    // Collect every payment leg; none may sit inside a reconciliation batch.
    const { rows: legs } = await client.query(
      `SELECT sp.id, sp.sale_id, sp.amount::numeric AS amount, sp.clearing_receipt_id
         FROM sale_payments sp
        WHERE sp.clearing_receipt_id = ANY($1::int[])
        ORDER BY sp.sale_id ASC, sp.id ASC`,
      [ids],
    );
    const legIds = legs.map((l: any) => Number(l.id));
    if (legIds.length > 0) {
      const { rows: [recon] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM reconciliation_batch_items WHERE sale_payment_id = ANY($1::int[])`,
        [legIds],
      );
      if (recon.n > 0) {
        throw new Error(`${guard}: ${recon.n} payment leg(s) are inside a bank reconciliation batch — refusing`);
      }
    }
    // Integrity: each voucher's legs must sum to its amount.
    for (const row of verified) {
      const sum = legs
        .filter((l: any) => Number(l.clearing_receipt_id) === Number(row.id))
        .reduce((a: number, l: any) => a + Number(l.amount), 0);
      if (Math.abs(money2(sum) - Number(row.amount)) >= 0.02) {
        throw new Error(
          `${guard}: legs of ${row.voucher_number} sum to ₹${money2(sum).toFixed(2)} ` +
          `but the voucher is ₹${Number(row.amount).toFixed(2)} — refusing`,
        );
      }
    }

    // Unwind — identical to the allocation branch of DELETE /accounts/receipts/:id.
    const invoiceChanges: Array<{ saleId: number; removed: number; newPaid: number; newStatus: string }> = [];
    for (const leg of legs) {
      const { rows: [sale] } = await client.query(
        `SELECT id, total_amount::numeric AS total_amount, amount_paid::numeric AS amount_paid
           FROM sales WHERE id = $1 FOR UPDATE`,
        [leg.sale_id],
      );
      if (!sale) continue;
      await client.query(`DELETE FROM sale_payments WHERE id = $1`, [leg.id]);
      const newPaid = money2(Math.max(0, Number(sale.amount_paid) - Number(leg.amount)));
      const pos = await loadPaymentPosition(client, Number(leg.sale_id));
      const newPos = computePaymentPosition({
        totalAmount: Number(sale.total_amount), amountReceived: newPaid,
        creditAdjustments: pos?.creditAdjustments ?? 0, cancelledAt: null,
      });
      await client.query(
        `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
        [newPaid, newPos.status, leg.sale_id],
      );
      invoiceChanges.push({
        saleId: Number(leg.sale_id), removed: Number(leg.amount),
        newPaid, newStatus: newPos.status,
      });
    }

    await client.query(`DELETE FROM receipts WHERE id = ANY($1::int[])`, [ids]);

    // Audit: who, when, why — one entry per voucher, written in the SAME
    // transaction so the audit trail can never exist without the deletion
    // (or vice versa).
    for (const row of verified) {
      const rowLegs = legs.filter((l: any) => Number(l.clearing_receipt_id) === Number(row.id));
      await client.query(
        `INSERT INTO activity_log (action, module, entity_type, entity_id, description, "user", type, metadata)
         VALUES ('DELETE', 'accounts', 'receipt_voucher', $1, $2, $3, 'DELETE', $4::jsonb)`,
        [
          Number(row.id),
          `Settlement receipt ${row.voucher_number} deleted — ₹${Number(row.amount).toLocaleString("en-IN")}, ` +
            `${rowLegs.length} bill allocation(s) unwound (one-time cleanup)`,
          "admin (owner-requested cleanup)",
          JSON.stringify({
            reason,
            guard,
            old: {
              voucherNumber: row.voucher_number,
              date: row.receipt_date,
              amount: Number(row.amount),
              receivedFromLedgerId: Number(row.received_from_ledger_id),
              receivedInLedgerId: Number(row.received_in_ledger_id),
              allocations: rowLegs.map((l: any) => ({ saleId: Number(l.sale_id), amount: Number(l.amount) })),
            },
          }),
        ],
      );
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [guard],
    );
    await client.query("COMMIT");

    const total = verified.reduce((a: number, r: any) => a + Number(r.amount), 0);
    const saleIds = [...new Set(invoiceChanges.map((c) => c.saleId))];
    return (
      `${guard}: deleted ${verified.length} settlement receipt(s) totalling ₹${money2(total).toFixed(2)}, ` +
      `unwound ${invoiceChanges.length} allocation leg(s) across ${saleIds.length} invoice(s) — ` +
      `all in one transaction`
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

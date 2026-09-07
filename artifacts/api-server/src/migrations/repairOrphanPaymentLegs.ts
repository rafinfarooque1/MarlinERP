import type { PgPool } from "@workspace/db";
import { logActivity } from "../lib/audit";

/**
 * Repair only the legacy payment rows whose outgoing leg points at a deleted
 * ledger but whose source and stamped location make the replacement
 * unambiguous.
 *
 * This is deliberately narrow:
 *   - vendor/allocation payments only;
 *   - the missing leg must be paid_from, never paid_to;
 *   - the stamped location must have one deterministic branch till;
 *   - the vendor ledger must still exist and be postable;
 *   - ambiguous or otherwise orphaned rows are left for manual review.
 *
 * No balancing journal is invented. The existing payment is repaired in place
 * and each changed row receives an audit event after the transaction commits.
 */
const GUARD = "orphan_payment_legs_v1";

export async function repairOrphanPaymentLegs(pool: PgPool): Promise<void> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`,
    [GUARD],
  );
  if (done) return;

  const client = await pool.connect();
  const repaired: any[] = [];
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(`
      WITH owners AS (
        SELECT cash_ledger_id AS ledger_id, 'warehouse' AS location_type, id AS location_id
          FROM warehouses
         WHERE cash_ledger_id IS NOT NULL
        UNION
        SELECT cash_ledger_id, 'outlet', id
          FROM outlets
         WHERE cash_ledger_id IS NOT NULL
      ), picked AS (
        SELECT DISTINCT ON (ledger_id) ledger_id, location_type, location_id
          FROM owners
         ORDER BY ledger_id,
                  CASE WHEN location_type = 'warehouse' THEN 0 ELSE 1 END,
                  location_id
      )
      SELECT p.id, p.voucher_number, p.paid_from_ledger_id,
             p.paid_to_ledger_id, p.amount::numeric AS amount,
             p.location_type, p.location_id, p.source,
             picked.ledger_id AS replacement_ledger_id,
             to_ledger.code AS paid_to_code
        FROM payments p
        JOIN picked
          ON picked.location_type = p.location_type
         AND picked.location_id = p.location_id
        JOIN account_ledgers till
          ON till.id = picked.ledger_id
         AND till.is_active = true
         AND till.is_group = false
        JOIN account_ledgers to_ledger
          ON to_ledger.id = p.paid_to_ledger_id
         AND to_ledger.is_active = true
         AND to_ledger.is_group = false
       WHERE p.source IN ('vendor', 'allocation')
         AND p.paid_from_ledger_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM account_ledgers from_ledger
            WHERE from_ledger.id = p.paid_from_ledger_id
         )
         AND to_ledger.code ~ '^VEND-[0-9]+$'
       ORDER BY p.id
    `);

    for (const row of rows) {
      const { rows: [updated] } = await client.query(
        `UPDATE payments
            SET paid_from_ledger_id = $1
          WHERE id = $2
            AND paid_from_ledger_id = $3
          RETURNING id, voucher_number, paid_from_ledger_id`,
        [Number(row.replacement_ledger_id), Number(row.id), Number(row.paid_from_ledger_id)],
      );
      if (updated) repaired.push({
        ...row,
        replacementLedgerId: Number(updated.paid_from_ledger_id),
      });
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [GUARD],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const row of repaired) {
    logActivity({
      action: "UPDATE",
      module: "accounts",
      entityType: "payment_voucher",
      entityId: Number(row.id),
      description: `Repaired orphan payment ${row.voucher_number ?? `#${row.id}`} source ledger`,
      metadata: {
        reason: "legacy paid_from ledger no longer exists",
        before: {
          paidFromLedgerId: Number(row.paid_from_ledger_id),
          paidToLedgerId: Number(row.paid_to_ledger_id),
          amount: Number(row.amount),
        },
        after: {
          paidFromLedgerId: Number(row.replacementLedgerId),
          paidToLedgerId: Number(row.paid_to_ledger_id),
          amount: Number(row.amount),
        },
      },
    }).catch(() => {});
  }

  if (repaired.length > 0) {
    console.log(`[migration] ${GUARD}: repaired ${repaired.length} unambiguous orphan payment leg(s)`);
  }
}
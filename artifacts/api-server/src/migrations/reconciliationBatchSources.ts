import type { PgPool } from "@workspace/db";

/**
 * Stores the source documents linked to an accounting-impact reconciliation
 * batch. The reset flow snapshots these identities, reverses the generated
 * settlement voucher, then clears the links so the original items are pending
 * again and can be settled later.
 *
 * This is an additive, idempotent schema change; existing batch rows receive
 * an empty source list and remain untouched.
 */
export async function addReconciliationBatchSources(pool: PgPool): Promise<void> {
  await pool.query(`
    ALTER TABLE bank_reconciliation_batches
      ADD COLUMN IF NOT EXISTS source_items jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
}
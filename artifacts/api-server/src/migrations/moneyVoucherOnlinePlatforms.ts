import type { PgPool } from "@workspace/db";

/** Stores the selected Online Platform separately from the Electronic Clearing posting ledger. */
export async function addMoneyVoucherOnlinePlatforms(pool: PgPool): Promise<void> {
  await pool.query(`
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS online_platform_ledger_id integer;
    ALTER TABLE receipts
      ADD COLUMN IF NOT EXISTS online_platform_ledger_id integer;
    CREATE INDEX IF NOT EXISTS idx_payments_online_platform
      ON payments(online_platform_ledger_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_online_platform
      ON receipts(online_platform_ledger_id);
  `);
}
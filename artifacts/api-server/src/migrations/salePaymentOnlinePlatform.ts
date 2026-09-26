import type { PgPool } from "@workspace/db";

/** Stores the location-assigned online platform chosen at collection time. */
export async function addSalePaymentOnlinePlatform(pool: PgPool): Promise<void> {
  await pool.query(`
    ALTER TABLE sale_payments
      ADD COLUMN IF NOT EXISTS online_platform_ledger_id integer;
    CREATE INDEX IF NOT EXISTS idx_sale_payments_online_platform
      ON sale_payments(online_platform_ledger_id);
  `);
}
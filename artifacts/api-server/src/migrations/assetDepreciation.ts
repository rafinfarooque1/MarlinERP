/**
 * Straight-line fixed-asset depreciation.
 *
 * One row per asset and accounting month is the idempotency key. The row points
 * to the journal voucher that posted Dr Depreciation Expense / Cr Accumulated
 * Depreciation, so reports use the same journal stream as every other book.
 */
import type { PgPool as Pool } from "@workspace/db";
import { resolveChartParentId } from "../lib/chartGroups";

export const DEPRECIATION_EXPENSE_CODE = "STD-DEPR-EXP";
export const ACCUMULATED_DEPRECIATION_CODE = "STD-ACCUM-DEPR";
export const ASSET_DISPOSAL_LOSS_CODE = "STD-ASSET-DISP-LOSS";
const MIGRATION_NAME = "asset_depreciation_v1";

export async function addAssetDepreciation(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_depreciation_runs (
        id                 BIGSERIAL PRIMARY KEY,
        asset_purchase_id  INTEGER NOT NULL,
        period_start       DATE NOT NULL,
        amount             NUMERIC(14,2) NOT NULL,
        journal_voucher_id INTEGER NOT NULL,
        created_by         TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (asset_purchase_id, period_start)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_asset_depreciation_period
        ON asset_depreciation_runs(period_start)
    `);
    await client.query(`
      ALTER TABLE asset_disposals
        ADD COLUMN IF NOT EXISTS journal_voucher_id INTEGER,
        ADD COLUMN IF NOT EXISTS accumulated_depreciation NUMERIC(14,2)
    `);
    await client.query(`
      ALTER TABLE asset_depreciation_runs
        DROP CONSTRAINT IF EXISTS fk_asset_depreciation_purchase
    `);
    await client.query(`
      ALTER TABLE asset_depreciation_runs
        ADD CONSTRAINT fk_asset_depreciation_purchase
        FOREIGN KEY (asset_purchase_id) REFERENCES asset_purchases(id) ON DELETE RESTRICT
    `);

    const expenseParent = await resolveChartParentId(client as any, "SYS-INDEXP");
    const fixedParent = await resolveChartParentId(client as any, "SYS-FIXD");
    if (expenseParent) {
      await client.query(`
        INSERT INTO account_ledgers
          (name, type, code, section, parent_id, is_group, is_system_group, description)
        VALUES ('Depreciation Expense', 'expense', $1, 'profit_loss', $2, false, false,
                'Straight-line depreciation expense for fixed assets')
        ON CONFLICT DO NOTHING
      `, [DEPRECIATION_EXPENSE_CODE, expenseParent]);
    }
    if (fixedParent) {
      await client.query(`
        INSERT INTO account_ledgers
          (name, type, code, section, parent_id, is_group, is_system_group, description)
        VALUES ('Accumulated Depreciation', 'asset', $1, 'balance_sheet', $2, false, false,
                'Contra-asset balance for posted fixed-asset depreciation')
        ON CONFLICT DO NOTHING
      `, [ACCUMULATED_DEPRECIATION_CODE, fixedParent]);
    }
    if (expenseParent) {
      await client.query(`
        INSERT INTO account_ledgers
          (name, type, code, section, parent_id, is_group, is_system_group, description)
        VALUES ('Loss on Asset Disposal', 'expense', $1, 'profit_loss', $2, false, false,
                'Net book value written off when a fixed asset is disposed')
        ON CONFLICT DO NOTHING
      `, [ASSET_DISPOSAL_LOSS_CODE, expenseParent]);
    }
    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      [MIGRATION_NAME],
    );
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: depreciation ledger ready`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migration] ${MIGRATION_NAME} FAILED — will retry next boot:`, error);
  } finally {
    client.release();
  }
}
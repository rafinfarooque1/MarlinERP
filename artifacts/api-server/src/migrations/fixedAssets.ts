/**
 * Fixed-asset support (spec §7).
 *
 * Assets are NOT sale inventory. The three existing product kinds
 * (item | material | raw_material) share the polymorphic `stock_entries` /
 * `stock_batches` tables with OVERLAPPING id spaces and a DB CHECK constraint
 * that lists exactly those three types. Pushing an "asset" through that machinery
 * would make a freezer look like sellable stock and would corrupt every query
 * that scopes by `material_type`. So assets get their OWN two tables and never
 * touch `stock_entries`:
 *
 *   assets          — the master (name, code, unit, description, status)
 *   asset_purchases — one row per acquisition (asset, qty, cost/unit, location,
 *                     date, vendor, and the journal voucher that booked it)
 *
 * Accounting. An asset purchase is capital expenditure, not a P&L purchase, so
 * it must land on the Fixed Asset group (SYS-FIXD), never on Purchases/inventory
 * and never on saleable stock. SYS-FIXD is a system GROUP and nothing can post
 * to a group, so this migration provisions ONE postable ledger under it —
 * STD-FIXED-ASSET — the same way rent/payroll provision their ledgers. The
 * asset-purchase route then writes a plain journal voucher (Dr Fixed Asset /
 * Cr the vendor's payable ledger), which the shared `buildDerivedPostings`
 * already picks up as stored journal lines, so the value reaches the Balance
 * Sheet under Fixed Assets with no parallel posting path. No depreciation.
 *
 * Idempotent + guarded by migration_log, per the house pattern. Constraints are
 * added with separate guarded ALTERs because a constraint written inside
 * CREATE TABLE IF NOT EXISTS never reaches a database where the table already
 * exists.
 */
import type { PgPool as Pool } from "@workspace/db";
import { resolveChartParentId } from "../lib/chartGroups";

const MIGRATION_NAME = "fixed_assets_v1";

/** The single postable Fixed Asset ledger every asset purchase debits. */
export const FIXED_ASSET_LEDGER_CODE = "STD-FIXED-ASSET";

export async function addFixedAssets(pool: Pool): Promise<void> {
  const { rowCount: alreadyDone } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`,
    [MIGRATION_NAME],
  );
  if (alreadyDone) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);

    const { rowCount: raced } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (raced) { await client.query("ROLLBACK"); return; }

    // ── Asset master ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id          serial PRIMARY KEY,
        name        text NOT NULL,
        item_code   text,
        unit        text NOT NULL,
        description text,
        status      text NOT NULL DEFAULT 'active',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Guarded ALTERs so an already-existing table still gains the guards.
    await client.query(`ALTER TABLE assets DROP CONSTRAINT IF EXISTS chk_assets_status`);
    await client.query(
      `ALTER TABLE assets ADD CONSTRAINT chk_assets_status CHECK (status IN ('active','inactive'))`,
    );
    // Asset codes are unique when supplied (blank/NULL means "not set").
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_item_code
         ON assets (item_code) WHERE item_code IS NOT NULL AND item_code <> ''`,
    );

    // ── Asset acquisitions ─────────────────────────────────────────────────────
    // purchase_date is a real DATE column (this migration creates it fresh, so it
    // is a DATE from birth — it does NOT touch the 16 verified converted columns).
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_purchases (
        id                 serial PRIMARY KEY,
        asset_id           integer NOT NULL,
        quantity           numeric(14,3) NOT NULL,
        acquisition_cost   numeric(14,2) NOT NULL,
        location_type      text NOT NULL DEFAULT 'headoffice',
        location_id        integer NOT NULL DEFAULT 1,
        vendor_id          integer,
        purchase_date      date NOT NULL,
        notes              text,
        journal_voucher_id integer,
        created_by         text,
        created_at         timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS fk_asset_purchases_asset`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT fk_asset_purchases_asset
         FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE RESTRICT`,
    );
    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS chk_asset_purchases_qty`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT chk_asset_purchases_qty CHECK (quantity::numeric > 0)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_asset_purchases_asset ON asset_purchases (asset_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_asset_purchases_location
         ON asset_purchases (location_type, location_id)`,
    );

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: assets + asset_purchases tables ready`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Not rethrown: a throw here would abort every later migration.
    console.error(`[migration] CRITICAL: ${MIGRATION_NAME} failed and was rolled back.`, e);
  } finally {
    client.release();
  }

  // Ledger provisioning is separate and runs on EVERY boot (idempotent): the
  // chart of accounts is seeded elsewhere in index.ts, and if it was not ready
  // when this migration first ran, the next boot still gets the ledger created.
  await ensureFixedAssetLedger(pool);
}

/**
 * Create (or find) the single postable Fixed Asset ledger under SYS-FIXD.
 *
 * Mirrors `provisionOne` in rentLedgers.ts: insert ON CONFLICT DO NOTHING, then
 * re-read, so concurrent boots converge on one ledger. Returns null only while
 * the chart of accounts has not been seeded yet, in which case the next boot
 * retries.
 */
export async function ensureFixedAssetLedger(pool: Pool): Promise<number | null> {
  const { rows: [existing] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [FIXED_ASSET_LEDGER_CODE],
  );
  if (existing) return existing.id;

  const parentId = await resolveChartParentId(pool, "SYS-FIXD");
  if (!parentId) return null; // chart not seeded yet — retried next boot

  const { rows: [created] } = await pool.query<{ id: number }>(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, 'asset', $2, 'balance_sheet', $3, false, false, $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    ["Fixed Assets", FIXED_ASSET_LEDGER_CODE, parentId, "Fixed assets acquired through asset purchases"],
  );
  if (created) return created.id;

  const { rows: [retry] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [FIXED_ASSET_LEDGER_CODE],
  );
  return retry?.id ?? null;
}

/**
 * Asset Management module (standalone Assets section).
 *
 * Extends the fixed-asset layer created by fixedAssets.ts into a full register:
 *
 *   asset_categories — user-editable category master, seeded with defaults
 *   asset_purchases  — EXTENDED: each purchase row IS a register entry that
 *                      carries its own current location and lifecycle status.
 *                      Transfers and disposals act on these rows.
 *   asset_transfers  — movement history (no accounting entries)
 *   asset_disposals  — disposal history (no accounting yet; `amount` is
 *                      headroom for future disposal proceeds/accounting)
 *
 * Accounting stays exactly as fixedAssets.ts established it: an asset purchase
 * posts Dr STD-FIXED-ASSET / Cr Cash, Bank or the vendor's payable ledger and
 * never touches stock. GST on the purchase is recorded and capitalised into the
 * total — no input-tax-credit posting (out of scope).
 *
 * House rules applied here:
 *   • Guarded by migration_log — runs exactly once per database.
 *   • Constraints via separate guarded ALTERs, never inside CREATE TABLE
 *     IF NOT EXISTS (they would never reach a DB where the table exists).
 *   • New date columns are DATE from birth (no text→date conversion, which the
 *     publish schema diff cannot apply).
 *   • New columns are added NULLABLE and explicitly backfilled — an ADD COLUMN
 *     ... NOT NULL DEFAULT would stamp every historical row with a guess.
 *   • These columns are raw-migration columns: drizzle cannot see them, so all
 *     reads and writes go through raw SQL in routes/assets.ts.
 */
import type { PgPool as Pool } from "@workspace/db";

const MIGRATION_NAME = "asset_module_v1";

/** Seeded category defaults — user-editable afterwards. */
export const DEFAULT_ASSET_CATEGORIES = [
  "Building", "Vehicle", "Furniture", "Computer", "Printer", "Machine",
  "Freezer", "Air Conditioner", "Generator", "UPS", "Office Equipment", "Other",
] as const;

export const ASSET_STATUSES = [
  "active", "sold", "scrapped", "written_off", "transferred_outside",
] as const;

export const ASSET_DISPOSAL_TYPES = [
  "sold", "scrapped", "written_off", "transferred_outside",
] as const;

export const ASSET_PAYMENT_MODES = ["cash", "bank", "upi", "credit"] as const;
export const ASSET_PAYMENT_STATUSES = ["paid", "unpaid", "partial"] as const;

export async function addAssetModule(pool: Pool): Promise<void> {
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

    // ── Category master ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_categories (
        id         serial PRIMARY KEY,
        name       text NOT NULL,
        status     text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `ALTER TABLE asset_categories DROP CONSTRAINT IF EXISTS chk_asset_categories_status`,
    );
    await client.query(
      `ALTER TABLE asset_categories
         ADD CONSTRAINT chk_asset_categories_status CHECK (status IN ('active','inactive'))`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_categories_name
         ON asset_categories ((lower(name)))`,
    );
    // Seed with WHERE NOT EXISTS, not ON CONFLICT — an expression-index conflict
    // target is exactly the 42P10 trap the migration memory warns about.
    for (const name of DEFAULT_ASSET_CATEGORIES) {
      await client.query(
        `INSERT INTO asset_categories (name)
         SELECT $1 WHERE NOT EXISTS (
           SELECT 1 FROM asset_categories WHERE lower(name) = lower($1))`,
        [name],
      );
    }

    // ── Register fields on asset_purchases ──────────────────────────────────
    // One purchase row = one register entry. Nullable + backfilled below.
    await client.query(`
      ALTER TABLE asset_purchases
        ADD COLUMN IF NOT EXISTS asset_code            text,
        ADD COLUMN IF NOT EXISTS category_id           integer,
        ADD COLUMN IF NOT EXISTS invoice_number        text,
        ADD COLUMN IF NOT EXISTS gst_rate              numeric(5,2),
        ADD COLUMN IF NOT EXISTS gst_amount            numeric(14,2),
        ADD COLUMN IF NOT EXISTS total_cost            numeric(14,2),
        ADD COLUMN IF NOT EXISTS payment_mode          text,
        ADD COLUMN IF NOT EXISTS payment_status        text,
        ADD COLUMN IF NOT EXISTS warranty_start        date,
        ADD COLUMN IF NOT EXISTS warranty_end          date,
        ADD COLUMN IF NOT EXISTS serial_number         text,
        ADD COLUMN IF NOT EXISTS asset_tag             text,
        ADD COLUMN IF NOT EXISTS useful_life_months    integer,
        ADD COLUMN IF NOT EXISTS attachment_path       text,
        ADD COLUMN IF NOT EXISTS status                text,
        ADD COLUMN IF NOT EXISTS current_location_type text,
        ADD COLUMN IF NOT EXISTS current_location_id   integer,
        ADD COLUMN IF NOT EXISTS updated_at            timestamptz
    `);

    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS fk_asset_purchases_category`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT fk_asset_purchases_category
         FOREIGN KEY (category_id) REFERENCES asset_categories (id) ON DELETE RESTRICT`,
    );
    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS chk_asset_purchases_status`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT chk_asset_purchases_status
         CHECK (status IS NULL OR status IN ('${ASSET_STATUSES.join("','")}'))`,
    );
    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS chk_asset_purchases_pay_mode`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT chk_asset_purchases_pay_mode
         CHECK (payment_mode IS NULL OR payment_mode IN ('${ASSET_PAYMENT_MODES.join("','")}'))`,
    );
    await client.query(
      `ALTER TABLE asset_purchases DROP CONSTRAINT IF EXISTS chk_asset_purchases_pay_status`,
    );
    await client.query(
      `ALTER TABLE asset_purchases
         ADD CONSTRAINT chk_asset_purchases_pay_status
         CHECK (payment_status IS NULL OR payment_status IN ('${ASSET_PAYMENT_STATUSES.join("','")}'))`,
    );

    // Backfills for rows recorded before this module existed.
    // Existing rows all posted Cr vendor payable (credit) or Cr Cash — mirror
    // that so the register never invents a payment mode the books disagree with.
    await client.query(`
      UPDATE asset_purchases SET
        total_cost            = COALESCE(total_cost, round(quantity * acquisition_cost, 2)),
        gst_rate              = COALESCE(gst_rate, 0),
        gst_amount            = COALESCE(gst_amount, 0),
        payment_mode          = COALESCE(payment_mode, CASE WHEN vendor_id IS NOT NULL THEN 'credit' ELSE 'cash' END),
        payment_status        = COALESCE(payment_status, CASE WHEN vendor_id IS NOT NULL THEN 'unpaid' ELSE 'paid' END),
        status                = COALESCE(status, 'active'),
        current_location_type = COALESCE(current_location_type, location_type, 'headoffice'),
        current_location_id   = COALESCE(current_location_id, location_id, 1),
        updated_at            = COALESCE(updated_at, created_at)
    `);
    await client.query(`
      UPDATE asset_purchases
         SET asset_code = 'AST-' || lpad(id::text, 4, '0')
       WHERE asset_code IS NULL
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_purchases_code
         ON asset_purchases (asset_code) WHERE asset_code IS NOT NULL`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_asset_purchases_current_loc
         ON asset_purchases (current_location_type, current_location_id)`,
    );

    // ── Transfer history ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_transfers (
        id                serial PRIMARY KEY,
        asset_purchase_id integer NOT NULL,
        from_type         text NOT NULL,
        from_id           integer NOT NULL,
        to_type           text NOT NULL,
        to_id             integer NOT NULL,
        transfer_date     date NOT NULL,
        approved_by       text,
        reason            text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `ALTER TABLE asset_transfers DROP CONSTRAINT IF EXISTS fk_asset_transfers_purchase`,
    );
    await client.query(
      `ALTER TABLE asset_transfers
         ADD CONSTRAINT fk_asset_transfers_purchase
         FOREIGN KEY (asset_purchase_id) REFERENCES asset_purchases (id) ON DELETE CASCADE`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_asset_transfers_purchase
         ON asset_transfers (asset_purchase_id)`,
    );

    // ── Disposal history ─────────────────────────────────────────────────────
    // `amount` is future headroom (sale proceeds / written-down value) — no
    // disposal accounting is posted yet.
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_disposals (
        id                serial PRIMARY KEY,
        asset_purchase_id integer NOT NULL,
        disposal_type     text NOT NULL,
        disposal_date     date NOT NULL,
        reason            text,
        amount            numeric(14,2),
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `ALTER TABLE asset_disposals DROP CONSTRAINT IF EXISTS fk_asset_disposals_purchase`,
    );
    await client.query(
      `ALTER TABLE asset_disposals
         ADD CONSTRAINT fk_asset_disposals_purchase
         FOREIGN KEY (asset_purchase_id) REFERENCES asset_purchases (id) ON DELETE CASCADE`,
    );
    await client.query(
      `ALTER TABLE asset_disposals DROP CONSTRAINT IF EXISTS chk_asset_disposals_type`,
    );
    await client.query(
      `ALTER TABLE asset_disposals
         ADD CONSTRAINT chk_asset_disposals_type
         CHECK (disposal_type IN ('${ASSET_DISPOSAL_TYPES.join("','")}'))`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_asset_disposals_purchase
         ON asset_disposals (asset_purchase_id)`,
    );

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: asset categories/register/transfers/disposals ready`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Not rethrown: a throw here would abort every later migration.
    console.error(`[migration] CRITICAL: ${MIGRATION_NAME} failed and was rolled back.`, e);
  } finally {
    client.release();
  }
}

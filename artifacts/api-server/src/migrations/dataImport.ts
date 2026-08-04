/**
 * Data Import module — boot migration.
 *
 * Adds the batch/row bookkeeping tables behind the Tally/Zoho-style Import Data
 * page (Company › Import Data), plus the master-data columns the old ERP's
 * exports carry that this schema did not yet store (PAN and free-text notes on
 * parties).
 *
 * Everything here is additive and idempotent. Constraints/indexes are created
 * OUTSIDE the CREATE TABLE so they also reach databases where the table already
 * exists (see migration-ddl-drift).
 *
 * The import pipeline:
 *   parse   → one import_batches row (status 'validated') + one import_rows row
 *             per spreadsheet line, carrying the raw data and the validation
 *             verdict (valid / warning / error with reason + suggestion).
 *   commit  → creates the real records THROUGH THE SAME CODE PATHS as manual
 *             creation, stamping each import_rows row with what it created so
 *             rollback knows exactly what belongs to the batch.
 *   rollback→ deletes only the records the batch created, refusing when any of
 *             them has since been used (postings, sales, purchases, children).
 */
import { pool } from "@workspace/db";

export async function addDataImport(): Promise<void> {
  // ── Batch + row tables ─────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id             serial PRIMARY KEY,
      module         text NOT NULL,
      filename       text NOT NULL DEFAULT '',
      status         text NOT NULL DEFAULT 'validated',
      total_rows     integer NOT NULL DEFAULT 0,
      valid_rows     integer NOT NULL DEFAULT 0,
      warning_rows   integer NOT NULL DEFAULT 0,
      error_rows     integer NOT NULL DEFAULT 0,
      imported_rows  integer NOT NULL DEFAULT 0,
      updated_rows   integer NOT NULL DEFAULT 0,
      skipped_rows   integer NOT NULL DEFAULT 0,
      failed_rows    integer NOT NULL DEFAULT 0,
      created_by     text NOT NULL DEFAULT 'system',
      location_type  text,
      location_id    integer,
      created_at     timestamptz NOT NULL DEFAULT now(),
      committed_at   timestamptz,
      committed_by   text,
      rolled_back_at timestamptz,
      rolled_back_by text
    );

    CREATE TABLE IF NOT EXISTS import_rows (
      id                  serial PRIMARY KEY,
      batch_id            integer NOT NULL,
      row_number          integer NOT NULL,
      raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
      status              text NOT NULL DEFAULT 'valid',
      reason              text,
      suggestion          text,
      duplicate_of_id     integer,
      created_record_type text,
      created_record_id   integer,
      created_ledger_id   integer,
      opening_balance_id  integer,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows (batch_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches (status)`);

  // ── Party columns the old ERP exports carry ────────────────────────────────
  // Raw-migration columns: INVISIBLE to drizzle — read and write them via raw
  // SQL only (see raw-migration-columns).
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS pan text;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes text;
    ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS pan text;
    ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS notes text;
    -- The duplicate-update path stamps updated_at; schema-created databases
    -- already have it, but a legacy database that drifted must not fail every
    -- "update duplicates" row over a missing bookkeeping column.
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
  `);

  // ── Permission seeding (ONE TIME) ──────────────────────────────────────────
  // page:/company/import is a NEW key under default-deny: without seeding,
  // every pre-existing role above level 1 would silently lose the module.
  // Same direction as quotations_page_perms_v1: GRANT to roles that already
  // existed and let an admin take rights away on the Permissions page. Roles
  // created later start with no rows and stay denied — that is default-deny.
  const { rows: seeded } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'import_page_perms_v1'`,
  );
  if (seeded.length === 0) {
    const { rows: hRows } = await pool.query<{ id: number }>(
      `SELECT id FROM hierarchies WHERE level != 1`,
    );
    for (const h of hRows) {
      await pool.query(
        `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download, can_print, can_approve, can_share)
         VALUES ($1, 'page:/company/import', true, true, true, true, true, true, true, true)
         ON CONFLICT (hierarchy_id, module) DO NOTHING`,
        [h.id],
      );
    }
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('import_page_perms_v1') ON CONFLICT (name) DO NOTHING`,
    );
    console.log(
      `[migration] import_page_perms_v1 — granted Import Data page to ${hRows.length} pre-existing roles`,
    );
  }
}

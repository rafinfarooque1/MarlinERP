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

  // ── Location + batch-provenance columns ────────────────────────────────────
  // Raw-migration columns: INVISIBLE to drizzle — read/write via raw SQL only.
  //
  // account_ledgers.location_*: which branch/warehouse OWNS the ledger.
  // Display + import bookkeeping only — report scoping stays document-based
  // (postings carry the location, see jv-location-visibility). NULL = global.
  //
  // import_batch_id: stamps every record a Data Import batch CREATED (updates
  // to pre-existing records are deliberately NOT stamped — rollback must never
  // touch manual data). Rollback still walks import_rows as the authority;
  // the stamp powers traceability, per-table counts and the leftover check.
  await pool.query(`
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS location_type text;
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS location_id integer;

    ALTER TABLE customers        ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE vendors          ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE account_ledgers  ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE opening_balances ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE sales            ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE purchases        ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE receipts         ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE payments         ADD COLUMN IF NOT EXISTS import_batch_id integer;
  `);

  // ── Backfill batch stamps from import_rows (ONE TIME) ──────────────────────
  // Historical committed batches recorded what they created on import_rows;
  // copy that onto the records themselves so counts and the post-rollback
  // "nothing left behind" check work for old batches too.
  const { rows: stamped } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'import_batch_stamps_v1'`,
  );
  if (stamped.length === 0) {
    const stampSql = (table: string, type: string) => `
      UPDATE ${table} t SET import_batch_id = r.batch_id
        FROM import_rows r
       WHERE r.created_record_type = '${type}' AND r.status = 'imported'
         AND r.created_record_id = t.id AND t.import_batch_id IS NULL`;
    await pool.query(stampSql("customers", "customer"));
    await pool.query(stampSql("vendors", "vendor"));
    await pool.query(stampSql("sales", "sale"));
    await pool.query(stampSql("purchases", "purchase"));
    await pool.query(stampSql("receipts", "receipt"));
    await pool.query(stampSql("payments", "payment"));
    // Ledgers arrive two ways: a ledger import's own row (created_record_id)
    // and the auto-provisioned party ledger (created_ledger_id).
    await pool.query(`
      UPDATE account_ledgers l SET import_batch_id = r.batch_id
        FROM import_rows r
       WHERE r.status = 'imported' AND r.created_ledger_id = l.id
         AND l.import_batch_id IS NULL`);
    await pool.query(`
      UPDATE opening_balances ob SET import_batch_id = r.batch_id
        FROM import_rows r
       WHERE r.status = 'imported' AND r.opening_balance_id = ob.id
         AND ob.import_batch_id IS NULL`);
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('import_batch_stamps_v1') ON CONFLICT (name) DO NOTHING`,
    );
    console.log("[migration] import_batch_stamps_v1 — batch provenance stamped onto imported records");
  }

  // ── Backfill party-ledger locations (ONE TIME) ─────────────────────────────
  // CUST-/VEND- ledgers inherit their party's location. One-time (not
  // every-boot healing) so a deliberate manual clear is never overridden.
  const { rows: ledLoc } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'party_ledger_location_backfill_v1'`,
  );
  if (ledLoc.length === 0) {
    await pool.query(`
      UPDATE account_ledgers al SET location_type = c.location_type, location_id = c.location_id
        FROM customers c
       WHERE al.code = 'CUST-' || c.id AND al.location_type IS NULL AND c.location_type IS NOT NULL`);
    await pool.query(`
      UPDATE account_ledgers al SET location_type = v.location_type, location_id = v.location_id
        FROM vendors v
       WHERE al.code = 'VEND-' || v.id AND al.location_type IS NULL AND v.location_type IS NOT NULL`);
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('party_ledger_location_backfill_v1') ON CONFLICT (name) DO NOTHING`,
    );
    console.log("[migration] party_ledger_location_backfill_v1 — party ledgers inherited party locations");
  }

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

  // ══ ERP Migration Wizard (module replacement) ══════════════════════════════
  // The Import Data page became a staged wizard: Upload → Analyse → Manual
  // Mapping → Demo Import (one never-committed transaction; report snapshots
  // taken before ROLLBACK) → Approve (all-or-nothing) or Discard.
  await pool.query(`
    -- Demo-run snapshots and outcome bookkeeping. demo_report holds the full
    -- financial report pack computed INSIDE the demo transaction (TB, P&L, BS,
    -- receivables, vendor outstanding, cash/bank book, stock valuation,
    -- dashboard KPIs); demo_summary the per-row outcome counts. Stored via a
    -- separate small transaction after the demo ROLLBACK.
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS demo_report   jsonb;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS demo_summary  jsonb;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS demo_at       timestamptz;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS demo_by       text;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS discarded_at  timestamptz;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS discarded_by  text;
    -- Legacy voucher-number range carried by the file (history display).
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS legacy_min    text;
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS legacy_max    text;
    -- Old-software report conversion metadata (report family, header row,
    -- kept/dropped counts, notes, excluded voucher types) — NULL for normal
    -- sample-template files.
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS conversion    jsonb;
  `);

  // Permanent master mapping memory: old-ERP name → this ERP's record.
  // ONE row per (kind, normalized name); validation resolves masters ONLY
  // through this table — no silent auto-matching. Managed on the page's
  // Manage Mapping screen. Unique index OUTSIDE the CREATE TABLE
  // (migration-ddl-drift: constraints inside CREATE TABLE IF NOT EXISTS
  // never reach live databases).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_mappings (
      id           serial PRIMARY KEY,
      kind         text NOT NULL,            -- customer | vendor | item | ledger
      source_name  text NOT NULL,            -- as it appeared in the file (display)
      source_norm  text NOT NULL,            -- normalized match key (lower/trim/squeeze)
      target_id    integer NOT NULL,         -- id in the matching master table
      created_by   text NOT NULL DEFAULT 'system',
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_import_mappings_kind_norm ON import_mappings (kind, source_norm)`,
  );
  // Product mappings must remember WHICH master table the target id lives in:
  // items, materials and raw_materials have overlapping id spaces
  // (polymorphic-stock-entries), so a bare integer is ambiguous. NULL for
  // customer/vendor/ledger kinds (their id spaces are unambiguous).
  await pool.query(
    `ALTER TABLE import_mappings ADD COLUMN IF NOT EXISTS target_kind text`,
  );

  // Legacy voucher numbers: every imported document gets a REAL ERP number
  // from the allocators; the old ERP's number is stored alongside and stays
  // searchable. sales.legacy_invoice_number already exists; these cover the
  // voucher-shaped documents (Day Book journals, receipts, payments).
  await pool.query(`
    ALTER TABLE journal_vouchers ADD COLUMN IF NOT EXISTS legacy_voucher_number text;
    ALTER TABLE receipts         ADD COLUMN IF NOT EXISTS legacy_voucher_number text;
    ALTER TABLE payments         ADD COLUMN IF NOT EXISTS legacy_voucher_number text;

    -- New importable record kinds need batch provenance too.
    ALTER TABLE journal_vouchers    ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE items               ADD COLUMN IF NOT EXISTS import_batch_id integer;
    ALTER TABLE stock_verifications ADD COLUMN IF NOT EXISTS import_batch_id integer;
  `);
  // ── ERP Migration Wizard: the umbrella over one multi-file migration ──────
  // One import_migrations row groups up to one batch per wizard module
  // (sales, purchases, receipts, payments, daybook, opening_stock). The
  // wizard's demo report, approval and rollback all live at THIS level —
  // the per-batch columns keep their per-file bookkeeping.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS import_migrations (
      id             serial PRIMARY KEY,
      status         text NOT NULL DEFAULT 'draft',
      location_type  text,
      location_id    integer,
      demo_report    jsonb,
      demo_summary   jsonb,
      demo_at        timestamptz,
      demo_by        text,
      record_counts  jsonb,
      legacy_min     text,
      legacy_max     text,
      created_by     text NOT NULL DEFAULT 'system',
      created_at     timestamptz NOT NULL DEFAULT now(),
      committed_at   timestamptz,
      committed_by   text,
      discarded_at   timestamptz,
      discarded_by   text,
      rolled_back_at timestamptz,
      rolled_back_by text
    );
    ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS migration_id integer;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_import_batches_migration ON import_batches (migration_id) WHERE migration_id IS NOT NULL`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_legacy_no ON sales (legacy_invoice_number) WHERE legacy_invoice_number IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_jv_legacy_no ON journal_vouchers (legacy_voucher_number) WHERE legacy_voucher_number IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_receipts_legacy_no ON receipts (legacy_voucher_number) WHERE legacy_voucher_number IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_legacy_no ON payments (legacy_voucher_number) WHERE legacy_voucher_number IS NOT NULL`);
}

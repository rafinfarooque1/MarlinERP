import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { migrateOutletsToWarehouses } from "./migrations/outletToWarehouse";
import { repairOpeningBatches } from "./migrations/repairOpeningBatches";
import { addMaterialLocations } from "./migrations/materialLocations";
import { addMaterialBatches } from "./migrations/materialBatches";
import { addWarehouseRent } from "./migrations/warehouseRent";
import { addInvoiceShareLinks } from "./migrations/invoiceShareLinks";
import { startRentAccrualScheduler } from "./lib/rentAccrual";
import { addSalaryAccrual } from "./migrations/salaryAccrual";
import { startSalaryAccrualScheduler } from "./lib/salaryAccrual";
import { addBackupRestore } from "./migrations/backupRestore";
import { addExpensePaymentModes } from "./migrations/expensePaymentModes";
import { addFixedAssets } from "./migrations/fixedAssets";
import { addAssetModule } from "./migrations/assetModule";
import { addPurchaseBillFields } from "./migrations/purchaseBills";
import { addVoucherProvenance } from "./migrations/voucherProvenance";
import { startBackupScheduler } from "./lib/backup/scheduler";
import { PasswordService } from "./lib/password";
import { PRODUCT_KINDS, PRODUCT_TABLE, nextProductIdentity } from "./lib/productIdentity";
import { nextVoucherNumber } from "./lib/voucherNumber";
import { PAGE_PERM_KEYS, LEGACY_MODULE_TO_PAGES } from "./lib/pagePermissions";
import { ensureChartStructure } from "./lib/chartGroups";
import { DATE_COLUMNS } from "./lib/dateColumns";

async function runMigrations() {
  // Existing migrations
  await pool.query(`
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_from text;
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_to text;
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'outlet';
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS code text;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS bill_discount numeric(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tax_total numeric(12,2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS discount_total numeric(12,2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS round_off numeric(12,2) DEFAULT 0;
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS hsn_code text NOT NULL DEFAULT '';
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 0;
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS hsn_code text NOT NULL DEFAULT '';
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT 0;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS mrp numeric(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS cost numeric(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS cost numeric(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS cost numeric(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS avg_cost numeric(12,4) NOT NULL DEFAULT 0;
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS avg_cost numeric(12,4) NOT NULL DEFAULT 0;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_by text;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_line_items jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS rejection_reason text;
    ALTER TABLE stock_transfers ALTER COLUMN status SET DEFAULT 'in_transit';
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS upi_id text;
    ALTER TABLE outlets    ADD COLUMN IF NOT EXISTS upi_id text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS cash_ledger_id integer;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS sales_ledger_id integer;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS purchase_ledger_id integer;

    -- Warehouse billing profile. A warehouse is the legal identity that issues a
    -- sales invoice, so everything a GST tax invoice must state about the seller
    -- lives on the warehouse row. All nullable and additive: an unconfigured
    -- warehouse keeps behaving exactly as it did, and the invoice omits the
    -- fields it has no value for rather than borrowing another profile's.
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS billing_name text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS city text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS district text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS pincode text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS fssai_number text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS bank_account_holder text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS bank_name text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS bank_branch text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS bank_account_number text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS ifsc_code text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS invoice_footer text;
    ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS authorized_signatory text;
    ALTER TABLE outlets    ADD COLUMN IF NOT EXISTS cash_ledger_id integer;
    ALTER TABLE outlets    ADD COLUMN IF NOT EXISTS sales_ledger_id integer;

    ALTER TABLE sales ALTER COLUMN outlet_id DROP NOT NULL;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'outlet';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_id integer;

    CREATE TABLE IF NOT EXISTS payments (
      id serial PRIMARY KEY,
      voucher_number text,
      payment_date text NOT NULL,
      paid_from_ledger_id integer NOT NULL,
      paid_to_ledger_id integer NOT NULL,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      narration text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id serial PRIMARY KEY,
      voucher_number text,
      receipt_date text NOT NULL,
      received_from_ledger_id integer NOT NULL,
      received_in_ledger_id integer NOT NULL,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      narration text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Seed default admin user — step 1: ensure a level-1 hierarchy row exists
  await pool.query(
    `INSERT INTO hierarchies (name, level, description)
     SELECT 'Management', 1, 'Top-level management'
     WHERE NOT EXISTS (SELECT 1 FROM hierarchies WHERE level = 1)`
  );
  // Seed default admin user — step 2: upsert admin with correct password
  await pool.query(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, is_active)
     SELECT 'Administrator', 'admin', 'admin123', h.id, 'headoffice', 0, 0, CURRENT_DATE, true
     FROM hierarchies h WHERE h.level = 1 LIMIT 1
     ON CONFLICT (username) DO NOTHING`
  );

  // Ensure must_change_password column exists (idempotent)
  await pool.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS work_experience jsonb DEFAULT '[]'::jsonb;
  `);

  // Migrate admin: set securely hashed marlin1458 password and force change on first login.
  // The WHERE clause ensures this is a no-op once admin has already set their own bcrypt password.
  const adminHash = await PasswordService.hash('marlin1458');
  await pool.query(
    `UPDATE employees
     SET password_hash = $1, must_change_password = true
     WHERE username = 'admin' AND password_hash NOT LIKE '$2%'`,
    [adminHash],
  );

  // Migrate any other employees still storing plaintext passwords
  const { rows: plaintextEmps } = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE password_hash NOT LIKE '$2%'`,
  );
  for (const emp of plaintextEmps) {
    const h = await PasswordService.hash('marlin1458');
    await pool.query(
      `UPDATE employees SET password_hash = $1, must_change_password = true WHERE id = $2`,
      [h, emp.id],
    );
  }

  // Add Tally-style COA columns
  await pool.query(`
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS section text;
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS is_system_group boolean NOT NULL DEFAULT false;
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS bank_details jsonb;
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
  `);
  // Backfill: every system group is also a group container
  await pool.query(`UPDATE account_ledgers SET is_group = true WHERE is_system_group = true AND is_group = false`);

  // ── One-time: clean up old user-created ledgers, create standard ones ──────
  const { rows: stdCheck } = await pool.query(
    `SELECT 1 FROM account_ledgers WHERE code = 'STD-SALES' LIMIT 1`
  );
  if (stdCheck.length === 0) {
    // Remove transaction rows that reference user-created ledgers (safe: system groups have no such refs)
    await pool.query(`DELETE FROM expenses WHERE ledger_account_id IN (SELECT id FROM account_ledgers WHERE NOT is_system_group)`);
    await pool.query(`DELETE FROM payments WHERE paid_from_ledger_id IN (SELECT id FROM account_ledgers WHERE NOT is_system_group) OR paid_to_ledger_id IN (SELECT id FROM account_ledgers WHERE NOT is_system_group)`);
    await pool.query(`DELETE FROM receipts WHERE received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE NOT is_system_group) OR received_in_ledger_id IN (SELECT id FROM account_ledgers WHERE NOT is_system_group)`);
    await pool.query(`DELETE FROM account_ledgers WHERE NOT is_system_group`);
  }

  // Seed Tally-standard system group heads — parameterised INSERT to avoid dollar-quoting
  const sysGroups: [string, string, string, string, string][] = [
    ['Capital Accounts',   'equity',    'SYS-CAP',      'balance_sheet', 'Owner capital and reserves'],
    ['Loans (Liability)',  'liability', 'SYS-LOAN',     'balance_sheet', 'Long-term loans and borrowings'],
    ['Current Liabilities','liability', 'SYS-CURL',     'balance_sheet', 'Short-term obligations due within a year'],
    ['Fixed Asset',        'asset',     'SYS-FIXD',     'balance_sheet', 'Long-term tangible and intangible assets'],
    ['Current Asset',      'asset',     'SYS-CURA',     'balance_sheet', 'Short-term assets convertible within a year'],
    ['Opening Stock',      'asset',     'SYS-OPSTOCK',  'balance_sheet', 'Opening stock balance at the start of the accounting period'],
    ['Closing Stock',      'asset',     'SYS-CLSTOCK',  'balance_sheet', 'Closing stock balance at the end of the accounting period'],
    ['Purchase',           'expense',   'SYS-PUR',      'profit_loss',   'Cost of goods purchased for resale or production'],
    ['Direct Expense',     'expense',   'SYS-DIREXP',   'profit_loss',   'Expenses directly related to production'],
    ['Indirect Expense',   'expense',   'SYS-INDEXP',   'profit_loss',   'Administrative and overhead expenses'],
    ['Sales',              'income',    'SYS-SAL',      'profit_loss',   'Revenue from sale of goods and services'],
    ['Direct Income',      'income',    'SYS-DIRINC',   'profit_loss',   'Income directly from core operations'],
    ['Indirect Income',    'income',    'SYS-INDINC',   'profit_loss',   'Other miscellaneous income'],
  ];
  for (const [name, type, code, section, description] of sysGroups) {
    await pool.query(
      `INSERT INTO account_ledgers (name, type, code, section, is_system_group, description)
       SELECT $1, $2, $3, $4, true, $5
       WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
      [name, type, code, section, description],
    );
  }

  // ── Idempotent renames: keep display names in sync for existing installs ──────
  // Uses code-based lookup so it is safe to run on every startup.
  const groupRenames: [string, string][] = [
    ['SYS-CAP',    'Capital Accounts'],
    ['SYS-FIXD',   'Fixed Asset'],
    ['SYS-CURA',   'Current Asset'],
    ['SYS-PUR',    'Purchase'],
    ['SYS-DIREXP', 'Direct Expense'],
    ['SYS-INDEXP', 'Indirect Expense'],
    ['SYS-SAL',    'Sales'],
    ['SYS-DIRINC', 'Direct Income'],
    ['SYS-INDINC', 'Indirect Income'],
  ];
  for (const [code, name] of groupRenames) {
    await pool.query(
      `UPDATE account_ledgers SET name = $1 WHERE code = $2 AND is_system_group = true AND name <> $1`,
      [name, code],
    );
  }

  // Create standard ledgers under system groups (idempotent)
  const stdLedgers: [string, string, string, string, string, string][] = [
    ['Sales',             'income',    'STD-SALES',    'profit_loss',   'SYS-SAL',  'Auto-linked to all sales invoices'],
    ['Purchases',         'expense',   'STD-PUR',      'profit_loss',   'SYS-PUR',  'Auto-linked to all purchase orders'],
    ['Bank',              'asset',     'STD-BANK',     'balance_sheet', 'SYS-CURA', 'Bank accounts — add sub-ledgers for each bank account'],
    ['Cash',              'asset',     'STD-CASH',     'balance_sheet', 'SYS-CURA', 'Cash in hand — add sub-ledgers for each cash point'],
    ['Duty & Tax',        'liability', 'STD-DTX',      'balance_sheet', 'SYS-CURL', 'Output GST collected on sales (CGST + SGST or IGST)'],
    ['Sundry Debtors',   'asset',     'SYS-DEBTORS',  'balance_sheet', 'SYS-CURA', 'Amounts receivable from customers'],
    ['Sundry Creditors',  'liability', 'SYS-CREDITORS','balance_sheet', 'SYS-CURL', 'Amounts payable to vendors/suppliers'],
  ];
  for (const [name, type, code, section, parentCode, desc] of stdLedgers) {
    const { rows: [parent] } = await pool.query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [parentCode]
    );
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, $2, $3, $4, $5, false, $6
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
        [name, type, code, section, parent.id, desc],
      );
    }
  }

  // ── Migration log table (one-time migrations that must not re-run on restart) ─
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_log (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // ── Payment & Reconciliation schema ──────────────────────────────────────
  await pool.query(`
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS sale_payments (
      id serial PRIMARY KEY,
      sale_id integer NOT NULL,
      payment_date text NOT NULL,
      method text NOT NULL,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      reference_number text,
      notes text,
      reconciliation_status text,
      clearing_receipt_id integer,
      outlet_id integer NOT NULL,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id ON sale_payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sale_payments_rec_status ON sale_payments(reconciliation_status);

    CREATE TABLE IF NOT EXISTS reconciliation_batches (
      id serial PRIMARY KEY,
      batch_reference text NOT NULL,
      settlement_date text NOT NULL,
      gross_amount numeric(12,2) NOT NULL DEFAULT 0,
      charges numeric(12,2) NOT NULL DEFAULT 0,
      net_amount numeric(12,2) NOT NULL DEFAULT 0,
      destination_bank_ledger_id integer NOT NULL,
      external_reference text,
      notes text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS reconciliation_batch_items (
      id serial PRIMARY KEY,
      batch_id integer NOT NULL,
      sale_payment_id integer NOT NULL,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      UNIQUE(sale_payment_id)
    );

    CREATE TABLE IF NOT EXISTS cash_deposits (
      id serial PRIMARY KEY,
      outlet_id integer,
      warehouse_id integer,
      source_cash_ledger_id integer NOT NULL,
      amount numeric(12,2) NOT NULL DEFAULT 0,
      deposit_date text NOT NULL,
      deposit_reference text,
      destination_bank_ledger_id integer,
      notes text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'pending_reconciliation',
      transit_payment_id integer,
      bank_receipt_id integer
    );
  `);

  // Drop NOT NULL on sale_payments.outlet_id — warehouse sales have no outlet_id
  await pool.query(`ALTER TABLE sale_payments ALTER COLUMN outlet_id DROP NOT NULL`);

  // ── Reconciliation "Matched" state ───────────────────────────────────────
  // Widen the sale_payments reconciliation workflow with a third state:
  // pending -> reconciled -> matched. A matched payment is tied to a specific
  // ledger posting/voucher so it can be PROVEN, not just asserted. These audit
  // columns are added via startup migration, so they are INVISIBLE to Drizzle's
  // select() — they must be read AND written with raw SQL via `pool`.
  await pool.query(`
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS matched_reference text;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS matched_by text;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS matched_at timestamptz;
  `);

  // Allow warehouse deposits: add warehouse_id column and make outlet_id nullable
  await pool.query(`ALTER TABLE cash_deposits ADD COLUMN IF NOT EXISTS warehouse_id integer REFERENCES warehouses(id)`);
  await pool.query(`ALTER TABLE cash_deposits ALTER COLUMN outlet_id DROP NOT NULL`);

  // Location-scoped customers: add location columns (idempotent)
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_type text`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_id integer`);

  // Idempotent backfill: set location_id = outlet_id for existing outlet sales
  await pool.query(
    `UPDATE sales SET location_id = outlet_id WHERE location_id IS NULL AND outlet_id IS NOT NULL`
  );

  // Normalize any accidental 'partial' status rows to the canonical enum value
  // ('unpaid' | 'partially_paid' | 'paid') used by payments, filters and badges.
  await pool.query(
    `UPDATE sales SET payment_status = 'partially_paid' WHERE payment_status = 'partial'`
  );

  // ── Phase 5: production costing & wastage (additive, idempotent) ──────────
  // Cost columns are nullable on purpose: pre-existing batches stay NULL
  // ("not costed") and are never backfilled — costing applies to new batches.
  await pool.query(`
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS material_cost numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS overhead_percent numeric(5,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS overhead_amount numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS total_cost numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS cost_per_unit numeric(12,4);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS wastage jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS wastage_qty numeric(10,3) NOT NULL DEFAULT 0;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS wastage_value numeric(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS production_overhead_percent numeric(5,2) NOT NULL DEFAULT 0;
  `);

  // ── Warehouse purchasing + true batch costing (additive, idempotent) ──────
  // A production run and a purchase bill each record WHICH location performed
  // it, so a warehouse can buy and manufacture on its own books. 'headoffice'
  // stays the default; this is a *location* dimension and deliberately does NOT
  // resurrect the retired `branch_type = 'production'` concept (see
  // remove_production_branch_type_v1 below) — production remains a department
  // of whichever location runs it.
  //
  // Batch cost is split into its real components so a batch can be explained:
  //   rm_cost      raw material consumed   (materials table)
  //   pm_cost      packing material        (raw_materials table)
  //   labour_cost  allocated from that day's production payroll
  //   labour_method 'payroll' | 'manual' | 'none' — how labour was arrived at
  // material_cost stays as rm_cost + pm_cost so existing readers keep working.
  await pool.query(`
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'headoffice';
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS location_id   integer NOT NULL DEFAULT 1;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS rm_cost       numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS pm_cost       numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS labour_cost   numeric(12,2);
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS labour_method text;
    ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'headoffice';
    ALTER TABLE purchases   ADD COLUMN IF NOT EXISTS location_id   integer NOT NULL DEFAULT 1;
    ALTER TABLE employees   ADD COLUMN IF NOT EXISTS is_production_staff boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_productions_location ON productions (location_type, location_id);
    CREATE INDEX IF NOT EXISTS idx_productions_day_loc  ON productions (production_date, location_type, location_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_location   ON purchases   (location_type, location_id);
  `);

  // Every run and bill recorded before locations existed happened at Head
  // Office — the only place that could purchase or manufacture until now.
  // The column defaults cover new rows; this repairs rows that predate the
  // column (NULL is impossible thanks to NOT NULL, so only stray 0 ids remain).
  await pool.query(`
    UPDATE productions SET location_type = 'headoffice', location_id = 1
     WHERE location_type IS NULL OR location_type = '' OR location_id IS NULL OR location_id = 0;
    UPDATE purchases   SET location_type = 'headoffice', location_id = 1
     WHERE location_type IS NULL OR location_type = '' OR location_id IS NULL OR location_id = 0;
  `);

  // Split existing single-figure material costs into the RM/PM columns so old
  // batches read consistently. Runs once: later edits own their own values.
  {
    const { rows: [done] } = await pool.query(
      `SELECT 1 FROM migration_log WHERE name = 'production_cost_split_v1'`
    );
    if (!done) {
      // Legacy rows stored only material_cost. Recover the split from the
      // stored line snapshots (each line carries materialType + lineCost);
      // anything unsplittable lands wholly in rm_cost, which is what the
      // single figure has always represented in reporting.
      const { rowCount } = await pool.query(`
        UPDATE productions p SET
          rm_cost = COALESCE(s.rm, p.material_cost, 0),
          pm_cost = COALESCE(s.pm, 0),
          labour_cost = COALESCE(p.labour_cost, 0),
          labour_method = COALESCE(p.labour_method, 'none')
        FROM (
          SELECT id,
                 SUM(CASE WHEN l->>'materialType' = 'material'     THEN (l->>'lineCost')::numeric ELSE 0 END) AS rm,
                 SUM(CASE WHEN l->>'materialType' = 'raw_material' THEN (l->>'lineCost')::numeric ELSE 0 END) AS pm
          FROM productions, jsonb_array_elements(COALESCE(material_used, '[]'::jsonb)) l
          WHERE l ? 'lineCost'
          GROUP BY id
        ) s
        WHERE s.id = p.id AND p.rm_cost IS NULL
      `);
      await pool.query(`
        UPDATE productions SET rm_cost = COALESCE(material_cost, 0), pm_cost = 0,
                               labour_cost = COALESCE(labour_cost, 0),
                               labour_method = COALESCE(labour_method, 'none')
         WHERE rm_cost IS NULL AND material_cost IS NOT NULL
      `);
      await pool.query(`INSERT INTO migration_log (name) VALUES ('production_cost_split_v1')`);
      console.log(`[migration] production_cost_split_v1: split ${rowCount} costed production rows into RM/PM`);
    }
  }

  // ── Item & batch identification (additive, idempotent) ────────────────────
  // Every product gets a human code, a scannable EAN-13 barcode and an
  // active/inactive status. The three master tables stay separate (their id
  // spaces overlap from 1), so each carries its own copy of the columns and its
  // own code sequence. Batches inherit the parent product's barcode and MRP so
  // a scanned lot resolves to a price without a second lookup.
  await pool.query(`
    ALTER TABLE items         ADD COLUMN IF NOT EXISTS item_code text;
    ALTER TABLE items         ADD COLUMN IF NOT EXISTS barcode   text;
    ALTER TABLE items         ADD COLUMN IF NOT EXISTS status    text NOT NULL DEFAULT 'active';
    ALTER TABLE materials     ADD COLUMN IF NOT EXISTS item_code text;
    ALTER TABLE materials     ADD COLUMN IF NOT EXISTS barcode   text;
    ALTER TABLE materials     ADD COLUMN IF NOT EXISTS status    text NOT NULL DEFAULT 'active';
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS item_code text;
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS barcode   text;
    ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS status    text NOT NULL DEFAULT 'active';
    ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS barcode text;
    ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS mrp     numeric(10,2);
    CREATE SEQUENCE IF NOT EXISTS item_code_seq_item;
    CREATE SEQUENCE IF NOT EXISTS item_code_seq_material;
    CREATE SEQUENCE IF NOT EXISTS item_code_seq_raw_material;
  `);

  // One-time backfill of codes and barcodes for products that predate the
  // columns. Done in JS through the same helper the create routes use, so a
  // backfilled code is indistinguishable in format from a freshly issued one.
  // Status defaults to 'active' at the column level, so nothing is left invalid.
  const { rows: [productIdApplied] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'product_identification_backfill_v1'`
  );
  if (!productIdApplied) {
    const idClient = await pool.connect();
    try {
      await idClient.query('BEGIN');
      let issued = 0;
      for (const kind of PRODUCT_KINDS) {
        const table = PRODUCT_TABLE[kind];
        const { rows } = await idClient.query(
          `SELECT id FROM ${table} WHERE item_code IS NULL OR item_code = '' ORDER BY id`
        );
        for (const r of rows) {
          const { itemCode, barcode } = await nextProductIdentity(idClient, kind);
          await idClient.query(
            `UPDATE ${table} SET
               item_code = $1,
               barcode   = CASE WHEN barcode IS NULL OR barcode = '' THEN $2 ELSE barcode END,
               status    = COALESCE(NULLIF(status, ''), 'active'),
               updated_at = now()
             WHERE id = $3`,
            [itemCode, barcode, r.id]
          );
          issued++;
        }
      }
      await idClient.query(`INSERT INTO migration_log (name) VALUES ('product_identification_backfill_v1')`);
      await idClient.query('COMMIT');
      console.log(`[migration] product_identification_backfill_v1 applied — ${issued} product code(s) issued`);
    } catch (e) {
      await idClient.query('ROLLBACK').catch(() => {});
      console.error('[migration] product_identification_backfill_v1 FAILED:', e);
    } finally {
      idClient.release();
    }
  }

  // Codes and barcodes must identify exactly one product per master table.
  // Partial indexes so rows that somehow hold no code stay legal, and a
  // pre-existing duplicate is reported instead of crashing the boot.
  for (const kind of PRODUCT_KINDS) {
    const table = PRODUCT_TABLE[kind];
    for (const col of ['item_code', 'barcode'] as const) {
      try {
        await pool.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_${table}_${col}
             ON ${table} (${col}) WHERE ${col} IS NOT NULL AND ${col} <> ''`
        );
      } catch (e) {
        console.error(`[migration] CRITICAL: could not make ${table}.${col} unique — duplicates exist:`, e);
      }
    }
  }

  // Existing lots get their parent product's barcode: identity is stable, so
  // this is a lookup, not a rewrite of history. `mrp` is deliberately NOT
  // backfilled — a price is a point-in-time fact we don't have for old lots, so
  // it stays NULL ("not stamped") and the batch views fall back to the parent's
  // current MRP for display, exactly as the Phase 5 cost columns do.
  await pool.query(`
    UPDATE stock_batches sb SET barcode = p.barcode
      FROM (
        SELECT id, 'item'::text AS material_type, barcode FROM items         WHERE barcode IS NOT NULL AND barcode <> ''
        UNION ALL
        SELECT id, 'material',                    barcode FROM materials     WHERE barcode IS NOT NULL AND barcode <> ''
        UNION ALL
        SELECT id, 'raw_material',                barcode FROM raw_materials WHERE barcode IS NOT NULL AND barcode <> ''
      ) p
     WHERE sb.item_id = p.id
       AND sb.material_type = p.material_type
       AND (sb.barcode IS NULL OR sb.barcode = '')
  `);

  // One-time backfill: mark all PRE-EXISTING sales (those created before the payment
  // tracking columns existed) as fully paid. Tracked in migration_log so it never
  // re-runs on subsequent boots and cannot overwrite legitimate payment state.
  const { rows: [backfillApplied] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'sales_payment_backfill_v1'`
  );
  if (!backfillApplied) {
    await pool.query(`
      UPDATE sales SET payment_status = 'paid', amount_paid = total_amount
      WHERE payment_status = 'unpaid' AND total_amount > 0
    `);
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('sales_payment_backfill_v1')`
    );
    console.log('[migration] sales_payment_backfill_v1 applied');
  }

  // One-time backfill: counter-settled sales (cash/upi/card) recorded before
  // settlement-at-creation existed carry amount_paid = 0 (many already say
  // payment_status 'paid'), which pollutes outstanding/collections and the
  // credit-limit check. Mark them fully paid. Placed AFTER the payment columns
  // above are guaranteed to exist; migration_log keeps it one-time. Credit
  // sales and partially-collected rows are untouched.
  const { rows: [settledBackfill] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'settled_sales_paid_backfill_v1'`
  );
  if (!settledBackfill) {
    const { rowCount: settledFixed } = await pool.query(`
      UPDATE sales SET amount_paid = total_amount, payment_status = 'paid'
      WHERE payment_mode IN ('cash', 'upi', 'card')
        AND COALESCE(amount_paid, 0) = 0
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('settled_sales_paid_backfill_v1')`);
    console.log(`[migration] settled_sales_paid_backfill_v1: marked ${settledFixed} counter-settled sales paid`);
  }

  // ── Backfill CUST-{id} / VEND-{id} ledgers for pre-existing records ──────
  const { rows: [cvBackfill] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'cust_vend_ledger_backfill_v1'`
  );
  if (!cvBackfill) {
    const { rows: [debtors] }   = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-DEBTORS' LIMIT 1`);
    const { rows: [creditors] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-CREDITORS' LIMIT 1`);
    if (debtors && creditors) {
      const { rows: custs } = await pool.query(
        `SELECT c.id, c.name FROM customers c
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers al WHERE al.code = 'CUST-' || c.id::text)`
      );
      for (const c of custs) {
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [c.name, `CUST-${c.id}`, debtors.id, `Customer ledger — ${c.name}`]
        );
      }
      const { rows: vends } = await pool.query(
        `SELECT v.id, v.name FROM vendors v
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers al WHERE al.code = 'VEND-' || v.id::text)`
      );
      for (const v of vends) {
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'liability', $2, 'balance_sheet', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [v.name, `VEND-${v.id}`, creditors.id, `Vendor ledger — ${v.name}`]
        );
      }
      await pool.query(`INSERT INTO migration_log (name) VALUES ('cust_vend_ledger_backfill_v1')`);
      console.log(`[migration] cust_vend_ledger_backfill_v1: seeded ${custs.length} customer + ${vends.length} vendor ledgers`);
    }
  }

  // ── Clearing / transit / charges ledgers ────────────────────────────────
  const clearingLedgers: [string, string, string, string, string, string][] = [
    ['Electronic Payment Clearing', 'asset',   'STD-ELEC-CLR', 'balance_sheet', 'SYS-CURA',   'Clearing for UPI/Card/Bank Transfer payments awaiting bank reconciliation'],
    ['Cash in Transit',             'asset',   'STD-CIT',      'balance_sheet', 'SYS-CURA',   'Cash physically deposited at bank but not yet confirmed'],
    ['Bank & Processor Charges',    'expense', 'STD-PROC-CHG', 'profit_loss',   'SYS-INDEXP', 'Bank and payment processor charges deducted from settlements'],
  ];
  for (const [name, type, code, section, parentCode, desc] of clearingLedgers) {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [parentCode]);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, $2, $3, $4, $5, false, $6
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
        [name, type, code, section, parent.id, desc],
      );
    }
  }

  // ── Production costing ledgers ──────────────────────────────────────────
  // Purchases and payroll are expensed when they happen. When a batch is
  // manufactured its cost is capitalised into stock, so the expense side must
  // be relieved by the same amount — otherwise the cost is counted twice.
  //   Dr Finished Goods Inventory   (asset — the batch now sits in stock)
  //   Cr Production Cost Absorbed   (contra-expense — relieves purchases,
  //                                  wages and overhead already booked)
  // Deleting a batch posts the mirror image, so the pair always nets to the
  // value actually held in stock.
  const productionLedgers: [string, string, string, string, string, string][] = [
    ['Finished Goods Inventory', 'asset',   'STD-FG-INV',   'balance_sheet', 'SYS-CURA',   'Manufactured stock held at cost — debited when a production batch is recorded'],
    ['Production Cost Absorbed', 'expense', 'STD-PROD-ABS', 'profit_loss',   'SYS-DIREXP', 'Contra to purchases, wages and overhead for costs capitalised into manufactured stock'],
    // Inter-branch transfer clearing. A transfer between two GSTINs raises a tax
    // invoice, but it is not turnover — so its value must NOT land in Sales or
    // Purchases. It parks here instead: credited when goods leave, debited when
    // they land, netting to zero once both legs post. Sitting in the balance
    // sheet is what keeps the P&L completely untouched by transfers.
    ['Inter-Branch Transfer',    'liability', 'STD-BRANCH-TRF', 'balance_sheet', 'SYS-CURL', 'Value of taxable stock transferred between own GSTINs — credited on dispatch, debited on receipt, nets to zero'],
  ];
  for (const [name, type, code, section, parentCode, desc] of productionLedgers) {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [parentCode]);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, $2, $3, $4, $5, false, $6
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
        [name, type, code, section, parent.id, desc],
      );
    }
  }

  // ── Statutory payroll ledgers ───────────────────────────────────────────
  // Salary is an indirect expense. The employee's own PF/ESI share is withheld
  // from pay, so it is NOT a separate expense — it moves out of net pay into a
  // payable. The employer's share IS an extra cost to the business, so it gets
  // its own expense ledger. Both shares settle through the same payable, which
  // is what a PF/ESI challan actually discharges.
  const statutoryLedgers: [string, string, string, string, string, string][] = [
    ["Employer PF Contribution",  "expense",   "STD-PF-EMPR",  "profit_loss",   "SYS-INDEXP", "Employer's share of Provident Fund — a cost to the business over and above gross salary"],
    ["Employer ESI Contribution", "expense",   "STD-ESI-EMPR", "profit_loss",   "SYS-INDEXP", "Employer's share of Employees' State Insurance — a cost to the business over and above gross salary"],
    ["PF Payable",                "liability", "STD-PF-PAY",   "balance_sheet", "SYS-CURL",   "Provident Fund withheld from employees plus the employer share, owed to EPFO until the challan is paid"],
    ["ESI Payable",               "liability", "STD-ESI-PAY",  "balance_sheet", "SYS-CURL",   "ESI withheld from employees plus the employer share, owed to ESIC until the challan is paid"],
    ["Employee Deductions Payable", "liability", "STD-EMP-DED", "balance_sheet", "SYS-CURL",  "Other amounts withheld from salary (TDS, loan instalments, fines) pending onward payment"],
  ];
  for (const [name, type, code, section, parentCode, desc] of statutoryLedgers) {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [parentCode]);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, $2, $3, $4, $5, false, $6
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
        [name, type, code, section, parent.id, desc],
      );
    }
  }

  // The two inter-branch party ledgers were created with no parent, which left
  // them outside every balance-sheet group — their balances fell into the
  // statement's "difference" line instead of Current Assets/Liabilities. It
  // never showed because no transfer had ever been taxable. Taxable transfers
  // now post real balances here, so re-parent them.
  for (const [code, parentCode] of [
    ['STD-BRANCH-DEBTOR',   'SYS-CURA'],
    ['STD-BRANCH-CREDITOR', 'SYS-CURL'],
  ] as const) {
    await pool.query(
      `UPDATE account_ledgers SET parent_id = (SELECT id FROM account_ledgers WHERE code = $2)
        WHERE code = $1 AND parent_id IS NULL`,
      [code, parentCode],
    );
  }

  // ── GST ledgers under Duty & Tax (Output = liability, Input = ITC asset) ──
  const gstLedgers: [string, string, string, string][] = [
    ['Output CGST', 'liability', 'STD-OUT-CGST', 'CGST collected on sales (output tax)'],
    ['Output SGST', 'liability', 'STD-OUT-SGST', 'SGST collected on sales (output tax)'],
    ['Output IGST', 'liability', 'STD-OUT-IGST', 'IGST collected on inter-state sales (output tax)'],
    ['Input CGST',  'asset',     'STD-INP-CGST', 'CGST paid on purchases (input tax credit)'],
    ['Input SGST',  'asset',     'STD-INP-SGST', 'SGST paid on purchases (input tax credit)'],
    ['Input IGST',  'asset',     'STD-INP-IGST', 'IGST paid on inter-state purchases (input tax credit)'],
  ];
  const { rows: [dtxParent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'STD-DTX'`);
  if (dtxParent) {
    for (const [name, type, code, desc] of gstLedgers) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, $2, $3, 'balance_sheet', $4, false, $5
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
        [name, type, code, dtxParent.id, desc],
      );
    }
  }

  // ── Per-outlet cash ledgers (provision at startup, idempotent) ──────────
  const { rows: allOutlets } = await pool.query(`SELECT id, name FROM outlets ORDER BY id`);
  const { rows: [cashRootRow] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`);
  if (cashRootRow) {
    for (const outlet of allOutlets) {
      const outletCashCode = `OUTLET-CASH-${outlet.id}`;
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [`${outlet.name} Cash`, outletCashCode, cashRootRow.id, `Cash held at ${outlet.name} outlet`],
      );
    }
  }

  // ── Cash grouping self-heal (idempotent, every boot) ─────────────────────
  // Every per-location cash ledger files under the standard Cash group. Older
  // provisioning could parent one under Current Assets directly when STD-CASH
  // resolved differently, which puts location cash BESIDE Cash on the Balance
  // Sheet instead of inside it. Re-parent on every boot so the grouping stays
  // dynamic — new locations, restores and legacy rows all end up under Cash
  // with no manual chart surgery.
  if (cashRootRow) {
    await pool.query(
      `UPDATE account_ledgers
          SET parent_id = $1
        WHERE (code LIKE 'WH-CASH-%' OR code LIKE 'OUTLET-CASH-%')
          AND parent_id IS DISTINCT FROM $1
          AND id <> $1`,
      [cashRootRow.id],
    );
  }

  // ── Backfill warehouse & outlet ledger IDs (one-time, guarded) ───────────
  const { rows: [woBfApplied] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'warehouse_outlet_ledger_backfill_v1'`
  );
  if (!woBfApplied) {
    const { rows: [cashParent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`);
    const { rows: [salParent] }  = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-SAL' LIMIT 1`);
    const { rows: [purParent] }  = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-PUR' LIMIT 1`);

    if (cashParent && salParent && purParent) {
      // Warehouses missing any ledger ID
      const { rows: warehouses } = await pool.query(
        `SELECT id, name FROM warehouses WHERE cash_ledger_id IS NULL OR sales_ledger_id IS NULL OR purchase_ledger_id IS NULL ORDER BY id`
      );
      for (const wh of warehouses) {
        // Cash
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [`${wh.name} Cash`, `WH-CASH-${wh.id}`, cashParent.id, `Cash held at ${wh.name}`]
        );
        const { rows: [cl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [`WH-CASH-${wh.id}`]);
        // Sales
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'income', $2, 'profit_loss', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [`${wh.name} Sales`, `WH-SAL-${wh.id}`, salParent.id, `Sales revenue from ${wh.name}`]
        );
        const { rows: [sl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [`WH-SAL-${wh.id}`]);
        // Purchase
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'expense', $2, 'profit_loss', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [`${wh.name} Purchase`, `WH-PUR-${wh.id}`, purParent.id, `Purchases at ${wh.name}`]
        );
        const { rows: [pl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [`WH-PUR-${wh.id}`]);
        await pool.query(
          `UPDATE warehouses SET cash_ledger_id = $1, sales_ledger_id = $2, purchase_ledger_id = $3 WHERE id = $4`,
          [cl?.id ?? null, sl?.id ?? null, pl?.id ?? null, wh.id]
        );
      }

      // Outlets missing any ledger ID
      const { rows: outlets } = await pool.query(
        `SELECT id, name FROM outlets WHERE cash_ledger_id IS NULL OR sales_ledger_id IS NULL ORDER BY id`
      );
      for (const outlet of outlets) {
        // Cash (may already exist from per-outlet cash ledger provisioning above)
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [`${outlet.name} Cash`, `OUTLET-CASH-${outlet.id}`, cashParent.id, `Cash held at ${outlet.name}`]
        );
        const { rows: [cl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [`OUTLET-CASH-${outlet.id}`]);
        // Sales
        await pool.query(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, 'income', $2, 'profit_loss', $3, false, $4
           WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
          [`${outlet.name} Sales`, `OUTLET-SAL-${outlet.id}`, salParent.id, `Sales revenue from ${outlet.name}`]
        );
        const { rows: [sl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [`OUTLET-SAL-${outlet.id}`]);
        await pool.query(
          `UPDATE outlets SET cash_ledger_id = $1, sales_ledger_id = $2 WHERE id = $3`,
          [cl?.id ?? null, sl?.id ?? null, outlet.id]
        );
      }

      await pool.query(`INSERT INTO migration_log (name) VALUES ('warehouse_outlet_ledger_backfill_v1')`);
      console.log(`[migration] warehouse_outlet_ledger_backfill_v1: linked ledgers for ${warehouses.length} warehouse(s) + ${outlets.length} outlet(s)`);
    }
  }

  // ── Performance indexes (all idempotent via IF NOT EXISTS) ───────────────
  await pool.query(`
    -- stock_entries: main lookup by branch (used on every stock page)
    CREATE INDEX IF NOT EXISTS idx_stock_entries_branch
      ON stock_entries(branch_type, branch_id);
    CREATE INDEX IF NOT EXISTS idx_stock_entries_item
      ON stock_entries(item_id);

    -- sales: filter by location and date (dashboard, reports, POS)
    CREATE INDEX IF NOT EXISTS idx_sales_location
      ON sales(location_type, location_id);
    CREATE INDEX IF NOT EXISTS idx_sales_date
      ON sales(sale_date);
    CREATE INDEX IF NOT EXISTS idx_sales_payment_status
      ON sales(payment_status);

    -- stock_transfers: filter by status and branch (transfers page)
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_status
      ON stock_transfers(status);
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_from
      ON stock_transfers(from_type, from_id);
    CREATE INDEX IF NOT EXISTS idx_stock_transfers_to
      ON stock_transfers(to_type, to_id);

    -- activity_log: always ordered by created_at desc (dashboard)
    CREATE INDEX IF NOT EXISTS idx_activity_log_created
      ON activity_log(created_at DESC);

    -- payments: date lookups (expenses/location expenses pages)
    CREATE INDEX IF NOT EXISTS idx_payments_date
      ON payments(payment_date);
    CREATE INDEX IF NOT EXISTS idx_payments_from_ledger
      ON payments(paid_from_ledger_id);
    CREATE INDEX IF NOT EXISTS idx_payments_to_ledger
      ON payments(paid_to_ledger_id);

    -- purchases: vendor and date lookups
    CREATE INDEX IF NOT EXISTS idx_purchases_vendor
      ON purchases(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_date
      ON purchases(purchase_date);

    -- customers: location lookup
    CREATE INDEX IF NOT EXISTS idx_customers_location
      ON customers(location_type, location_id);

    -- outlets: warehouse association
    CREATE INDEX IF NOT EXISTS idx_outlets_warehouse
      ON outlets(warehouse_id);
  `);

  // ── Employee personal profile fields ──────────────────────────────────────
  await pool.query(`
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS education       jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact jsonb;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_address  text;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth     text;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS bio               text;
  `);

  // ── Phase 1: Professional Accounts Core (additive only) ──────────────────
  // Journal / Contra / Credit Note / Debit Note vouchers + FY-aware
  // sequence-based voucher numbering. Existing payments/receipts untouched.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal_vouchers (
      id serial PRIMARY KEY,
      voucher_type text NOT NULL DEFAULT 'journal',
      voucher_number text NOT NULL,
      voucher_date text NOT NULL,
      narration text,
      party_ledger_id integer,
      reason text,
      total_amount numeric(14,2) NOT NULL DEFAULT 0,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS journal_voucher_lines (
      id serial PRIMARY KEY,
      voucher_id integer NOT NULL REFERENCES journal_vouchers(id) ON DELETE CASCADE,
      ledger_id integer NOT NULL,
      debit numeric(14,2) NOT NULL DEFAULT 0,
      credit numeric(14,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS voucher_sequences (
      voucher_type text NOT NULL,
      fy_label text NOT NULL,
      last_number integer NOT NULL DEFAULT 0,
      PRIMARY KEY (voucher_type, fy_label)
    );

    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS fy_start_month integer NOT NULL DEFAULT 4;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS voucher_prefixes jsonb;

    CREATE INDEX IF NOT EXISTS idx_jv_lines_voucher ON journal_voucher_lines(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_jv_lines_ledger  ON journal_voucher_lines(ledger_id);
    CREATE INDEX IF NOT EXISTS idx_jv_date          ON journal_vouchers(voucher_date);
    CREATE INDEX IF NOT EXISTS idx_jv_type          ON journal_vouchers(voucher_type);
  `);

  // ── Phase 3: Batch-level inventory, expiry, valuation, reorder levels ─────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_batches (
      id serial PRIMARY KEY,
      item_id integer NOT NULL,
      branch_type text NOT NULL,
      branch_id integer NOT NULL,
      batch_number text NOT NULL,
      mfg_date text,
      expiry_date text,
      quantity numeric(12,3) NOT NULL DEFAULT 0,
      unit_cost numeric(12,2) NOT NULL DEFAULT 0,
      source text,
      source_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_id, branch_type, branch_id, batch_number)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_batches_loc    ON stock_batches(branch_type, branch_id);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_item   ON stock_batches(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches(expiry_date);

    CREATE TABLE IF NOT EXISTS stock_verifications (
      id serial PRIMARY KEY,
      branch_type text NOT NULL,
      branch_id integer NOT NULL,
      verify_date text NOT NULL,
      notes text,
      created_by text,
      lines jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_level numeric(12,3) NOT NULL DEFAULT 10;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS avg_cost numeric(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS batch_number text;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS mfg_date text;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS expiry_date text;

    -- Phase 4: credit control, returns, invoice PDF settings
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit numeric(14,2) NOT NULL DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_days integer NOT NULL DEFAULT 0;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS payment_terms text;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS invoice_footer text;

    CREATE TABLE IF NOT EXISTS sales_returns (
      id serial PRIMARY KEY,
      return_number text NOT NULL,
      sale_id integer NOT NULL REFERENCES sales(id),
      customer_id integer,
      location_type text NOT NULL DEFAULT 'outlet',
      location_id integer NOT NULL DEFAULT 0,
      return_date text NOT NULL,
      line_items jsonb NOT NULL DEFAULT '[]',
      subtotal numeric(14,2) NOT NULL DEFAULT 0,
      tax_total numeric(14,2) NOT NULL DEFAULT 0,
      total_amount numeric(14,2) NOT NULL DEFAULT 0,
      refund_mode text NOT NULL DEFAULT 'credit_note',
      credit_note_id integer,
      refund_payment_id integer,
      reason text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id serial PRIMARY KEY,
      return_number text NOT NULL,
      purchase_id integer NOT NULL REFERENCES purchases(id),
      vendor_id integer NOT NULL,
      return_date text NOT NULL,
      line_items jsonb NOT NULL DEFAULT '[]',
      subtotal numeric(14,2) NOT NULL DEFAULT 0,
      tax_total numeric(14,2) NOT NULL DEFAULT 0,
      total_amount numeric(14,2) NOT NULL DEFAULT 0,
      debit_note_id integer,
      reason text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_sales_returns_sale     ON sales_returns(sale_id);
    CREATE INDEX IF NOT EXISTS idx_sales_returns_customer ON sales_returns(customer_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_purchase ON purchase_returns(purchase_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_returns_vendor   ON purchase_returns(vendor_id);
  `);

  // De-duplicate stock_entries so its identity key is unique, then enforce it.
  // Atomic: the merged quantity lands on the keeper row and duplicates are
  // removed in one transaction. Once the unique index exists, the dedup query
  // matches nothing and this is a permanent no-op.
  //
  // The identity key GREW to include material_type once materials became
  // location-aware. It must be read from the live schema, never hardcoded: on a
  // migrated database item #1 and material #1 legitimately share
  // (item_id, branch_type, branch_id), so grouping without material_type would
  // see them as duplicates and MERGE A MATERIAL INTO AN ITEM — silently
  // destroying stock on an ordinary restart.
  {
    const { rows: [seTyped] } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'stock_entries' AND column_name = 'material_type'`
    );
    const keyCols = seTyped
      ? `item_id, material_type, branch_type, branch_id`
      : `item_id, branch_type, branch_id`;
    const matchCols = seTyped
      ? `se.item_id = d.item_id AND se.material_type = d.material_type
          AND se.branch_type = d.branch_type AND se.branch_id = d.branch_id`
      : `se.item_id = d.item_id AND se.branch_type = d.branch_type
          AND se.branch_id = d.branch_id`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE stock_entries se SET quantity = d.total_qty, cost_price = d.max_cost, updated_at = now()
        FROM (
          SELECT ${keyCols}, MIN(id) AS keep_id,
                 SUM(quantity::numeric) AS total_qty, MAX(cost_price::numeric) AS max_cost
          FROM stock_entries
          GROUP BY ${keyCols}
          HAVING COUNT(*) > 1
        ) d
        WHERE se.id = d.keep_id
      `);
      await client.query(`
        DELETE FROM stock_entries se USING (
          SELECT ${keyCols}, MIN(id) AS keep_id
          FROM stock_entries
          GROUP BY ${keyCols}
          HAVING COUNT(*) > 1
        ) d
        WHERE ${matchCols} AND se.id <> d.keep_id
      `);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Only create the pre-material index on databases that have not yet gained
    // the discriminator. Recreating it afterwards would forbid a location from
    // holding both item #1 and material #1.
    if (!seTyped) {
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_entries_item_branch
         ON stock_entries(item_id, branch_type, branch_id)`
      );
    }
  }

  // One-time: seed weighted-average cost from the manual cost field
  const { rows: [avgSeeded] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'items_avg_cost_seed_v1'`
  );
  if (!avgSeeded) {
    await pool.query(`UPDATE items SET avg_cost = cost WHERE avg_cost = 0 AND cost > 0`);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('items_avg_cost_seed_v1')`);
    console.log('[migration] items_avg_cost_seed_v1 applied');
  }

  // One-time v2: items with no manual cost still get a real average from the
  // weighted cost_price of their existing stock entries, and zero-cost
  // OPENING batches inherit it — otherwise valuation shows ₹0 for stocked
  // locations.
  const { rows: [avgSeededV2] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'items_avg_cost_seed_v2'`
  );
  if (!avgSeededV2) {
    await pool.query(`
      UPDATE items i SET avg_cost = sub.wavg
      FROM (
        SELECT item_id,
               ROUND((SUM(quantity::numeric * cost_price::numeric) / NULLIF(SUM(quantity::numeric), 0))::numeric, 2) AS wavg
        FROM stock_entries
        WHERE quantity::numeric > 0 AND cost_price::numeric > 0
        GROUP BY item_id
      ) sub
      WHERE i.id = sub.item_id AND COALESCE(i.avg_cost, 0) = 0 AND sub.wavg > 0
    `);
    await pool.query(`
      UPDATE stock_batches sb SET unit_cost = i.avg_cost
      FROM items i
      WHERE i.id = sb.item_id AND sb.unit_cost = 0 AND i.avg_cost > 0
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('items_avg_cost_seed_v2')`);
    console.log('[migration] items_avg_cost_seed_v2 applied');
  }

  // One-time: the same treatment for raw and packing materials. Bills recorded
  // before purchases started rolling avg_cost left the masters at 0, which makes
  // every batch made from them cost nothing. The rate is recovered from the
  // purchase history that already exists (weighted by quantity bought), and
  // zero-cost material lots inherit it so batch valuation matches the master.
  const { rows: [matAvgSeeded] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'materials_avg_cost_seed_v1'`
  );
  if (!matAvgSeeded) {
    for (const [kind, table] of [["material", "materials"], ["raw_material", "raw_materials"]] as const) {
      await pool.query(`
        UPDATE ${table} m SET avg_cost = sub.wavg
        FROM (
          SELECT (li->>'materialId')::int AS mid,
                 ROUND((SUM((li->>'quantity')::numeric * (li->>'unitCost')::numeric)
                        / NULLIF(SUM((li->>'quantity')::numeric), 0))::numeric, 4) AS wavg
          FROM purchases p, jsonb_array_elements(p.line_items) li
          -- Branch-transfer inward invoices carry the sending branch's own cost,
          -- not a vendor price. Blending them into the purchase weighted average
          -- would let a transfer restate a material's cost.
          WHERE p.branch_transfer_id IS NULL
            AND li->>'materialType' = $1
            AND (li->>'quantity')::numeric > 0
            AND (li->>'unitCost')::numeric > 0
          GROUP BY (li->>'materialId')::int
        ) sub
        WHERE m.id = sub.mid AND COALESCE(m.avg_cost, 0) = 0 AND sub.wavg > 0
      `, [kind]);
      // Fall back to the manual rate where no purchase history exists.
      await pool.query(`UPDATE ${table} SET avg_cost = cost WHERE COALESCE(avg_cost, 0) = 0 AND COALESCE(cost, 0) > 0`);
      await pool.query(`
        UPDATE stock_batches sb SET unit_cost = m.avg_cost
        FROM ${table} m
        WHERE m.id = sb.item_id AND sb.material_type = $1
          AND sb.unit_cost::numeric = 0 AND m.avg_cost::numeric > 0
      `, [kind]);
    }
    await pool.query(`INSERT INTO migration_log (name) VALUES ('materials_avg_cost_seed_v1')`);
    console.log('[migration] materials_avg_cost_seed_v1 applied');
  }

  // One-time: wrap every existing positive stock quantity into an OPENING
  // batch so legacy stock participates in batch views with quantities
  // preserved exactly. Runs after dedup so (item, branch) rows are unique.
  // Phase 7: login history + configurable password policy (raw columns —
  // remember: invisible to drizzle db.select(), read/write via raw SQL only)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id serial PRIMARY KEY,
      username text NOT NULL,
      employee_id integer,
      success boolean NOT NULL,
      ip text,
      user_agent text,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_username ON login_attempts(username);

    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS password_min_length integer NOT NULL DEFAULT 8;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS password_require_uppercase boolean NOT NULL DEFAULT false;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS password_require_number boolean NOT NULL DEFAULT false;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS password_require_special boolean NOT NULL DEFAULT false;
    ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS general_settings jsonb;
  `);

  // One-time migration: re-home all 'production' branch_type records to 'headoffice'.
  // Production is a department of Head Office, not a separate branch.
  const { rows: [prodMigDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'remove_production_branch_v1'`
  );
  if (!prodMigDone) {
    await pool.query(`
      UPDATE employees     SET branch_type = 'headoffice' WHERE branch_type = 'production';
      UPDATE stock_entries SET branch_type = 'headoffice' WHERE branch_type = 'production';
      UPDATE stock_batches SET branch_type = 'headoffice' WHERE branch_type = 'production';
      UPDATE stock_transfers SET from_type = 'headoffice' WHERE from_type = 'production';
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('remove_production_branch_v1')`);
    console.log('[migration] remove_production_branch_v1 applied — production branch re-homed to headoffice');
  }

  // Repair: stock_batches predates the UNIQUE (item_id, branch_type, branch_id,
  // batch_number) clause in its CREATE TABLE above. Because CREATE TABLE IF NOT
  // EXISTS is a no-op on an existing table, older databases never got the
  // constraint — so every `ON CONFLICT (item_id, branch_type, branch_id,
  // batch_number)` in this file and in lib/batches.ts fails with 42P10
  // ("no unique or exclusion constraint matching the ON CONFLICT
  // specification"). That broke batch credits, and with them sales returns.
  // Merge any duplicate rows first so the index can be created on live data.
  //
  // DANGEROUS ON A WIDENED KEY: once stock_batches carries `material_type`,
  // item #1 and material #1 legitimately share
  // (item_id, branch_type, branch_id, batch_number) — the master tables have
  // overlapping id spaces. Running the dedupe below would merge two unrelated
  // products' lots and destroy stock. If the discriminator is present, the v2
  // key already provides the conflict target, so this block is retired instead.
  const { rows: [batchKeyDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'stock_batches_natural_key_v1'`
  );
  const { rows: [batchDiscriminator] } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'stock_batches' AND column_name = 'material_type'`
  );
  if (!batchKeyDone && batchDiscriminator) {
    await pool.query(`INSERT INTO migration_log (name) VALUES ('stock_batches_natural_key_v1')`);
    console.log('[migration] stock_batches_natural_key_v1 skipped — material_type is present, the wider v2 key supersedes it');
  } else if (!batchKeyDone) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Collapse duplicates onto the lowest id: sum quantity, keep earliest
      // known dates, and carry a quantity-weighted unit cost.
      await client.query(`
        WITH dupes AS (
          SELECT item_id, branch_type, branch_id, batch_number,
                 MIN(id) AS keep_id,
                 SUM(quantity::numeric) AS total_qty,
                 MIN(mfg_date) AS mfg_date,
                 MIN(expiry_date) AS expiry_date,
                 CASE WHEN SUM(quantity::numeric) > 0
                      THEN ROUND((SUM(quantity::numeric * unit_cost::numeric) / SUM(quantity::numeric))::numeric, 2)
                      ELSE MAX(unit_cost::numeric) END AS wavg_cost
          FROM stock_batches
          GROUP BY item_id, branch_type, branch_id, batch_number
          HAVING COUNT(*) > 1
        )
        UPDATE stock_batches sb
        SET quantity = d.total_qty, unit_cost = d.wavg_cost,
            mfg_date = d.mfg_date, expiry_date = d.expiry_date, updated_at = now()
        FROM dupes d
        WHERE sb.id = d.keep_id
      `);
      await client.query(`
        DELETE FROM stock_batches sb
        USING (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY item_id, branch_type, branch_id, batch_number ORDER BY id) AS rn
          FROM stock_batches
        ) x
        WHERE sb.id = x.id AND x.rn > 1
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_natural_key
           ON stock_batches (item_id, branch_type, branch_id, batch_number)`
      );
      await client.query(`INSERT INTO migration_log (name) VALUES ('stock_batches_natural_key_v1')`);
      await client.query('COMMIT');
      console.log('[migration] stock_batches_natural_key_v1 applied — ON CONFLICT upserts on stock_batches now work');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[migration] stock_batches_natural_key_v1 FAILED:', e);
    } finally {
      client.release();
    }
  }

  // Assert the conflict target actually exists. Every batch upsert below and in
  // lib/batches.ts targets this natural key, so without it sales returns,
  // production and purchase batch credits all fail with Postgres 42P10. We do
  // not throw: rethrowing here would abort runMigrations() and skip every
  // later migration. Instead fail LOUDLY so a broken index can't hide behind a
  // successful boot, and skip the two migrations that depend on the key.
  // material_type is part of the check because it is part of the real key.
  // stock_batches is polymorphic — items and materials share the table with
  // overlapping ids — so the live unique index is the five-column
  // stock_batches_natural_key_v2. A four-column check reports a healthy key
  // that Postgres will not accept as an ON CONFLICT arbiter.
  const { rows: [batchKeyIdx] } = await pool.query(`
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'stock_batches' AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%item_id%' AND indexdef ILIKE '%material_type%'
      AND indexdef ILIKE '%branch_type%'
      AND indexdef ILIKE '%branch_id%' AND indexdef ILIKE '%batch_number%'
  `);
  const batchKeyOk = Boolean(batchKeyIdx);
  if (!batchKeyOk) {
    console.error(
      '[migration] CRITICAL: stock_batches has no UNIQUE (item_id, branch_type, branch_id, batch_number) index. ' +
      'Batch upserts (sales returns, production and purchase batch credits) WILL fail with Postgres 42P10 until this is repaired. ' +
      'Most likely cause: duplicate rows on that key that the dedupe step could not merge.'
    );
  }

  const { rows: [openingDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'stock_batches_opening_v1'`
  );
  // Its own try/catch. This statement's ON CONFLICT target is the OLD
  // four-column key, so on any database carrying the five-column
  // stock_batches_natural_key_v2 it raises 42P10 — and an uncaught 42P10 here
  // aborts runMigrations() and silently skips every migration below it, which
  // is exactly the class of failure this boot path must never have again.
  // Applying it correctly means widening both the column list and the conflict
  // target to include material_type, which is a data migration in its own right
  // rather than something to slip into an unrelated fix.
  if (!openingDone) {
    try {
    await pool.query(`
      INSERT INTO stock_batches (item_id, branch_type, branch_id, batch_number, quantity, unit_cost, source)
      SELECT se.item_id, se.branch_type, se.branch_id, 'OPENING',
             se.quantity::numeric - COALESCE(c.lots, 0),
             CASE WHEN se.cost_price::numeric > 0 THEN se.cost_price::numeric ELSE COALESCE(i.avg_cost, 0) END,
             'opening'
      FROM stock_entries se
      LEFT JOIN items i ON i.id = se.item_id
      -- An OPENING batch represents only stock that real lots do NOT already
      -- cover. Inserting the full quantity would double-count every item that
      -- had already been produced or purchased, leaving lots claiming more
      -- goods than the location holds.
      LEFT JOIN (
        SELECT item_id, branch_type, branch_id, SUM(quantity::numeric) AS lots
        FROM stock_batches WHERE batch_number <> 'OPENING'
        GROUP BY item_id, branch_type, branch_id
      ) c ON c.item_id = se.item_id AND c.branch_type = se.branch_type AND c.branch_id = se.branch_id
      WHERE se.quantity::numeric - COALESCE(c.lots, 0) > 0
      ON CONFLICT (item_id, branch_type, branch_id, batch_number) DO NOTHING
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('stock_batches_opening_v1')`);
    console.log('[migration] stock_batches_opening_v1 applied');
    } catch (e) {
      // Deferred, not lost: no migration_log row is written, so a corrected
      // version still applies on a later boot.
      console.error(
        '[migration] stock_batches_opening_v1 DEFERRED (migrations continue):',
        (e as Error).message,
      );
    }
  }

  // One-time: re-sync purchase-lot mfg/expiry dates from their owning bill.
  // Purchase edits made on older builds updated the bill's line_items but left
  // stock_batches untouched (creditBatch COALESCE kept the lot's original
  // dates), so an expiry typo corrected on the bill lived on in stock, expiry
  // reports and FEFO picking. The current edit path deletes and re-inserts the
  // bill's own lots, so new edits propagate — this fixes the rows that
  // diverged before that. The bill line is authoritative for purchase lots:
  // dates are only ever entered on the bill. Lots whose batch number matches
  // more than one line with DIFFERENT dates (the legacy one-lot-per-bill
  // numbering) are skipped rather than guessed at, and only well-formed
  // YYYY-MM-DD values are applied — a malformed bill value never nulls or
  // corrupts a lot date. Own try/catch: a failure here must not skip the
  // migrations below.
  const { rows: [lotDatesDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'purchase_lot_dates_resync_v1'`
  );
  if (!lotDatesDone) {
    try {
      // Candidates are validated HERE, not in SQL: a shape regex cannot catch
      // an impossible calendar date (2026-02-30), and a set-based UPDATE that
      // throws on one bad legacy value aborts the whole repair — blocking
      // every VALID stale lot until someone hand-fixes the bad line. Each lot
      // is judged and written on its own, so a bad value skips only itself.
      const asCalendarDate = (v: unknown): string | null => {
        // Accept plain YYYY-MM-DD or an ISO timestamp prefix; nothing else.
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(String(v ?? ""));
        if (!m) return null;
        const [, y, mo, d] = m;
        const dt = new Date(Date.UTC(+y, +mo - 1, +d));
        return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d
          ? `${y}-${mo}-${d}` : null;
      };
      const { rows: lotCandidates } = await pool.query(`
        SELECT sb.id AS batch_id,
               to_char(sb.expiry_date, 'YYYY-MM-DD') AS lot_exp,
               to_char(sb.mfg_date,    'YYYY-MM-DD') AS lot_mfg,
               min(li->>'expiryDate') AS bill_exp,
               min(li->>'mfgDate')    AS bill_mfg
        FROM stock_batches sb
        JOIN purchases p ON p.id = sb.source_id
        CROSS JOIN LATERAL jsonb_array_elements(p.line_items::jsonb) li
        WHERE sb.source = 'purchase'
          AND li->>'batchNumber' = sb.batch_number
          AND (li->>'materialId')::int = sb.item_id
          AND COALESCE(li->>'materialType', 'item') = sb.material_type
        GROUP BY sb.id
        -- Legacy one-lot-per-bill numbering can match several lines; when
        -- they disagree on dates there is nothing safe to pick, so skip.
        HAVING count(DISTINCT ROW(li->>'expiryDate', li->>'mfgDate')) = 1
      `);
      let lotsResynced = 0;
      for (const c of lotCandidates) {
        const exp = asCalendarDate(c.bill_exp);
        const mfg = asCalendarDate(c.bill_mfg);
        const wantExp = exp !== null && exp !== (c.lot_exp ?? null);
        const wantMfg = mfg !== null && mfg !== (c.lot_mfg ?? null);
        if (!wantExp && !wantMfg) continue;
        await pool.query(
          `UPDATE stock_batches SET
             expiry_date = COALESCE($2::date, expiry_date),
             mfg_date    = COALESCE($3::date, mfg_date),
             updated_at  = now()
           WHERE id = $1`,
          [c.batch_id, wantExp ? exp : null, wantMfg ? mfg : null],
        );
        lotsResynced++;
      }
      await pool.query(`INSERT INTO migration_log (name) VALUES ('purchase_lot_dates_resync_v1')`);
      console.log(`[migration] purchase_lot_dates_resync_v1: re-synced ${lotsResynced} lot date(s) from purchase bills`);
    } catch (e) {
      console.error(
        '[migration] purchase_lot_dates_resync_v1 DEFERRED (migrations continue):',
        (e as Error).message,
      );
    }
  }

  // One-time: retire the 'production' branch type. Production is a Head Office
  // department, not a branch — the hierarchy is headoffice | warehouse | outlet.
  // Employees and stock recorded under 'production' move to Head Office
  // (branch_id 1). Merge-safe: quantities combine where a headoffice row or
  // batch already exists (unique indexes on stock_entries/stock_batches).
  const { rows: [prodBranchDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'remove_production_branch_type_v1'`
  );
  if (!prodBranchDone) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const emp = await client.query(
        `UPDATE employees SET branch_type = 'headoffice', branch_id = 1 WHERE branch_type = 'production'`
      );
      // The uniqueness key gained `material_type` once materials became
      // location-aware. This block predates that, so the conflict target is
      // resolved against the live schema — naming columns that are not in the
      // current unique index raises 42P10 and would abort every later
      // migration.
      const { rows: [mt] } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stock_entries' AND column_name = 'material_type'`
      );
      const seKey = mt
        ? `(item_id, material_type, branch_type, branch_id)`
        : `(item_id, branch_type, branch_id)`;
      // stock_batches gained material_type in the same change and needs the
      // identical treatment. It was left on the old four-column target, so the
      // insert below raised 42P10 and aborted every migration after this block.
      const { rows: [mtBatch] } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'stock_batches' AND column_name = 'material_type'`
      );
      const sbKey = mtBatch
        ? `(item_id, material_type, branch_type, branch_id, batch_number)`
        : `(item_id, branch_type, branch_id, batch_number)`;
      // Carried through the merge, and grouped on, so an item and a material
      // sharing an id are never folded into one batch.
      const sbMt = mtBatch ? 'material_type, ' : '';
      await client.query(`
        INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price)
        SELECT item_id, 'headoffice', 1, SUM(quantity::numeric), MAX(cost_price::numeric)
        FROM stock_entries WHERE branch_type = 'production'
        GROUP BY item_id
        ON CONFLICT ${seKey} DO UPDATE SET
          quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
          cost_price = GREATEST(stock_entries.cost_price::numeric, EXCLUDED.cost_price::numeric),
          updated_at = now()
      `);
      await client.query(`DELETE FROM stock_entries WHERE branch_type = 'production'`);
      await client.query(`
        INSERT INTO stock_batches (item_id, ${sbMt}branch_type, branch_id, batch_number, mfg_date, expiry_date,
                                   quantity, unit_cost, source, source_id)
        SELECT item_id, ${sbMt}'headoffice', 1, batch_number, MIN(mfg_date), MIN(expiry_date),
               SUM(quantity::numeric),
               CASE WHEN SUM(quantity::numeric) > 0
                    THEN ROUND((SUM(quantity::numeric * unit_cost::numeric) / SUM(quantity::numeric))::numeric, 2)
                    ELSE MAX(unit_cost::numeric) END,
               MIN(source), MIN(source_id)
        FROM stock_batches WHERE branch_type = 'production'
        GROUP BY item_id, ${sbMt}batch_number
        ON CONFLICT ${sbKey} DO UPDATE SET
          quantity = stock_batches.quantity::numeric + EXCLUDED.quantity::numeric,
          updated_at = now()
      `);
      await client.query(`DELETE FROM stock_batches WHERE branch_type = 'production'`);
      // Historical documents keep resolving to a real branch name
      await client.query(`UPDATE stock_transfers SET from_type = 'headoffice', from_id = 1 WHERE from_type = 'production'`);
      await client.query(`UPDATE stock_transfers SET to_type = 'headoffice', to_id = 1 WHERE to_type = 'production'`);
      await client.query(`UPDATE stock_verifications SET branch_type = 'headoffice', branch_id = 1 WHERE branch_type = 'production'`);
      await client.query(`INSERT INTO migration_log (name) VALUES ('remove_production_branch_type_v1')`);
      await client.query('COMMIT');
      console.log(`[migration] remove_production_branch_type_v1: ${emp.rowCount} employee(s) re-assigned to Head Office; production stock merged into headoffice`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ERP stabilization: hygiene, date-column typing, indexes, invoice numbering
  // All blocks below are guarded, idempotent and re-runnable on a LIVE database.
  // ══════════════════════════════════════════════════════════════════════════

  // ── (1) Remove test/demo data — GUARDED, delete ONLY unreferenced rows ─────
  // Confirmed test rows: customers 5..19 and their CUST-{id} ledgers, plus item
  // 12 ('TST-P5 Pack 63178'). We delete a row ONLY when it has zero references
  // anywhere it could be pointed at. Anything referenced is deliberately left in
  // place — deleting it would orphan real business documents. This block reports
  // what it removed and what it kept so the state is auditable on every boot.
  // Skipped entirely in production. This block DELETEs rows, and a deletion
  // that is merely believed to be safe has no place running unattended against
  // real business data on every single boot; the test rows it targets only ever
  // existed in development.
  if (process.env.NODE_ENV === "production") {
    console.error("[migration] test_data_cleanup: skipped (production never deletes rows)");
  } else {
    const custIds = Array.from({ length: 15 }, (_, i) => i + 5); // 5..19
    // A customer is safe to remove only if NOTHING points at it.
    const { rows: safeCusts } = await pool.query(
      `SELECT c.id FROM customers c
        WHERE c.id = ANY($1)
          AND c.name ~ '^(Credit Test|ZZ )'
          AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.customer_id = c.id)
          -- its CUST-{id} ledger must also be unreferenced
          AND NOT EXISTS (
            SELECT 1 FROM account_ledgers al
             WHERE al.code = 'CUST-' || c.id::text
               AND (
                 EXISTS (SELECT 1 FROM journal_voucher_lines jvl WHERE jvl.ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM receipts r WHERE r.received_from_ledger_id = al.id OR r.received_in_ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM payments p WHERE p.paid_from_ledger_id = al.id OR p.paid_to_ledger_id = al.id)
               )
          )`,
      [custIds],
    );
    const safeCustIds = safeCusts.map((r) => r.id);
    if (safeCustIds.length > 0) {
      await pool.query(
        `DELETE FROM account_ledgers WHERE code = ANY($1)`,
        [safeCustIds.map((id: number) => `CUST-${id}`)],
      );
      await pool.query(`DELETE FROM customers WHERE id = ANY($1)`, [safeCustIds]);
      console.log(`[migration] test_data_cleanup: removed ${safeCustIds.length} unreferenced test customer(s): ${safeCustIds.join(', ')}`);
    } else {
      console.log('[migration] test_data_cleanup: 0 test customers removable — all customers 5..19 are referenced by sales/receipts; kept in place');
    }

    // Item 12: delete only if it has NO stock/ledger/price/BOM/production refs.
    const { rows: [item12Safe] } = await pool.query(
      `SELECT 1 WHERE
         NOT EXISTS (SELECT 1 FROM stock_entries WHERE item_id = 12 AND material_type = 'item')
         AND NOT EXISTS (SELECT 1 FROM stock_batches WHERE item_id = 12 AND material_type = 'item')
         AND NOT EXISTS (SELECT 1 FROM stock_ledger WHERE ref_id = 12 AND material_type = 'item')
         AND NOT EXISTS (SELECT 1 FROM item_prices WHERE item_id = 12)
         AND NOT EXISTS (SELECT 1 FROM bom_templates WHERE item_id = 12)
         AND NOT EXISTS (SELECT 1 FROM productions WHERE item_id = 12)`
    );
    if (item12Safe) {
      await pool.query(`DELETE FROM items WHERE id = 12 AND name = 'TST-P5 Pack 63178'`);
      console.log('[migration] test_data_cleanup: removed unreferenced test item 12');
    } else {
      console.log('[migration] test_data_cleanup: item 12 kept — referenced by stock_entries/stock_batches (zero-qty scaffolding rows)');
    }
  }

  // ── (2) Fill missing HSN codes for frozen-fruit items ──────────────────────
  // 0810 10 00 is frozen strawberries. Item 1 ('Strawberry') gets it. Item 12,
  // if it survived (1) above, gets a generic frozen-fruit HSN. Idempotent: only
  // touches rows whose hsn_code is still blank.
  await pool.query(
    `UPDATE items SET hsn_code = '08101000'
      WHERE id = 1 AND (hsn_code IS NULL OR hsn_code = '')`
  );
  await pool.query(
    `UPDATE items SET hsn_code = '08101000'
      WHERE id = 12 AND name = 'TST-P5 Pack 63178' AND (hsn_code IS NULL OR hsn_code = '')`
  );
  // NOTE: a DB-level CHECK (hsn_code <> '') is deliberately NOT added here. The
  // item create/update path (routes/inventory.ts) is owned elsewhere and inserts
  // hsn_code verbatim, so a hard CHECK could reject a legitimate future insert
  // that relies on a blank default. Recommendation reported to the main agent.


  // ── (5) Priority-3 performance indexes for hot query paths ─────────────────
  // Each index is created only if the table and every column it needs exist.
  {
    const idxSpecs: [string, string, string[]][] = [
      ['idx_sales_sale_date',          'sales',                 ['sale_date']],
      ['idx_sales_customer_id',        'sales',                 ['customer_id']],
      ['idx_sales_branch_transfer_id', 'sales',                 ['branch_transfer_id']],
      ['idx_sales_cancelled_at',       'sales',                 ['cancelled_at']],
      ['idx_sales_loc',                'sales',                 ['location_type', 'location_id']],
      ['idx_purchases_purchase_date',  'purchases',             ['purchase_date']],
      ['idx_purchases_vendor_id',      'purchases',             ['vendor_id']],
      ['idx_stock_entries_item_mt_br', 'stock_entries',         ['item_id', 'material_type', 'branch_type', 'branch_id']],
      ['idx_stock_batches_item_mt_br', 'stock_batches',         ['item_id', 'material_type', 'branch_type', 'branch_id']],
      ['idx_stock_ledger_ref_mt_br',   'stock_ledger',          ['ref_id', 'material_type', 'branch_type', 'branch_id']],
      ['idx_stock_ledger_doc',         'stock_ledger',          ['doc_type', 'doc_id']],
      ['idx_jvl_ledger_id',            'journal_voucher_lines', ['ledger_id']],
      ['idx_jv_voucher_date',          'journal_vouchers',      ['voucher_date']],
      ['idx_receipts_voucher_number',  'receipts',              ['voucher_number']],
      ['idx_sale_payments_sale_id2',   'sale_payments',         ['sale_id']],
      ['idx_attendance_date',          'attendance',            ['date']],
      ['idx_sales_returns_sale_id',    'sales_returns',         ['sale_id']],
    ];
    for (const [idxName, table, cols] of idxSpecs) {
      try {
        const { rows: present } = await pool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
          [table],
        );
        if (present.length === 0) { console.warn(`[migration] index ${idxName}: table ${table} missing — skipped`); continue; }
        const have = new Set(present.map((r) => r.column_name));
        const missing = cols.filter((c) => !have.has(c));
        if (missing.length > 0) { console.warn(`[migration] index ${idxName}: ${table} missing column(s) ${missing.join(', ')} — skipped`); continue; }
        await pool.query(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (${cols.join(', ')})`);
      } catch (e) {
        console.error(`[migration] index ${idxName} FAILED:`, (e as Error).message);
      }
    }
  }

  // ── (6) Fix duplicate sales invoice numbers, then enforce uniqueness ───────
  // ids 1..13 collide with 15..27 on 'TST/2025-26/0001'..'0013'. They are real,
  // distinct sales, so nothing is deleted — the LATER (higher-id) row of each
  // pair is renumbered onto a fresh number in the SAME format. Any receipt whose
  // voucher_number pointed at the renumbered invoice is updated in the same
  // transaction, because the general ledger links receipts to sales purely by
  // voucher_number = invoice_number (and excludes such receipts to avoid
  // double-counting revenue). Renumbering without fixing the receipt would
  // silently double-count that sale in the Trial Balance.
  {
    const { rows: [dupFixDone] } = await pool.query(
      `SELECT 1 FROM migration_log WHERE name = 'sales_invoice_dedupe_v1'`
    );
    // Only act if duplicates actually remain (also makes a re-run a no-op).
    const { rows: [dupCount] } = await pool.query(
      `SELECT count(*)::int AS c FROM (
         SELECT invoice_number FROM sales
         GROUP BY invoice_number HAVING count(*) > 1
       ) d`
    );
    if (!dupFixDone && dupCount.c > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Group prefixes seen so we can find the next free running number per
        // prefix/FY (e.g. 'TST/2025-26/'). Renumber every non-lowest id in each
        // colliding group.
        const { rows: dupes } = await client.query(
          `SELECT invoice_number, array_agg(id ORDER BY id) AS ids
             FROM sales GROUP BY invoice_number HAVING count(*) > 1`
        );
        let renamed = 0, receiptsFixed = 0;
        for (const d of dupes) {
          // Split 'TST/2025-26/0001' -> prefix 'TST/2025-26/', width 4.
          const m = String(d.invoice_number).match(/^(.*?)(\d+)$/);
          const prefix = m ? m[1] : `${d.invoice_number}-`;
          const width = m ? m[2].length : 4;
          const ids: number[] = d.ids;
          // Keep the lowest id on the original number; renumber the rest.
          for (let i = 1; i < ids.length; i++) {
            const oldNum = d.invoice_number;
            // Next free number for this prefix. CRITICAL: it must not collide
            // with an existing SALE invoice_number NOR an existing RECEIPT
            // voucher_number. The general ledger excludes any receipt whose
            // voucher_number equals a sale invoice_number (to avoid double-
            // counting revenue), so reusing a receipt's number would silently
            // knock that receipt out of the Trial Balance. Take the max numeric
            // suffix across BOTH tables and add one.
            const escPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const { rows: [nextRow] } = await client.query(
              `SELECT GREATEST(
                 COALESCE((SELECT MAX((regexp_replace(invoice_number, '^' || $1, ''))::int)
                             FROM sales
                            WHERE invoice_number LIKE $2
                              AND regexp_replace(invoice_number, '^' || $1, '') ~ '^\\d+$'), 0),
                 COALESCE((SELECT MAX((regexp_replace(voucher_number, '^' || $1, ''))::int)
                             FROM receipts
                            WHERE voucher_number LIKE $2
                              AND regexp_replace(voucher_number, '^' || $1, '') ~ '^\\d+$'), 0)
               ) + 1 AS n`,
              [escPrefix, prefix + '%'],
            );
            const newNum = `${prefix}${String(nextRow.n).padStart(width, '0')}`;
            await client.query(`UPDATE sales SET invoice_number = $1 WHERE id = $2`, [newNum, ids[i]]);
            const { rowCount: rc } = await client.query(
              `UPDATE receipts SET voucher_number = $1 WHERE voucher_number = $2`,
              [newNum, oldNum],
            );
            receiptsFixed += rc ?? 0;
            renamed++;
          }
        }
        // Prove uniqueness before enforcing it.
        const { rows: [stillDup] } = await client.query(
          `SELECT count(*)::int AS c FROM (
             SELECT invoice_number FROM sales GROUP BY invoice_number HAVING count(*) > 1
           ) d`
        );
        if (stillDup.c > 0) throw new Error(`invoice de-dupe left ${stillDup.c} duplicate group(s)`);
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoice_number ON sales (invoice_number)`
        );
        await client.query(`INSERT INTO migration_log (name) VALUES ('sales_invoice_dedupe_v1')`);
        await client.query('COMMIT');
        console.log(`[migration] sales_invoice_dedupe_v1: renumbered ${renamed} sale(s), updated ${receiptsFixed} linked receipt(s), unique index added`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[migration] sales_invoice_dedupe_v1 FAILED (rolled back):', (e as Error).message);
      } finally {
        client.release();
      }
    } else if (!dupFixDone) {
      // No duplicates: still enforce uniqueness and record the migration.
      try {
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_invoice_number ON sales (invoice_number)`);
        await pool.query(`INSERT INTO migration_log (name) VALUES ('sales_invoice_dedupe_v1')`);
        console.log('[migration] sales_invoice_dedupe_v1: no duplicates found, unique index ensured');
      } catch (e) {
        console.error('[migration] sales_invoice_dedupe_v1 unique index FAILED:', (e as Error).message);
      }
    }
  }

  // ── Invoice sequence reconcile (every boot, idempotent) ────────────────────
  // The next invoice number comes from company_settings.invoice_sequence, but
  // the number actually stored on a sale is what makes it unique. Renumbering
  // duplicates moves sales ONTO higher numbers without advancing the counter,
  // so the counter points at numbers that are already taken and every new sale
  // dies on uq_sales_invoice_number. Anything that rewrites invoice numbers can
  // strand the counter the same way, so this is not gated behind a migration
  // log entry — it re-checks on every start and only ever moves the counter
  // forward, never backward over numbers already issued.
  try {
    const { rows } = await pool.query<{ id: number; invoice_sequence: number }>(
      `UPDATE company_settings cs
          SET invoice_sequence = GREATEST(cs.invoice_sequence, COALESCE((
                SELECT MAX((regexp_replace(s.invoice_number, '^.*/', ''))::int)
                  FROM sales s
                 WHERE s.invoice_number LIKE cs.invoice_prefix || '/' || cs.financial_year || '/%'
                   AND regexp_replace(s.invoice_number, '^.*/', '') ~ '^[0-9]+$'
              ), 0))
        WHERE cs.invoice_prefix IS NOT NULL AND cs.financial_year IS NOT NULL
        RETURNING cs.id, cs.invoice_sequence`
    );
    for (const r of rows) {
      console.log(`[migration] invoice_sequence_reconcile: company ${r.id} next invoice sequence is ${r.invoice_sequence}`);
    }
  } catch (e) {
    console.error('[migration] invoice_sequence_reconcile FAILED:', (e as Error).message);
  }

  // ── Chart of Accounts structure ───────────────────────────────────────────
  // Runs last, after every ledger backfill above, so the per-entity ledgers
  // they create are regrouped into their sub-groups in the same boot.
  try {
    await ensureChartStructure(pool);
  } catch (e) {
    console.error('[migration] chart_structure FAILED:', (e as Error).message);
  }
}

// ── Boot-time observability ──────────────────────────────────────────────────
// Production captures stderr from the moment the process starts but only picks
// up stdout once the port is open, so every console.log emitted during boot is
// discarded. That is how a migration failure stayed invisible in production for
// days: its only report was a pino warning, and pino writes to stdout. Anything
// that must be readable after a deploy goes to stderr AND to a boot_status row
// that can be read back later with a plain SQL query.
async function recordBootStatus(
  migrationsError: string | null,
  dateColumns: string,
): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS boot_status (
        id               SERIAL PRIMARY KEY,
        booted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        node_env         TEXT,
        migrations_ok    BOOLEAN,
        migrations_error TEXT,
        date_columns     TEXT
      )`);
    await pool.query(
      `INSERT INTO boot_status (node_env, migrations_ok, migrations_error, date_columns)
       VALUES ($1, $2, $3, $4)`,
      [
        process.env.NODE_ENV ?? "unknown",
        migrationsError === null,
        migrationsError,
        dateColumns,
      ],
    );
    // A diagnostic tail, not an audit log — keep the last 50 boots.
    await pool.query(
      `DELETE FROM boot_status WHERE id <= (SELECT max(id) - 50 FROM boot_status)`,
    );
  } catch (e) {
    console.error("[boot] could not record boot_status:", (e as Error).message);
  }
}

// ── Text date columns → real DATE columns ────────────────────────────────────
// This runs as its OWN top-level step, deliberately NOT inside runMigrations().
// runMigrations() is one long function wrapped in a single catch, so any
// statement that throws part-way through silently skips everything after it.
// That is exactly how production kept these columns as text while every boot
// still reported healthy — the conversion sat behind an earlier statement that
// never completed, and the failure went to a stream nobody could read. Out
// here, an unrelated failure earlier in the boot cannot skip it.
//
// The pass is TYPE-DRIVEN, not log-gated: it inspects the live column type on
// every boot and converts whatever is still text. A publish that reverses the
// type (PostgreSQL applies date->text silently) therefore heals itself on the
// next restart instead of being locked out by an "already applied" log row.
//
// Each column is independent: a missing column, an unexpected type, or a value
// that cannot be cast skips that one column instead of aborting the batch.
async function convertTextDateColumns(): Promise<string> {
  // Development-only escape hatch. A publish diffs the two LIVE databases and
  // PostgreSQL cannot auto-cast text->date, so development has to stay on text
  // until production has converted; the flag is removed straight afterwards.
  //
  // Production REFUSES the hold rather than honouring it. Honouring it there
  // would recreate the exact failure this whole change exists to prevent —
  // columns left as text while the boot reports itself healthy — and no
  // environment variable should be able to quietly undo the conversion.
  const holdRequested = process.env.HOLD_DATE_COLUMN_CONVERSION === "1";
  if (holdRequested && process.env.NODE_ENV === "production") {
    console.error(
      "[migration] text_date_columns_to_date_v2: HOLD_DATE_COLUMN_CONVERSION=1 IGNORED in production — converting anyway",
    );
  } else if (holdRequested) {
    const msg =
      "HELD by HOLD_DATE_COLUMN_CONVERSION=1 — columns left as text (development only)";
    console.error(`[migration] text_date_columns_to_date_v2: ${msg}`);
    return msg;
  }

  let already = 0;
  const converted: string[] = [];
  const skipped: string[] = [];

  for (const [table, col] of DATE_COLUMNS) {
    try {
      // table_schema = 'public' is not optional: this database also carries a
      // backup_meta schema, and an unqualified lookup can answer for a
      // same-named column in another schema.
      const {
        rows: [meta],
      } = await pool.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, col],
      );
      if (!meta) {
        skipped.push(`${table}.${col} (column missing)`);
        continue;
      }
      if (meta.data_type === "date") {
        already++;
        continue;
      }
      if (meta.data_type !== "text" && meta.data_type !== "character varying") {
        skipped.push(`${table}.${col} (unexpected type ${meta.data_type})`);
        continue;
      }
      // Validate every stored value BEFORE altering the column:
      //  - bad_shape: not YYYY-MM-DD at all, so the cast would fail
      //  - bad_value: right shape but not a real date (e.g. 2026-02-30).
      //    to_date is lenient and would silently shift it to 2026-03-02, so
      //    compare the round-trip instead of trusting the regex alone.
      //  - blanks: '' becomes NULL, which a NOT NULL column would reject
      const {
        rows: [audit],
      } = await pool.query(
        `SELECT
           count(*) FILTER (WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} !~ '^\\d{4}-\\d{2}-\\d{2}$')::int AS bad_shape,
           count(*) FILTER (WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} ~ '^\\d{4}-\\d{2}-\\d{2}$'
                                  AND to_date(${col}, 'YYYY-MM-DD')::text <> ${col})::int AS bad_value,
           count(*) FILTER (WHERE ${col} = '')::int AS blanks
         FROM ${table}`,
      );
      if (audit.bad_shape > 0 || audit.bad_value > 0) {
        skipped.push(
          `${table}.${col} (${audit.bad_shape} malformed + ${audit.bad_value} impossible value(s))`,
        );
        continue;
      }
      if (audit.blanks > 0 && meta.is_nullable === "NO") {
        skipped.push(`${table}.${col} (${audit.blanks} blank(s) in a NOT NULL column)`);
        continue;
      }
      await pool.query(
        `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE date USING NULLIF(${col}, '')::date`,
      );
      converted.push(`${table}.${col}`);
    } catch (e) {
      skipped.push(`${table}.${col} (error: ${(e as Error).message})`);
    }
  }

  if (skipped.length === 0) {
    // Record that a full pass succeeded. Informational only — the loop above
    // never consults it, so a later reversal still heals.
    await pool.query(
      `INSERT INTO migration_log (name) SELECT 'text_date_columns_to_date_v2'
        WHERE NOT EXISTS (SELECT 1 FROM migration_log WHERE name = 'text_date_columns_to_date_v2')`,
    );
    const outcome =
      converted.length > 0
        ? `converted ${converted.length} column(s) text->date: ${converted.join(", ")}`
        : `all ${already} date column(s) already correct`;
    console.error(`[migration] text_date_columns_to_date_v2: ${outcome}`);
    return outcome;
  }

  const outcome = `${converted.length} converted, ${already} already date, SKIPPED: ${skipped.join("; ")} — will retry next boot`;
  console.error(`[migration] text_date_columns_to_date_v2: ${outcome}`);
  return outcome;
}

// ── Run core migrations first so all tables exist before the top-level awaits ──
let migrationsError: string | null = null;
try {
  await runMigrations();
} catch (err) {
  // Reported on stderr as well as through the logger: pino writes to stdout,
  // which production discards until the port opens, and this is precisely the
  // failure that must never be silent again.
  const e = err as Error;
  migrationsError = e?.message ?? String(err);
  console.error("[migration] runMigrations FAILED (non-fatal):", migrationsError);
  console.error(e?.stack ?? "(no stack available)");
  logger.warn({ err }, "Migration warning (non-fatal)");
}

// Independent of the block above, on purpose — see convertTextDateColumns().
let dateColumnsOutcome: string;
try {
  dateColumnsOutcome = await convertTextDateColumns();
} catch (err) {
  dateColumnsOutcome = `FAILED: ${(err as Error).message}`;
  console.error(
    "[migration] text_date_columns_to_date_v2 FAILED:",
    (err as Error).message,
  );
}
await recordBootStatus(migrationsError, dateColumnsOutcome);

// ── MRP column on materials and raw_materials ────────────────────────────────
await pool.query(`ALTER TABLE materials    ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) DEFAULT 0`);
await pool.query(`ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) DEFAULT 0`);

// ── GST-aware transfer columns ────────────────────────────────────────────────
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS transfer_type     TEXT DEFAULT 'internal'`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS from_gstin        TEXT`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS to_gstin          TEXT`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS tax_type          TEXT DEFAULT 'none'`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS transfer_value    NUMERIC(14,2)`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS gst_amount        NUMERIC(14,2)`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS dispatch_voucher_id INTEGER`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS receive_voucher_id  INTEGER`);

// ── GST transfer invoicing ────────────────────────────────────────────────────
// A transfer between two different GSTINs is a taxable supply, so it needs a
// real tax invoice at the sender and a purchase invoice at the receiver — GST
// returns read the sales/purchases tables and cannot see journal vouchers.
//
// `document_mode` is the forward-only gate. Transfers raised before this
// existed are stamped 'voucher' by the backfill below and keep their original
// journal-voucher treatment forever; only new transfers get 'invoice'. NULL is
// read as 'voucher' everywhere as a second line of defence.
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS document_mode           TEXT`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS transfer_invoice_number TEXT`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS sale_id                 INTEGER`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS purchase_id             INTEGER`);
await pool.query(`ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS credit_note_voucher_id  INTEGER`);
await pool.query(`UPDATE stock_transfers SET document_mode = 'voucher' WHERE document_mode IS NULL`);

// Transfer invoices live in the sales/purchases tables so GSTR-1, GSTR-3B and
// the HSN summary pick them up. `branch_transfer_id` is what every revenue and
// spend report filters on to keep them out of business turnover — the user's
// requirement is that these are statutory documents, not sales.
for (const t of ['sales', 'purchases']) {
  await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS branch_transfer_id INTEGER`);
  await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS party_name  TEXT`);
  await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS party_gstin TEXT`);
  await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS party_state TEXT`);
  await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${t}_branch_transfer ON ${t} (branch_transfer_id) WHERE branch_transfer_id IS NOT NULL`);
}
// The receiving branch is not a vendor in the masters, so a transfer purchase
// invoice has no vendor_id. Party details live in the party_* columns above.
await pool.query(`ALTER TABLE purchases ALTER COLUMN vendor_id DROP NOT NULL`).catch(() => {});

// Master switch plus a dedicated invoice series. Transfer invoices must not
// consume customer invoice numbers — gaps in the customer sales register are
// exactly what an auditor queries.
await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS gst_transfer_invoicing   BOOLEAN NOT NULL DEFAULT TRUE`);
await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS branch_transfer_prefix   TEXT    NOT NULL DEFAULT 'BTR'`);
await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS branch_transfer_sequence INTEGER NOT NULL DEFAULT 0`);

// ── Invoice payment presentation: UPI collect + bank details ─────────────────
// What an invoice asks the customer to do. The UPI ID sits here as the company
// default; a location that collects into its own handle keeps its own
// `warehouses/outlets.upi_id` and that continues to win, because per-location
// UPI is what makes electronic collections reconcilable to a location.
//
// Defaults preserve the behaviour that existed before these switches: UPI on,
// QR printed, bank details printed. They exist so a company can turn a payment
// request OFF, not to make anyone re-enable what already worked.
//
// bank_branch / account_type / bank_account_holder complete the bank block the
// renderer has always tried to print — it referenced these fields while they
// only ever existed in the template, so those rows silently printed blank.
await pool.query(`
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS upi_enabled                  BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS upi_id                       TEXT;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS upi_payee_name               TEXT;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS show_upi_qr_on_invoice       BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS show_bank_details_on_invoice BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_branch                  TEXT;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS account_type                 TEXT;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS bank_account_holder          TEXT;
`);

// The invoice series lives ON the settings row, so on a fresh database the row
// has to exist before the first transfer is dispatched or the sequence has
// nowhere to persist. The customer INV series has the same dependency.
await pool.query(`
  INSERT INTO company_settings (company_name)
  SELECT 'My Company'
   WHERE NOT EXISTS (SELECT 1 FROM company_settings)
`);

// Two transfers must never share a statutory invoice number. Scoped to transfer
// rows because the customer series predates this and already contains duplicates
// from earlier test data — a global unique index would fail to create.
// The receiver's purchase invoice deliberately reuses the sender's number, so
// this guard belongs on `sales` only.
await pool.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_branch_transfer_invoice_uq
     ON sales (invoice_number)
   WHERE branch_transfer_id IS NOT NULL AND invoice_number IS NOT NULL`,
).catch((e) => {
  console.warn('[migrate] transfer invoice uniqueness index not created:', e?.message ?? e);
});

// ── Outlet GST fields ─────────────────────────────────────────────────────────
await pool.query(`ALTER TABLE outlets ADD COLUMN IF NOT EXISTS gstin       TEXT`);
await pool.query(`ALTER TABLE outlets ADD COLUMN IF NOT EXISTS state       TEXT`);
await pool.query(`ALTER TABLE outlets ADD COLUMN IF NOT EXISTS state_code  TEXT`);

// ── Warehouse state code ──────────────────────────────────────────────────────
await pool.query(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS state_code TEXT`);

// ── stock_ledger table ───────────────────────────────────────────────────────
await pool.query(`
  CREATE TABLE IF NOT EXISTS stock_ledger (
    id          BIGSERIAL PRIMARY KEY,
    txn_type    TEXT NOT NULL,
    material_type TEXT NOT NULL,
    ref_id      INTEGER NOT NULL,
    item_name   TEXT NOT NULL DEFAULT '',
    unit        TEXT NOT NULL DEFAULT '',
    branch_type TEXT NOT NULL DEFAULT '',
    branch_id   INTEGER NOT NULL DEFAULT 0,
    branch_name TEXT NOT NULL DEFAULT '',
    qty_change  NUMERIC(14,4) NOT NULL,
    unit_cost   NUMERIC(14,4) NOT NULL DEFAULT 0,
    doc_type    TEXT NOT NULL,
    doc_id      INTEGER,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_ref      ON stock_ledger (material_type, ref_id, created_at)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_doc      ON stock_ledger (doc_type, doc_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_created  ON stock_ledger (created_at DESC)`);

// txn_date = the movement's BUSINESS date (the document's own date), distinct
// from created_at (the insert time). Date-based stock reports (opening/closing
// stock, stock-as-of) read COALESCE(txn_date, created_at::date) so a backdated
// purchase or an edit made days later lands on the bill's date, not the edit's.
// Backfill: rows written before this column existed get their insert day —
// the best information available for them.
await pool.query(`ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS txn_date DATE`);
await pool.query(`UPDATE stock_ledger SET txn_date = created_at::date WHERE txn_date IS NULL`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_txn_date ON stock_ledger (txn_date)`);

// ── stock_reservations table ──────────────────────────────────────────────────
// One row per commitment against stock, so the same physical goods can never be
// promised twice. `hold` rows reduce available quantity (goods still on hand);
// `in_transit` rows do not (goods already deducted at dispatch) and exist so
// in-flight stock stays visible and valuable to its sender. See
// lib/reservations.ts for the full contract.
await pool.query(`
  CREATE TABLE IF NOT EXISTS stock_reservations (
    id            SERIAL PRIMARY KEY,
    ref_id        INTEGER NOT NULL,
    material_type TEXT    NOT NULL DEFAULT 'item',
    branch_type   TEXT    NOT NULL,
    branch_id     INTEGER NOT NULL,
    batch_id      INTEGER,
    batch_number  TEXT,
    quantity      NUMERIC(12,3) NOT NULL,
    unit_cost     NUMERIC(12,2) NOT NULL DEFAULT 0,
    kind          TEXT    NOT NULL,
    doc_type      TEXT    NOT NULL,
    doc_id        INTEGER NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at   TIMESTAMPTZ,
    CONSTRAINT stock_reservations_qty_positive CHECK (quantity > 0),
    CONSTRAINT stock_reservations_kind_valid   CHECK (kind IN ('hold','in_transit')),
    CONSTRAINT stock_reservations_status_valid CHECK (status IN ('active','released'))
  )
`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_res_active ON stock_reservations (material_type, ref_id, branch_type, branch_id, kind) WHERE status = 'active'`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_res_batch  ON stock_reservations (batch_id) WHERE status = 'active'`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_res_doc    ON stock_reservations (doc_type, doc_id)`);

// Transfers dispatched before reservations existed still have goods in flight.
// Without a row each, that stock belongs to no location and vanishes from
// valuation. Line-level (not lot-level) is enough for a backfill: availability
// is unaffected by in-transit rows, and the value is what matters.
await pool.query(`
  INSERT INTO stock_reservations
    (ref_id, material_type, branch_type, branch_id, quantity, unit_cost, kind, doc_type, doc_id, notes)
  SELECT (li->>'itemId')::int,
         COALESCE(NULLIF(li->>'materialType', ''), 'item'),
         t.from_type, t.from_id,
         (li->>'quantity')::numeric,
         COALESCE(NULLIF(li->>'costPrice', '')::numeric, 0),
         'in_transit', 'stock_transfer', t.id,
         'Backfilled from a transfer already in transit'
    FROM stock_transfers t
    CROSS JOIN LATERAL jsonb_array_elements(t.line_items) li
   WHERE t.status = 'in_transit'
     AND (li->>'itemId') IS NOT NULL
     AND COALESCE((li->>'quantity')::numeric, 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM stock_reservations r
        WHERE r.doc_type = 'stock_transfer' AND r.doc_id = t.id
     )
`);

// ── Additional performance indexes ────────────────────────────────────────────
await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_customer       ON sales (customer_id)       WHERE customer_id IS NOT NULL`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice        ON sales (invoice_number)    WHERE invoice_number IS NOT NULL`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_jv_party_ledger      ON journal_vouchers (party_ledger_id) WHERE party_ledger_id IS NOT NULL`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_emp_month    ON payroll (employee_id, year, month)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_permissions_hier     ON permissions (hierarchy_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry_loc ON stock_batches (expiry_date, branch_type, branch_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_receipts_date        ON receipts (receipt_date)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_journal_voucher_lines_ledger ON journal_voucher_lines (ledger_id)`);

// ── GIN index on JSONB line_items for fast containment queries ────────────────
await pool.query(`CREATE INDEX IF NOT EXISTS idx_sales_line_items_gin   ON sales   USING gin (line_items)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchases_line_items_gin ON purchases USING gin (line_items)`);

// ── LBAC: location columns for vendors (allows per-location vendor isolation) ──
await pool.query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS location_type TEXT DEFAULT 'headoffice'`);
await pool.query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS location_id   INT  DEFAULT 0`);

// ── LBAC: location columns for purchases (all existing records stay headoffice) ─
await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS branch_type TEXT DEFAULT 'headoffice'`);
await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS branch_id   INT  DEFAULT 1`);

// ── LBAC: location columns for money vouchers (payments & receipts) ───────────
// Warehouses run their own cash box, so a voucher has to say which location it
// belongs to. Existing rows default to Head Office and are re-owned by the
// backfill below wherever a ledger leg identifies a branch.
await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS location_type TEXT DEFAULT 'headoffice'`);
await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS location_id   INT  DEFAULT 0`);
await pool.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS location_type TEXT DEFAULT 'headoffice'`);
await pool.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS location_id   INT  DEFAULT 0`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_location ON payments (location_type, location_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_receipts_location ON receipts (location_type, location_id)`);

// One-time backfill: stamp historical vouchers from their ledger legs. A
// payment out of (or receipt into) a location's cash ledger, and a receipt from
// a location's sales ledger, all belong to that location. Runs after the DDL
// above so the columns are guaranteed to exist; migration_log keeps it one-time.
{
  const { rows: mlRows } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'money_voucher_location_backfill_v1'`,
  );
  if (mlRows.length === 0) {
    for (const [table, legs] of [
      ["payments", ["paid_from_ledger_id", "paid_to_ledger_id"]],
      ["receipts", ["received_in_ledger_id", "received_from_ledger_id"]],
    ] as const) {
      // Cash leg (money physically leaves/enters a location's cash box)
      for (const loc of ["warehouse", "outlet"] as const) {
        const locTable = loc === "warehouse" ? "warehouses" : "outlets";
        await pool.query(`
          UPDATE ${table} t SET location_type = '${loc}', location_id = l.id
          FROM ${locTable} l
          WHERE l.cash_ledger_id IS NOT NULL
            AND (t.${legs[0]} = l.cash_ledger_id OR t.${legs[1]} = l.cash_ledger_id)
            AND t.location_type = 'headoffice'
        `);
      }
    }
    // Sales-ledger leg: a location's own sales revenue (e.g. UPI counter sales
    // that clear through STD-ELEC-CLR and never touch the cash box).
    for (const loc of ["warehouse", "outlet"] as const) {
      const locTable = loc === "warehouse" ? "warehouses" : "outlets";
      await pool.query(`
        UPDATE receipts t SET location_type = '${loc}', location_id = l.id
        FROM ${locTable} l
        WHERE l.sales_ledger_id IS NOT NULL
          AND t.received_from_ledger_id = l.sales_ledger_id
          AND t.location_type = 'headoffice'
      `);
    }
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('money_voucher_location_backfill_v1')`,
    );
    console.log("[migration] money_voucher_location_backfill_v1 — stamped historical payments/receipts with their owning location");
  }
}

// ── Print permission column ───────────────────────────────────────────────────
// Download and print are separate rights: an accountant may need a PDF to email
// out, while a warehouse clerk should only be able to put a sheet on the printer
// and never carry a file off the premises.
await pool.query(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS can_print BOOLEAN NOT NULL DEFAULT false`);

// ── One permission row per (role, page) — enforced by the database ────────────
// Without this, two server instances booting at once can both pass the
// "does a row exist?" check and each insert one, leaving two rows for the same
// role and page. The guards read permissions with json_object_agg(module, ...),
// so a duplicate makes the effective rights whichever row the planner happened
// to emit last — authorisation would stop being deterministic.
//
// Any pre-existing duplicates are merged rather than dropped: the surviving row
// takes the OR of every duplicate's flags, so nobody loses access on upgrade.
await pool.query(`
  WITH dupes AS (
    SELECT hierarchy_id, module, MIN(id) AS keep_id,
           bool_or(can_view) v, bool_or(can_add) a, bool_or(can_edit) e,
           bool_or(can_delete) d, bool_or(can_download) dl, bool_or(can_print) p
      FROM permissions GROUP BY hierarchy_id, module HAVING COUNT(*) > 1
  ), merged AS (
    UPDATE permissions SET can_view = dupes.v, can_add = dupes.a, can_edit = dupes.e,
           can_delete = dupes.d, can_download = dupes.dl, can_print = dupes.p
      FROM dupes WHERE permissions.id = dupes.keep_id RETURNING permissions.id
  )
  DELETE FROM permissions p USING dupes
   WHERE p.hierarchy_id = dupes.hierarchy_id AND p.module = dupes.module AND p.id <> dupes.keep_id
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS permissions_hierarchy_module_uq
    ON permissions (hierarchy_id, module)
`);

// ── Per-link permission rows ──────────────────────────────────────────────────
// Permissions used to be grouped: one "Books" row governed Day Book, Cash Book,
// Bank Book and Trial Balance together, so granting a cashier the Cash Book also
// handed them the Trial Balance. Every sidebar link now gets its own row.
//
// Existing access is preserved rather than reset. For each link, the flags of
// every old row that covered it are OR-ed together, so nobody loses anything
// they had. Print starts equal to download, which is the closest existing right
// and what the old UI implicitly allowed.
//
// The important safety property is the fallback direction: if a link has no old
// row covering it at all, it is GRANTED, not denied. Getting this backwards
// would lock administrators out of the Permissions page itself, and the only way
// back in would be a hand-written SQL statement.
//
// This migration runs EXACTLY ONCE, guarded by migration_log. It cannot re-run
// on subsequent boots, and migration_log is intentionally excluded from the
// company/reset truncation so a data reset cannot re-trigger it. The
// all-true rows it may seed for uncovered links are visible via
// GET /company/permissions/rbac-audit.
{
  const { rows: mlRows } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'per_link_permissions_v1'`,
  );
  if (mlRows.length === 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: hRows } = await client.query(`SELECT id FROM hierarchies WHERE level != 1`);
      let expanded = 0;
      let granted = 0;

      for (const h of hRows) {
        const { rows: legacyRows } = await client.query(
          `SELECT module, can_view, can_add, can_edit, can_delete, can_download
             FROM permissions WHERE hierarchy_id = $1`,
          [h.id],
        );
        const byModule = new Map(legacyRows.map((r: any) => [r.module, r]));

        for (const pageKey of PAGE_PERM_KEYS) {
          // Every old module whose pages include this link.
          const sources = Object.entries(LEGACY_MODULE_TO_PAGES)
            .filter(([, pages]) => pages.includes(pageKey))
            .map(([legacy]) => byModule.get(legacy))
            .filter(Boolean) as any[];

          let flags;
          if (sources.length === 0) {
            // Nothing covered this link. Grant — see the note above on why the
            // fallback must not be deny.
            flags = { v: true, a: true, e: true, d: true, dl: true };
            granted++;
          } else {
            flags = {
              v:  sources.some(s => s.can_view === true),
              a:  sources.some(s => s.can_add === true),
              e:  sources.some(s => s.can_edit === true),
              d:  sources.some(s => s.can_delete === true),
              dl: sources.some(s => s.can_download === true),
            };
            expanded++;
          }

          await client.query(
            `INSERT INTO permissions
               (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download, can_print)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (hierarchy_id, module) DO NOTHING`,
            [h.id, pageKey, flags.v, flags.a, flags.e, flags.d, flags.dl],
          );
        }
      }

      // Drop the old grouped rows in the same transaction. Leaving them would be
      // worse than untidy: the gap-fill below reads DISTINCT module from this
      // table, so any survivor would be re-created for every hierarchy forever.
      const del = await client.query(
        `DELETE FROM permissions WHERE module <> ALL($1::text[])`,
        [PAGE_PERM_KEYS],
      );

      await client.query(`INSERT INTO migration_log (name) VALUES ('per_link_permissions_v1')`);
      await client.query("COMMIT");
      console.log(
        `[migration] per_link_permissions_v1 — ${hRows.length} roles × ${PAGE_PERM_KEYS.length} pages: ` +
        `${expanded} carried over, ${granted} granted (no old row covered them), ${del.rowCount} grouped rows removed`,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

// ── Default-deny permission seeding (ONE TIME) ───────────────────────────────
// When enforcement switched from default-allow to default-deny, roles that had
// never been configured would have lost everything overnight. This gives each
// role that existed at that moment an explicit all-true row per page, so the
// change is invisible to them and an admin can then take rights away.
//
// This block runs EXACTLY ONCE, guarded by migration_log. It previously ran on
// every boot (the "gap-fill"), which quietly destroyed the permission model: a
// role created with three pages granted came back from the next restart holding
// all pages with all-true, because the old loop treated "no row" as "grant
// everything". That behaviour was removed when migration_log gating was added.
//
// IMPORTANT: migration_log is intentionally NOT truncated by POST /company/reset
// (see routes/company.ts). This guarantees the seed cannot re-run after a data
// reset and widen permissions for hierarchies created post-reset.
//
// A role created after this migration has run starts with NO permission rows and
// is therefore denied everywhere until an admin explicitly grants access on the
// Permissions page — that is the whole point of default-deny RBAC.
//
// All-true rows seeded here are visible via GET /company/permissions/rbac-audit.
{
  const { rows: seeded } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'permission_seed_existing_v1'`,
  );
  if (seeded.length === 0) {
    const { rows: hRows } = await pool.query(
      `SELECT id FROM hierarchies WHERE level != 1`
    );
    for (const h of hRows) {
      for (const mod of PAGE_PERM_KEYS) {
        await pool.query(
          `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download, can_print)
           VALUES ($1, $2, true, true, true, true, true, true)
           ON CONFLICT (hierarchy_id, module) DO NOTHING`,
          [h.id, mod]
        );
      }
    }
    await pool.query(`INSERT INTO migration_log (name) VALUES ('permission_seed_existing_v1')`);
    console.log(`[migration] permission_seed_existing_v1 — seeded ${hRows.length} pre-existing roles`);
  }
}

// ── Assets module permission seeding (ONE TIME) ─────────────────────────────
// The Assets pages are NEW keys under default-deny: without seeding, every
// pre-existing role — including admin-like roles above level 1 — would be
// silently denied the whole module. Same fallback direction as
// per_link_permissions_v1: GRANT to roles that already existed, and let an
// admin take rights away on the Permissions page. Roles created after this
// migration start with no rows and are denied until granted — that is the
// point of default-deny. Level-1 admins bypass permission checks entirely.
{
  const { rows: seeded } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'assets_page_perms_v1'`,
  );
  if (seeded.length === 0) {
    const ASSET_PAGE_KEYS = [
      "page:/assets/purchases", "page:/assets/register", "page:/assets/categories",
      "page:/assets/transfers", "page:/assets/disposal", "page:/assets/reports",
    ];
    const { rows: hRows } = await pool.query(
      `SELECT id FROM hierarchies WHERE level != 1`,
    );
    for (const h of hRows) {
      for (const mod of ASSET_PAGE_KEYS) {
        await pool.query(
          `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download, can_print)
           VALUES ($1, $2, true, true, true, true, true, true)
           ON CONFLICT (hierarchy_id, module) DO NOTHING`,
          [h.id, mod],
        );
      }
    }
    await pool.query(`INSERT INTO migration_log (name) VALUES ('assets_page_perms_v1')`);
    console.log(`[migration] assets_page_perms_v1 — granted Assets pages to ${hRows.length} pre-existing roles`);
  }
}

// ── Five-action permission model (ONE TIME) ──────────────────────────────────
// Print, Approve and Share stopped being separate user-facing rights: Download
// now covers every output channel (export, PDF save, print, WhatsApp/email
// share) and Edit covers approval (sign-off is write authority). This fold can
// only PRESERVE or (from the folded rights' perspective) narrow — can_download
// and can_edit only ever gain from the columns folded INTO them, so nobody who
// could print/share/approve loses that ability, and nobody who could do none
// of them gains anything.
//
// The legacy columns stay in the table but become mirrors of download/edit —
// written in the same statement here and on every POST /company/permissions —
// so any stray reader of can_print/can_approve/can_share can never disagree
// with the live model. The guards never read them again.
{
  const { rows: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'permission_five_action_fold_v1'`,
  );
  if (done.length === 0) {
    // Every SET expression reads the row's OLD values (SQL semantics), so the
    // mirrors and the fold see the same pre-migration state.
    const folded = await pool.query(`
      UPDATE permissions
         SET can_download = can_download OR can_print OR can_share,
             can_edit     = can_edit OR can_approve,
             can_print    = can_download OR can_print OR can_share,
             can_share    = can_download OR can_print OR can_share,
             can_approve  = can_edit OR can_approve
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('permission_five_action_fold_v1')`);
    console.log(`[migration] permission_five_action_fold_v1 — folded print/share→download, approve→edit across ${folded.rowCount} permission row(s)`);
  }
}

// ── Role reporting lines ─────────────────────────────────────────────────────
// hierarchies.reports_to_id names the role each role reports to. NULL exactly
// for the single root (level-1) role. Level is now DERIVED from this chain
// (root = 1, child = parent + 1); it stays in the table because the RBAC
// middleware's level-1 full-access override and the seeding migrations above
// key on it, but it is no longer client-writable.
await pool.query(`ALTER TABLE hierarchies ADD COLUMN IF NOT EXISTS reports_to_id INTEGER REFERENCES hierarchies(id)`);
{
  const { rows: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'hierarchy_reports_to_v1'`,
  );
  if (done.length === 0) {
    // The model requires EXACTLY ONE root. The canonical root is the oldest
    // level-1 role; if the table somehow holds no level-1 role at all, the
    // backfill is skipped WITHOUT marking done (retried next boot) rather than
    // guessing which role deserves the full-access override.
    const { rows: roots } = await pool.query(
      `SELECT id FROM hierarchies WHERE level = 1 ORDER BY id ASC`,
    );
    if (roots.length === 0) {
      console.error("[migration] hierarchy_reports_to_v1 SKIPPED: no level-1 role exists to serve as the root — fix the hierarchies table; will retry next boot");
    } else {
      const rootId = roots[0].id;
      if (roots.length > 1) {
        // Extra level-1 rows each carried the unrestricted-access override.
        // Folding them under the canonical root NARROWS them to ordinary
        // roles (level re-derived to 2 below) — deliberate: the single-root
        // invariant is the security model, and preserve-or-narrow allows it.
        console.warn(`[migration] hierarchy_reports_to_v1: ${roots.length - 1} extra level-1 role(s) folded under the canonical root (id=${rootId}) and demoted from full access`);
        await pool.query(
          `UPDATE hierarchies SET reports_to_id = $1 WHERE level = 1 AND id <> $1 AND reports_to_id IS NULL`,
          [rootId],
        );
      }
      // Backfill: every remaining role reports to the nearest role above it —
      // the greatest level still smaller than its own (ties → the oldest such
      // role). Roles with nothing above them fall back to the canonical root,
      // so NOTHING except the root is left parentless.
      await pool.query(`
        UPDATE hierarchies h
           SET reports_to_id = COALESCE(
             (SELECT p.id FROM hierarchies p
               WHERE p.level < h.level AND p.id <> h.id
               ORDER BY p.level DESC, p.id ASC LIMIT 1),
             $1
           )
         WHERE h.id <> $1 AND h.reports_to_id IS NULL
      `, [rootId]);
      // Re-derive levels from the chain, seeded from the canonical root only.
      // reports_to_id was all-NULL until this migration and parents always
      // have strictly smaller (old) levels, so cycles cannot exist here; the
      // depth bound is defense in depth against hand-edited data.
      await pool.query(`
        WITH RECURSIVE chain AS (
          SELECT id, 1 AS lvl FROM hierarchies WHERE id = $1
          UNION ALL
          SELECT h.id, c.lvl + 1 FROM hierarchies h JOIN chain c ON h.reports_to_id = c.id
          WHERE c.lvl < 100
        )
        UPDATE hierarchies h SET level = c.lvl FROM chain c WHERE h.id = c.id AND h.level <> c.lvl
      `, [rootId]);
      await pool.query(`INSERT INTO migration_log (name) VALUES ('hierarchy_reports_to_v1')`);
      console.log("[migration] hierarchy_reports_to_v1 — backfilled reporting lines and re-derived role levels");
    }
  }
}

// ── Negative stock prevention ─────────────────────────────────────────────────
// Add a check constraint so the database itself refuses to persist a negative
// quantity. The tolerance of -0.001 absorbs floating-point arithmetic errors
// in FEFO batch consumption while blocking real negatives.
// Only applied when data is already clean; if existing rows violate the
// constraint the ALTER will raise an error which we catch non-fatally.
try {
  await pool.query(`
    ALTER TABLE stock_entries
    ADD CONSTRAINT chk_stock_non_negative CHECK (quantity::numeric >= -0.001)
  `);
} catch {
  // Constraint already exists or data violation — non-fatal, log only.
}

// ── Payroll workflow + Employee advances ──────────────────────────────────────
await pool.query(`
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'draft';
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS extra_amount   NUMERIC(10,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS extra_note     TEXT;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS paid_amount    NUMERIC(10,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS payment_mode       TEXT;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS advance_deduction  NUMERIC(10,2) NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS employee_advances (
    id              SERIAL PRIMARY KEY,
    employee_id     INTEGER NOT NULL REFERENCES employees(id),
    amount          NUMERIC(10,2) NOT NULL,
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    note            TEXT,
    is_deducted     BOOLEAN NOT NULL DEFAULT FALSE,
    deducted_payroll_id INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_advances_employee ON employee_advances (employee_id);

  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS general_settings JSONB;
`);

// ── Multi-punch attendance ────────────────────────────────────────────────────
// A punch pair is one continuous work session; a day can hold several. The
// `attendance` row keeps its first-in/last-out and status exactly as before —
// payroll and the daily salary accrual read it unchanged — while the punches
// carry the detail. Days with punch rows are priced on TOTAL punched hours
// (see attendanceFactor.punchedHours); days without any behave exactly as they
// always have, which is what keeps pre-punch history byte-identical.
await pool.query(`
  CREATE TABLE IF NOT EXISTS attendance_punches (
    id          SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    date        DATE NOT NULL,
    punch_in    TIMESTAMPTZ NOT NULL,
    punch_out   TIMESTAMPTZ,
    in_lat      NUMERIC(10,7),
    in_lng      NUMERIC(10,7),
    out_lat     NUMERIC(10,7),
    out_lng     NUMERIC(10,7),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_att_punches_emp_date ON attendance_punches (employee_id, date);
`);
// One-time: back-fill status for records created before this column existed
{
  const { rows: [payStatusDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'payroll_status_backfill_v1'`
  );
  if (!payStatusDone) {
    await pool.query(`UPDATE payroll SET status = 'paid'     WHERE is_paid = TRUE  AND status = 'draft'`);
    await pool.query(`UPDATE payroll SET status = 'approved' WHERE is_paid = FALSE AND status = 'draft' AND net_pay::numeric > 0`);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('payroll_status_backfill_v1')`);
    console.log('[migration] payroll_status_backfill_v1 applied');
  }
}

// ── Audit-ready expenses + statutory payroll ──────────────────────────────────
// Expenses are recorded two ways and both feed one audited list: rows in
// `expenses` (Head Office, paid from a company cash/bank account) and rows in
// `payments` (a location spending its own cash). The location rows already
// carried a voucher number and a location stamp; these columns bring the
// Head Office rows up to the same standard and give both a category and a
// scanned-bill attachment.
await pool.query(`
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_number TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category       TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS attachment_url TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS location_type  TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS location_id    INTEGER;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by     INTEGER;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_number ON expenses (expense_number) WHERE expense_number IS NOT NULL;

  ALTER TABLE payments ADD COLUMN IF NOT EXISTS expense_category TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS attachment_url   TEXT;

  -- created_by was first shipped as TEXT, which cannot be joined against the
  -- integer employees.id. ADD COLUMN IF NOT EXISTS will not retype an existing
  -- column, so an already-migrated database needs this explicit correction.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'expenses' AND column_name = 'created_by' AND data_type = 'text'
    ) THEN
      ALTER TABLE expenses
        ALTER COLUMN created_by TYPE INTEGER
        USING NULLIF(regexp_replace(created_by, '\D', '', 'g'), '')::INTEGER;
    END IF;
  END $$;

  -- Statutory rates live in company settings, not per employee: PF and ESI are
  -- company-wide obligations. Percentages are editable because the statutory
  -- rates change, and the wage ceilings differ by establishment.
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS pf_enabled           BOOLEAN      NOT NULL DEFAULT TRUE;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS pf_employee_percent  NUMERIC(5,2) NOT NULL DEFAULT 12;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS pf_employer_percent  NUMERIC(5,2) NOT NULL DEFAULT 12;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS esi_enabled          BOOLEAN      NOT NULL DEFAULT TRUE;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS esi_employee_percent NUMERIC(5,2) NOT NULL DEFAULT 0.75;
  ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS esi_employer_percent NUMERIC(5,2) NOT NULL DEFAULT 3.25;

  -- The full salary breakdown is stored on the payroll row, not recomputed on
  -- demand: a rate change must never alter what a period already paid out.
  -- statutory_snapshot records the rates in force when the run was generated.
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS pf_employee        NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS pf_employer        NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS esi_employee       NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS esi_employer       NUMERIC(12,2) NOT NULL DEFAULT 0;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS statutory_snapshot JSONB;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS advance_ids        JSONB;
  ALTER TABLE payroll ADD COLUMN IF NOT EXISTS pay_period_label   TEXT;

  -- Attendance is counted in half days (there is a half-day hours threshold in
  -- settings, and the payslip reports these to one decimal), but these columns
  -- were created as INTEGER. Any period containing a single half day therefore
  -- failed to generate at all. Widened rather than rounded: rounding a half day
  -- either pays for a day not worked or docks a day that was.
  ALTER TABLE payroll ALTER COLUMN present_days TYPE NUMERIC(6,2);
  ALTER TABLE payroll ALTER COLUMN lop_days     TYPE NUMERIC(6,2);

  -- The Add Payment Account form has always collected an IFSC code, but no
  -- column existed to receive it and the API body schema did not declare it,
  -- so every value entered was silently discarded on the way in.
  ALTER TABLE cash_bank_accounts ADD COLUMN IF NOT EXISTS ifsc_code TEXT;
`);

// One-time: give every pre-existing expense an audit number in date order and
// attribute it to Head Office, which is where all of them were recorded.
{
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'expense_audit_fields_v1'`
  );
  if (!done) {
    await pool.query(
      `UPDATE expenses SET location_type = 'headoffice', location_id = 0
        WHERE location_type IS NULL`
    );
    await pool.query(`UPDATE expenses SET category = 'Uncategorised' WHERE category IS NULL`);
    const { rows: legacy } = await pool.query(
      `SELECT id, expense_date FROM expenses
        WHERE expense_number IS NULL ORDER BY expense_date ASC, id ASC`
    );
    for (const row of legacy) {
      const num = await nextVoucherNumber(pool, "expense", String(row.expense_date).slice(0, 10));
      await pool.query(`UPDATE expenses SET expense_number = $1 WHERE id = $2`, [num, row.id]);
    }
    await pool.query(`INSERT INTO migration_log (name) VALUES ('expense_audit_fields_v1')`);
    console.log(`[migration] expense_audit_fields_v1: numbered ${legacy.length} existing expense(s)`);
  }
}

// One-time: materialise a pay structure row for every existing employee. The
// pay-components table was only written when someone opened the editor and
// saved, so most employees ran on an implicit hard-coded default. Seeding real
// rows makes the table the single source of truth for allowances/deductions.
{
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'pay_components_seed_v1'`
  );
  if (!done) {
    const { rowCount } = await pool.query(
      `INSERT INTO pay_components (employee_id, allowances, deductions)
       SELECT e.id, '[]'::jsonb, '[]'::jsonb FROM employees e
       WHERE NOT EXISTS (SELECT 1 FROM pay_components pc WHERE pc.employee_id = e.id)`
    );
    await pool.query(`INSERT INTO migration_log (name) VALUES ('pay_components_seed_v1')`);
    console.log(`[migration] pay_components_seed_v1: seeded ${rowCount} pay structure row(s)`);
  }
}

// ── Opening balances table ────────────────────────────────────────────────────
await pool.query(`
  CREATE TABLE IF NOT EXISTS opening_balances (
    id          SERIAL PRIMARY KEY,
    ledger_id   INTEGER NOT NULL,
    balance     NUMERIC(15,2) NOT NULL DEFAULT 0,
    balance_type TEXT NOT NULL CHECK (balance_type IN ('debit','credit')),
    as_of_date  DATE NOT NULL,
    financial_year TEXT NOT NULL DEFAULT '',
    notes       TEXT,
    created_by  TEXT NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_opening_balances_ledger ON opening_balances (ledger_id)`);
await pool.query(`CREATE INDEX IF NOT EXISTS idx_opening_balances_date   ON opening_balances (as_of_date)`);
// Unique constraint enables the upsert (ON CONFLICT) in the opening-balances route
try {
  await pool.query(`
    ALTER TABLE opening_balances
    ADD CONSTRAINT opening_balances_ledger_year_unique UNIQUE (ledger_id, financial_year)
  `);
} catch { /* constraint already exists */ }

// ── Outlets become warehouses ─────────────────────────────────────────────────
// Runs last: it depends on every column and ledger table created above.
await migrateOutletsToWarehouses(pool);

// Runs after the conversion so it repairs the post-migration locations.
await repairOpeningBatches(pool);

// Materials gain a location dimension. Runs after the conversion so material
// rows land on the final warehouse/head-office layout, and after the opening
// repair so the batch layer is already consistent for items.
await addMaterialLocations(pool);

// Materials gain a batch/expiry layer. Must follow addMaterialLocations: it
// seeds opening lots from the located material rows that migration creates.
await addMaterialBatches(pool);

// Warehouse rent. Runs after the outlet→warehouse conversion so every converted
// warehouse is registered for rent, and after the ledger tables exist so the
// per-warehouse rent ledgers can be provisioned.
await addWarehouseRent(pool);

// Catch up any rent days missed while the server was down, then keep accruing.
startRentAccrualScheduler(pool);

// Daily salary accrual. Runs after the ledger tables exist so the per-employee
// salary ledgers can be provisioned on an employee's first accrued day.
await addSalaryAccrual(pool);
startSalaryAccrualScheduler(pool);

// Invoice share links: the stateful layer behind customer-facing invoice URLs.
await addInvoiceShareLinks(pool);

// Backup catalogue. Runs last: the tables it creates are excluded from every dump,
// so they must exist independently of whatever a restored archive happens to hold.
await addBackupRestore(pool);
await addExpensePaymentModes(pool);

// Fixed-asset support (spec §7). Runs after the chart of accounts is seeded
// above so the postable Fixed Asset ledger (STD-FIXED-ASSET) can be provisioned
// under the SYS-FIXD group. Assets get their OWN tables and never touch stock.
await addFixedAssets(pool);

// Standalone Asset Management module: categories, register fields on
// asset_purchases, transfer + disposal history. Must follow addFixedAssets —
// it extends the tables that migration creates.
await addAssetModule(pool);

// Manual Purchase Bill: stored rate mode, the batch-number allocator and the
// duplicate-invoice guard. Independent of the ledger seeding above.
await addPurchaseBillFields(pool);

// Voucher provenance — records which journal vouchers a person actually typed,
// so only those can be edited by hand. Additive and re-runnable: it only ever
// fills rows whose origin is still unknown. Its own try/catch keeps a failure
// here from taking down boot, and the outcome is on stderr where production
// can read it.
try {
  await addVoucherProvenance(pool);
} catch (err) {
  console.error("[migration] voucher_provenance_v1 FAILED (non-fatal):", (err as Error).message);
}

// Automatic backups and retention. Starts after the migrations above so a
// scheduled backup can never capture a half-upgraded schema.
startBackupScheduler();

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});

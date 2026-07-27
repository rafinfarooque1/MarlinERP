import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { PasswordService } from "./lib/password";

async function runMigrations() {
  // Existing migrations
  await pool.query(`
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_from text;
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_to text;
    ALTER TABLE account_ledgers ADD COLUMN IF NOT EXISTS code text;
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

  // De-duplicate stock_entries so (item, branch_type, branch_id) is unique,
  // then enforce it. Atomic: the merged quantity lands on the keeper row and
  // duplicates are removed in one transaction. Once the unique index exists,
  // the dedup query matches nothing and this is a permanent no-op.
  {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE stock_entries se SET quantity = d.total_qty, cost_price = d.max_cost, updated_at = now()
        FROM (
          SELECT item_id, branch_type, branch_id, MIN(id) AS keep_id,
                 SUM(quantity::numeric) AS total_qty, MAX(cost_price::numeric) AS max_cost
          FROM stock_entries
          GROUP BY item_id, branch_type, branch_id
          HAVING COUNT(*) > 1
        ) d
        WHERE se.id = d.keep_id
      `);
      await client.query(`
        DELETE FROM stock_entries se USING (
          SELECT item_id, branch_type, branch_id, MIN(id) AS keep_id
          FROM stock_entries
          GROUP BY item_id, branch_type, branch_id
          HAVING COUNT(*) > 1
        ) d
        WHERE se.item_id = d.item_id AND se.branch_type = d.branch_type
          AND se.branch_id = d.branch_id AND se.id <> d.keep_id
      `);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_entries_item_branch
     ON stock_entries(item_id, branch_type, branch_id)`
  );

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
  `);

  const { rows: [openingDone] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'stock_batches_opening_v1'`
  );
  if (!openingDone) {
    await pool.query(`
      INSERT INTO stock_batches (item_id, branch_type, branch_id, batch_number, quantity, unit_cost, source)
      SELECT se.item_id, se.branch_type, se.branch_id, 'OPENING',
             se.quantity::numeric,
             CASE WHEN se.cost_price::numeric > 0 THEN se.cost_price::numeric ELSE COALESCE(i.avg_cost, 0) END,
             'opening'
      FROM stock_entries se
      LEFT JOIN items i ON i.id = se.item_id
      WHERE se.quantity::numeric > 0
      ON CONFLICT (item_id, branch_type, branch_id, batch_number) DO NOTHING
    `);
    await pool.query(`INSERT INTO migration_log (name) VALUES ('stock_batches_opening_v1')`);
    console.log('[migration] stock_batches_opening_v1 applied');
  }
}

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

(async () => {
  try {
    await runMigrations();
  } catch (err) {
    logger.warn({ err }, "Migration warning (non-fatal)");
  }

  app.listen(port, (err) => {
    if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
    logger.info({ port }, "Server listening");
  });
})();

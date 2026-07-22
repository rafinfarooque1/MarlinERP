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
  `);

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
    ['Capital Account',     'equity',    'SYS-CAP',    'balance_sheet', 'Owner capital and reserves'],
    ['Loans (Liability)',   'liability', 'SYS-LOAN',   'balance_sheet', 'Long-term loans and borrowings'],
    ['Current Liabilities', 'liability', 'SYS-CURL',   'balance_sheet', 'Short-term obligations due within a year'],
    ['Fixed Assets',        'asset',     'SYS-FIXD',   'balance_sheet', 'Long-term tangible and intangible assets'],
    ['Current Assets',      'asset',     'SYS-CURA',   'balance_sheet', 'Short-term assets convertible within a year'],
    ['Purchase Accounts',   'expense',   'SYS-PUR',    'profit_loss',   'Cost of goods purchased for resale or production'],
    ['Direct Expenses',     'expense',   'SYS-DIREXP', 'profit_loss',   'Expenses directly related to production'],
    ['Indirect Expenses',   'expense',   'SYS-INDEXP', 'profit_loss',   'Administrative and overhead expenses'],
    ['Sales Accounts',      'income',    'SYS-SAL',    'profit_loss',   'Revenue from sale of goods and services'],
    ['Direct Incomes',      'income',    'SYS-DIRINC', 'profit_loss',   'Income directly from core operations'],
    ['Indirect Incomes',    'income',    'SYS-INDINC', 'profit_loss',   'Other miscellaneous income'],
  ];
  for (const [name, type, code, section, description] of sysGroups) {
    await pool.query(
      `INSERT INTO account_ledgers (name, type, code, section, is_system_group, description)
       SELECT $1, $2, $3, $4, true, $5
       WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
      [name, type, code, section, description],
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
      outlet_id integer NOT NULL,
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

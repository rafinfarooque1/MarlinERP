import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

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
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_by text;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_line_items jsonb DEFAULT '[]'::jsonb;
    ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS rejection_reason text;
    UPDATE stock_transfers SET status = 'completed' WHERE status = 'completed';

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
     ON CONFLICT (username) DO UPDATE SET password_hash = 'admin123'`
  );

  // Seed default root account groups (only if none exist)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Capital Account' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Capital Account', 'equity', 'CAP', 'Owner capital and investments');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Sales Account' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Sales Account', 'income', 'SAL', 'Revenue from sales');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Purchase Account' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Purchase Account', 'expense', 'PUR', 'Cost of goods purchased');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Expenses' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Expenses', 'expense', 'EXP', 'Business operating expenses');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Cash & Bank' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Cash & Bank', 'asset', 'CASH', 'Cash and bank balances');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Trade Receivables' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Trade Receivables', 'asset', 'REC', 'Customer receivables');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM account_ledgers WHERE name = 'Trade Payables' AND parent_id IS NULL) THEN
        INSERT INTO account_ledgers (name, type, code, description) VALUES ('Trade Payables', 'liability', 'PAY', 'Vendor payables');
      END IF;
    END $$;
  `);
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

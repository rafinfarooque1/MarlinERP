import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;
import { provisionRentLedgers } from "../lib/rentLedgers";

/**
 * Warehouse Rent Management schema.
 *
 * Four tables plus one permission column. Every warehouse is auto-registered
 * with a rent agreement so the module always lists the full estate — nobody
 * hand-links a warehouse to a rent record.
 *
 * Note on `CREATE TABLE IF NOT EXISTS`: constraints written inside the CREATE
 * only ever apply the first time. Every uniqueness rule below is therefore a
 * separate `CREATE UNIQUE INDEX IF NOT EXISTS`, so it still lands on a database
 * where an earlier version of the table already exists.
 */
export async function addWarehouseRent(pool: Pool): Promise<void> {
  // ── 1. Rent master: one agreement per warehouse ────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS warehouse_rent_agreements (
      id                SERIAL PRIMARY KEY,
      warehouse_id      INTEGER NOT NULL,
      monthly_rent      NUMERIC(15,2) NOT NULL DEFAULT 0,
      security_deposit  NUMERIC(15,2) NOT NULL DEFAULT 0,
      agreement_number  TEXT        NOT NULL DEFAULT '',
      landlord_name     TEXT        NOT NULL DEFAULT '',
      landlord_phone    TEXT        NOT NULL DEFAULT '',
      landlord_email    TEXT        NOT NULL DEFAULT '',
      landlord_address  TEXT        NOT NULL DEFAULT '',
      start_date        DATE,
      end_date          DATE,
      due_day           INTEGER     NOT NULL DEFAULT 5,
      status            TEXT        NOT NULL DEFAULT 'inactive',
      inactive_from     DATE,
      expense_ledger_id INTEGER,
      payable_ledger_id INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_agreement_warehouse
       ON warehouse_rent_agreements (warehouse_id)`,
  );

  // ── 2. Daily accrual rows ──────────────────────────────────────────────────
  // The unique index is what makes the nightly catch-up idempotent: re-running
  // it for a day already accrued is a no-op rather than a double charge.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_accruals (
      id            SERIAL PRIMARY KEY,
      warehouse_id  INTEGER NOT NULL,
      accrual_date  DATE    NOT NULL,
      year          INTEGER NOT NULL,
      month         INTEGER NOT NULL,
      amount        NUMERIC(15,2) NOT NULL,
      monthly_rent  NUMERIC(15,2) NOT NULL,
      days_in_month INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_accrual_wh_date
       ON rent_accruals (warehouse_id, accrual_date)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_rent_accrual_period ON rent_accruals (warehouse_id, year, month)`,
  );

  // ── 3. Approval state, one row per warehouse-month ─────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_periods (
      id           SERIAL PRIMARY KEY,
      warehouse_id INTEGER NOT NULL,
      year         INTEGER NOT NULL,
      month        INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      approved_at  TIMESTAMPTZ,
      approved_by  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_period_wh_ym
       ON rent_periods (warehouse_id, year, month)`,
  );

  // ── 4. Payments (partial supported; many rows per period) ──────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id               SERIAL PRIMARY KEY,
      warehouse_id     INTEGER NOT NULL,
      year             INTEGER NOT NULL,
      month            INTEGER NOT NULL,
      payment_date     DATE    NOT NULL,
      amount           NUMERIC(15,2) NOT NULL,
      payment_mode     TEXT    NOT NULL DEFAULT 'cash',
      reference_number TEXT    NOT NULL DEFAULT '',
      remarks          TEXT    NOT NULL DEFAULT '',
      voucher_id       INTEGER,
      created_by       TEXT    NOT NULL DEFAULT 'system',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_rent_payment_period ON rent_payments (warehouse_id, year, month)`,
  );

  // ── 5. Approve becomes a permission in its own right ───────────────────────
  // Rent is the first module to separate "may edit" from "may approve". The
  // backfill grants approve wherever edit was already granted: approval was
  // previously reachable through the edit action (that is how payroll approval
  // is gated), so defaulting the column to false alone would silently strip
  // authority that roles already had.
  await pool.query(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS can_approve BOOLEAN NOT NULL DEFAULT FALSE`);
  const { rowCount: granted } = await pool.query(
    `UPDATE permissions SET can_approve = TRUE WHERE can_edit = TRUE AND can_approve = FALSE`,
  );
  if (granted) console.log(`[migration] warehouse_rent: granted can_approve to ${granted} existing permission row(s)`);

  // ── 6. Auto-register every existing warehouse ──────────────────────────────
  // New warehouses are registered by the create route; this covers the estate
  // that already existed when the module shipped. Rent starts at zero and
  // inactive, so nothing accrues until someone fills in the agreement.
  const { rowCount: registered } = await pool.query(`
    INSERT INTO warehouse_rent_agreements (warehouse_id)
    SELECT w.id FROM warehouses w
    WHERE NOT EXISTS (SELECT 1 FROM warehouse_rent_agreements a WHERE a.warehouse_id = w.id)
  `);
  if (registered) console.log(`[migration] warehouse_rent: registered ${registered} warehouse(s) for rent`);

  // ── 7. Provision the two ledgers per warehouse ─────────────────────────────
  // Idempotent, and retried on every boot: if the chart of accounts had not been
  // seeded yet on a previous boot the ledgers come out null, and this run fixes
  // them without needing anyone to notice.
  const { rows: warehouses } = await pool.query<{ id: number; name: string }>(
    `SELECT w.id, w.name FROM warehouses w
       JOIN warehouse_rent_agreements a ON a.warehouse_id = w.id
      WHERE a.expense_ledger_id IS NULL OR a.payable_ledger_id IS NULL`,
  );
  let provisioned = 0;
  for (const w of warehouses) {
    const ids = await provisionRentLedgers(pool, w.id, w.name);
    if (ids.expenseLedgerId && ids.payableLedgerId) provisioned++;
  }
  if (provisioned) console.log(`[migration] warehouse_rent: provisioned rent ledgers for ${provisioned} warehouse(s)`);
}

/**
 * Party creation — the ONE code path that makes a customer or a vendor.
 *
 * Used by the manual POST /customers and POST /vendors routes AND by the Data
 * Import commit, so ledger auto-provisioning, location stamping and the
 * insert/stamp atomicity behave identically no matter how a party is born.
 *
 * The insert and the location stamp are one transaction: the caller authorised
 * this row to exist *at this location*, and a row that survives without its
 * stamp is one whose access scoping silently falls back to something nobody
 * approved.
 *
 * `pan` and `notes` are raw-migration columns (added by the data-import boot
 * migration), so drizzle cannot see them — they are written via raw SQL.
 */
import { db, pool, customersTable, vendorsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface LocationStamp {
  type: string;
  id: number;
}

export interface CustomerCreateInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  state?: string | null;
  /** Raw columns — written via raw SQL, not drizzle. */
  pan?: string | null;
  notes?: string | null;
}

export interface VendorCreateInput extends CustomerCreateInput {
  bankName?: string | null;
  accountNumber?: string | null;
}

/** Write the raw-migration extras (pan/notes) when the caller supplied them. */
async function applyPartyExtras(
  table: "customers" | "vendors",
  id: number,
  input: { pan?: string | null; notes?: string | null },
): Promise<void> {
  if (input.pan === undefined && input.notes === undefined) return;
  await pool.query(
    `UPDATE ${table} SET
       pan   = CASE WHEN $1 THEN $2 ELSE pan END,
       notes = CASE WHEN $3 THEN $4 ELSE notes END
     WHERE id = $5`,
    [input.pan !== undefined, input.pan ?? null, input.notes !== undefined, input.notes ?? null, id],
  );
}

/**
 * Auto-create the debtor ledger under Sundry Debtors.
 * Returns the ledger id (created or already existing), or null when the parent
 * head is missing — non-fatal by design, the ledger can be created manually.
 */
export async function ensureCustomerLedger(
  customerId: number, name: string, q: { query: Function } = pool,
): Promise<number | null> {
  try {
    const { rows: [parent] } = await (q as any).query(`SELECT id FROM account_ledgers WHERE code = 'SYS-DEBTORS'`);
    if (!parent) return null;
    await (q as any).query(
      `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
       SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
       WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
      [name, `CUST-${customerId}`, parent.id, `Customer ledger — ${name}`],
    );
    const { rows: [led] } = await (q as any).query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${customerId}`],
    );
    return led ? Number(led.id) : null;
  } catch {
    return null;
  }
}

/** Auto-create the creditor ledger under Sundry Creditors. Same contract.
 *  `q` lets an import run this inside its own (possibly demo) transaction. */
export async function ensureVendorLedger(
  vendorId: number, name: string, q: { query: Function } = pool,
): Promise<number | null> {
  try {
    const { rows: [parent] } = await (q as any).query(`SELECT id FROM account_ledgers WHERE code = 'SYS-CREDITORS'`);
    if (!parent) return null;
    await (q as any).query(
      `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
       SELECT $1, 'liability', $2, 'balance_sheet', $3, false, $4
       WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
      [name, `VEND-${vendorId}`, parent.id, `Vendor ledger — ${name}`],
    );
    const { rows: [led] } = await (q as any).query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${vendorId}`],
    );
    return led ? Number(led.id) : null;
  } catch {
    return null;
  }
}

export async function createCustomerWithLedger(
  input: CustomerCreateInput,
  stamp: LocationStamp,
): Promise<{ row: typeof customersTable.$inferSelect; ledgerId: number | null }> {
  const { pan, notes, ...core } = input;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(customersTable)
      .values(core as typeof customersTable.$inferInsert).returning();
    // location_type/location_id are startup-migration columns — raw SQL only.
    await tx.execute(
      sql`UPDATE customers SET location_type = ${stamp.type}, location_id = ${stamp.id} WHERE id = ${created.id}`,
    );
    return created;
  });
  await applyPartyExtras("customers", row.id, { pan, notes });
  const ledgerId = await ensureCustomerLedger(row.id, row.name);
  if (ledgerId) await stampLedgerLocation(ledgerId, stamp);
  return { row, ledgerId };
}

export async function createVendorWithLedger(
  input: VendorCreateInput,
  stamp: LocationStamp,
): Promise<{ row: typeof vendorsTable.$inferSelect; ledgerId: number | null }> {
  const { pan, notes, ...core } = input;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(vendorsTable)
      .values(core as typeof vendorsTable.$inferInsert).returning();
    await tx.execute(
      sql`UPDATE vendors SET location_type = ${stamp.type}, location_id = ${stamp.id} WHERE id = ${created.id}`,
    );
    return created;
  });
  await applyPartyExtras("vendors", row.id, { pan, notes });
  const ledgerId = await ensureVendorLedger(row.id, row.name);
  if (ledgerId) await stampLedgerLocation(ledgerId, stamp);
  return { row, ledgerId };
}

/**
 * Party ledgers inherit the party's location (display/ownership only — report
 * scoping stays document-based). Only fills a NULL stamp: an existing ledger
 * that was deliberately re-homed or cleared is never overridden.
 * location_type/location_id on account_ledgers are raw-migration columns.
 */
async function stampLedgerLocation(ledgerId: number, stamp: LocationStamp): Promise<void> {
  await pool.query(
    `UPDATE account_ledgers SET location_type = $1, location_id = $2
      WHERE id = $3 AND location_type IS NULL`,
    [stamp.type, stamp.id, ledgerId],
  ).catch(() => {}); // non-fatal, same contract as ensure*Ledger
}

// ── Credit-control fields (raw columns on customers) ────────────────────────

export function validateCreditFields(body: Record<string, any>): string | null {
  if ('creditLimit' in body && body.creditLimit !== null) {
    const v = Number(body.creditLimit);
    if (!Number.isFinite(v) || v < 0) return "creditLimit must be a number ≥ 0";
  }
  if ('creditDays' in body && body.creditDays !== null) {
    const v = Number(body.creditDays);
    if (!Number.isInteger(v) || v < 0) return "creditDays must be a whole number ≥ 0";
  }
  return null;
}

export async function applyCreditFields(id: number, body: Record<string, any>): Promise<void> {
  if ('creditLimit' in body) {
    const v = body.creditLimit === null ? 0 : Math.round(Number(body.creditLimit) * 100) / 100;
    await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [v, id]);
  }
  if ('creditDays' in body) {
    const v = body.creditDays === null ? 0 : Number(body.creditDays);
    await pool.query(`UPDATE customers SET credit_days = $1 WHERE id = $2`, [v, id]);
  }
}

export async function creditFieldsRow(id: number): Promise<{ creditLimit: number; creditDays: number }> {
  const { rows: [r] } = await pool.query<any>(
    `SELECT COALESCE(credit_limit, 0)::numeric AS cl, COALESCE(credit_days, 0) AS cd FROM customers WHERE id = $1`, [id]
  );
  return { creditLimit: Number(r?.cl ?? 0), creditDays: Number(r?.cd ?? 0) };
}

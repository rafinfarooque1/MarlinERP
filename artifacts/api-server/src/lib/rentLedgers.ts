import { pool as _pool } from "@workspace/db";
import { resolveChartParentId } from "./chartGroups";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Per-warehouse rent ledgers.
 *
 * Every warehouse gets exactly two, both system-generated and never hand-made:
 *
 *   Current Liabilities → Rent Payable → <Warehouse>    (SYS-CURL)
 *   Indirect Expense    → Rent Expense → <Warehouse>    (SYS-INDEXP)
 *
 * They sit under the same two group roots payroll uses for salary payable and
 * salary expense, which is what carries rent into the balance sheet and the P&L
 * without any module-specific reporting code.
 */

export const RENT_EXPENSE_CODE = (warehouseId: number) => `RENT-EXP-${warehouseId}`;
export const RENT_PAYABLE_CODE = (warehouseId: number) => `RENT-PAY-${warehouseId}`;

/**
 * Idempotent: safe to call on every warehouse create and on every boot.
 *
 * Mirrors `findOrProvisionLedger` in the payroll module — insert with
 * ON CONFLICT DO NOTHING, then re-read, so two concurrent callers converge on
 * one ledger instead of racing to create duplicates.
 */
async function provisionOne(
  pool: Pool,
  code: string,
  name: string,
  type: "expense" | "liability",
  parentCode: string,
  description: string,
): Promise<number | null> {
  const { rows: [existing] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  if (existing) return existing.id;

  const parentId = await resolveChartParentId(pool, parentCode);
  if (!parentId) return null; // chart of accounts not seeded yet — caller retries next boot

  const section = type === "expense" ? "profit_loss" : "balance_sheet";
  const { rows: [created] } = await pool.query<{ id: number }>(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, $2, $3, $4, $5, false, false, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [name, type, code, section, parentId, description],
  );
  if (created) return created.id;

  const { rows: [retry] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  return retry?.id ?? null;
}

export interface RentLedgerIds {
  expenseLedgerId: number | null;
  payableLedgerId: number | null;
}

/** Create (or find) both rent ledgers for a warehouse and link them to its agreement row. */
export async function provisionRentLedgers(
  pool: Pool,
  warehouseId: number,
  warehouseName: string,
): Promise<RentLedgerIds> {
  const expenseLedgerId = await provisionOne(
    pool,
    RENT_EXPENSE_CODE(warehouseId),
    `Rent Expense - ${warehouseName}`,
    "expense",
    "SYS-INDEXP",
    `Rent expense for ${warehouseName}`,
  );
  const payableLedgerId = await provisionOne(
    pool,
    RENT_PAYABLE_CODE(warehouseId),
    `Rent Payable - ${warehouseName}`,
    "liability",
    "SYS-CURL",
    `Rent payable for ${warehouseName}`,
  );

  await pool.query(
    `UPDATE warehouse_rent_agreements
        SET expense_ledger_id = COALESCE($1, expense_ledger_id),
            payable_ledger_id = COALESCE($2, payable_ledger_id)
      WHERE warehouse_id = $3`,
    [expenseLedgerId, payableLedgerId, warehouseId],
  );

  return { expenseLedgerId, payableLedgerId };
}

/**
 * Keep ledger display names in step with a warehouse rename.
 *
 * Resolved by the linked ledger id rather than the `RENT-*` code, for the same
 * reason the cash/sales/purchase sync does: a warehouse converted from an outlet
 * can carry ledgers created under a different code convention, and a code-based
 * lookup would silently match nothing and let the names drift apart.
 */
export async function syncRentLedgerNames(
  pool: Pool,
  warehouseId: number,
  newName: string,
): Promise<void> {
  const { rows: [row] } = await pool.query<{
    expense_ledger_id: number | null; payable_ledger_id: number | null;
  }>(
    `SELECT expense_ledger_id, payable_ledger_id FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  if (!row) return;

  const renames: [number | null, string][] = [
    [row.expense_ledger_id, `Rent Expense - ${newName}`],
    [row.payable_ledger_id, `Rent Payable - ${newName}`],
  ];
  for (const [ledgerId, name] of renames) {
    if (ledgerId != null) {
      await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [name, ledgerId]);
    }
  }
}

/** Rent ledger ids for a warehouse, used by the delete guard in the branches route. */
export async function rentLedgerIdsFor(pool: Pool, warehouseId: number): Promise<(number | null)[]> {
  const { rows: [row] } = await pool.query<{
    expense_ledger_id: number | null; payable_ledger_id: number | null;
  }>(
    `SELECT expense_ledger_id, payable_ledger_id FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  return [row?.expense_ledger_id ?? null, row?.payable_ledger_id ?? null];
}

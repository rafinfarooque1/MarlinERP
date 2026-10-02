import { pool as _pool } from "@workspace/db";
import { resolveChartParentId } from "./chartGroups";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Per-agreement rent ledgers.
 *
 * Each agreement gets exactly two, both system-generated and never hand-made.
 * The first agreement keeps the legacy per-warehouse codes so existing rent
 * postings and balances remain on their original accounts; later room agreements
 * receive codes keyed by agreement ID:
 *
 *   Current Liabilities → Rent Payable → <Warehouse / Room>
 *   Indirect Expense    → Rent Expense → <Warehouse / Room>
 *
 * They sit under the same two group roots payroll uses for salary payable and
 * salary expense, which is what carries rent into the balance sheet and the P&L
 * without any module-specific reporting code.
 */

export const RENT_EXPENSE_CODE = (warehouseId: number) => `RENT-EXP-${warehouseId}`;
export const RENT_PAYABLE_CODE = (warehouseId: number) => `RENT-PAY-${warehouseId}`;
export const RENT_AGREEMENT_EXPENSE_CODE = (agreementId: number) => `RENT-EXP-A${agreementId}`;
export const RENT_AGREEMENT_PAYABLE_CODE = (agreementId: number) => `RENT-PAY-A${agreementId}`;

function ledgerRoomSuffix(roomName: string): string {
  const label = roomName.trim();
  return label && label !== "Main agreement" ? ` - ${label}` : "";
}

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

/** Create (or find) this agreement's rent ledgers without changing older agreement links. */
export async function provisionRentLedgers(
  pool: Pool,
  agreementId: number,
  warehouseId: number,
  warehouseName: string,
  roomName: string,
): Promise<RentLedgerIds> {
  // Target the container codes, not the group heads (SYS-INDEXP / SYS-CURL):
  // passing a group head files the ledger as a loose sibling of every other
  // indirect expense / current liability, and it only reaches its "Rent Expense"
  // / "Rent Payable" container on the next boot when ensureChartStructure
  // relocates it. Naming the container puts it there on first provision.
  // If the container isn't seeded yet, provisionOne returns null (no ledger,
  // no duplicate container) and the caller retries on the next boot.
  const { rows: [agreement] } = await pool.query<{
    expense_ledger_id: number | null; payable_ledger_id: number | null;
  }>(
    `SELECT expense_ledger_id, payable_ledger_id
       FROM warehouse_rent_agreements
      WHERE id = $1 AND warehouse_id = $2`,
    [agreementId, warehouseId],
  );
  if (!agreement) return { expenseLedgerId: null, payableLedgerId: null };

  // Preserve the original per-warehouse codes and linked accounts for the first
  // agreement. Additional room agreements receive their own stable codes.
  const { rows: [first] } = await pool.query<{ id: number }>(
    `SELECT MIN(id) AS id FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const isOriginal = Number(first?.id) === agreementId;
  const suffix = ledgerRoomSuffix(roomName);
  const expenseCode = isOriginal ? RENT_EXPENSE_CODE(warehouseId) : RENT_AGREEMENT_EXPENSE_CODE(agreementId);
  const payableCode = isOriginal ? RENT_PAYABLE_CODE(warehouseId) : RENT_AGREEMENT_PAYABLE_CODE(agreementId);
  const expenseName = `Rent Expense - ${warehouseName}${suffix}`;
  const payableName = `Rent Payable - ${warehouseName}${suffix}`;

  const expenseLedgerId = agreement.expense_ledger_id ?? await provisionOne(
    pool, expenseCode, expenseName, "expense", "STD-GRP-RENT-EXP", `Rent expense for ${warehouseName}${suffix}`,
  );
  const payableLedgerId = agreement.payable_ledger_id ?? await provisionOne(
    pool, payableCode, payableName, "liability", "STD-GRP-RENT-PAY", `Rent payable for ${warehouseName}${suffix}`,
  );

  await pool.query(
    `UPDATE warehouse_rent_agreements
        SET expense_ledger_id = COALESCE(expense_ledger_id, $1),
            payable_ledger_id = COALESCE(payable_ledger_id, $2)
      WHERE id = $3 AND warehouse_id = $4`,
    [expenseLedgerId, payableLedgerId, agreementId, warehouseId],
  );
  if (expenseLedgerId != null) {
    await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [expenseName, expenseLedgerId]);
  }
  if (payableLedgerId != null) {
    await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [payableName, payableLedgerId]);
  }

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
  const { rows } = await pool.query<{
    expense_ledger_id: number | null; payable_ledger_id: number | null; room_name: string;
  }>(
    `SELECT expense_ledger_id, payable_ledger_id, room_name
       FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const renames = new Map<number, string>();
  for (const row of rows) {
    const suffix = ledgerRoomSuffix(row.room_name ?? "Main agreement");
    if (row.expense_ledger_id != null) renames.set(row.expense_ledger_id, `Rent Expense - ${newName}${suffix}`);
    if (row.payable_ledger_id != null) renames.set(row.payable_ledger_id, `Rent Payable - ${newName}${suffix}`);
  }
  for (const [ledgerId, name] of renames) {
    await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [name, ledgerId]);
  }
}

/** Rent ledger ids for a warehouse, used by the delete guard in the branches route. */
export async function rentLedgerIdsFor(pool: Pool, warehouseId: number): Promise<(number | null)[]> {
  const { rows } = await pool.query<{
    expense_ledger_id: number | null; payable_ledger_id: number | null;
  }>(
    `SELECT expense_ledger_id, payable_ledger_id FROM warehouse_rent_agreements WHERE warehouse_id = $1`,
    [warehouseId],
  );
  return [...new Set(rows.flatMap((row) => [row.expense_ledger_id, row.payable_ledger_id]))];
}

import { pool as _pool } from "@workspace/db";
import { resolveChartParentId } from "./chartGroups";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Per-employee salary ledgers.
 *
 * Every employee gets exactly two, both system-generated and never hand-made:
 *
 *   Current Liabilities → Salary Payable - <Employee>   (SYS-CURL)
 *   Indirect Expense    → Salary - <Employee>           (SYS-INDEXP)
 *
 * These used to be provisioned only when a payroll run was approved, which was
 * fine while salary reached the books at approval. Daily accrual needs them
 * from the employee's first accrued day, so provisioning moved here where both
 * the accrual sweep and the approval voucher can share one implementation —
 * two copies would eventually disagree about the parent group or the section,
 * and a salary ledger filed under the wrong section silently drops out of the
 * P&L.
 */

export const SALARY_EXPENSE_CODE = (employeeId: number) => `SAL-EMP-${employeeId}`;
export const SALARY_PAYABLE_CODE = (employeeId: number) => `SAL-PAY-${employeeId}`;

/**
 * Idempotent: insert with ON CONFLICT DO NOTHING, then re-read, so two
 * concurrent callers converge on one ledger instead of racing to create
 * duplicates.
 */
async function provisionOne(
  pool: Pool,
  code: string,
  name: string,
  type: "expense" | "liability" | "asset",
  parentCode: string,
  description: string,
): Promise<number | null> {
  const { rows: [existing] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [code],
  );
  if (existing) return existing.id;

  const parentId = await resolveChartParentId(pool, parentCode);
  // Section follows the ledger type; an expense stamped 'balance_sheet' never
  // appears in the P&L however correct its postings are.
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

export interface SalaryLedgers {
  expenseLedgerId: number | null;
  payableLedgerId: number | null;
}

/** Safe to call on every accrual sweep and every approval. */
export async function provisionSalaryLedgers(
  pool: Pool,
  employeeId: number,
  empLabel: string,
): Promise<SalaryLedgers> {
  // The container codes, not the group heads (SYS-INDEXP / SYS-CURL): passing a
  // group head files the ledger as a loose sibling of every other indirect
  // expense, and it only reaches its "Salary Expense" container on the next boot
  // when ensureChartStructure relocates it. Naming the container puts it there
  // on the first day the employee accrues.
  const expenseLedgerId = await provisionOne(
    pool, SALARY_EXPENSE_CODE(employeeId), `Salary - ${empLabel}`,
    "expense", "STD-SALARY-EXP", `Salary expense for ${empLabel}`,
  );
  const payableLedgerId = await provisionOne(
    pool, SALARY_PAYABLE_CODE(employeeId), `Salary Payable - ${empLabel}`,
    "liability", "STD-GRP-SAL-PAY", `Salary payable to ${empLabel}`,
  );
  return { expenseLedgerId, payableLedgerId };
}

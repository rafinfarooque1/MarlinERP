import { pool } from "@workspace/db";

/**
 * Administrator = level-1 hierarchy. Voucher deletion (manual receipts,
 * payments and journal-family vouchers) is gated on this ON TOP of the page
 * delete right: removing a voucher rewrites the books, which is a bigger
 * authority than editing one — and the page permission matrix intentionally
 * stays about pages, not about who may erase accounting history.
 *
 * Fails closed: no hierarchy, unknown hierarchy or a read error all mean
 * "not an Administrator".
 */
export async function isLevelOneAdmin(employee: any): Promise<boolean> {
  const hid = Number(employee?.hierarchyId);
  if (!Number.isFinite(hid)) return false;
  const { rows } = await pool.query(`SELECT level FROM hierarchies WHERE id = $1`, [hid]);
  return Number(rows[0]?.level ?? 99) === 1;
}

export const ADMIN_DELETE_ERROR = "Only an Administrator can delete vouchers.";

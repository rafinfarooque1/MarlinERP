/**
 * Server-side data scope helper.
 *
 * Determines which locations an authenticated employee may see data for,
 * derived purely from their branch_type and branch_id — never from
 * client-supplied query parameters.
 *
 * Head Office   → all warehouses and outlets
 * Warehouse     → own warehouse + every outlet whose warehouse_id = their branch_id
 * Outlet        → own outlet only
 */

import { pool } from "@workspace/db";

export interface DataScope {
  isHeadOffice: boolean;
  /** Warehouse branch IDs in scope */
  warehouseIds: number[];
  /** Outlet branch IDs in scope */
  outletIds: number[];
}

export async function getUserDataScope(employee: {
  branchType: string;
  branchId: number;
}): Promise<DataScope> {
  const { branchType, branchId } = employee;

  if (branchType === "headoffice") {
    return { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  }

  if (branchType === "warehouse") {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM outlets WHERE warehouse_id = $1 ORDER BY id`,
      [branchId],
    );
    return {
      isHeadOffice: false,
      warehouseIds: [branchId],
      outletIds: rows.map((r) => Number(r.id)),
    };
  }

  // outlet — sees only their own outlet
  return {
    isHeadOffice: false,
    warehouseIds: [],
    outletIds: [branchId],
  };
}

/**
 * SQL WHERE fragment for the `sales` table.
 * Uses COALESCE because location_type / location_id are raw-migration columns
 * that are null on legacy outlet rows.
 *
 * Appends required values to `params` and returns the SQL string with
 * positional placeholders (`$N`) numbered relative to existing params length.
 *
 * Returns `'TRUE'` for head-office scope (no restriction).
 * Returns `'FALSE'` if the scope is empty (no accessible locations).
 */
export function scopeSalesWhere(scope: DataScope, params: unknown[]): string {
  if (scope.isHeadOffice) return "TRUE";

  const conds: string[] = [];

  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(
      `(COALESCE(s.location_type,'outlet') = 'warehouse' AND COALESCE(s.location_id, s.outlet_id) = ANY($${params.length}::int[]))`,
    );
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(
      `(COALESCE(s.location_type,'outlet') = 'outlet' AND COALESCE(s.location_id, s.outlet_id) = ANY($${params.length}::int[]))`,
    );
  }

  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

/**
 * SQL WHERE fragment for tables with `branch_type` + `branch_id` columns
 * (stock_entries, stock_batches, employees, etc.).
 *
 * @param alias  Table alias used in the query (default: 'se')
 */
export function scopeBranchWhere(
  scope: DataScope,
  params: unknown[],
  alias = "se",
): string {
  if (scope.isHeadOffice) return "TRUE";

  const conds: string[] = [];

  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(
      `(${alias}.branch_type = 'warehouse' AND ${alias}.branch_id = ANY($${params.length}::int[]))`,
    );
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(
      `(${alias}.branch_type = 'outlet' AND ${alias}.branch_id = ANY($${params.length}::int[]))`,
    );
  }

  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

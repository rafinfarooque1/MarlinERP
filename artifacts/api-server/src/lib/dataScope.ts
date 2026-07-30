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

/**
 * Returns whether a concrete branch belongs to a server-derived scope.
 *
 * Request location fields are a requested view, never proof of entitlement.
 * Route handlers should use this before a write, and use the SQL helpers below
 * when reading a stored record. Keeping the primitive here avoids every module
 * inventing subtly different warehouse/outlet checks.
 */
export function isLocationInScope(
  scope: DataScope,
  locationType: string | null | undefined,
  locationId: number | null | undefined,
): boolean {
  if (scope.isHeadOffice) return true;
  if (!Number.isInteger(Number(locationId))) return false;
  if (locationType === "warehouse") return scope.warehouseIds.includes(Number(locationId));
  if (locationType === "outlet") return scope.outletIds.includes(Number(locationId));
  return false;
}

/** A transfer is visible only when either endpoint belongs to the caller. */
export function scopeTransferWhere(
  scope: DataScope,
  params: unknown[],
  alias = "t",
): string {
  if (scope.isHeadOffice) return "TRUE";
  const locations: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    const p = params.length;
    locations.push(`(${alias}.from_type = 'warehouse' AND ${alias}.from_id = ANY($${p}::int[]))`);
    locations.push(`(${alias}.to_type = 'warehouse' AND ${alias}.to_id = ANY($${p}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    const p = params.length;
    locations.push(`(${alias}.from_type = 'outlet' AND ${alias}.from_id = ANY($${p}::int[]))`);
    locations.push(`(${alias}.to_type = 'outlet' AND ${alias}.to_id = ANY($${p}::int[]))`);
  }
  return locations.length ? `(${locations.join(" OR ")})` : "FALSE";
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

/**
 * SQL WHERE fragment for tables with `location_type` + `location_id` columns
 * (customers, sales_returns, vendors, etc.).
 *
 * @param alias             Table alias (default: 't')
 * @param includeHeadoffice Also match rows tagged 'headoffice' or NULL — useful
 *                          for shared master-data like HO-created vendors that
 *                          should be visible to all locations.
 */
export function scopeLocationTypeWhere(
  scope: DataScope,
  params: unknown[],
  alias = "t",
  includeHeadoffice = false,
): string {
  if (scope.isHeadOffice) return "TRUE";

  const conds: string[] = [];

  if (includeHeadoffice) {
    conds.push(
      `(${alias}.location_type IS NULL OR ${alias}.location_type = 'headoffice')`,
    );
  }
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(
      `(${alias}.location_type = 'warehouse' AND ${alias}.location_id = ANY($${params.length}::int[]))`,
    );
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(
      `(${alias}.location_type = 'outlet' AND ${alias}.location_id = ANY($${params.length}::int[]))`,
    );
  }

  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

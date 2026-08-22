import { pool, type PgPoolClient } from "@workspace/db";

export type CashBankLocationType = "headoffice" | "warehouse" | "outlet";

export interface CashBankLocation {
  locationType: CashBankLocationType;
  locationId: number;
  locationName: string;
}

type Queryable = Pick<PgPoolClient, "query">;

export function cashBankLocationKey(location: Pick<CashBankLocation, "locationType" | "locationId">): string {
  return `${location.locationType}:${location.locationId}`;
}

/**
 * Loads account availability in one query. It is deliberately separate from
 * transaction stamps: changing this list controls future account selection
 * only and never rewrites an existing document.
 */
export async function cashBankLocationsByAccount(
  accountIds?: number[],
  queryable: Queryable = pool,
): Promise<Map<number, CashBankLocation[]>> {
  const ids = accountIds?.map(Number).filter(Number.isInteger) ?? [];
  const params: unknown[] = [];
  const where = ids.length > 0 ? `WHERE cbal.account_id = ANY($1::int[])` : "";
  if (ids.length > 0) params.push(ids);
  const { rows } = await queryable.query(`
    SELECT cbal.account_id, cbal.location_type, cbal.location_id,
           CASE cbal.location_type
             WHEN 'headoffice' THEN 'Head Office'
             WHEN 'warehouse' THEN COALESCE(w.name, 'Warehouse #' || cbal.location_id::text)
             WHEN 'outlet' THEN COALESCE(o.name, 'Outlet #' || cbal.location_id::text)
             ELSE 'Unknown location'
           END AS location_name
      FROM cash_bank_account_locations cbal
      LEFT JOIN warehouses w
        ON cbal.location_type = 'warehouse' AND w.id = cbal.location_id
      LEFT JOIN outlets o
        ON cbal.location_type = 'outlet' AND o.id = cbal.location_id
      ${where}
     ORDER BY cbal.account_id, cbal.location_type, cbal.location_id
  `, params);

  const out = new Map<number, CashBankLocation[]>();
  for (const row of rows as any[]) {
    const accountId = Number(row.account_id);
    const location: CashBankLocation = {
      locationType: row.location_type as CashBankLocationType,
      locationId: Number(row.location_id),
      locationName: String(row.location_name),
    };
    out.set(accountId, [...(out.get(accountId) ?? []), location]);
  }
  return out;
}

export async function replaceCashBankLocations(
  queryable: Queryable,
  accountId: number,
  locations: Array<Pick<CashBankLocation, "locationType" | "locationId">>,
): Promise<void> {
  await queryable.query(`DELETE FROM cash_bank_account_locations WHERE account_id = $1`, [accountId]);
  for (const location of locations) {
    await queryable.query(
      `INSERT INTO cash_bank_account_locations (account_id, location_type, location_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, location_type, location_id) DO NOTHING`,
      [accountId, location.locationType, location.locationId],
    );
  }
}
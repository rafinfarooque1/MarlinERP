import type { PgPool as Pool } from "@workspace/db";

/**
 * Backfill the assigned location on party masters that never got one.
 *
 * `location_type` / `location_id` are raw-migration columns on customers and
 * vendors (invisible to drizzle — raw SQL only). Vendors received a
 * DEFAULT of headoffice/0 when their columns were added, but customers were
 * added without a default, so parties created before location stamping have
 * NULL and fall outside every location filter.
 *
 * Rules (masters only — no transaction row is ever touched):
 *  - A customer whose sales all happened at exactly ONE location is assigned
 *    that location: the record demonstrably belongs there.
 *  - Everyone else (no sales, or sales at several locations) goes to Head
 *    Office, the shared-master home. Ambiguity must not guess a branch —
 *    a wrong branch stamp would HIDE the record from every other branch.
 *
 * Idempotent by shape: only NULL rows are touched, and every code path that
 * creates a party stamps a location, so re-runs are no-ops.
 */
export async function backfillPartyLocations(pool: Pool): Promise<void> {
  // Customers with a single distinct sale location → that location.
  // Sale location follows the sale-location-resolution convention:
  // location_type/location_id when present, else legacy outlet_id rows.
  const { rowCount: derived } = await pool.query(`
    UPDATE customers c
       SET location_type = t.ltype, location_id = t.lid
      FROM (
        SELECT customer_id, MIN(ltype) AS ltype, MIN(lid) AS lid
          FROM (
            SELECT DISTINCT s.customer_id,
                   COALESCE(s.location_type, 'outlet') AS ltype,
                   COALESCE(s.location_id, s.outlet_id, 0) AS lid
              FROM sales s
             WHERE s.customer_id IS NOT NULL
          ) d
          -- A branch stamp needs a REAL branch id: a malformed sale that
          -- resolves to warehouse/outlet id 0 must not become a stamp no
          -- location filter can ever match. Head Office ids are placeholders.
         WHERE d.lid > 0 OR d.ltype = 'headoffice'
         GROUP BY customer_id
        HAVING COUNT(*) = 1
      ) t
     WHERE c.id = t.customer_id AND c.location_type IS NULL
  `);

  // Everyone still unstamped → Head Office (shared master).
  const { rowCount: cust } = await pool.query(`
    UPDATE customers SET location_type = 'headoffice', location_id = COALESCE(location_id, 0)
     WHERE location_type IS NULL
  `);
  const { rowCount: vend } = await pool.query(`
    UPDATE vendors SET location_type = 'headoffice', location_id = COALESCE(location_id, 0)
     WHERE location_type IS NULL
  `);

  if ((derived ?? 0) + (cust ?? 0) + (vend ?? 0) > 0) {
    console.log(
      `[migration] party location backfill: ${derived ?? 0} customer(s) from their sales, ` +
      `${cust ?? 0} customer(s) + ${vend ?? 0} vendor(s) to Head Office`,
    );
  }
}

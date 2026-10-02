/**
 * SQL predicate for ordinary read views: hide a warehouse's own rows and
 * outlet rows whose parent warehouse is disabled. Missing location masters
 * remain visible so this display rule does not conceal unrelated orphans.
 *
 * Expressions passed here must be fixed SQL fragments from the caller, never
 * request-provided text. Company-wide accounting books intentionally do not
 * use this predicate; those totals remain complete.
 */
export function visibleLocationSql(
  locationTypeExpression: string,
  locationIdExpression: string,
): string {
  const locationType = `COALESCE((${locationTypeExpression})::text, '')`;
  const locationId = `(${locationIdExpression})::int`;
  return `NOT (
    (
      ${locationType} = 'warehouse'
      AND EXISTS (
        SELECT 1 FROM warehouses disabled_wh
        WHERE disabled_wh.id = ${locationId}
          AND disabled_wh.disabled_at IS NOT NULL
      )
    )
    OR (
      ${locationType} = 'outlet'
      AND EXISTS (
        SELECT 1
          FROM outlets disabled_outlet
          JOIN warehouses disabled_parent ON disabled_parent.id = disabled_outlet.warehouse_id
         WHERE disabled_outlet.id = ${locationId}
           AND disabled_parent.disabled_at IS NOT NULL
      )
    )
  )`;
}
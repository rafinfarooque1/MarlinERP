/**
 * The single stock-valuation function.
 *
 * Every figure that expresses "what is our stock worth" must come from here:
 * the P&L closing stock, the Balance Sheet, the Stock Valuation report and the
 * dashboard. Before this existed the P&L valued stock at MRP off an abandoned
 * counter column while the Stock Valuation report valued the same item at
 * weighted-average cost, so the two never agreed.
 *
 * Rules:
 *  - Quantity comes from `stock_entries`, which is the quantity truth. Never
 *    from `items.production_stock` (a retired counter that sales never
 *    decremented) and never from `stock_batches` (a reconciling lot layer).
 *  - Cost is the item's weighted-average cost, falling back to its manual cost.
 *    MRP is a selling price and must never value stock — that would capitalise
 *    unrealised profit into inventory.
 */

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

/** Weighted-average cost with a manual-cost fallback. Kept as SQL so callers
 *  that need per-location rows and callers that need totals cannot diverge. */
export const ITEM_UNIT_COST_SQL =
  `CASE WHEN COALESCE(i.avg_cost, 0) > 0 THEN i.avg_cost::numeric ELSE COALESCE(i.cost, 0)::numeric END`;

export type ValuedItem = {
  id: number;
  name: string;
  unit: string;
  stock: number;
  unitCost: number;
  total: number;
};

let materialTypeChecked = false;
let hasMaterialType = false;

/**
 * `stock_entries` gains a `material_type` column when raw and packing materials
 * become location-aware. Until then every row is an item. Checked once, because
 * without the filter the JOIN to `items` would silently match material IDs
 * against unrelated item rows.
 */
async function itemRowsFilter(q: Queryable): Promise<string> {
  if (!materialTypeChecked) {
    const { rows } = await q.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'stock_entries' AND column_name = 'material_type'`,
    );
    hasMaterialType = rows.length > 0;
    materialTypeChecked = true;
  }
  return hasMaterialType ? `AND se.material_type = 'item'` : ``;
}

/** Per-item closing stock across every location, valued at cost. */
export async function itemStockValuation(
  q: Queryable,
): Promise<{ items: ValuedItem[]; total: number }> {
  const filter = await itemRowsFilter(q);
  const { rows } = await q.query(
    `SELECT i.id, i.name, COALESCE(i.unit, 'unit') AS unit,
            SUM(se.quantity::numeric)::float AS stock,
            ${ITEM_UNIT_COST_SQL}::float      AS unit_cost
       FROM stock_entries se
       JOIN items i ON i.id = se.item_id
      WHERE TRUE ${filter}
      GROUP BY i.id, i.name, i.unit, i.avg_cost, i.cost
     HAVING SUM(se.quantity::numeric) > 0
      ORDER BY i.name`,
  );

  const items: ValuedItem[] = rows.map((r) => {
    const stock = Number(r.stock);
    const unitCost = Number(r.unit_cost);
    return {
      id: Number(r.id),
      name: r.name,
      unit: r.unit,
      stock,
      unitCost,
      total: Math.round(stock * unitCost * 100) / 100,
    };
  });

  return {
    items,
    total: Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100,
  };
}

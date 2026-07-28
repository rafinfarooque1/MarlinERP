/**
 * Per-location stock movement for raw and packing materials.
 *
 * `stock_entries` is the quantity truth for materials exactly as it is for
 * items, discriminated by `material_type`. The old global counters
 * (`materials.current_stock` / `raw_materials.current_stock`) are kept as
 * mirrors of the company-wide total — the same arrangement items already have
 * with `items.production_stock`. They must never be read to answer "how much is
 * at this location", because they cannot express a location at all.
 *
 * Both helpers take a transaction client: a material movement and its mirror
 * update have to commit or roll back together, or the mirror drifts.
 */

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

/** The tables each discriminator points at. `item` is deliberately absent —
 *  items go through the item paths, which also maintain batches. */
const MIRROR_TABLE: Record<string, string> = {
  material: "materials",
  raw_material: "raw_materials",
};

export type MaterialKind = "material" | "raw_material";

export function isMaterialKind(t: string): t is MaterialKind {
  return t === "material" || t === "raw_material";
}

/**
 * Quantity of one material held at one location. Zero when no row exists —
 * absence of a row means none is held there, not "unknown".
 */
export async function materialStockAt(
  c: Queryable,
  kind: MaterialKind,
  refId: number,
  branchType: string,
  branchId: number,
): Promise<number> {
  const { rows } = await c.query(
    `SELECT quantity::numeric AS quantity FROM stock_entries
      WHERE item_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4
      LIMIT 1 FOR UPDATE`,
    [refId, kind, branchType, branchId],
  );
  return rows[0] ? Number(rows[0].quantity) : 0;
}

/**
 * Deduct from one location. Returns the shortfall check to the caller rather
 * than throwing, so routes keep their existing 400-with-message behaviour.
 *
 * `mirror: false` is for movements that only relocate goods (a transfer between
 * two locations) — the company-wide total has not changed, so touching the
 * mirror would corrupt it.
 */
export async function deductMaterialAt(
  c: Queryable,
  kind: MaterialKind,
  refId: number,
  branchType: string,
  branchId: number,
  qty: number,
  opts: { mirror?: boolean; floor?: boolean } = {},
): Promise<{ ok: boolean; available: number }> {
  const available = await materialStockAt(c, kind, refId, branchType, branchId);
  if (!opts.floor && available + 0.001 < qty) return { ok: false, available };

  // `floor` is for reversal paths — deleting a purchase, un-approving a batch.
  // They must not fail on an arithmetic shortfall, and stock_entries carries a
  // non-negative CHECK, so the subtraction is clamped instead of refused.
  await c.query(
    opts.floor
      ? `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
          WHERE item_id = $2 AND material_type = $3 AND branch_type = $4 AND branch_id = $5`
      : `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now()
          WHERE item_id = $2 AND material_type = $3 AND branch_type = $4 AND branch_id = $5`,
    [qty, refId, kind, branchType, branchId],
  );

  if (opts.mirror) {
    await c.query(
      `UPDATE ${MIRROR_TABLE[kind]} SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`,
      [qty, refId],
    );
  }
  return { ok: true, available };
}

/**
 * Credit a location, creating the row when the material has never been held
 * there. `unitCost` only seeds a brand-new row; an existing row keeps the cost
 * it already carries so a relocation cannot silently revalue stock.
 */
export async function creditMaterialAt(
  c: Queryable,
  kind: MaterialKind,
  refId: number,
  branchType: string,
  branchId: number,
  qty: number,
  unitCost = 0,
  opts: { mirror?: boolean } = {},
): Promise<void> {
  await c.query(
    `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
       quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
       updated_at = now()`,
    [refId, kind, branchType, branchId, qty, unitCost],
  );

  if (opts.mirror) {
    await c.query(
      `UPDATE ${MIRROR_TABLE[kind]} SET current_stock = COALESCE(current_stock, 0)::numeric + $1, updated_at = now() WHERE id = $2`,
      [qty, refId],
    );
  }
}

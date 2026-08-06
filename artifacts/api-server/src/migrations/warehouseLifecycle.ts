type Queryable = { query: (text: string) => Promise<unknown> };

/**
 * Warehouse lifecycle columns — a warehouse can be disabled (soft-off) before
 * anyone considers deleting it. NULL disabled_at = active. The column is
 * additive and invisible to Drizzle's partial schema, so every reader and
 * writer must use raw SQL (see raw-migration column convention).
 */
export async function addWarehouseLifecycle(pool: Queryable): Promise<void> {
  await pool.query(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS disabled_by TEXT`);
}

import type { PgPool } from "@workspace/db";

/**
 * Give raw materials and packing materials a batch layer, exactly like finished
 * goods already have.
 *
 * `stock_batches` was item-only: its natural key was
 * (item_id, branch_type, branch_id, batch_number). Materials now live in
 * `stock_entries` under a `material_type` discriminator, and the three master
 * tables (items / materials / raw_materials) have OVERLAPPING id spaces both
 * starting at 1. So the same widening has to happen here or material #1's lots
 * would collide with item #1's lots and merge two unrelated products.
 *
 * Ordering matters: the wider unique index is created BEFORE the narrow one is
 * dropped, so there is never a window in which batch upserts have no conflict
 * target (that raises Postgres 42P10 and silently breaks every batch credit).
 *
 * Idempotent, guarded by migration_log, and never rethrows — an inner throw
 * here would abort the remaining startup migrations.
 */
export async function addMaterialBatches(pool: PgPool): Promise<void> {
  const GUARD = "stock_batches_material_type_v1";
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD]
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Discriminator column. Existing 34 rows are all finished goods.
    await client.query(
      `ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS material_type TEXT NOT NULL DEFAULT 'item'`
    );
    await client.query(`UPDATE stock_batches SET material_type = 'item' WHERE material_type IS NULL`);
    const { rows: [chk] } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'chk_stock_batches_material_type'`
    );
    if (!chk) {
      await client.query(`
        ALTER TABLE stock_batches
        ADD CONSTRAINT chk_stock_batches_material_type
        CHECK (material_type IN ('item','material','raw_material'))
      `);
    }

    // 2. Wider natural key first, so upserts always have a conflict target.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_natural_key_v2
        ON stock_batches (item_id, material_type, branch_type, branch_id, batch_number)
    `);

    // 3. Retire the narrow key. It is both an inline UNIQUE constraint (fresh
    //    databases, created by the CREATE TABLE in index.ts) and a plain index
    //    (older databases repaired by stock_batches_natural_key_v1) — drop
    //    whichever form exists. Leaving it in place would forbid material #1
    //    and item #1 from holding the same batch number at one location.
    await client.query(`ALTER TABLE stock_batches DROP CONSTRAINT IF EXISTS stock_batches_item_id_branch_type_branch_id_batch_number_key`);
    await client.query(`DROP INDEX IF EXISTS stock_batches_natural_key`);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_stock_batches_mt_item ON stock_batches (material_type, item_id)`
    );

    // 4. Seed an OPENING lot for every material quantity that already exists at
    //    a location, so the batch layer starts reconciled with stock_entries
    //    instead of reporting every material as untracked. Unit cost comes from
    //    the located row, falling back to the master's weighted-average cost.
    for (const kind of ["material", "raw_material"] as const) {
      const table = kind === "raw_material" ? "raw_materials" : "materials";
      await client.query(`
        INSERT INTO stock_batches (item_id, material_type, branch_type, branch_id,
                                   batch_number, quantity, unit_cost, source)
        SELECT se.item_id, $1, se.branch_type, se.branch_id, 'OPENING',
               se.quantity::numeric,
               CASE WHEN se.cost_price::numeric > 0 THEN se.cost_price::numeric
                    ELSE COALESCE(m.avg_cost, 0)::numeric END,
               'opening'
        FROM stock_entries se
        LEFT JOIN ${table} m ON m.id = se.item_id
        WHERE se.material_type = $1 AND se.quantity::numeric > 0
        ON CONFLICT (item_id, material_type, branch_type, branch_id, batch_number) DO NOTHING
      `, [kind]);
    }

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [GUARD]);
    await client.query("COMMIT");

    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_batches WHERE material_type <> 'item'`
    );
    console.log(
      `[migration] ${GUARD} applied — stock_batches is polymorphic; ` +
      `${c?.n ?? 0} material lot(s) seeded`
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migration] ${GUARD} FAILED:`, e);
  } finally {
    client.release();
  }
}

/**
 * Give raw and packing materials a location dimension.
 *
 * Before this, `stock_entries` held only finished items and every material
 * quantity lived in a single global counter (`materials.current_stock` /
 * `raw_materials.current_stock`) with no location at all. That made two
 * different things impossible: knowing where a material physically is, and
 * having one source of truth for "stock by location" — the Stock page had to
 * UNION three tables together and pretend every material sat at Head Office.
 *
 * After this migration `stock_entries` is the quantity truth for items AND
 * materials, discriminated by `material_type`:
 *   'item'          -> items.id
 *   'material'      -> materials.id          (raw materials in this schema)
 *   'raw_material'  -> raw_materials.id      (packing materials in this schema)
 *
 * Two structural consequences, both required:
 *
 *  1. The foreign key `item_id -> items.id` must go. `item_id` becomes a
 *     polymorphic reference whose target table depends on `material_type`, so a
 *     single FK can no longer express it. A CHECK constraint keeps
 *     `material_type` from drifting to an unknown value.
 *
 *  2. The uniqueness key must include `material_type`. Without it, material #1
 *     and item #1 at the same location collide, because the three id spaces
 *     overlap from 1.
 *
 * The overlapping id spaces are also why every pre-existing query against
 * `stock_entries` must filter `material_type = 'item'`. A query that joins
 * `se.item_id` to `items.id` without that filter would match material rows
 * against unrelated items and silently invent stock.
 *
 * Existing rows are all items, so the column defaults to 'item' and the
 * backfill is a no-op for them.
 */
import type { PgPool as Pool } from "@workspace/db";

const MIGRATION_NAME = "stock_entries_material_type_v1";

/** Global material counters are folded into Head Office, the only location
 *  they could ever have meant. */
const MATERIAL_SOURCES: { table: string; type: string }[] = [
  { table: "materials", type: "material" },
  { table: "raw_materials", type: "raw_material" },
];

export async function addMaterialLocations(pool: Pool): Promise<void> {
  const { rowCount: alreadyDone } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`,
    [MIGRATION_NAME],
  );
  if (alreadyDone) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);

    const { rowCount: raced } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (raced) { await client.query("ROLLBACK"); return; }

    // ── 1. the discriminator ────────────────────────────────────────────────
    await client.query(
      `ALTER TABLE stock_entries
         ADD COLUMN IF NOT EXISTS material_type text NOT NULL DEFAULT 'item'`,
    );

    // Added separately from the column so re-running on a half-applied database
    // still reaches the constraint. NOT VALID would leave existing rows
    // unchecked; they are all 'item', so a full validate is safe and cheap.
    await client.query(`ALTER TABLE stock_entries DROP CONSTRAINT IF EXISTS chk_stock_material_type`);
    await client.query(
      `ALTER TABLE stock_entries
         ADD CONSTRAINT chk_stock_material_type
         CHECK (material_type IN ('item', 'material', 'raw_material'))`,
    );

    // ── 2. item_id becomes polymorphic, so the FK cannot stand ──────────────
    await client.query(
      `ALTER TABLE stock_entries
         DROP CONSTRAINT IF EXISTS stock_entries_item_id_items_id_fk`,
    );

    // ── 3. uniqueness must include the discriminator ────────────────────────
    // Built before dropping the old index so a failure here cannot leave the
    // table with no uniqueness guard at all.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_entries_ref_branch
         ON stock_entries (item_id, material_type, branch_type, branch_id)`,
    );
    await client.query(`DROP INDEX IF EXISTS uq_stock_entries_item_branch`);

    // ── 4. fold the global counters into Head Office ────────────────────────
    const moved: string[] = [];
    for (const { table, type } of MATERIAL_SOURCES) {
      // cost_price mirrors the item convention: weighted-average cost, falling
      // back to manual cost. Never MRP.
      const { rows } = await client.query<{ id: number; name: string; qty: string }>(
        `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
         SELECT m.id, $1, 'headoffice', 1, m.current_stock::numeric,
                CASE WHEN COALESCE(m.avg_cost, 0) > 0 THEN m.avg_cost::numeric
                     ELSE COALESCE(m.cost, 0)::numeric END
           FROM ${table} m
          WHERE COALESCE(m.current_stock, 0)::numeric <> 0
         ON CONFLICT (item_id, material_type, branch_type, branch_id) DO NOTHING
         RETURNING item_id AS id, material_type AS name, quantity::text AS qty`,
        [type],
      );
      for (const r of rows) moved.push(`${type} #${r.id}: ${r.qty} -> headoffice #1`);
    }

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");

    console.log(
      `[migration] ${MIGRATION_NAME}: stock_entries is now location-aware for materials` +
      (moved.length ? `; moved ${moved.length} global counter(s):\n  ${moved.join("\n  ")}` : `; no material stock to move`),
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Not rethrown: a throw here would abort every later migration.
    console.error(`[migration] CRITICAL: ${MIGRATION_NAME} failed and was rolled back.`, e);
  } finally {
    client.release();
  }
}

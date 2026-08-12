/**
 * Storage locations & placements — DDL restore.
 *
 * The storage sub-location feature (named areas inside a warehouse, one level
 * of parent → child nesting, with an additive placement layer over
 * stock_entries) originally shipped its DDL as an inline boot block that was
 * lost in a workspace revert. This migration re-creates that DDL as a proper
 * migrations/ module. Every statement is idempotent, so on databases where the
 * feature already ran (dev) this is a pure no-op, and on fresh databases it
 * builds the full current shape in one pass.
 *
 * Design invariants (see routes/storageLocations.ts):
 *  - stock_entries stays the quantity truth; placements only annotate WHERE
 *    stock sits. Unassigned = warehouse total − Σ placements, derived.
 *  - Hierarchy is at most 1 level deep (parent must be a root).
 *  - Name uniqueness is scoped: roots unique per warehouse, children unique
 *    per parent — two partial unique indexes, NOT a COALESCE expression index
 *    (expression indexes break the publish schema differ).
 *  - The old warehouse-wide unique index storage_locations_wh_name_uniq must
 *    go: it would forbid a child sharing a name with a root elsewhere.
 *
 * No migration_log gate: unlike data conversions, re-running DDL guarded by
 * IF NOT EXISTS is safe and self-healing on half-applied databases.
 */
import type { PgPool as Pool } from "@workspace/db";

export async function addStorageLocationsSetup(pool: Pool): Promise<void> {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS storage_locations (
         id          SERIAL PRIMARY KEY,
         warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
         name        TEXT NOT NULL,
         disabled_at TIMESTAMPTZ,
         created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
         parent_id   INTEGER
       )`,
    );
    await pool.query(
      `CREATE TABLE IF NOT EXISTS storage_placements (
         id                  SERIAL PRIMARY KEY,
         storage_location_id INTEGER NOT NULL REFERENCES storage_locations(id),
         warehouse_id        INTEGER NOT NULL,
         material_type       TEXT NOT NULL DEFAULT 'item',
         item_id             INTEGER NOT NULL,
         quantity            NUMERIC NOT NULL,
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    // Columns/constraints added separately so a database created by an OLDER
    // version of the CREATE TABLE above still converges (constraints inside
    // CREATE TABLE IF NOT EXISTS never reach pre-existing tables).
    await pool.query(
      `ALTER TABLE storage_locations ADD COLUMN IF NOT EXISTS parent_id INTEGER`,
    );
    await pool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'storage_locations_parent_id_fkey'
         ) THEN
           ALTER TABLE storage_locations
             ADD CONSTRAINT storage_locations_parent_id_fkey
             FOREIGN KEY (parent_id) REFERENCES storage_locations(id);
         END IF;
       END $$`,
    );
    await pool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'storage_placements_quantity_check'
         ) THEN
           ALTER TABLE storage_placements
             ADD CONSTRAINT storage_placements_quantity_check CHECK (quantity > 0);
         END IF;
       END $$`,
    );

    // Scoped-uniqueness indexes. Create-then-drop order so the table is never
    // left without a uniqueness guard mid-migration.
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS storage_locations_wh_root_name_uniq
         ON storage_locations (warehouse_id, lower(trim(name)))
         WHERE parent_id IS NULL`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS storage_locations_parent_name_uniq
         ON storage_locations (parent_id, lower(trim(name)))
         WHERE parent_id IS NOT NULL`,
    );
    await pool.query(`DROP INDEX IF EXISTS storage_locations_wh_name_uniq`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS storage_locations_parent_idx
         ON storage_locations (parent_id)`,
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS storage_placements_loc_item_uniq
         ON storage_placements (storage_location_id, material_type, item_id)`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS storage_placements_wh_item_idx
         ON storage_placements (warehouse_id, material_type, item_id)`,
    );

    console.log(`[migration] storage_locations_setup: storage tables/indexes ensured`);
  } catch (e) {
    // Not rethrown: a throw here would abort every later migration.
    console.error(`[migration] CRITICAL: storage_locations_setup failed.`, e);
  }
}

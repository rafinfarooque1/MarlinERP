/**
 * Persisted weighted-average inventory valuation checkpoints.
 *
 * stock_entries remains the quantity source of truth. These checkpoints add the
 * missing cost history: every stock-ledger write records the resulting
 * quantity and unit cost for that product/location. Existing history is not
 * reconstructed with today's cost; the first checkpoint is explicitly marked
 * as a baseline and reports before it remain flagged as derived.
 */
import type { PgPool as Pool } from "@workspace/db";

const MIGRATION_NAME = "inventory_valuation_checkpoints_v1";

export async function addInventoryValuation(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_cost_snapshots (
        id            BIGSERIAL PRIMARY KEY,
        as_of_date    DATE NOT NULL,
        material_type TEXT NOT NULL,
        ref_id        INTEGER NOT NULL,
        branch_type   TEXT NOT NULL,
        branch_id     INTEGER NOT NULL,
        quantity      NUMERIC(14,4) NOT NULL,
        unit_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,
        value         NUMERIC(18,4) NOT NULL DEFAULT 0,
        source        TEXT NOT NULL,
        source_id     INTEGER,
        captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stock_cost_snapshots_key
        ON stock_cost_snapshots(material_type, ref_id, branch_type, branch_id, as_of_date, id)
    `);

    const { rows: marker } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (marker.length === 0) {
      // This is an honest baseline, not a claim that earlier historical costs
      // are known. It lets all future dates be valued from a recorded position.
      await client.query(`
        INSERT INTO stock_cost_snapshots
          (as_of_date, material_type, ref_id, branch_type, branch_id,
           quantity, unit_cost, value, source)
        SELECT CURRENT_DATE, se.material_type, se.item_id, se.branch_type, se.branch_id,
               se.quantity::numeric, se.cost_price::numeric,
               (se.quantity::numeric * se.cost_price::numeric)::numeric AS value,
               'migration_baseline'
          FROM stock_entries se
      `);
      await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    }
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: valuation checkpoints ready`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migration] ${MIGRATION_NAME} FAILED — will retry next boot:`, error);
  } finally {
    client.release();
  }
}
/**
 * Repair: OPENING batches that double-count stock already covered by real lots.
 *
 * An OPENING batch exists for one reason — to represent stock that predates lot
 * tracking, so that legacy quantities still appear in batch views. It is
 * therefore a *residual*: whatever the stock row holds that real lots do not
 * already account for.
 *
 * The original one-time migration inserted an OPENING batch equal to the whole
 * stock quantity, without subtracting lots that already existed. Any item that
 * had been produced or purchased before that migration ran ended up with lots
 * claiming far more goods than the location actually holds — FEFO would then
 * hand out stock that does not exist, and batch valuation would overstate
 * inventory.
 *
 * This recomputes every OPENING batch as `stock - lots already covering it`,
 * clamped at zero. Items whose real lots already cover their stock get an
 * OPENING batch of zero, which is the correct answer.
 *
 * Idempotent: once corrected, the recomputation returns the same value and the
 * UPDATE matches nothing.
 */
import type { PgPool as Pool } from "@workspace/db";

const MIGRATION_NAME = "repair_opening_batch_overlap_v1";

export async function repairOpeningBatches(pool: Pool): Promise<void> {
  const { rowCount: alreadyDone } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`,
    [MIGRATION_NAME],
  );
  if (alreadyDone) return;

  // Guard: stock_entries.material_type is added by addMaterialLocations() which
  // runs AFTER this function is called. On a fresh DB the column does not exist
  // yet. Skip and let it run on the next boot once the column is present.
  const { rows: [seColExists] } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stock_entries' AND column_name = 'material_type'`,
  );
  if (!seColExists) {
    console.log(`[migration] ${MIGRATION_NAME}: deferred — stock_entries.material_type not yet present (will run next boot)`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);

    const { rowCount: raced } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (raced) { await client.query("ROLLBACK"); return; }

    const { rows: corrected } = await client.query<{
      id: number; item_id: number; branch_type: string; branch_id: number;
      old_qty: string; new_qty: string;
    }>(`
      WITH covered AS (
        SELECT item_id, branch_type, branch_id,
               SUM(quantity::numeric) AS lots
          FROM stock_batches
         WHERE batch_number <> 'OPENING'
         GROUP BY item_id, branch_type, branch_id
      ),
      target AS (
        SELECT ob.id, ob.item_id, ob.branch_type, ob.branch_id,
               ob.quantity::numeric AS old_qty,
               GREATEST(0, COALESCE(se.quantity::numeric, 0) - COALESCE(c.lots, 0)) AS new_qty
          FROM stock_batches ob
          LEFT JOIN stock_entries se
                 ON se.item_id = ob.item_id
                AND se.material_type = 'item'
                AND se.branch_type = ob.branch_type
                AND se.branch_id = ob.branch_id
          LEFT JOIN covered c
                 ON c.item_id = ob.item_id
                AND c.branch_type = ob.branch_type
                AND c.branch_id = ob.branch_id
         WHERE ob.batch_number = 'OPENING'
      )
      UPDATE stock_batches sb
         SET quantity = t.new_qty, updated_at = now()
        FROM target t
       WHERE sb.id = t.id
         AND ABS(sb.quantity::numeric - t.new_qty) > 0.001
      RETURNING sb.id, t.item_id, t.branch_type, t.branch_id, t.old_qty::text, t.new_qty::text
    `);

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");

    if (corrected.length === 0) {
      console.log(`[migration] ${MIGRATION_NAME}: no overlapping OPENING batches found`);
    } else {
      console.log(
        `[migration] ${MIGRATION_NAME}: corrected ${corrected.length} OPENING batch(es) that double-counted real lots:\n  ` +
        corrected
          .map((r) => `item ${r.item_id} @ ${r.branch_type} #${r.branch_id}: ${r.old_qty} -> ${r.new_qty}`)
          .join("\n  "),
      );
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Not rethrown: a throw here would abort every later migration.
    console.error(`[migration] CRITICAL: ${MIGRATION_NAME} failed and was rolled back.`, e);
  } finally {
    client.release();
  }
}

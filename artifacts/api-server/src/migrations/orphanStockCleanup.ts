import type { PgPool } from "@workspace/db";

/**
 * One-time sweep of orphaned stock rows left by product deletions that
 * predate the guarded master delete (ERP audit finding M-3).
 *
 * Every stock report joins stock rows back to the product master for the
 * name, unit and cost. A master deleted while its stock rows survived leaves
 * blank-name rows in the Stock Valuation report and the Live Stock page —
 * quantities that count in totals but cannot be identified, sold, adjusted
 * or transferred.
 *
 * The API now refuses to delete a product with stock on hand, batches or an
 * active reservation (guardedMasterDelete, routes/inventory.ts) — this sweep
 * removes the rows that older, unguarded deletions already stranded. A stock
 * row is an orphan only when its master row is gone from the ONE table its
 * material_type points to (the three master tables have overlapping ids, so
 * each type checks only its own table).
 *
 * stock_ledger rows are deliberately kept: that table is the append-only
 * audit trail, and erasing a deleted product's movement history would
 * destroy the only remaining record of where its stock went.
 *
 * No accounting postings reference these rows — inventory valuation is
 * derived for display (P&L closing stock line, reports), never posted — so
 * the trial balance and every ledger are untouched by construction.
 *
 * One-shot via migration_log marker, written in the same transaction.
 */
const GUARD = "orphan_stock_cleanup_v1";

const ORPHAN_WHERE = (t: string) => `
  ${t}.material_type IN ('item', 'material', 'raw_material')
  AND NOT EXISTS (SELECT 1 FROM items i         WHERE ${t}.material_type = 'item'         AND i.id  = ${t}.item_id)
  AND NOT EXISTS (SELECT 1 FROM materials m     WHERE ${t}.material_type = 'material'     AND m.id  = ${t}.item_id)
  AND NOT EXISTS (SELECT 1 FROM raw_materials r WHERE ${t}.material_type = 'raw_material' AND r.id  = ${t}.item_id)
`;

/**
 * Referential guard for the polymorphic stock tables (no FK can express
 * "item_id points at ONE of three tables depending on material_type").
 *
 * Every INSERT/UPDATE on stock_entries / stock_batches takes a FOR KEY SHARE
 * lock on its product master row and aborts if the master is gone. This is
 * what actually closes the delete-vs-writer race: guardedMasterDelete holds
 * the master FOR UPDATE, so a concurrent stock writer blocks on the KEY SHARE
 * until the delete commits — then finds no master and aborts, instead of
 * committing an orphan a few milliseconds after the sweep. In the opposite
 * interleaving the writer's KEY SHARE makes the delete wait, and the guard
 * then sees the new stock and refuses with 409.
 *
 * FOR KEY SHARE is the weakest lock that conflicts with FOR UPDATE/DELETE, and
 * it does NOT conflict with the avg-cost UPDATEs writers run on the master
 * (those take FOR NO KEY UPDATE) — concurrent purchases/productions of the
 * same product serialize exactly as much as they did before.
 *
 * Idempotent DDL, re-applied every boot (CREATE OR REPLACE + DROP IF EXISTS).
 */
export async function ensureStockMasterGuardTrigger(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION assert_stock_master_exists() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.material_type = 'item' THEN
        PERFORM 1 FROM items WHERE id = NEW.item_id FOR KEY SHARE;
      ELSIF NEW.material_type = 'material' THEN
        PERFORM 1 FROM materials WHERE id = NEW.item_id FOR KEY SHARE;
      ELSIF NEW.material_type = 'raw_material' THEN
        PERFORM 1 FROM raw_materials WHERE id = NEW.item_id FOR KEY SHARE;
      ELSE
        RETURN NEW; -- unknown/legacy types pass through untouched
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'stock write refused: % #% no longer exists (product was deleted)',
          NEW.material_type, NEW.item_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql;
  `);
  for (const table of ["stock_entries", "stock_batches"]) {
    await pool.query(`DROP TRIGGER IF EXISTS trg_${table}_master_guard ON ${table}`);
    await pool.query(`
      CREATE TRIGGER trg_${table}_master_guard
        BEFORE INSERT OR UPDATE OF item_id, material_type, quantity ON ${table}
        FOR EACH ROW EXECUTE FUNCTION assert_stock_master_exists()
    `);
  }
}

export async function cleanupOrphanStockRows(pool: PgPool): Promise<void> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount: entries } = await client.query(
      `DELETE FROM stock_entries se WHERE ${ORPHAN_WHERE("se")}`,
    );
    const { rowCount: batches } = await client.query(
      `DELETE FROM stock_batches sb WHERE ${ORPHAN_WHERE("sb")}`,
    );
    // Dead reservations pointing at a vanished master can never be released
    // through the UI; only released rows are swept (an ACTIVE hold/in_transit
    // on a missing master cannot legitimately exist — the transfer flows join
    // the master — but if one ever did, leaving it visible beats hiding it).
    const { rowCount: reservations } = await client.query(
      `DELETE FROM stock_reservations sr
        WHERE sr.status <> 'active'
          AND sr.material_type IN ('item', 'material', 'raw_material')
          AND NOT EXISTS (SELECT 1 FROM items i         WHERE sr.material_type = 'item'         AND i.id  = sr.ref_id)
          AND NOT EXISTS (SELECT 1 FROM materials m     WHERE sr.material_type = 'material'     AND m.id  = sr.ref_id)
          AND NOT EXISTS (SELECT 1 FROM raw_materials r WHERE sr.material_type = 'raw_material' AND r.id  = sr.ref_id)`,
    );

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [GUARD],
    );
    await client.query("COMMIT");

    if ((entries ?? 0) + (batches ?? 0) + (reservations ?? 0) > 0) {
      console.log(
        `[migration] orphan stock cleanup: removed ${entries ?? 0} stock entr(ies), ` +
        `${batches ?? 0} batch row(s) and ${reservations ?? 0} settled reservation(s) ` +
        `whose product master was deleted before the delete guard existed`,
      );
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

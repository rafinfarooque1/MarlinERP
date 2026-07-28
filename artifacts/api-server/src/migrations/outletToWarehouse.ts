/**
 * One-time conversion: every outlet becomes a warehouse.
 *
 * Why: the system carried two kinds of stock-holding location with different
 * capabilities (outlets could not purchase or produce, and had no GST identity).
 * Collapsing them onto one kind gives stock a single location dimension, which
 * is what lets one quantity store be the truth for every location.
 *
 * Design decisions worth knowing before changing this:
 *
 * 1. Outlet rows are NOT deleted. Historical documents keep a resolvable
 *    `sales.outlet_id`, and the Outlet screens stay in the codebase behind a
 *    settings toggle. Nothing reads outlet rows for *stock* after this runs, so
 *    keeping them cannot double-count.
 *
 * 2. New warehouse IDs are allocated from the sequence — the outlet and
 *    warehouse ID spaces overlap (outlet 1 and warehouse 1 both exist), so
 *    flipping `branch_type` in place would silently merge one location's stock
 *    into another's. Every reference is remapped through an explicit old -> new
 *    map, which is persisted for audit.
 *
 * 3. Converted warehouses REUSE the outlet's existing cash and sales ledgers.
 *    Provisioning fresh `WH-CASH-*` ledgers would strand every historical
 *    payment and receipt on the old ledger and leave cash with two sources of
 *    truth. Only the purchase ledger is new, because outlets never had one.
 *
 * 4. GSTIN and state are inherited from the outlet's parent warehouse, since
 *    outlets were operated under the parent's registration.
 *
 * Idempotent and guarded by `migration_log`. On failure it rolls back and logs
 * CRITICAL rather than rethrowing, so one failure cannot abort the rest of the
 * startup migration chain.
 */
import type { PgPool as Pool, PgPoolClient as PoolClient } from "@workspace/db";

const MIGRATION_NAME = "outlet_to_warehouse_v1";

type OutletRow = {
  id: number;
  name: string;
  warehouse_id: number;
  address: string | null;
  contact_person: string | null;
  phone: string | null;
  upi_id: string | null;
  cash_ledger_id: number | null;
  sales_ledger_id: number | null;
};

/** True when `table.column` exists — startup-migration columns vary by database age. */
async function hasColumn(c: PoolClient, table: string, column: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (rowCount ?? 0) > 0;
}

async function tableExists(c: PoolClient, table: string): Promise<boolean> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Remap a (type, id) location pair. Skipped silently when the table or columns
 * are absent so the migration survives databases at different ages.
 */
async function remapTypeIdPair(
  c: PoolClient,
  table: string,
  typeCol: string,
  idCol: string,
  oldId: number,
  newId: number,
  log: string[],
): Promise<void> {
  if (!(await tableExists(c, table))) return;
  if (!(await hasColumn(c, table, typeCol)) || !(await hasColumn(c, table, idCol))) return;
  const r = await c.query(
    `UPDATE ${table} SET ${typeCol} = 'warehouse', ${idCol} = $1
      WHERE ${typeCol} = 'outlet' AND ${idCol} = $2`,
    [newId, oldId],
  );
  if (r.rowCount) log.push(`${table}.${typeCol}: ${r.rowCount}`);
}

/** Remap a bare `outlet_id` column onto the warehouse column beside it. */
async function remapOutletIdColumn(
  c: PoolClient,
  table: string,
  oldId: number,
  newId: number,
  log: string[],
): Promise<void> {
  if (!(await tableExists(c, table))) return;
  if (!(await hasColumn(c, table, "outlet_id")) || !(await hasColumn(c, table, "warehouse_id"))) return;
  const r = await c.query(
    `UPDATE ${table} SET warehouse_id = $1, outlet_id = NULL WHERE outlet_id = $2`,
    [newId, oldId],
  );
  if (r.rowCount) log.push(`${table}.outlet_id->warehouse_id: ${r.rowCount}`);
}

export async function migrateOutletsToWarehouses(pool: Pool): Promise<void> {
  const { rowCount: alreadyDone } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`,
    [MIGRATION_NAME],
  );
  if (alreadyDone) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialise against a concurrently booting instance.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIGRATION_NAME]);

    // Re-check inside the lock — another instance may have just finished.
    const { rowCount: raced } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (raced) { await client.query("ROLLBACK"); return; }

    await client.query(`
      CREATE TABLE IF NOT EXISTS location_migration_map (
        id          SERIAL PRIMARY KEY,
        old_type    TEXT NOT NULL,
        old_id      INTEGER NOT NULL,
        new_type    TEXT NOT NULL,
        new_id      INTEGER NOT NULL,
        old_name    TEXT NOT NULL DEFAULT '',
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (old_type, old_id)
      )
    `);

    const { rows: outlets } = await client.query<OutletRow>(
      `SELECT o.id, o.name, o.warehouse_id, o.address, o.contact_person, o.phone,
              o.upi_id, o.cash_ledger_id, o.sales_ledger_id
         FROM outlets o ORDER BY o.id`,
    );

    if (outlets.length === 0) {
      await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
      await client.query("COMMIT");
      console.log(`[migration] ${MIGRATION_NAME}: no outlets to convert`);
      return;
    }

    const { rows: [purParent] } = await client.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = 'SYS-PUR' LIMIT 1`,
    );

    const summary: string[] = [];

    for (const o of outlets) {
      // Inherit the tax identity the outlet actually traded under.
      const { rows: [parent] } = await client.query<{
        state: string; gst_number: string; state_code: string | null;
      }>(`SELECT state, gst_number, COALESCE(state_code,'') AS state_code
            FROM warehouses WHERE id = $1`, [o.warehouse_id]);

      const { rows: [wh] } = await client.query<{ id: number }>(
        `INSERT INTO warehouses
           (name, state, gst_number, address, contact_person, phone, upi_id,
            cash_ledger_id, sales_ledger_id, state_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          o.name,
          parent?.state ?? "",
          parent?.gst_number ?? "",
          o.address, o.contact_person, o.phone, o.upi_id,
          // Reuse the outlet's ledgers so cash and revenue history stay attached.
          o.cash_ledger_id, o.sales_ledger_id,
          parent?.state_code || null,
        ],
      );
      const newId = wh.id;

      // Outlets never had a purchase ledger; a warehouse can buy, so create one.
      if (purParent) {
        const code = `WH-PUR-${newId}`;
        const { rows: [existing] } = await client.query<{ id: number }>(
          `SELECT id FROM account_ledgers WHERE code = $1`, [code],
        );
        const purId = existing?.id ?? (await client.query<{ id: number }>(
          `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
           VALUES ($1,'expense',$2,'profit_loss',$3,false,$4) RETURNING id`,
          [`${o.name} Purchase`, code, purParent.id, `Purchases at ${o.name}`],
        )).rows[0].id;
        await client.query(`UPDATE warehouses SET purchase_ledger_id = $1 WHERE id = $2`, [purId, newId]);
      }

      const log: string[] = [];

      // Stock and operational references move to the new warehouse. Target IDs
      // are freshly allocated, so no unique key on (item, branch) can collide.
      for (const t of ["stock_entries", "stock_batches", "stock_ledger", "stock_verifications", "employees", "purchases"]) {
        await remapTypeIdPair(client, t, "branch_type", "branch_id", o.id, newId, log);
      }
      // Sales, returns, customers and vendors use location_type/location_id.
      for (const t of ["sales", "sales_returns", "customers", "vendors"]) {
        await remapTypeIdPair(client, t, "location_type", "location_id", o.id, newId, log);
      }
      // item_prices keeps its location id in `outlet_id` next to `location_type`
      // — it has no location_id column — so it needs the id column named
      // explicitly. Miss this and POS pricing stays attached to the retired
      // outlet and the converted warehouse sells at no price.
      await remapTypeIdPair(client, "item_prices", "location_type", "outlet_id", o.id, newId, log);
      // Transfers carry two endpoints.
      await remapTypeIdPair(client, "stock_transfers", "from_type", "from_id", o.id, newId, log);
      await remapTypeIdPair(client, "stock_transfers", "to_type", "to_id", o.id, newId, log);
      // Cash deposits key off the location columns directly.
      await remapOutletIdColumn(client, "cash_deposits", o.id, newId, log);

      await client.query(
        `INSERT INTO location_migration_map (old_type, old_id, new_type, new_id, old_name)
         VALUES ('outlet', $1, 'warehouse', $2, $3)
         ON CONFLICT (old_type, old_id) DO NOTHING`,
        [o.id, newId, o.name],
      );

      summary.push(`outlet #${o.id} "${o.name}" -> warehouse #${newId}${log.length ? ` (${log.join(", ")})` : ""}`);
    }

    await client.query(`INSERT INTO migration_log (name) VALUES ($1)`, [MIGRATION_NAME]);
    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME} applied:\n  ${summary.join("\n  ")}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Deliberately not rethrown: a throw here aborts every later migration.
    console.error(
      `[migration] CRITICAL: ${MIGRATION_NAME} failed and was rolled back. ` +
      `Outlets remain outlets and stock is unchanged. Error:`, e,
    );
  } finally {
    client.release();
  }
}

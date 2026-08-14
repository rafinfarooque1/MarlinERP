/**
 * Storage locations (freezers / cold rooms) inside warehouses.
 *
 * Design: an ADDITIVE placement layer over stock_entries, mirroring the batch
 * layer's invariants —
 *   • stock_entries remains the ONLY source of truth for quantities; nothing
 *     here ever writes stock_entries or the books.
 *   • A placement says "N units of this product sit in freezer X". The
 *     "Unassigned" bucket is a DERIVED remainder (warehouse truth − Σ placed),
 *     never a stored row, so Warehouse Total = Σ storage locations + Unassigned
 *     reconciles by construction.
 *   • Stock consumed by sales/transfers/production shrinks the unassigned
 *     remainder first. If consumption exceeds it, placements are OVER-ASSIGNED
 *     (Σ placed > truth): reads flag it per item and moves out of the affected
 *     freezers stay allowed so a manager can true the map up; moves INTO a
 *     location are capped by the real unassigned remainder.
 *
 * Permissions ride the Stock page ('page:/headoffice/stock') — the sidebar is
 * frozen, so this module lives as a tab there: view right = see the map,
 * add/edit/delete rights = manage locations and move stock.
 *
 * LBAC: head office sees every warehouse; a warehouse user only their own.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { getUserDataScope } from "../lib/dataScope";
import { logActivity } from "../lib/audit";

const router: IRouter = Router();

const PAGE = "page:/headoffice/stock";
const KINDS = new Set(["item", "material", "raw_material"]);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Emp = { branchType: string; branchId: number; username?: string } | undefined;

/** Warehouse ids the caller may touch, or null for head office (all). */
async function scopedWarehouseIds(emp: Emp): Promise<number[] | null> {
  if (!emp || emp.branchType === "headoffice") return null;
  const scope = await getUserDataScope(emp);
  return scope.warehouseIds;
}

/** 404 (not 403) when the warehouse exists but is outside the caller's scope. */
async function loadWarehouse(emp: Emp, warehouseId: number): Promise<{ id: number; name: string; disabled: boolean } | null> {
  if (!Number.isInteger(warehouseId) || warehouseId <= 0) return null;
  const allowed = await scopedWarehouseIds(emp);
  if (allowed !== null && !allowed.includes(warehouseId)) return null;
  const { rows: [w] } = await pool.query(
    `SELECT id, name, disabled_at FROM warehouses WHERE id = $1`, [warehouseId]);
  if (!w) return null;
  return { id: Number(w.id), name: String(w.name), disabled: w.disabled_at != null };
}

// ── List storage locations ───────────────────────────────────────────────────
router.get("/storage-locations", requireModuleView(PAGE), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const allowed = await scopedWarehouseIds(emp);
  const params: unknown[] = [];
  const conds: string[] = [];
  const warehouseId = req.query.warehouseId != null ? Number(req.query.warehouseId) : null;
  if (warehouseId != null) {
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) { res.status(400).json({ error: "Invalid warehouseId" }); return; }
    if (allowed !== null && !allowed.includes(warehouseId)) { res.json([]); return; }
    params.push(warehouseId);
    conds.push(`sl.warehouse_id = $${params.length}`);
  } else if (allowed !== null) {
    params.push(allowed);
    conds.push(`sl.warehouse_id = ANY($${params.length}::int[])`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  // Hierarchy is capped at three levels (freezer → rack → shelf), so parent
  // and grandparent are plain self-joins — no recursion. Families sort
  // together: root first, then each level-1 child followed by its own
  // children. childPlacedQty rolls up EVERY descendant placement (children +
  // grandchildren) without double counting: each placement row belongs to
  // exactly one bucket (own vs descendant are disjoint).
  const { rows } = await pool.query(
    `SELECT sl.id, sl.warehouse_id, w.name AS warehouse_name, sl.name, sl.disabled_at,
            sl.parent_id, ps.name AS parent_name, ps.disabled_at AS parent_disabled_at,
            gs.name AS grandparent_name, gs.disabled_at AS grandparent_disabled_at,
            COALESCE(p.placed_qty, 0)::numeric AS placed_qty,
            COALESCE(p.item_count, 0)::int     AS item_count,
            (SELECT COUNT(*) FROM storage_locations c WHERE c.parent_id = sl.id)::int AS child_count,
            COALESCE((
              SELECT SUM(cp.quantity) FROM storage_placements cp
               JOIN storage_locations c ON c.id = cp.storage_location_id
              WHERE c.parent_id = sl.id
                 OR c.parent_id IN (SELECT c2.id FROM storage_locations c2 WHERE c2.parent_id = sl.id)
            ), 0)::numeric AS child_placed_qty
       FROM storage_locations sl
       JOIN warehouses w ON w.id = sl.warehouse_id
       LEFT JOIN storage_locations ps ON ps.id = sl.parent_id
       LEFT JOIN storage_locations gs ON gs.id = ps.parent_id
       LEFT JOIN (
         SELECT storage_location_id, SUM(quantity) AS placed_qty, COUNT(*) AS item_count
           FROM storage_placements GROUP BY storage_location_id
       ) p ON p.storage_location_id = sl.id
       ${where}
       ORDER BY w.name,
                LOWER(COALESCE(gs.name, ps.name, sl.name)),
                (sl.parent_id IS NOT NULL),
                LOWER(CASE WHEN sl.parent_id IS NULL THEN '' WHEN ps.parent_id IS NULL THEN sl.name ELSE ps.name END),
                (ps.parent_id IS NOT NULL),
                LOWER(sl.name)`, params);
  res.json(rows.map((r: any) => ({
    id: Number(r.id),
    warehouseId: Number(r.warehouse_id),
    warehouseName: String(r.warehouse_name),
    name: String(r.name),
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    parentName: r.parent_name == null ? null : String(r.parent_name),
    pathLabel: [r.grandparent_name, r.parent_name, r.name].filter((x: unknown) => x != null).join(" › "),
    depth: r.grandparent_name != null ? 2 : r.parent_name != null ? 1 : 0,
    childCount: Number(r.child_count),
    isDisabled: r.disabled_at != null,
    effectiveDisabled: r.disabled_at != null || r.parent_disabled_at != null || r.grandparent_disabled_at != null,
    placedQty: r3(Number(r.placed_qty)),
    childPlacedQty: r3(Number(r.child_placed_qty)),
    itemCount: Number(r.item_count),
  })));
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post("/storage-locations", requireModuleAction(PAGE, "add"), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const warehouseId = Number((req.body as any)?.warehouseId);
  const name = String((req.body as any)?.name ?? "").trim();
  const parentIdRaw = (req.body as any)?.parentId;
  const parentId = parentIdRaw == null ? null : Number(parentIdRaw);
  if (!name || name.length > 80) { res.status(400).json({ error: "Name is required (max 80 characters)" }); return; }
  if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) { res.status(400).json({ error: "Invalid parentId" }); return; }
  const wh = await loadWarehouse(emp, warehouseId);
  if (!wh) { res.status(404).json({ error: "Warehouse not found" }); return; }
  if (wh.disabled) { res.status(400).json({ error: `${wh.name} is disabled — enable the warehouse before adding storage locations.` }); return; }

  // Nesting is capped at THREE levels (freezer → rack → shelf): the parent may
  // itself be a sub-location, but never a grand-child. Depth is validated on
  // the parent's own ancestry, so existing two-level data needs no change.
  let parentName: string | null = null;
  let grandparentName: string | null = null;
  if (parentId !== null) {
    const { rows: [parent] } = await pool.query(
      `SELECT p.id, p.warehouse_id, p.name, p.parent_id, p.disabled_at,
              gp.name AS gp_name, gp.parent_id AS gp_parent_id, gp.disabled_at AS gp_disabled_at
         FROM storage_locations p
         LEFT JOIN storage_locations gp ON gp.id = p.parent_id
        WHERE p.id = $1`, [parentId]);
    if (!parent || Number(parent.warehouse_id) !== warehouseId) {
      res.status(404).json({ error: "Parent storage location not found in this warehouse" }); return;
    }
    if (parent.parent_id != null && parent.gp_parent_id != null) {
      res.status(400).json({ error: "Storage locations can only nest three levels deep (e.g. Freezer → Rack → Shelf) — pick a higher-level location as the parent." }); return;
    }
    if (parent.disabled_at != null) {
      res.status(400).json({ error: `"${parent.name}" is disabled — enable it before adding sub-locations.` }); return;
    }
    if (parent.gp_disabled_at != null) {
      res.status(400).json({ error: `"${parent.gp_name}" is disabled — enable it before adding sub-locations inside it.` }); return;
    }
    parentName = String(parent.name);
    grandparentName = parent.gp_name == null ? null : String(parent.gp_name);
  }

  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO storage_locations (warehouse_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id`,
      [warehouseId, name, parentId]);
    logActivity({
      action: "CREATE", module: "inventory", entityType: "storage_location", entityId: Number(row.id),
      description: parentId === null
        ? `Added storage location "${name}" in ${wh.name}`
        : `Added sub-location "${name}" under "${parentName}" in ${wh.name}`,
      user: emp?.username,
    }).catch(() => {});
    res.status(201).json({
      id: Number(row.id), warehouseId, name, parentId, parentName,
      pathLabel: [grandparentName, parentName, name].filter(Boolean).join(" › "),
      depth: grandparentName != null ? 2 : parentName != null ? 1 : 0,
      childCount: 0, isDisabled: false, effectiveDisabled: false,
      placedQty: 0, childPlacedQty: 0, itemCount: 0,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      res.status(409).json({ error: parentName ? `"${name}" already exists under ${parentName}.` : `"${name}" already exists in ${wh.name}.` });
      return;
    }
    throw err;
  }
});

// ── Rename / enable / disable ────────────────────────────────────────────────
router.patch("/storage-locations/:id", requireModuleAction(PAGE, "edit"), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const { rows: [cur] } = await pool.query(
    `SELECT sl.id, sl.warehouse_id, sl.name, sl.disabled_at, w.name AS warehouse_name
       FROM storage_locations sl JOIN warehouses w ON w.id = sl.warehouse_id WHERE sl.id = $1`, [id]);
  if (!cur) { res.status(404).json({ error: "Storage location not found" }); return; }
  const allowed = await scopedWarehouseIds(emp);
  if (allowed !== null && !allowed.includes(Number(cur.warehouse_id))) { res.status(404).json({ error: "Storage location not found" }); return; }

  const body = req.body as any;
  const sets: string[] = [];
  const params: unknown[] = [];
  let newName: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body ?? {}, "name")) {
    newName = String(body.name ?? "").trim();
    if (!newName || newName.length > 80) { res.status(400).json({ error: "Name is required (max 80 characters)" }); return; }
    params.push(newName);
    sets.push(`name = $${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(body ?? {}, "isDisabled")) {
    if (typeof body.isDisabled !== "boolean") { res.status(400).json({ error: "isDisabled must be true or false" }); return; }
    sets.push(body.isDisabled ? `disabled_at = COALESCE(disabled_at, NOW())` : `disabled_at = NULL`);
  }
  if (!sets.length) { res.status(400).json({ error: "Nothing to update" }); return; }
  params.push(id);
  try {
    await pool.query(`UPDATE storage_locations SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: `"${newName}" already exists in ${cur.warehouse_name}.` }); return; }
    throw err;
  }
  logActivity({
    action: "UPDATE", module: "inventory", entityType: "storage_location", entityId: id,
    description: `Updated storage location "${cur.name}"${newName && newName !== cur.name ? ` → "${newName}"` : ""} in ${cur.warehouse_name}`,
    user: emp?.username,
    metadata: { before: { name: cur.name, isDisabled: cur.disabled_at != null }, after: { name: newName ?? cur.name, isDisabled: typeof body?.isDisabled === "boolean" ? body.isDisabled : cur.disabled_at != null } },
  }).catch(() => {});
  res.json({ ok: true });
});

// ── Delete (only when empty) ─────────────────────────────────────────────────
router.delete("/storage-locations/:id", requireModuleAction(PAGE, "delete"), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [cur] } = await client.query(
      `SELECT sl.id, sl.warehouse_id, sl.name, w.name AS warehouse_name
         FROM storage_locations sl JOIN warehouses w ON w.id = sl.warehouse_id
        WHERE sl.id = $1 FOR UPDATE OF sl`, [id]);
    if (!cur) { await client.query("ROLLBACK"); res.status(404).json({ error: "Storage location not found" }); return; }
    const allowed = await scopedWarehouseIds(emp);
    if (allowed !== null && !allowed.includes(Number(cur.warehouse_id))) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Storage location not found" }); return;
    }
    const { rows: [kids] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM storage_locations WHERE parent_id = $1`, [id]);
    if (Number(kids.n) > 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `"${cur.name}" has ${kids.n} sub-location${Number(kids.n) === 1 ? "" : "s"} — delete those first.` });
      return;
    }
    const { rows: [p] } = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty FROM storage_placements WHERE storage_location_id = $1`, [id]);
    if (Number(p.qty) > 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `"${cur.name}" still holds stock — move it to another location (or back to Unassigned) first.` });
      return;
    }
    await client.query(`DELETE FROM storage_placements WHERE storage_location_id = $1`, [id]);
    await client.query(`DELETE FROM storage_locations WHERE id = $1`, [id]);
    await client.query("COMMIT");
    logActivity({
      action: "DELETE", module: "inventory", entityType: "storage_location", entityId: id,
      description: `Deleted storage location "${cur.name}" from ${cur.warehouse_name}`, user: emp?.username,
    }).catch(() => {});
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ── Placement matrix for one warehouse ───────────────────────────────────────
// Rows = every product with stock at the warehouse OR with placements (so an
// over-assignment stays visible after the stock itself is gone).
router.get("/storage-stock", requireModuleView(PAGE), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const warehouseId = Number(req.query.warehouseId);
  const wh = await loadWarehouse(emp, warehouseId);
  if (!wh) { res.status(404).json({ error: "Warehouse not found" }); return; }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const matType = typeof req.query.materialType === "string" && KINDS.has(req.query.materialType) ? req.query.materialType : "";

  const params: unknown[] = [warehouseId];
  let extra = "";
  if (matType) { params.push(matType); extra += ` AND u.material_type = $${params.length}`; }
  if (q) { params.push(`%${q}%`); extra += ` AND u.item_name ILIKE $${params.length}`; }

  const { rows } = await pool.query(
    `WITH truth AS (
       SELECT se.material_type, se.item_id, SUM(se.quantity)::numeric AS qty
         FROM stock_entries se
        WHERE se.branch_type = 'warehouse' AND se.branch_id = $1
        GROUP BY se.material_type, se.item_id
     ), placed AS (
       SELECT sp.material_type, sp.item_id,
              SUM(sp.quantity)::numeric AS qty,
              json_agg(json_build_object(
                'storageLocationId', sp.storage_location_id,
                'name', COALESCE(gs.name || ' > ', '') || COALESCE(ps.name || ' > ', '') || sl.name,
                'quantity', sp.quantity,
                'isDisabled', (sl.disabled_at IS NOT NULL OR ps.disabled_at IS NOT NULL OR gs.disabled_at IS NOT NULL)
              ) ORDER BY LOWER(COALESCE(gs.name || ' > ', '') || COALESCE(ps.name || ' > ', '') || sl.name)) AS placements
         FROM storage_placements sp
         JOIN storage_locations sl ON sl.id = sp.storage_location_id
         LEFT JOIN storage_locations ps ON ps.id = sl.parent_id
         LEFT JOIN storage_locations gs ON gs.id = ps.parent_id
        WHERE sp.warehouse_id = $1
        GROUP BY sp.material_type, sp.item_id
     ), u AS (
       SELECT COALESCE(t.material_type, p.material_type) AS material_type,
              COALESCE(t.item_id, p.item_id)             AS item_id,
              COALESCE(t.qty, 0)                          AS total_qty,
              COALESCE(p.qty, 0)                          AS placed_qty,
              p.placements,
              COALESCE(i.name, m.name, rm.name, '')       AS item_name,
              COALESCE(i.unit, m.unit, rm.unit, '')       AS unit
         FROM truth t
         FULL OUTER JOIN placed p
           ON p.material_type = t.material_type AND p.item_id = t.item_id
         LEFT JOIN items         i  ON COALESCE(t.material_type, p.material_type) = 'item'         AND i.id  = COALESCE(t.item_id, p.item_id)
         LEFT JOIN materials     m  ON COALESCE(t.material_type, p.material_type) = 'material'     AND m.id  = COALESCE(t.item_id, p.item_id)
         LEFT JOIN raw_materials rm ON COALESCE(t.material_type, p.material_type) = 'raw_material' AND rm.id = COALESCE(t.item_id, p.item_id)
     )
     SELECT * FROM u
      WHERE (u.total_qty <> 0 OR u.placed_qty <> 0) ${extra}
      ORDER BY u.item_name ASC NULLS LAST, u.item_id`, params);

  res.json({
    warehouseId: wh.id,
    warehouseName: wh.name,
    rows: rows.map((r: any) => {
      const total = r3(Number(r.total_qty));
      const placed = r3(Number(r.placed_qty));
      return {
        materialType: String(r.material_type),
        itemId: Number(r.item_id),
        itemName: String(r.item_name),
        unit: String(r.unit ?? ""),
        totalQty: total,
        placedQty: placed,
        unassignedQty: r3(Math.max(0, total - placed)),
        overAssignedQty: placed > total ? r3(placed - total) : 0,
        placements: (r.placements ?? []).map((p: any) => ({
          storageLocationId: Number(p.storageLocationId),
          name: String(p.name),
          quantity: r3(Number(p.quantity)),
          isDisabled: !!p.isDisabled,
        })),
      };
    }),
  });
});

// ── Assign / move stock between storage locations ────────────────────────────
// from = null means the Unassigned pool; to = null returns stock to it.
router.post("/storage-placements/move", requireModuleAction(PAGE, "edit"), async (req, res): Promise<void> => {
  const emp = (req as any).employee as Emp;
  const body = (req.body ?? {}) as any;
  const warehouseId = Number(body.warehouseId);
  const materialType = String(body.materialType ?? "item");
  const itemId = Number(body.itemId);
  const fromId = body.fromStorageLocationId == null ? null : Number(body.fromStorageLocationId);
  const toId = body.toStorageLocationId == null ? null : Number(body.toStorageLocationId);
  const quantity = r3(Number(body.quantity));

  if (!KINDS.has(materialType)) { res.status(400).json({ error: "Invalid materialType" }); return; }
  if (!Number.isInteger(itemId) || itemId <= 0) { res.status(400).json({ error: "Invalid itemId" }); return; }
  if (!Number.isFinite(quantity) || quantity <= 0) { res.status(400).json({ error: "Quantity must be greater than zero" }); return; }
  if (fromId === null && toId === null) { res.status(400).json({ error: "Pick a storage location to move from or to" }); return; }
  if (fromId !== null && (!Number.isInteger(fromId) || fromId <= 0)) { res.status(400).json({ error: "Invalid fromStorageLocationId" }); return; }
  if (toId !== null && (!Number.isInteger(toId) || toId <= 0)) { res.status(400).json({ error: "Invalid toStorageLocationId" }); return; }
  if (fromId === toId) { res.status(400).json({ error: "Source and destination are the same location" }); return; }

  const wh = await loadWarehouse(emp, warehouseId);
  if (!wh) { res.status(404).json({ error: "Warehouse not found" }); return; }
  if (wh.disabled) { res.status(400).json({ error: `${wh.name} is disabled — stock placement is frozen.` }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Both endpoint locations must belong to THIS warehouse. Destination must
    // be active; a disabled source stays movable so it can be emptied out.
    // Effective disabled = own flag OR any ancestor's flag (disabling a
    // freezer freezes its racks AND shelves too, without touching the child
    // rows). The hierarchy is capped at three levels, so grandparent is the
    // deepest ancestor possible.
    const locIds = [fromId, toId].filter((x): x is number => x !== null);
    const { rows: locs } = await client.query(
      `SELECT sl.id, sl.name, sl.disabled_at, ps.disabled_at AS parent_disabled_at,
              gs.disabled_at AS grandparent_disabled_at
         FROM storage_locations sl
         LEFT JOIN storage_locations ps ON ps.id = sl.parent_id
         LEFT JOIN storage_locations gs ON gs.id = ps.parent_id
        WHERE sl.id = ANY($1::int[]) AND sl.warehouse_id = $2 FOR UPDATE OF sl`, [locIds, warehouseId]);
    const locById = new Map(locs.map((l: any) => [Number(l.id), l]));
    for (const lid of locIds) {
      if (!locById.has(lid)) { await client.query("ROLLBACK"); res.status(404).json({ error: "Storage location not found in this warehouse" }); return; }
    }
    if (toId !== null) {
      const dest = locById.get(toId)!;
      if (dest.disabled_at != null || dest.parent_disabled_at != null || dest.grandparent_disabled_at != null) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `"${dest.name}" is disabled — enable it before moving stock in.` });
        return;
      }
    }

    // Serialize every concurrent move of this product at this warehouse:
    // lock its placement rows (id order — consistent with other write paths).
    const { rows: placements } = await client.query(
      `SELECT sp.id, sp.storage_location_id, sp.quantity::numeric AS quantity
         FROM storage_placements sp
        WHERE sp.warehouse_id = $1 AND sp.material_type = $2 AND sp.item_id = $3
        ORDER BY sp.id FOR UPDATE`, [warehouseId, materialType, itemId]);
    const placedTotal = placements.reduce((s: number, p: any) => s + Number(p.quantity), 0);

    if (fromId === null) {
      // Out of the Unassigned pool — capped by the REAL remainder, so an
      // over-assigned map can never grow further from thin air.
      const { rows: [t] } = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty FROM stock_entries
          WHERE branch_type = 'warehouse' AND branch_id = $1 AND material_type = $2 AND item_id = $3`,
        [warehouseId, materialType, itemId]);
      const unassigned = r3(Number(t.qty) - placedTotal);
      if (quantity > unassigned + 1e-9) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: unassigned <= 0
            ? `No unassigned stock left for this product at ${wh.name}${placedTotal > Number(t.qty) ? " — the storage map is over-assigned; move stock out of a freezer first." : "."}`
            : `Only ${unassigned} unassigned — cannot place ${quantity}.`,
          unassignedQty: Math.max(0, unassigned),
        });
        return;
      }
    } else {
      const fromRow = placements.find((p: any) => Number(p.storage_location_id) === fromId);
      const have = r3(Number(fromRow?.quantity ?? 0));
      if (!fromRow || quantity > have + 1e-9) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `Only ${have} in "${locById.get(fromId)!.name}" — cannot move ${quantity}.`, availableQty: have });
        return;
      }
      const left = r3(have - quantity);
      if (left <= 0) await client.query(`DELETE FROM storage_placements WHERE id = $1`, [fromRow.id]);
      else await client.query(`UPDATE storage_placements SET quantity = $2, updated_at = NOW() WHERE id = $1`, [fromRow.id, left]);
    }

    if (toId !== null) {
      await client.query(
        `INSERT INTO storage_placements (storage_location_id, warehouse_id, material_type, item_id, quantity)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (storage_location_id, material_type, item_id)
         DO UPDATE SET quantity = round((storage_placements.quantity + EXCLUDED.quantity)::numeric, 3), updated_at = NOW()`,
        [toId, warehouseId, materialType, itemId, quantity]);
    }

    await client.query("COMMIT");
    const fromName = fromId === null ? "Unassigned" : String(locById.get(fromId)!.name);
    const toName = toId === null ? "Unassigned" : String(locById.get(toId)!.name);
    logActivity({
      action: "UPDATE", module: "inventory", entityType: "storage_placement", entityId: itemId,
      description: `Moved ${quantity} (${materialType} #${itemId}) from ${fromName} to ${toName} in ${wh.name}`,
      user: emp?.username,
      metadata: { warehouseId, materialType, itemId, fromStorageLocationId: fromId, toStorageLocationId: toId, quantity },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

export default router;

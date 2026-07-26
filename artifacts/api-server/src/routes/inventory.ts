import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { db, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { GetItemParams, DeleteItemParams } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";

const router = Router();

/** Reject non-slab GST rates (undefined/null = untouched, allowed). */
function slabViolation(taxRate: unknown, res: any): boolean {
  if (taxRate != null && !isValidGstSlab(taxRate)) {
    res.status(400).json({ error: gstSlabErrorMessage(taxRate) });
    return true;
  }
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────
const fmtMaterial = (r: any) => ({
  id: r.id, name: r.name, unit: r.unit, description: r.description,
  currentStock: Number(r.current_stock), hsnCode: r.hsn_code || '',
  taxRate: Number(r.tax_rate || 0), cost: Number(r.cost || 0),
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const fmtItem = (r: any) => ({
  id: r.id, name: r.name, hsnCode: r.hsn_code, taxRate: Number(r.tax_rate),
  unit: r.unit, description: r.description, productionStock: Number(r.production_stock),
  mrp: Number(r.mrp || 0), cost: Number(r.cost || 0),
  reorderLevel: Number(r.reorder_level ?? 10), avgCost: Number(r.avg_cost || 0),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

// ── Materials ─────────────────────────────────────────────────────────────
router.get("/materials", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT id, name, unit, description, current_stock, hsn_code, tax_rate, cost, created_at, updated_at FROM materials ORDER BY id`
  );
  res.json(result.rows.map(fmtMaterial));
});

router.post("/materials", requireModuleAction("Materials", "add"), async (req, res): Promise<void> => {
  const { name, unit, description, hsnCode, taxRate, cost } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `INSERT INTO materials (name, unit, description, hsn_code, tax_rate, cost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, unit, description || null, hsnCode || '', Number(taxRate ?? 0), Number(cost ?? 0)]
  );
  res.status(201).json(fmtMaterial(result.rows[0]));
});

router.get("/materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query(`SELECT * FROM materials WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.patch("/materials/:id", requireModuleAction("Materials", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, unit, description, hsnCode, taxRate, cost } = req.body;
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `UPDATE materials SET
      name = COALESCE($1, name),
      unit = COALESCE($2, unit),
      description = COALESCE($3, description),
      hsn_code = COALESCE($4, hsn_code),
      tax_rate = COALESCE($5, tax_rate),
      cost = COALESCE($6, cost),
      updated_at = now()
     WHERE id = $7 RETURNING *`,
    [name ?? null, unit ?? null, description ?? null, hsnCode ?? null,
     taxRate != null ? Number(taxRate) : null, cost != null ? Number(cost) : null, id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.delete("/materials/:id", requireModuleAction("Materials", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM materials WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Raw Materials ──────────────────────────────────────────────────────────
router.get("/raw-materials", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT id, name, unit, description, current_stock, hsn_code, tax_rate, cost, created_at, updated_at FROM raw_materials ORDER BY id`
  );
  res.json(result.rows.map(fmtMaterial));
});

router.post("/raw-materials", requireModuleAction("Raw Materials", "add"), async (req, res): Promise<void> => {
  const { name, unit, description, hsnCode, taxRate, cost } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `INSERT INTO raw_materials (name, unit, description, hsn_code, tax_rate, cost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, unit, description || null, hsnCode || '', Number(taxRate ?? 0), Number(cost ?? 0)]
  );
  res.status(201).json(fmtMaterial(result.rows[0]));
});

router.get("/raw-materials/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query(`SELECT * FROM raw_materials WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.patch("/raw-materials/:id", requireModuleAction("Raw Materials", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, unit, description, hsnCode, taxRate, cost } = req.body;
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `UPDATE raw_materials SET
      name = COALESCE($1, name),
      unit = COALESCE($2, unit),
      description = COALESCE($3, description),
      hsn_code = COALESCE($4, hsn_code),
      tax_rate = COALESCE($5, tax_rate),
      cost = COALESCE($6, cost),
      updated_at = now()
     WHERE id = $7 RETURNING *`,
    [name ?? null, unit ?? null, description ?? null, hsnCode ?? null,
     taxRate != null ? Number(taxRate) : null, cost != null ? Number(cost) : null, id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.delete("/raw-materials/:id", requireModuleAction("Raw Materials", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM raw_materials WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Items (Finished SKUs) ──────────────────────────────────────────────────
router.get("/items", async (_req, res): Promise<void> => {
  const result = await pool.query(
    `SELECT id, name, hsn_code, tax_rate, unit, description, production_stock, mrp, cost, reorder_level, avg_cost, created_at, updated_at FROM items ORDER BY id`
  );
  res.json(result.rows.map(fmtItem));
});

router.post("/items", requireModuleAction("Items", "add"), async (req, res): Promise<void> => {
  const { name, hsnCode, taxRate, unit, description, mrp, cost, reorderLevel } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `INSERT INTO items (name, hsn_code, tax_rate, unit, description, mrp, cost, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, hsnCode || '', Number(taxRate ?? 0), unit, description || null, Number(mrp ?? 0), Number(cost ?? 0), Number(reorderLevel ?? 10)]
  );
  res.status(201).json(fmtItem(result.rows[0]));
});

router.get("/items/:id", async (req, res): Promise<void> => {
  const { id: rawId } = GetItemParams.parse(req.params);
  const result = await pool.query(`SELECT * FROM items WHERE id = $1 LIMIT 1`, [rawId]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtItem(result.rows[0]));
});

router.patch("/items/:id", requireModuleAction("Items", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, hsnCode, taxRate, unit, description, mrp, cost, reorderLevel } = req.body;
  if (slabViolation(taxRate, res)) return;
  const result = await pool.query(
    `UPDATE items SET
      name = COALESCE($1, name),
      hsn_code = COALESCE($2, hsn_code),
      tax_rate = COALESCE($3, tax_rate),
      unit = COALESCE($4, unit),
      description = COALESCE($5, description),
      mrp = COALESCE($6, mrp),
      cost = COALESCE($7, cost),
      reorder_level = COALESCE($8, reorder_level),
      updated_at = now()
     WHERE id = $9 RETURNING *`,
    [name ?? null, hsnCode ?? null, taxRate != null ? Number(taxRate) : null,
     unit ?? null, description ?? null, mrp != null ? Number(mrp) : null,
     cost != null ? Number(cost) : null,
     reorderLevel != null ? Number(reorderLevel) : null, id]
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtItem(result.rows[0]));
});

router.delete("/items/:id", requireModuleAction("Items", "delete"), async (req, res): Promise<void> => {
  const { id } = DeleteItemParams.parse(req.params);
  await db.delete(itemsTable).where(eq(itemsTable.id, id));
  res.status(204).send();
});

export default router;

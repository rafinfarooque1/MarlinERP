import { Router } from "express";
import { db, warehousesTable, outletsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import {
  CreateWarehouseBody, UpdateWarehouseBody, GetWarehouseParams, DeleteWarehouseParams,
  CreateOutletBody, UpdateOutletBody, GetOutletParams, DeleteOutletParams,
} from "@workspace/api-zod";

const router = Router();

// ── Warehouses ─────────────────────────────────────────────────────────────
router.get("/warehouses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(warehousesTable).orderBy(warehousesTable.id);
  const outletCounts = await db
    .select({ warehouseId: outletsTable.warehouseId, cnt: count() })
    .from(outletsTable)
    .groupBy(outletsTable.warehouseId);
  const countMap = new Map(outletCounts.map((o) => [o.warehouseId, o.cnt]));
  res.json(rows.map((r) => ({ ...r, outletCount: countMap.get(r.id) ?? 0 })));
});

router.post("/warehouses", async (req, res): Promise<void> => {
  const parsed = CreateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(warehousesTable).values(parsed.data).returning();
  res.status(201).json({ ...row, outletCount: 0 });
});

router.get("/warehouses/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  res.json({ ...row, outletCount: cnt?.cnt ?? 0 });
});

router.patch("/warehouses/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(warehousesTable).set(parsed.data).where(eq(warehousesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  res.json({ ...row, outletCount: cnt?.cnt ?? 0 });
});

router.delete("/warehouses/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(warehousesTable).where(eq(warehousesTable.id, id));
  res.status(204).send();
});

// ── Outlets ────────────────────────────────────────────────────────────────
router.get("/outlets", async (_req, res): Promise<void> => {
  const rows = await db.select().from(outletsTable).orderBy(outletsTable.id);
  const warehouses = await db.select().from(warehousesTable);
  const wMap = new Map(warehouses.map((w) => [w.id, w.name]));
  res.json(rows.map((r) => ({ ...r, warehouseName: wMap.get(r.warehouseId) ?? "" })));
});

router.post("/outlets", async (req, res): Promise<void> => {
  const parsed = CreateOutletBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(outletsTable).values(parsed.data).returning();
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  res.status(201).json({ ...row, warehouseName: wh?.name ?? "" });
});

router.get("/outlets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(outletsTable).where(eq(outletsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  res.json({ ...row, warehouseName: wh?.name ?? "" });
});

router.patch("/outlets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateOutletBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(outletsTable).set(parsed.data).where(eq(outletsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  res.json({ ...row, warehouseName: wh?.name ?? "" });
});

router.delete("/outlets/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(outletsTable).where(eq(outletsTable.id, id));
  res.status(204).send();
});

export default router;

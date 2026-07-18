import { Router } from "express";
import { db, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateMaterialBody, UpdateMaterialBody, GetMaterialParams, DeleteMaterialParams,
  CreateRawMaterialBody, UpdateRawMaterialBody, GetRawMaterialParams, DeleteRawMaterialParams,
  CreateItemBody, UpdateItemBody, GetItemParams, DeleteItemParams,
} from "@workspace/api-zod";

const router = Router();

// ── Materials ─────────────────────────────────────────────────────────────
router.get("/materials", async (_req, res): Promise<void> => {
  const rows = await db.select().from(materialsTable).orderBy(materialsTable.id);
  res.json(rows.map((r) => ({ ...r, currentStock: Number(r.currentStock) })));
});

router.post("/materials", async (req, res): Promise<void> => {
  const parsed = CreateMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(materialsTable).values(parsed.data).returning();
  res.status(201).json({ ...row, currentStock: Number(row.currentStock) });
});

router.get("/materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(materialsTable).where(eq(materialsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, currentStock: Number(row.currentStock) });
});

router.patch("/materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(materialsTable).set(parsed.data).where(eq(materialsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, currentStock: Number(row.currentStock) });
});

router.delete("/materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(materialsTable).where(eq(materialsTable.id, id));
  res.status(204).send();
});

// ── Raw Materials ──────────────────────────────────────────────────────────
router.get("/raw-materials", async (_req, res): Promise<void> => {
  const rows = await db.select().from(rawMaterialsTable).orderBy(rawMaterialsTable.id);
  res.json(rows.map((r) => ({ ...r, currentStock: Number(r.currentStock) })));
});

router.post("/raw-materials", async (req, res): Promise<void> => {
  const parsed = CreateRawMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(rawMaterialsTable).values(parsed.data).returning();
  res.status(201).json({ ...row, currentStock: Number(row.currentStock) });
});

router.get("/raw-materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(rawMaterialsTable).where(eq(rawMaterialsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, currentStock: Number(row.currentStock) });
});

router.patch("/raw-materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateRawMaterialBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(rawMaterialsTable).set(parsed.data).where(eq(rawMaterialsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, currentStock: Number(row.currentStock) });
});

router.delete("/raw-materials/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(rawMaterialsTable).where(eq(rawMaterialsTable.id, id));
  res.status(204).send();
});

// ── Items ──────────────────────────────────────────────────────────────────
router.get("/items", async (_req, res): Promise<void> => {
  const rows = await db.select().from(itemsTable).orderBy(itemsTable.id);
  res.json(rows.map((r) => ({ ...r, taxRate: Number(r.taxRate), productionStock: Number(r.productionStock) })));
});

router.post("/items", async (req, res): Promise<void> => {
  const parsed = CreateItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(itemsTable).values({ ...parsed.data, taxRate: String(parsed.data.taxRate ?? 0) }).returning();
  res.status(201).json({ ...row, taxRate: Number(row.taxRate), productionStock: Number(row.productionStock) });
});

router.get("/items/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(itemsTable).where(eq(itemsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, taxRate: Number(row.taxRate), productionStock: Number(row.productionStock) });
});

router.patch("/items/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.taxRate !== undefined) updateData.taxRate = String(parsed.data.taxRate);
  const [row] = await db.update(itemsTable).set(updateData).where(eq(itemsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, taxRate: Number(row.taxRate), productionStock: Number(row.productionStock) });
});

router.delete("/items/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(itemsTable).where(eq(itemsTable.id, id));
  res.status(204).send();
});

export default router;

import { Router } from "express";
import { db, pool, productionsTable, itemsTable, stockEntriesTable, materialsTable, rawMaterialsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { CreateProductionBody, GetProductionParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { creditBatch, updateAvgCostOnInbound, inboundCostForItem } from "../lib/batches";

const defaultBatchNumber = (id: number) => `B-${String(id).padStart(4, "0")}`;

const router = Router();

router.get("/productions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(productionsTable).orderBy(productionsTable.id);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  // batch columns are migration-added (not in the Drizzle schema) — fetch raw
  const extra = await pool.query(`SELECT id, batch_number, mfg_date, expiry_date FROM productions`);
  const eMap = new Map(extra.rows.map((e: any) => [e.id, e]));
  res.json(rows.map((r) => {
    const ex = eMap.get(r.id);
    return {
      ...r,
      itemName: iMap.get(r.itemId) ?? "",
      producedQuantity: Number(r.producedQuantity),
      materialUsed: r.materialUsed ?? [],
      batchNumber: ex?.batch_number ?? defaultBatchNumber(r.id),
      mfgDate: ex?.mfg_date ?? null,
      expiryDate: ex?.expiry_date ?? null,
    };
  }));
});

router.post("/productions", async (req, res): Promise<void> => {
  const parsed = CreateProductionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const materialUsed = parsed.data.materialUsed as Array<{ materialType: string; materialId: number; usedQuantity: number }>;

  const [row] = await db.insert(productionsTable).values({
    itemId: parsed.data.itemId,
    producedQuantity: String(parsed.data.producedQuantity),
    productionDate: parsed.data.productionDate,
    materialUsed: materialUsed,
    notes: parsed.data.notes ?? null,
  }).returning();

  // Batch identity: user-provided or the existing display convention (B-0001)
  const rawBody = req.body as { batchNumber?: string; mfgDate?: string; expiryDate?: string };
  const batchNumber = (rawBody.batchNumber ?? "").trim() || defaultBatchNumber(row.id);
  const mfgDate = rawBody.mfgDate || parsed.data.productionDate || null;
  const expiryDate = rawBody.expiryDate || null;
  await pool.query(
    `UPDATE productions SET batch_number = $1, mfg_date = $2, expiry_date = $3 WHERE id = $4`,
    [batchNumber, mfgDate, expiryDate, row.id]
  );

  // Deduct materials used
  for (const mat of materialUsed) {
    if (mat.materialType === "material") {
      await db.update(materialsTable)
        .set({ currentStock: sql`${materialsTable.currentStock}::numeric - ${mat.usedQuantity}` })
        .where(eq(materialsTable.id, mat.materialId));
    } else if (mat.materialType === "raw_material") {
      await db.update(rawMaterialsTable)
        .set({ currentStock: sql`${rawMaterialsTable.currentStock}::numeric - ${mat.usedQuantity}` })
        .where(eq(rawMaterialsTable.id, mat.materialId));
    }
  }

  // Add to item production stock
  await db.update(itemsTable)
    .set({ productionStock: sql`${itemsTable.productionStock}::numeric + ${parsed.data.producedQuantity}` })
    .where(eq(itemsTable.id, parsed.data.itemId));

  // Update production stock entry
  const [existing] = await db.select().from(stockEntriesTable)
    .where(and(eq(stockEntriesTable.itemId, parsed.data.itemId), eq(stockEntriesTable.branchType, "production"), eq(stockEntriesTable.branchId, 1)))
    .limit(1);

  if (existing) {
    await db.update(stockEntriesTable)
      .set({ quantity: sql`${stockEntriesTable.quantity}::numeric + ${parsed.data.producedQuantity}` })
      .where(eq(stockEntriesTable.id, existing.id));
  } else {
    await db.insert(stockEntriesTable).values({
      itemId: parsed.data.itemId,
      branchType: "production",
      branchId: 1,
      quantity: String(parsed.data.producedQuantity),
      costPrice: "0",
    });
  }

  // Track the produced batch and roll the weighted-average cost. Until
  // Phase 5 costing lands, production output is booked at the item's current
  // average (falling back to its manual cost), which keeps the average stable.
  const unitCost = await inboundCostForItem(pool, parsed.data.itemId);
  await creditBatch(pool, {
    itemId: parsed.data.itemId, branchType: "production", branchId: 1,
    batchNumber, mfgDate, expiryDate,
    quantity: parsed.data.producedQuantity, unitCost,
    source: "production", sourceId: row.id,
  });
  await updateAvgCostOnInbound(pool, parsed.data.itemId, parsed.data.producedQuantity, unitCost);

  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);

  logActivity({
    action: "CREATE", module: "production", entityType: "production", entityId: row.id,
    description: `Produced ${parsed.data.producedQuantity} × ${item?.name ?? `Item #${parsed.data.itemId}`} on ${parsed.data.productionDate}`,
    metadata: { after: { itemId: row.itemId, itemName: item?.name, producedQuantity: parsed.data.producedQuantity, materialCount: materialUsed.length } },
  }).catch(() => {});

  res.status(201).json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [], batchNumber, mfgDate, expiryDate });
});

router.get("/productions/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  const { rows: [ex] } = await pool.query(`SELECT batch_number, mfg_date, expiry_date FROM productions WHERE id = $1`, [id]);
  res.json({
    ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [],
    batchNumber: ex?.batch_number ?? defaultBatchNumber(id), mfgDate: ex?.mfg_date ?? null, expiryDate: ex?.expiry_date ?? null,
  });
});

// ── Update (metadata only — date and notes) ───────────────────────────────────
router.patch("/productions/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { productionDate, notes } = req.body as { productionDate?: string; notes?: string };
  const updateData: Record<string, unknown> = {};
  if (productionDate !== undefined) updateData.productionDate = productionDate;
  if (notes !== undefined) updateData.notes = notes;
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  const [row] = await db.update(productionsTable).set(updateData).where(eq(productionsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [] });
});

// ── Delete (with full stock reversal) ────────────────────────────────────────
router.delete("/productions/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const materialUsed = (row.materialUsed ?? []) as Array<{ materialType: string; materialId: number; usedQuantity: number }>;
  const qty = Number(row.producedQuantity);

  // Reverse material deductions
  for (const mat of materialUsed) {
    if (mat.materialType === "material") {
      await db.update(materialsTable)
        .set({ currentStock: sql`GREATEST(0, ${materialsTable.currentStock}::numeric + ${mat.usedQuantity})` })
        .where(eq(materialsTable.id, mat.materialId));
    } else if (mat.materialType === "raw_material") {
      await db.update(rawMaterialsTable)
        .set({ currentStock: sql`GREATEST(0, ${rawMaterialsTable.currentStock}::numeric + ${mat.usedQuantity})` })
        .where(eq(rawMaterialsTable.id, mat.materialId));
    }
  }

  // Reverse production stock
  await db.update(itemsTable)
    .set({ productionStock: sql`GREATEST(0, ${itemsTable.productionStock}::numeric - ${qty})` })
    .where(eq(itemsTable.id, row.itemId));

  await db.update(stockEntriesTable)
    .set({ quantity: sql`GREATEST(0, ${stockEntriesTable.quantity}::numeric - ${qty})` })
    .where(and(
      eq(stockEntriesTable.itemId, row.itemId),
      eq(stockEntriesTable.branchType, "production"),
      eq(stockEntriesTable.branchId, 1),
    ));

  // Reverse this production's own batch (floored — it may be partly consumed)
  const { rows: [prodExtra] } = await pool.query(`SELECT batch_number FROM productions WHERE id = $1`, [id]);
  const delBatchNumber = prodExtra?.batch_number || defaultBatchNumber(id);
  await pool.query(
    `UPDATE stock_batches SET quantity = GREATEST(0, quantity - $1), updated_at = now()
     WHERE item_id = $2 AND branch_type = 'production' AND branch_id = 1 AND batch_number = $3`,
    [qty, row.itemId, delBatchNumber]
  );

  await db.delete(productionsTable).where(eq(productionsTable.id, id));

  logActivity({
    action: "DELETE", module: "production", entityType: "production", entityId: id,
    description: `Production batch B-${String(id).padStart(4, "0")} deleted (${qty} units reversed)`,
    metadata: { before: { itemId: row.itemId, producedQuantity: qty } },
  }).catch(() => {});

  res.status(204).send();
});

export default router;

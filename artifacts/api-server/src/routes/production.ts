import { Router } from "express";
import { db, productionsTable, itemsTable, stockEntriesTable, materialsTable, rawMaterialsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { CreateProductionBody, GetProductionParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";

const router = Router();

router.get("/productions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(productionsTable).orderBy(productionsTable.id);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  res.json(rows.map((r) => ({
    ...r,
    itemName: iMap.get(r.itemId) ?? "",
    producedQuantity: Number(r.producedQuantity),
    materialUsed: r.materialUsed ?? [],
  })));
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

  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);

  logActivity({
    action: "CREATE", module: "production", entityType: "production", entityId: row.id,
    description: `Produced ${parsed.data.producedQuantity} × ${item?.name ?? `Item #${parsed.data.itemId}`} on ${parsed.data.productionDate}`,
    metadata: { after: { itemId: row.itemId, itemName: item?.name, producedQuantity: parsed.data.producedQuantity, materialCount: materialUsed.length } },
  }).catch(() => {});

  res.status(201).json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [] });
});

router.get("/productions/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [] });
});

export default router;

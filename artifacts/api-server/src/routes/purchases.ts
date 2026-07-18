import { Router } from "express";
import { db, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";

const router = Router();

router.get("/purchases", async (_req, res): Promise<void> => {
  const rows = await db.select().from(purchasesTable).orderBy(purchasesTable.id);
  const vendors = await db.select().from(vendorsTable);
  const vMap = new Map(vendors.map((v) => [v.id, v.name]));
  res.json(rows.map((r) => ({
    ...r,
    vendorName: vMap.get(r.vendorId) ?? "",
    totalAmount: Number(r.totalAmount),
    lineItems: r.lineItems ?? [],
  })));
});

router.post("/purchases", async (req, res): Promise<void> => {
  const parsed = CreatePurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const lineItems = parsed.data.lineItems as Array<{ materialType: string; materialId: number; quantity: number; unitCost: number }>;
  const totalAmount = lineItems.reduce((sum, li) => sum + li.quantity * li.unitCost, 0);

  const [row] = await db.insert(purchasesTable).values({
    vendorId: parsed.data.vendorId,
    purchaseDate: parsed.data.purchaseDate,
    invoiceNumber: parsed.data.invoiceNumber ?? null,
    lineItems: lineItems,
    totalAmount: String(totalAmount),
    notes: parsed.data.notes ?? null,
  }).returning();

  // Update stock for each line item
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await db.update(materialsTable)
        .set({ currentStock: sql`${materialsTable.currentStock}::numeric + ${li.quantity}` })
        .where(eq(materialsTable.id, li.materialId));
    } else if (li.materialType === "raw_material") {
      await db.update(rawMaterialsTable)
        .set({ currentStock: sql`${rawMaterialsTable.currentStock}::numeric + ${li.quantity}` })
        .where(eq(rawMaterialsTable.id, li.materialId));
    }
  }

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.status(201).json({ ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount), lineItems: row.lineItems ?? [] });
});

router.get("/purchases/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.json({ ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount), lineItems: row.lineItems ?? [] });
});

export default router;

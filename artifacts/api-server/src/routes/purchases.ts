import { Router } from "express";
import { db, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";

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

  logActivity({
    action: "CREATE", module: "purchases", entityType: "purchase", entityId: row.id,
    description: `New purchase from ${vendor?.name ?? "Vendor"} — ₹${totalAmount.toFixed(2)}${row.invoiceNumber ? ` (Ref: ${row.invoiceNumber})` : ""}`,
    metadata: { after: { vendorId: row.vendorId, vendorName: vendor?.name, totalAmount, lineCount: lineItems.length, invoiceNumber: row.invoiceNumber } },
  }).catch(() => {});

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

// ── Update (metadata only — date, invoice, notes) ────────────────────────────
router.patch("/purchases/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { purchaseDate, invoiceNumber, notes } = req.body as { purchaseDate?: string; invoiceNumber?: string; notes?: string };
  const updateData: Record<string, unknown> = {};
  if (purchaseDate !== undefined) updateData.purchaseDate = purchaseDate;
  if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber;
  if (notes !== undefined) updateData.notes = notes;
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  const [row] = await db.update(purchasesTable).set(updateData).where(eq(purchasesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.json({ ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount), lineItems: row.lineItems ?? [] });
});

// ── Delete (with full stock reversal) ────────────────────────────────────────
router.delete("/purchases/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const lineItems = (row.lineItems ?? []) as Array<{ materialType: string; materialId: number; quantity: number }>;

  // Reverse stock additions
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await db.update(materialsTable)
        .set({ currentStock: sql`GREATEST(0, ${materialsTable.currentStock}::numeric - ${li.quantity})` })
        .where(eq(materialsTable.id, li.materialId));
    } else if (li.materialType === "raw_material") {
      await db.update(rawMaterialsTable)
        .set({ currentStock: sql`GREATEST(0, ${rawMaterialsTable.currentStock}::numeric - ${li.quantity})` })
        .where(eq(rawMaterialsTable.id, li.materialId));
    }
  }

  await db.delete(purchasesTable).where(eq(purchasesTable.id, id));

  logActivity({
    action: "DELETE", module: "purchases", entityType: "purchase", entityId: id,
    description: `Purchase PO-${String(id).padStart(4, "0")} deleted (stock reversed)`,
    metadata: { before: { vendorId: row.vendorId, totalAmount: Number(row.totalAmount) } },
  }).catch(() => {});

  res.status(204).send();
});

export default router;

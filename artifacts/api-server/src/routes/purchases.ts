import { Router } from "express";
import { db, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";

const router = Router();

function calcLineItems(rawLineItems: any[]) {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  const enriched = rawLineItems.map((li: any) => {
    const lineSubtotal = Number(li.quantity) * Number(li.unitCost);
    const discountPct = Number(li.discount ?? 0);
    const discountAmt = lineSubtotal * discountPct / 100;
    const taxableValue = lineSubtotal - discountAmt;
    const gstRate = Number(li.gstRate ?? 0);
    const taxAmount = Math.round(taxableValue * gstRate / 100 * 100) / 100;
    const intra = (li.taxType ?? 'intra') === 'intra';
    const cgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
    const sgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
    const igst = !intra ? taxAmount : 0;
    const lineTotal = taxableValue + taxAmount;
    subtotal += lineSubtotal;
    discountTotal += discountAmt;
    taxTotal += taxAmount;
    return {
      materialType: li.materialType,
      materialId: li.materialId,
      quantity: Number(li.quantity),
      unitCost: Number(li.unitCost),
      hsnCode: li.hsnCode ?? '',
      discount: discountPct,
      gstRate,
      taxType: li.taxType ?? 'intra',
      lineSubtotal: Math.round(lineSubtotal * 100) / 100,
      discountAmt: Math.round(discountAmt * 100) / 100,
      taxableValue: Math.round(taxableValue * 100) / 100,
      cgst, sgst, igst,
      taxAmount: Math.round(taxAmount * 100) / 100,
      lineTotal: Math.round(lineTotal * 100) / 100,
    };
  });
  const rawTotal = subtotal - discountTotal + taxTotal;
  const roundOff = Math.round(rawTotal) - rawTotal;
  const totalAmount = Math.round(rawTotal);
  return { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount };
}

router.get("/purchases", async (_req, res): Promise<void> => {
  const rows = await db.select().from(purchasesTable).orderBy(purchasesTable.id);
  const vendors = await db.select().from(vendorsTable);
  const vMap = new Map(vendors.map(v => [v.id, v.name]));
  res.json(rows.map(r => ({
    ...r,
    vendorName: vMap.get(r.vendorId) ?? "",
    totalAmount: Number(r.totalAmount),
    taxTotal: Number((r as any).taxTotal ?? 0),
    discountTotal: Number((r as any).discountTotal ?? 0),
    roundOff: Number((r as any).roundOff ?? 0),
    lineItems: r.lineItems ?? [],
  })));
});

router.post("/purchases", async (req, res): Promise<void> => {
  const parsed = CreatePurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rawLineItems = (req.body.lineItems || []) as any[];
  for (const li of rawLineItems) {
    if (!isValidGstSlab(li.gstRate ?? 0)) {
      res.status(400).json({ error: gstSlabErrorMessage(li.gstRate) });
      return;
    }
  }
  const { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount } = calcLineItems(rawLineItems);

  const [row] = await db.insert(purchasesTable).values({
    vendorId: parsed.data.vendorId,
    purchaseDate: parsed.data.purchaseDate,
    invoiceNumber: parsed.data.invoiceNumber ?? null,
    lineItems: enriched,
    totalAmount: String(totalAmount),
    notes: parsed.data.notes ?? null,
  }).returning();

  // Update stock for each line item
  for (const li of enriched) {
    if (li.materialType === "material") {
      await db.update(materialsTable).set({ currentStock: sql`${materialsTable.currentStock}::numeric + ${li.quantity}` }).where(eq(materialsTable.id, li.materialId));
    } else if (li.materialType === "raw_material") {
      await db.update(rawMaterialsTable).set({ currentStock: sql`${rawMaterialsTable.currentStock}::numeric + ${li.quantity}` }).where(eq(rawMaterialsTable.id, li.materialId));
    } else if (li.materialType === "item") {
      await db.update(itemsTable).set({ productionStock: sql`${itemsTable.productionStock}::numeric + ${li.quantity}` }).where(eq(itemsTable.id, li.materialId));
    }
  }

  // Patch tax/discount/roundoff columns
  await db.execute(sql`UPDATE purchases SET tax_total = ${taxTotal}, discount_total = ${discountTotal}, round_off = ${roundOff} WHERE id = ${row.id}`);

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);

  logActivity({
    action: "CREATE", module: "purchases", entityType: "purchase", entityId: row.id,
    description: `New purchase from ${vendor?.name ?? "Vendor"} — ₹${totalAmount.toFixed(2)}${row.invoiceNumber ? ` (Ref: ${row.invoiceNumber})` : ""}`,
    metadata: { after: { vendorId: row.vendorId, vendorName: vendor?.name, totalAmount, lineCount: enriched.length, invoiceNumber: row.invoiceNumber } },
  }).catch(() => {});

  res.status(201).json({
    ...row, vendorName: vendor?.name ?? "", totalAmount, taxTotal, discountTotal, roundOff,
    lineItems: enriched,
  });
});

router.get("/purchases/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.json({
    ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount),
    taxTotal: Number((row as any).taxTotal ?? 0),
    discountTotal: Number((row as any).discountTotal ?? 0),
    roundOff: Number((row as any).roundOff ?? 0),
    lineItems: row.lineItems ?? [],
  });
});

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

router.delete("/purchases/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const lineItems = (row.lineItems ?? []) as Array<{ materialType: string; materialId: number; quantity: number }>;
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await db.update(materialsTable).set({ currentStock: sql`GREATEST(0, ${materialsTable.currentStock}::numeric - ${li.quantity})` }).where(eq(materialsTable.id, li.materialId));
    } else if (li.materialType === "raw_material") {
      await db.update(rawMaterialsTable).set({ currentStock: sql`GREATEST(0, ${rawMaterialsTable.currentStock}::numeric - ${li.quantity})` }).where(eq(rawMaterialsTable.id, li.materialId));
    } else if (li.materialType === "item") {
      await db.update(itemsTable).set({ productionStock: sql`GREATEST(0, ${itemsTable.productionStock}::numeric - ${li.quantity})` }).where(eq(itemsTable.id, li.materialId));
    }
  }
  await db.delete(purchasesTable).where(eq(purchasesTable.id, id));
  logActivity({
    action: "DELETE", module: "purchases", entityType: "purchase", entityId: id,
    description: `Purchase Bill #${id} deleted (stock reversed)`,
    metadata: { before: { vendorId: row.vendorId, totalAmount: Number(row.totalAmount) } },
  }).catch(() => {});
  res.status(204).send();
});

export default router;

import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { db, pool, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";
import { creditBatch, updateAvgCostOnInbound } from "../lib/batches";

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
      // batch capture (used for finished-goods "item" lines)
      batchNumber: li.batchNumber ?? null,
      mfgDate: li.mfgDate ?? null,
      expiryDate: li.expiryDate ?? null,
    };
  });
  const rawTotal = subtotal - discountTotal + taxTotal;
  const roundOff = Math.round(rawTotal) - rawTotal;
  const totalAmount = Math.round(rawTotal);
  return { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount };
}

// ── Material-name enrichment (PO PDFs and detail views need names, not IDs) ──
type NameMaps = { material: Map<number, string>; raw_material: Map<number, string>; item: Map<number, string> };

async function buildNameMaps(): Promise<NameMaps> {
  const [mats, raws, its] = await Promise.all([
    db.select({ id: materialsTable.id, name: materialsTable.name }).from(materialsTable),
    db.select({ id: rawMaterialsTable.id, name: rawMaterialsTable.name }).from(rawMaterialsTable),
    db.select({ id: itemsTable.id, name: itemsTable.name }).from(itemsTable),
  ]);
  return {
    material: new Map(mats.map(m => [m.id, m.name])),
    raw_material: new Map(raws.map(m => [m.id, m.name])),
    item: new Map(its.map(m => [m.id, m.name])),
  };
}

function enrichLines(lineItems: unknown, maps: NameMaps): any[] {
  return (Array.isArray(lineItems) ? lineItems : []).map((li: any) => ({
    ...li,
    materialName: li.materialName
      || maps[(li.materialType as keyof NameMaps)]?.get(Number(li.materialId))
      || `${li.materialType === 'raw_material' ? 'Packing Material' : li.materialType === 'item' ? 'Item Name (SKU)' : 'Material'} #${li.materialId}`,
  }));
}

// GET /purchases — optionally server-paginated (Phase 7). Without `page`/
// `limit` the legacy full-array response is returned. `q` searches invoice
// number and vendor name (works in both modes).
router.get("/purchases", async (req, res): Promise<void> => {
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!paginated && !q) {
    const rows = await db.select().from(purchasesTable).orderBy(purchasesTable.id);
    const vendors = await db.select().from(vendorsTable);
    const vMap = new Map(vendors.map(v => [v.id, v.name]));
    const nameMaps = await buildNameMaps();
    res.json(rows.map(r => ({
      ...r,
      vendorName: vMap.get(r.vendorId) ?? "",
      totalAmount: Number(r.totalAmount),
      taxTotal: Number((r as any).taxTotal ?? 0),
      discountTotal: Number((r as any).discountTotal ?? 0),
      roundOff: Number((r as any).roundOff ?? 0),
      lineItems: enrichLines(r.lineItems, nameMaps),
    })));
    return;
  }

  const { pool } = await import("@workspace/db");
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(p.invoice_number ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const baseFrom = `FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id`;

  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = paginated ? Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200) : 0;
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS total ${baseFrom} ${where}`, params);
  const total = Number(t?.total ?? 0);

  const { rows } = await pool.query(`
    SELECT p.*, p.purchase_date::text AS purchase_date_str, v.name AS vendor_name
    ${baseFrom} ${where}
    ORDER BY p.id DESC${limit ? ` LIMIT ${limit} OFFSET ${(page - 1) * limit}` : ''}
  `, params);
  const nameMaps = await buildNameMaps();
  const mapped = rows.map((r: any) => ({
    id: r.id,
    vendorId: r.vendor_id,
    purchaseDate: r.purchase_date_str,
    invoiceNumber: r.invoice_number,
    notes: r.notes,
    createdAt: r.created_at,
    vendorName: r.vendor_name ?? "",
    totalAmount: Number(r.total_amount),
    taxTotal: Number(r.tax_total ?? 0),
    discountTotal: Number(r.discount_total ?? 0),
    roundOff: Number(r.round_off ?? 0),
    lineItems: enrichLines(r.line_items, nameMaps),
  }));

  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

router.post("/purchases", requireModuleAction("Purchases", "add"), async (req, res): Promise<void> => {
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
      // Purchased finished goods arrive at the production unit: keep the
      // location-level stock ledger consistent (previously only the item
      // counter was bumped), roll the weighted-average cost, and track the
      // inbound batch.
      await pool.query(
        `INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price)
         VALUES ($1, 'headoffice', 1, $2, $3)
         ON CONFLICT (item_id, branch_type, branch_id) DO UPDATE SET
           quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
           cost_price = EXCLUDED.cost_price,
           updated_at = now()`,
        [li.materialId, li.quantity, li.unitCost]
      );
      await updateAvgCostOnInbound(pool, li.materialId, li.quantity, li.unitCost);
      await creditBatch(pool, {
        itemId: li.materialId, branchType: "headoffice", branchId: 1,
        batchNumber: li.batchNumber || `PUR-${row.id}`,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.unitCost,
        source: "purchase", sourceId: row.id,
      });
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
    lineItems: enrichLines(enriched, await buildNameMaps()),
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
    lineItems: enrichLines(row.lineItems, await buildNameMaps()),
  });
});

router.patch("/purchases/:id", requireModuleAction("Purchases", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [current] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const { purchaseDate, invoiceNumber, notes, vendorId, lineItems } = req.body as {
    purchaseDate?: string; invoiceNumber?: string; notes?: string;
    vendorId?: number; lineItems?: any[];
  };

  if (lineItems !== undefined) {
    // ── Full edit: reverse old stock, validate new lines, apply new stock ──
    const oldLines = (current.lineItems ?? []) as Array<{
      materialType: string; materialId: number; quantity: number; batchNumber?: string | null;
    }>;

    // 1. Reverse stock from the old lines (mirror of the delete handler)
    for (const li of oldLines) {
      if (li.materialType === "material") {
        await db.update(materialsTable)
          .set({ currentStock: sql`GREATEST(0, ${materialsTable.currentStock}::numeric - ${li.quantity})` })
          .where(eq(materialsTable.id, li.materialId));
      } else if (li.materialType === "raw_material") {
        await db.update(rawMaterialsTable)
          .set({ currentStock: sql`GREATEST(0, ${rawMaterialsTable.currentStock}::numeric - ${li.quantity})` })
          .where(eq(rawMaterialsTable.id, li.materialId));
      } else if (li.materialType === "item") {
        await db.update(itemsTable)
          .set({ productionStock: sql`GREATEST(0, ${itemsTable.productionStock}::numeric - ${li.quantity})` })
          .where(eq(itemsTable.id, li.materialId));
        await pool.query(
          `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
           WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1`,
          [li.quantity, li.materialId],
        );
        await pool.query(
          `UPDATE stock_batches SET quantity = GREATEST(0, quantity - $1), updated_at = now()
           WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1 AND batch_number = $3`,
          [li.quantity, li.materialId, li.batchNumber || `PUR-${id}`],
        );
      }
    }

    // 2. Validate GST slabs on incoming lines
    for (const li of lineItems) {
      if (!isValidGstSlab(li.gstRate ?? 0)) {
        res.status(400).json({ error: gstSlabErrorMessage(li.gstRate) }); return;
      }
    }

    // 3. Calculate and enrich the new lines
    const { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount } = calcLineItems(lineItems);

    // 4. Apply stock for the new lines (mirror of the create handler)
    for (const li of enriched) {
      if (li.materialType === "material") {
        await db.update(materialsTable)
          .set({ currentStock: sql`${materialsTable.currentStock}::numeric + ${li.quantity}` })
          .where(eq(materialsTable.id, li.materialId));
      } else if (li.materialType === "raw_material") {
        await db.update(rawMaterialsTable)
          .set({ currentStock: sql`${rawMaterialsTable.currentStock}::numeric + ${li.quantity}` })
          .where(eq(rawMaterialsTable.id, li.materialId));
      } else if (li.materialType === "item") {
        await db.update(itemsTable)
          .set({ productionStock: sql`${itemsTable.productionStock}::numeric + ${li.quantity}` })
          .where(eq(itemsTable.id, li.materialId));
        await pool.query(
          `INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'headoffice', 1, $2, $3)
           ON CONFLICT (item_id, branch_type, branch_id) DO UPDATE SET
             quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
             cost_price = EXCLUDED.cost_price,
             updated_at = now()`,
          [li.materialId, li.quantity, li.unitCost],
        );
        await updateAvgCostOnInbound(pool, li.materialId, li.quantity, li.unitCost);
        await creditBatch(pool, {
          itemId: li.materialId, branchType: "headoffice", branchId: 1,
          batchNumber: li.batchNumber || `PUR-${id}`,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.unitCost,
          source: "purchase", sourceId: id,
        });
      }
    }

    // 5. Persist the updated record
    const [row] = await db.update(purchasesTable).set({
      vendorId: vendorId ?? current.vendorId,
      purchaseDate: purchaseDate ?? current.purchaseDate,
      invoiceNumber: invoiceNumber !== undefined ? invoiceNumber : current.invoiceNumber,
      notes: notes !== undefined ? notes : current.notes,
      lineItems: enriched,
      totalAmount: String(totalAmount),
    }).where(eq(purchasesTable.id, id)).returning();

    await db.execute(sql`UPDATE purchases SET tax_total = ${taxTotal}, discount_total = ${discountTotal}, round_off = ${roundOff} WHERE id = ${id}`);

    logActivity({
      action: "UPDATE", module: "purchases", entityType: "purchase", entityId: id,
      description: `Purchase Bill #${id} fully edited — ₹${totalAmount.toFixed(2)}`,
      metadata: { before: { totalAmount: Number(current.totalAmount) }, after: { totalAmount, lineCount: enriched.length } },
    }).catch(() => {});

    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
    res.json({
      ...row, vendorName: vendor?.name ?? "",
      totalAmount, taxTotal, discountTotal, roundOff,
      lineItems: enrichLines(enriched, await buildNameMaps()),
    });
    return;
  }

  // ── Metadata-only edit (date / invoice ref / notes, no line changes) ──
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

router.delete("/purchases/:id", requireModuleAction("Purchases", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const lineItems = (row.lineItems ?? []) as Array<{ materialType: string; materialId: number; quantity: number; batchNumber?: string | null }>;
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await db.update(materialsTable).set({ currentStock: sql`GREATEST(0, ${materialsTable.currentStock}::numeric - ${li.quantity})` }).where(eq(materialsTable.id, li.materialId));
    } else if (li.materialType === "raw_material") {
      await db.update(rawMaterialsTable).set({ currentStock: sql`GREATEST(0, ${rawMaterialsTable.currentStock}::numeric - ${li.quantity})` }).where(eq(rawMaterialsTable.id, li.materialId));
    } else if (li.materialType === "item") {
      await db.update(itemsTable).set({ productionStock: sql`GREATEST(0, ${itemsTable.productionStock}::numeric - ${li.quantity})` }).where(eq(itemsTable.id, li.materialId));
      // Reverse the stock-entry credit and the inbound batch (floored)
      await pool.query(
        `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
         WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1`,
        [li.quantity, li.materialId]
      );
      await pool.query(
        `UPDATE stock_batches SET quantity = GREATEST(0, quantity - $1), updated_at = now()
         WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1 AND batch_number = $3`,
        [li.quantity, li.materialId, li.batchNumber || `PUR-${id}`]
      );
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

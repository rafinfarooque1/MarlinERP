import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { db, pool, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";
import { creditBatch, debitBatchByNumber, updateAvgCostOnInbound } from "../lib/batches";
import { productBatchIdentity, blockedByInactiveProducts, INACTIVE_PRODUCT_CODE, isProductKind } from "../lib/productIdentity";
import { writeStockLedger } from "../lib/stockLedger";
import { deductMaterialAt, creditMaterialAt, isMaterialKind } from "../lib/materialStock";
import { resolveActingLocation, locationLabel, type ProdLocation } from "../lib/productionCosting";
import { getUserDataScope, scopeLocationTypeWhere } from "../lib/dataScope";

const router = Router();

/** Purchased goods land at the location that bought them: Head Office or any
 *  warehouse. The bill records that location, and every stock effect — location
 *  quantity, lot, ledger — uses it, so a warehouse's purchase never inflates
 *  Head Office stock. The mirror counter on the master row is company-wide and
 *  is maintained by the caller's own UPDATE (which also rolls avg_cost).
 *
 *  Stock-ledger branch id. Head Office has always ledgered materials at 0 and
 *  finished items at 1; every other location uses its own id for both. */
const ledgerBranchId = (loc: ProdLocation, materialType: string) =>
  loc.type === "headoffice" ? (materialType === "item" ? 1 : 0) : loc.id;

/** Parent product identity (barcode + MRP) stamped onto the batch a line creates. */
const lineIdentity = (li: any) =>
  productBatchIdentity(pool, (li.materialType ?? "item") as any, Number(li.materialId));

const KIND_LABEL: Record<string, string> = {
  material: "Raw Material", raw_material: "Packing Material", item: "Item",
};

/**
 * Batch identity is mandatory on every purchase line — raw material, packing
 * material and finished goods alike. Without a batch number and dates, stock
 * cannot be traced back to the bill it arrived on, expiry cannot be warned
 * about, and a recall cannot be answered. The message names the exact field and
 * line so it can be fixed without guessing.
 */
function batchIdentityError(lines: any[], maps: NameMaps): string | null {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i];
    const kind = String(li?.materialType ?? "material");
    const name = maps[kind as keyof NameMaps]?.get(Number(li?.materialId))
      ?? `${KIND_LABEL[kind] ?? "Item"} #${li?.materialId}`;
    const at = `Line ${i + 1} (${name})`;
    const batchNumber = String(li?.batchNumber ?? "").trim();
    const mfgDate = String(li?.mfgDate ?? "").trim();
    const expiryDate = String(li?.expiryDate ?? "").trim();
    if (!batchNumber) return `${at}: batch number is required`;
    if (!mfgDate) return `${at}: manufacturing date is required`;
    if (!expiryDate) return `${at}: expiry date is required`;
    if (!dateRe.test(mfgDate)) return `${at}: manufacturing date must be a date (YYYY-MM-DD)`;
    if (!dateRe.test(expiryDate)) return `${at}: expiry date must be a date (YYYY-MM-DD)`;
    if (expiryDate < mfgDate) return `${at}: expiry date cannot be before the manufacturing date`;
  }
  return null;
}

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

/** Names for every location that can purchase, for list labels. */
async function locationNameMap(): Promise<Map<string, string>> {
  const [whs, outs] = await Promise.all([
    pool.query(`SELECT id, name FROM warehouses`),
    pool.query(`SELECT id, name FROM outlets`),
  ]);
  const m = new Map<string, string>([["headoffice:1", "Head Office"]]);
  for (const w of whs.rows) m.set(`warehouse:${w.id}`, w.name);
  for (const o of outs.rows) m.set(`outlet:${o.id}`, o.name);
  return m;
}

router.get("/purchases", async (req, res): Promise<void> => {
  // LBAC: a location sees its own bills; Head Office sees every location's.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(p.invoice_number ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
  }
  const scopeWhere = scopeLocationTypeWhere(scope, params, 'p');
  if (scopeWhere === 'FALSE') {
    res.json(paginated ? { total: 0, page: 1, limit: 25, rows: [] } : []);
    return;
  }
  if (scopeWhere !== 'TRUE') conds.push(scopeWhere);

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
  const locNames = await locationNameMap();
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
    locationType: r.location_type ?? 'headoffice',
    locationId: Number(r.location_id ?? 1),
    locationName: locNames.get(`${r.location_type ?? 'headoffice'}:${Number(r.location_id ?? 1)}`) ?? 'Head Office',
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
  // A discontinued product cannot be bought again. Checked on create only:
  // existing purchases stay editable so a historical bill can still be corrected.
  const inactiveMsg = await blockedByInactiveProducts(
    pool,
    rawLineItems
      .filter(li => isProductKind(li?.materialType ?? "material"))
      .map(li => ({ kind: (li?.materialType ?? "material") as any, id: Number(li?.materialId) })),
  );
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }

  // Batch number + manufacturing date + expiry date are mandatory on every line.
  const identityMsg = batchIdentityError(rawLineItems, await buildNameMaps());
  if (identityMsg) { res.status(400).json({ error: identityMsg }); return; }

  // ── Which location is buying ─────────────────────────────────────────────
  // Head Office may record a bill for any location; a warehouse only for
  // itself. Stock, lots and the ledger all follow this location, and the vendor
  // payable and input GST post against this location's own purchase ledger.
  const resolved = await resolveActingLocation(pool, {
    employee: (req as any).employee,
    requested: { type: (req.body as any).locationType, id: (req.body as any).locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const loc = resolved.loc;
  const locName = await locationLabel(pool, loc);

  const { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount } = calcLineItems(rawLineItems);

  // Everything below moves stock, lots, weighted-average costs and the stock
  // ledger. A bill that half-applied would leave the books unreconcilable, so
  // the whole thing runs in ONE transaction on ONE client — including the
  // ledger write, which must not be fire-and-forget.
  const client = await pool.connect();
  let newId = 0;
  try {
    await client.query("BEGIN");

    // location_*, tax_total, discount_total and round_off are raw-migration
    // columns and invisible to drizzle, so the row is inserted with explicit SQL.
    const { rows: [ins] } = await client.query(
      `INSERT INTO purchases (vendor_id, purchase_date, invoice_number, line_items, total_amount,
                              notes, tax_total, discount_total, round_off, location_type, location_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [parsed.data.vendorId, parsed.data.purchaseDate, parsed.data.invoiceNumber ?? null,
       JSON.stringify(enriched), String(totalAmount), parsed.data.notes ?? null,
       taxTotal, discountTotal, roundOff, loc.type, loc.id],
    );
    newId = Number(ins.id);

  // Update stock for each line item
  for (const li of enriched) {
    if (li.materialType === "material") {
      // Atomically update current_stock AND roll weighted-average cost (avg_cost is a raw-migration column)
      await client.query(
        `UPDATE materials SET
           avg_cost = ROUND(
             (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
             / NULLIF(current_stock::numeric + $2::numeric, 0),
           4),
           current_stock = current_stock::numeric + $2::numeric
         WHERE id = $1`,
        [li.materialId, li.quantity, li.unitCost]
      );
      await creditMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.unitCost));
      await creditBatch(client, {
        itemId: li.materialId, materialType: "material",
        branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${newId}`,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.unitCost,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    } else if (li.materialType === "raw_material") {
      await client.query(
        `UPDATE raw_materials SET
           avg_cost = ROUND(
             (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
             / NULLIF(current_stock::numeric + $2::numeric, 0),
           4),
           current_stock = current_stock::numeric + $2::numeric
         WHERE id = $1`,
        [li.materialId, li.quantity, li.unitCost]
      );
      await creditMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.unitCost));
      await creditBatch(client, {
        itemId: li.materialId, materialType: "raw_material",
        branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${newId}`,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.unitCost,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    } else if (li.materialType === "item") {
      await client.query(
        `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      // Purchased finished goods arrive at the production unit: keep the
      // location-level stock ledger consistent (previously only the item
      // counter was bumped), roll the weighted-average cost, and track the
      // inbound batch.
      await client.query(
        `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
         VALUES ($1, 'item', $4, $5, $2, $3)
         ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
           quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
           cost_price = EXCLUDED.cost_price,
           updated_at = now()`,
        [li.materialId, li.quantity, li.unitCost, loc.type, loc.id]
      );
      await updateAvgCostOnInbound(client, li.materialId, li.quantity, li.unitCost);
      await creditBatch(client, {
        itemId: li.materialId, branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${newId}`,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.unitCost,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    }
  }

    // ── Stock ledger (purchase inbound) ───────────────────────────────────────
    // Awaited inside the transaction: an audit trail that can silently fail is
    // not an audit trail.
    await writeStockLedger(client, (enriched as any[]).map(li => ({
      txnType: 'purchase', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: li.materialName ?? '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: Number(li.quantity), unitCost: Number(li.unitCost ?? 0),
      docType: 'purchase', docId: newId,
    })));

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, newId)).limit(1);
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);

  logActivity({
    action: "CREATE", module: "purchases", entityType: "purchase", entityId: row.id,
    description: `New purchase from ${vendor?.name ?? "Vendor"} at ${locName} — ₹${totalAmount.toFixed(2)}${row.invoiceNumber ? ` (Ref: ${row.invoiceNumber})` : ""}`,
    metadata: { after: { vendorId: row.vendorId, vendorName: vendor?.name, totalAmount, lineCount: enriched.length, invoiceNumber: row.invoiceNumber, locationType: loc.type, locationId: loc.id } },
  }).catch(() => {});

  res.status(201).json({
    ...row, vendorName: vendor?.name ?? "", totalAmount, taxTotal, discountTotal, roundOff,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    lineItems: enrichLines(enriched, await buildNameMaps()),
  });
});

router.get("/purchases/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { rows: [locRow] } = await pool.query(
    `SELECT location_type, location_id FROM purchases WHERE id = $1`, [id]);
  const loc: ProdLocation = { type: locRow?.location_type ?? 'headoffice', id: Number(locRow?.location_id ?? 1) };

  // LBAC: a location may only open its own bills.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  if (!scope.isHeadOffice) {
    const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
      || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
  }

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.json({
    ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount),
    taxTotal: Number((row as any).taxTotal ?? 0),
    discountTotal: Number((row as any).discountTotal ?? 0),
    roundOff: Number((row as any).roundOff ?? 0),
    locationType: loc.type, locationId: loc.id,
    locationName: await locationLabel(pool, loc),
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

  // An edit stays at the location that recorded the bill: both the reversal of
  // the old lines and the re-apply of the new ones happen there, so an edit can
  // never quietly move stock between locations (that is a transfer).
  const { rows: [curLocRow] } = await pool.query(
    `SELECT location_type, location_id FROM purchases WHERE id = $1`, [id]);
  const loc: ProdLocation = { type: curLocRow?.location_type ?? 'headoffice', id: Number(curLocRow?.location_id ?? 1) };
  const locName = await locationLabel(pool, loc);

  // LBAC: a location may only edit its own bills.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  if (!scope.isHeadOffice) {
    const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
      || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
  }

  if (lineItems !== undefined) {
    // Batch identity is mandatory. Validated before any stock is touched so a
    // rejected edit leaves the bill and its stock exactly as they were.
    const identityMsg = batchIdentityError(lineItems, await buildNameMaps());
    if (identityMsg) { res.status(400).json({ error: identityMsg }); return; }
    for (const li of lineItems) {
      if (!isValidGstSlab(li.gstRate ?? 0)) {
        res.status(400).json({ error: gstSlabErrorMessage(li.gstRate) }); return;
      }
    }

    // 2. Calculate and enrich the new lines (before any write, so a bad line
    //    cannot leave the reversal applied)
    const { enriched, subtotal, discountTotal, taxTotal, roundOff, totalAmount } = calcLineItems(lineItems);

    // An edit is a reversal plus a re-apply: both halves, the lot layer, the
    // weighted-average costs, the bill row and the stock ledger commit together
    // or not at all.
    const client = await pool.connect();
    let beforeTotal = Number(current.totalAmount);
    try {
      await client.query("BEGIN");

      // Row-lock the bill and take the old lines FROM THE LOCKED ROW. Reading
      // them before BEGIN would let two concurrent edits (or an edit racing a
      // delete) each reverse the same lines from the same stale snapshot.
      const { rows: [locked] } = await client.query(
        `SELECT line_items, vendor_id, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date,
                invoice_number, notes, total_amount, location_type, location_id
         FROM purchases WHERE id = $1 FOR UPDATE`, [id]);
      if (!locked) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" }); return;
      }
      // Location is immutable, so a mismatch means the row is not what the LBAC
      // check above cleared. Refuse rather than post to the wrong warehouse.
      if ((locked.location_type ?? 'headoffice') !== loc.type || Number(locked.location_id ?? 1) !== loc.id) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This bill was changed by someone else. Reload and try again." }); return;
      }
      beforeTotal = Number(locked.total_amount ?? 0);

      // ── Full edit: reverse old stock, then apply the new lines ──
      const oldLines = (locked.line_items ?? []) as Array<{
        materialType: string; materialId: number; quantity: number; batchNumber?: string | null;
      }>;

    // 1. Reverse stock from the old lines (mirror of the delete handler)
    for (const li of oldLines) {
      if (li.materialType === "material") {
        await client.query(
          `UPDATE materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await deductMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "material", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      } else if (li.materialType === "raw_material") {
        await client.query(
          `UPDATE raw_materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await deductMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "raw_material", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      } else if (li.materialType === "item") {
        await client.query(
          `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await client.query(
          `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
           WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
          [li.quantity, li.materialId, loc.type, loc.id],
        );
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "item", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      }
    }

    // ── Stock ledger (purchase edit reversal) ────────────────────────────────
    await writeStockLedger(client, (oldLines as any[]).map(li => ({
      txnType: 'purchase_reversal', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: -Number(li.quantity), unitCost: 0,
      docType: 'purchase', docId: id,
      notes: 'Purchase edit — old lines reversed',
    })));

    // 3. Apply stock for the new lines (mirror of the create handler)
    for (const li of enriched) {
      if (li.materialType === "material") {
        await client.query(
          `UPDATE materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.unitCost]
        );
        await creditMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.unitCost));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "material",
          branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.unitCost,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "raw_material") {
        await client.query(
          `UPDATE raw_materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.unitCost]
        );
        await creditMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.unitCost));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "raw_material",
          branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.unitCost,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "item") {
        await client.query(
          `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await client.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $4, $5, $2, $3)
           ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
             quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
             cost_price = EXCLUDED.cost_price,
             updated_at = now()`,
          [li.materialId, li.quantity, li.unitCost, loc.type, loc.id],
        );
        await updateAvgCostOnInbound(client, li.materialId, li.quantity, li.unitCost);
        await creditBatch(client, {
          itemId: li.materialId, branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.unitCost,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      }
    }

    // ── Stock ledger (purchase edit re-apply) ────────────────────────────────
    await writeStockLedger(client, (enriched as any[]).map(li => ({
      txnType: 'purchase', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: li.materialName ?? '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: Number(li.quantity), unitCost: Number(li.unitCost ?? 0),
      docType: 'purchase', docId: id,
      notes: 'Purchase edit — new lines applied',
    })));

    // 4. Persist the updated record
      await client.query(
        `UPDATE purchases SET vendor_id = $2, purchase_date = $3, invoice_number = $4, notes = $5,
                              line_items = $6::jsonb, total_amount = $7,
                              tax_total = $8, discount_total = $9, round_off = $10
         WHERE id = $1`,
        [id, vendorId ?? locked.vendor_id, purchaseDate ?? locked.purchase_date,
         invoiceNumber !== undefined ? invoiceNumber : locked.invoice_number,
         notes !== undefined ? notes : locked.notes,
         JSON.stringify(enriched), String(totalAmount), taxTotal, discountTotal, roundOff],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);

    logActivity({
      action: "UPDATE", module: "purchases", entityType: "purchase", entityId: id,
      description: `Purchase Bill #${id} fully edited at ${locName} — ₹${totalAmount.toFixed(2)}`,
      metadata: { before: { totalAmount: beforeTotal }, after: { totalAmount, lineCount: enriched.length, locationType: loc.type, locationId: loc.id } },
    }).catch(() => {});

    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
    res.json({
      ...row, vendorName: vendor?.name ?? "",
      totalAmount, taxTotal, discountTotal, roundOff,
      locationType: loc.type, locationId: loc.id, locationName: locName,
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
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });

  // Deleting a bill un-does stock, lots and the audit trail. Half a reversal is
  // worse than none, so it all commits together — and the row is read under a
  // FOR UPDATE lock inside the transaction, so two concurrent deletes (or a
  // delete racing an edit) can never reverse the same lines twice.
  const client = await pool.connect();
  let loc: ProdLocation = { type: 'headoffice', id: 1 };
  let locName = "Head Office";
  let vendorIdBefore = 0;
  let totalBefore = 0;
  try {
    await client.query("BEGIN");
    const { rows: [locked] } = await client.query(
      `SELECT line_items, vendor_id, total_amount, location_type, location_id
       FROM purchases WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }

    // Reverse at the location that bought the goods, never a hardcoded HO.
    loc = { type: locked.location_type ?? 'headoffice', id: Number(locked.location_id ?? 1) };
    locName = await locationLabel(client, loc);
    vendorIdBefore = Number(locked.vendor_id ?? 0);
    totalBefore = Number(locked.total_amount ?? 0);

    // LBAC: a location may only delete its own bills.
    if (!scope.isHeadOffice) {
      const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
        || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
      if (!allowed) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" }); return;
      }
    }

    const lineItems = (locked.line_items ?? []) as Array<{ materialType: string; materialId: number; quantity: number; batchNumber?: string | null }>;
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await client.query(
        `UPDATE materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      await deductMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "material", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    } else if (li.materialType === "raw_material") {
      await client.query(
        `UPDATE raw_materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      await deductMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "raw_material", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    } else if (li.materialType === "item") {
      await client.query(
        `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      // Reverse the stock-entry credit and the inbound batch (floored)
      await client.query(
        `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
         WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
        [li.quantity, li.materialId, loc.type, loc.id]
      );
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "item", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    }
  }
    await writeStockLedger(client, lineItems.map(li => ({
      txnType: 'purchase_reversal', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: -Number(li.quantity), unitCost: 0,
      docType: 'purchase', docId: id,
      notes: 'Purchase deleted — stock reversed',
    })));
    const del = await client.query(`DELETE FROM purchases WHERE id = $1 RETURNING id`, [id]);
    if (del.rowCount === 0) {
      // Belt and braces: the FOR UPDATE above should make this impossible, so if
      // it ever happens the reversal must not be committed against a bill that
      // someone else already removed.
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "DELETE", module: "purchases", entityType: "purchase", entityId: id,
    description: `Purchase Bill #${id} deleted at ${locName} (stock reversed)`,
    metadata: { before: { vendorId: vendorIdBefore, totalAmount: totalBefore, locationType: loc.type, locationId: loc.id } },
  }).catch(() => {});
  res.status(204).send();
});

export default router;

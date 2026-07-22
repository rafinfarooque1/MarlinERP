import { Router } from "express";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable, companySettingsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { createInvoiceShareToken } from "../lib/shareToken";

const router = Router();

// ── Tax computation helpers ───────────────────────────────────────────────────

function computeInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
}

// GST is INCLUSIVE in MRP. taxable = gross / (1 + rate/100), tax = gross - taxable.
function computeLineTax(
  grossAmount: number,   // MRP × qty (GST-inclusive)
  taxRate: number,
  isInterState: boolean,
): { taxRate: number; taxType: string; cgst: number; sgst: number; igst: number; taxAmount: number; taxableAmount: number } {
  const taxableAmount = taxRate > 0
    ? Math.round(grossAmount / (1 + taxRate / 100) * 100) / 100
    : grossAmount;
  const taxAmount = Math.round((grossAmount - taxableAmount) * 100) / 100;
  if (isInterState) {
    return { taxRate, taxType: 'igst', cgst: 0, sgst: 0, igst: taxAmount, taxAmount, taxableAmount };
  }
  const half = Math.round(taxAmount / 2 * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', cgst: half, sgst: half, igst: 0, taxAmount, taxableAmount };
}

// ── Item Prices ───────────────────────────────────────────────────────────────

router.get("/item-prices", async (req, res): Promise<void> => {
  const qp = ListItemPricesQueryParams.safeParse(req.query);
  let rows = await db.select().from(itemPricesTable);
  if (qp.success && qp.data.outletId) {
    rows = rows.filter((r) => r.outletId === Number(qp.data.outletId));
  }
  const items = await db.select().from(itemsTable);
  const outlets = await db.select().from(outletsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  const oMap = new Map(outlets.map((o) => [o.id, o.name]));
  res.json(rows.map((r) => ({
    ...r,
    itemName: iMap.get(r.itemId) ?? "",
    outletName: oMap.get(r.outletId) ?? "",
    price: Number(r.price),
    updatedAt: r.updatedAt.toISOString(),
  })));
});

router.post("/item-prices", async (req, res): Promise<void> => {
  const parsed = SetItemPriceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [existing] = await db.select().from(itemPricesTable)
    .where(and(eq(itemPricesTable.itemId, parsed.data.itemId), eq(itemPricesTable.outletId, parsed.data.outletId)))
    .limit(1);

  const body = req.body as { validFrom?: string; validTo?: string };
  const extraFields: Record<string, unknown> = {};
  if (body.validFrom !== undefined) extraFields.validFrom = body.validFrom || null;
  if (body.validTo !== undefined) extraFields.validTo = body.validTo || null;

  let row;
  if (existing) {
    [row] = await db.update(itemPricesTable)
      .set({ price: String(parsed.data.price), ...extraFields })
      .where(eq(itemPricesTable.id, existing.id))
      .returning();
  } else {
    [row] = await db.insert(itemPricesTable)
      .values({ itemId: parsed.data.itemId, outletId: parsed.data.outletId, price: String(parsed.data.price), ...extraFields })
      .returning();
  }

  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outletId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? "", outletName: outlet?.name ?? "", price: Number(row.price), updatedAt: row.updatedAt.toISOString() });
});

// ── Sales ──────────────────────────────────────────────────────────────────

router.get("/sales", async (req, res): Promise<void> => {
  const rows = await db.select().from(salesTable).orderBy(salesTable.id);
  const outlets = await db.select().from(outletsTable);
  const customers = await db.select().from(customersTable);
  const oMap = new Map(outlets.map((o) => [o.id, { name: o.name, upiId: (o as any).upiId ?? "" }]));
  const cMap = new Map(customers.map((c) => [c.id, { name: c.name, phone: c.phone ?? null }]));

  const outletIdFilter = req.query.outletId ? Number(req.query.outletId) : null;
  const filtered = outletIdFilter ? rows.filter((r) => r.outletId === outletIdFilter) : rows;

  res.json(filtered.map((r) => {
    const cust = r.customerId ? cMap.get(r.customerId) : null;
    const outlet = oMap.get(r.outletId);
    return {
      ...r,
      outletName: outlet?.name ?? "",
      outletUpiId: outlet?.upiId ?? "",
      customerName: cust?.name ?? null,
      customerPhone: cust?.phone ?? null,
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.taxTotal),
      discountTotal: Number(r.discountTotal),
      totalAmount: Number(r.totalAmount),
      lineItems: r.lineItems ?? [],
    };
  }));
});

router.post("/sales", async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number;
  }>;

  // ── Fetch (or create) company settings for invoice numbering and GST state ─
  let company = (await db.select().from(companySettingsTable).limit(1))[0];
  if (!company) {
    [company] = await db.insert(companySettingsTable).values({}).returning();
  }
  const companyState = (company.state ?? '').trim().toLowerCase();

  // ── Atomically increment invoice sequence ─────────────────────────────────
  const [updatedCompany] = await db
    .update(companySettingsTable)
    .set({ invoiceSequence: sql`${companySettingsTable.invoiceSequence} + 1` })
    .where(eq(companySettingsTable.id, company.id))
    .returning();

  const seq = updatedCompany.invoiceSequence;
  const fy = updatedCompany.financialYear || '2025-26';
  const prefix = updatedCompany.invoicePrefix || 'INV';
  const invoiceNumber = computeInvoiceNumber(prefix, fy, seq);

  // ── Determine inter-state vs intra-state ──────────────────────────────────
  let customerState = '';
  if (parsed.data.customerId) {
    const [cust] = await db.select().from(customersTable)
      .where(eq(customersTable.id, parsed.data.customerId))
      .limit(1);
    customerState = (cust?.state ?? '').trim().toLowerCase();
  }
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // ── Fetch item tax rates ──────────────────────────────────────────────────
  const itemIds = [...new Set(rawLineItems.map(li => li.itemId))];
  const itemsData = itemIds.length > 0
    ? await db.select({ id: itemsTable.id, taxRate: itemsTable.taxRate, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
        .from(itemsTable)
        .where(inArray(itemsTable.id, itemIds))
    : [];
  const itemTaxMap = new Map(itemsData.map(i => [i.id, { taxRate: Number(i.taxRate), name: i.name, hsnCode: i.hsnCode, unit: i.unit }]));

  // ── Build enriched line items with GST ────────────────────────────────────
  const lineItems = rawLineItems.map(li => {
    const itemInfo = itemTaxMap.get(li.itemId);
    const taxRate = itemInfo?.taxRate ?? 0;
    // MRP is GST-inclusive: gross = qty × unitPrice, taxable = back-calculated
    const grossAmount = li.quantity * li.unitPrice - (li.discount ?? 0);
    const taxInfo = computeLineTax(grossAmount, taxRate, isInterState);
    return {
      itemId: li.itemId,
      itemName: itemInfo?.name ?? '',
      hsnCode: itemInfo?.hsnCode ?? '',
      unit: itemInfo?.unit ?? '',
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      discount: li.discount ?? 0,
      lineSubtotal: taxInfo.taxableAmount, // taxable (ex-GST) stored as lineSubtotal
      ...taxInfo,
    };
  });

  const subtotal = lineItems.reduce((s, li) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s, li) => s + li.taxAmount, 0);
  const discountTotal = parsed.data.discountTotal ?? lineItems.reduce((s, li) => s + li.discount, 0);
  const totalAmount = subtotal + taxTotal - discountTotal;

  const [row] = await db.insert(salesTable).values({
    invoiceNumber,
    outletId: parsed.data.outletId,
    customerId: parsed.data.customerId ?? null,
    saleDate: parsed.data.saleDate,
    lineItems,
    subtotal: String(subtotal),
    taxTotal: String(taxTotal),
    discountTotal: String(discountTotal),
    totalAmount: String(totalAmount),
    paymentMode: parsed.data.paymentMode,
    couponCode: parsed.data.couponCode ?? null,
  }).returning();

  // ── Deduct outlet stock ───────────────────────────────────────────────────
  for (const li of lineItems) {
    const [existing] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, "outlet"),
        eq(stockEntriesTable.branchId, parsed.data.outletId)
      ))
      .limit(1);
    if (existing) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric - ${li.quantity}` })
        .where(eq(stockEntriesTable.id, existing.id));
    }
  }

  // ── Update customer total purchases ───────────────────────────────────────
  if (parsed.data.customerId) {
    await db.update(customersTable)
      .set({ totalPurchases: sql`${customersTable.totalPurchases}::numeric + ${totalAmount}` })
      .where(eq(customersTable.id, parsed.data.customerId));
  }

  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outletId)).limit(1);
  const customerName = row.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customerId)).limit(1))[0]?.name ?? null
    : null;

  logActivity({
    action: "CREATE", module: "sales", entityType: "sale", entityId: row.id,
    description: `New sale ${invoiceNumber} — ${customerName ?? "Walk-in"} — ₹${totalAmount.toFixed(2)}`,
    metadata: { after: { invoiceNumber, outletId: row.outletId, customerId: row.customerId, totalAmount, lineCount: lineItems.length } },
  }).catch(() => {});

  res.status(201).json({
    ...row,
    outletName: outlet?.name ?? "",
    outletUpiId: (outlet as any)?.upiId ?? "",
    customerName,
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.taxTotal),
    discountTotal: Number(row.discountTotal),
    totalAmount: Number(row.totalAmount),
    lineItems: row.lineItems ?? [],
  });
});

router.get("/sales/summary", async (_req, res): Promise<void> => {
  const rows = await db.select().from(salesTable);
  const outlets = await db.select().from(outletsTable);
  const oMap = new Map(outlets.map((o) => [o.id, o.name]));

  const totalSales = rows.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTax = rows.reduce((s, r) => s + Number(r.taxTotal), 0);

  const byOutlet = new Map<number, { salesAmount: number; invoiceCount: number }>();
  for (const r of rows) {
    const existing = byOutlet.get(r.outletId) ?? { salesAmount: 0, invoiceCount: 0 };
    existing.salesAmount += Number(r.totalAmount);
    existing.invoiceCount += 1;
    byOutlet.set(r.outletId, existing);
  }

  res.json({
    totalSales,
    totalTax,
    totalInvoices: rows.length,
    byOutlet: Array.from(byOutlet.entries()).map(([outletId, d]) => ({
      outletId,
      outletName: oMap.get(outletId) ?? "",
      salesAmount: d.salesAmount,
      invoiceCount: d.invoiceCount,
    })),
  });
});

// Create a time-limited signed share token for the invoice PDF.
// The backend verifies the sale exists (and thereby the customer linkage)
// before issuing a token — the frontend never passes phone numbers or IDs
// that could be tampered with into the PDF pipeline.
router.post("/sales/:id/share-token", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
  const [row] = await db.select({ id: salesTable.id }).from(salesTable).where(eq(salesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { token, expiresAt } = createInvoiceShareToken(id);
  res.json({ token, expiresAt });
});

router.get("/sales/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(salesTable).where(eq(salesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outletId)).limit(1);
  const customerName = row.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customerId)).limit(1))[0]?.name ?? null
    : null;
  res.json({
    ...row,
    outletName: outlet?.name ?? "",
    outletUpiId: (outlet as any)?.upiId ?? "",
    customerName,
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.taxTotal),
    discountTotal: Number(row.discountTotal),
    totalAmount: Number(row.totalAmount),
    lineItems: row.lineItems ?? [],
  });
});

export default router;

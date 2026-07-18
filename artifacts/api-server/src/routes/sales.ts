import { Router } from "express";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable } from "@workspace/db";
import { eq, and, sum, count, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";

const router = Router();

// ── Item Prices ────────────────────────────────────────────────────────────
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

  // Upsert: find existing or create new
  const [existing] = await db.select().from(itemPricesTable)
    .where(and(eq(itemPricesTable.itemId, parsed.data.itemId), eq(itemPricesTable.outletId, parsed.data.outletId)))
    .limit(1);

  let row;
  if (existing) {
    [row] = await db.update(itemPricesTable).set({ price: String(parsed.data.price) }).where(eq(itemPricesTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(itemPricesTable).values({ itemId: parsed.data.itemId, outletId: parsed.data.outletId, price: String(parsed.data.price) }).returning();
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
  const oMap = new Map(outlets.map((o) => [o.id, o.name]));
  const cMap = new Map(customers.map((c) => [c.id, c.name]));

  const outletIdFilter = req.query.outletId ? Number(req.query.outletId) : null;
  const filtered = outletIdFilter ? rows.filter((r) => r.outletId === outletIdFilter) : rows;

  res.json(filtered.map((r) => ({
    ...r,
    outletName: oMap.get(r.outletId) ?? "",
    customerName: r.customerId ? cMap.get(r.customerId) ?? null : null,
    subtotal: Number(r.subtotal),
    taxTotal: Number(r.taxTotal),
    discountTotal: Number(r.discountTotal),
    totalAmount: Number(r.totalAmount),
    lineItems: r.lineItems ?? [],
  })));
});

router.post("/sales", async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const lineItems = parsed.data.lineItems as Array<{ itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number }>;
  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
  const taxTotal = lineItems.reduce((s, li) => s + (li.taxAmount ?? 0), 0);
  const discountTotal = lineItems.reduce((s, li) => s + (li.discount ?? 0), 0);
  const totalAmount = subtotal + taxTotal - discountTotal;
  const invoiceNumber = `INV-${Date.now()}`;

  const [row] = await db.insert(salesTable).values({
    invoiceNumber,
    outletId: parsed.data.outletId,
    customerId: parsed.data.customerId ?? null,
    saleDate: parsed.data.saleDate,
    lineItems: lineItems,
    subtotal: String(subtotal),
    taxTotal: String(taxTotal),
    discountTotal: String(discountTotal),
    totalAmount: String(totalAmount),
    paymentMode: parsed.data.paymentMode,
    couponCode: parsed.data.couponCode ?? null,
  }).returning();

  // Deduct from outlet stock
  for (const li of lineItems) {
    const [existing] = await db.select().from(stockEntriesTable)
      .where(and(eq(stockEntriesTable.itemId, li.itemId), eq(stockEntriesTable.branchType, "outlet"), eq(stockEntriesTable.branchId, parsed.data.outletId)))
      .limit(1);
    if (existing) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric - ${li.quantity}` })
        .where(eq(stockEntriesTable.id, existing.id));
    }
  }

  // Update customer total purchases if present
  if (parsed.data.customerId) {
    await db.update(customersTable)
      .set({ totalPurchases: sql`${customersTable.totalPurchases}::numeric + ${totalAmount}` })
      .where(eq(customersTable.id, parsed.data.customerId));
  }

  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outletId)).limit(1);
  const customerName = row.customerId ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customerId)).limit(1))[0]?.name ?? null : null;

  res.status(201).json({
    ...row,
    outletName: outlet?.name ?? "",
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

router.get("/sales/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(salesTable).where(eq(salesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outletId)).limit(1);
  const customerName = row.customerId ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customerId)).limit(1))[0]?.name ?? null : null;
  res.json({
    ...row,
    outletName: outlet?.name ?? "",
    customerName,
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.taxTotal),
    discountTotal: Number(row.discountTotal),
    totalAmount: Number(row.totalAmount),
    lineItems: row.lineItems ?? [],
  });
});

export default router;

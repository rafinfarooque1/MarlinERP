import { Router } from "express";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable, companySettingsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { createInvoiceShareToken } from "../lib/shareToken";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches } from "../lib/batches";

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
  const { pool: pgPool } = await import("@workspace/db");
  const { rows: rawRows } = await pgPool.query(`SELECT * FROM sales ORDER BY id`);
  const outlets = await db.select().from(outletsTable);
  const customers = await db.select().from(customersTable);
  const { rows: warehouses } = await pgPool.query<{ id: number; name: string; upi_id: string | null }>(
    `SELECT id, name, upi_id FROM warehouses ORDER BY id`
  );
  const oMap = new Map(outlets.map((o) => [o.id, { name: o.name, upiId: (o as any).upiId ?? "" }]));
  const wMap = new Map(warehouses.map((w) => [w.id, { name: w.name, upiId: w.upi_id ?? "" }]));
  const cMap = new Map(customers.map((c) => [c.id, { name: c.name, phone: c.phone ?? null }]));

  const outletIdFilter = req.query.outletId ? Number(req.query.outletId) : null;
  const filtered = outletIdFilter ? rawRows.filter((r: any) => r.outlet_id === outletIdFilter) : rawRows;

  res.json(filtered.map((r: any) => {
    const cust = r.customer_id ? cMap.get(r.customer_id) : null;
    const locationType: string = r.location_type ?? 'outlet';
    const locationId: number = r.location_id ?? r.outlet_id;
    const outlet = oMap.get(r.outlet_id);
    const warehouse = locationType === 'warehouse' ? wMap.get(locationId) : null;
    const locationName = warehouse?.name ?? outlet?.name ?? "";
    const locationUpiId = warehouse?.upiId ?? outlet?.upiId ?? "";
    const totalAmount = Number(r.total_amount);
    const amountPaid  = Number(r.amount_paid ?? 0);
    return {
      id: r.id,
      invoiceNumber: r.invoice_number,
      outletId: r.outlet_id,
      locationType,
      locationId,
      customerId: r.customer_id,
      saleDate: r.sale_date,
      lineItems: r.line_items ?? [],
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      discountTotal: Number(r.discount_total),
      totalAmount,
      paymentMode: r.payment_mode,
      couponCode: r.coupon_code,
      createdAt: r.created_at,
      paymentStatus: r.payment_status ?? "paid",
      amountPaid,
      balanceDue: Math.max(0, totalAmount - amountPaid),
      outletName: locationName,
      outletUpiId: locationUpiId,
      customerName: cust?.name ?? null,
      customerPhone: cust?.phone ?? null,
    };
  }));
});

router.post("/sales", async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { pool: pgPool } = await import("@workspace/db");

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number;
  }>;

  // ── Determine location (warehouse or outlet) ──────────────────────────────
  const rawBody = req.body as any;
  const locationType: 'outlet' | 'warehouse' = rawBody.locationType === 'warehouse' ? 'warehouse' : 'outlet';
  const locationId: number = rawBody.locationId ? Number(rawBody.locationId) : parsed.data.outletId;

  // Look up location name, UPI ID, and ledger IDs
  let cashLedgerId: number | null = null;
  let salesLedgerId: number | null = null;
  let locationName = '';
  let locationUpiId = '';

  if (locationType === 'warehouse') {
    const { rows: [wh] } = await pgPool.query<{
      name: string; upi_id: string | null; cash_ledger_id: number | null; sales_ledger_id: number | null
    }>(`SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM warehouses WHERE id = $1`, [locationId]);
    if (!wh) { res.status(400).json({ error: 'Warehouse not found' }); return; }
    cashLedgerId = wh.cash_ledger_id;
    salesLedgerId = wh.sales_ledger_id;
    locationName = wh.name;
    locationUpiId = wh.upi_id ?? '';
  } else {
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, locationId)).limit(1);
    if (!outlet) { res.status(400).json({ error: 'Outlet not found' }); return; }
    const { rows: [ol] } = await pgPool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null }>(
      `SELECT cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`, [locationId]
    );
    cashLedgerId = ol?.cash_ledger_id ?? null;
    salesLedgerId = ol?.sales_ledger_id ?? null;
    locationName = outlet.name;
    locationUpiId = (outlet as any).upiId ?? '';
  }

  // ── Validate stock availability before committing ─────────────────────────
  for (const li of rawLineItems) {
    const [stock] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, locationType as any),
        eq(stockEntriesTable.branchId, locationId)
      ))
      .limit(1);
    const available = stock ? Number(stock.quantity) : 0;
    if (available < li.quantity) {
      res.status(400).json({
        error: `Insufficient stock for item ${li.itemId}. Available: ${available}, requested: ${li.quantity}`
      });
      return;
    }
  }

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
      lineSubtotal: taxInfo.taxableAmount,
      ...taxInfo,
    };
  });

  const subtotal = lineItems.reduce((s, li) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s, li) => s + li.taxAmount, 0);
  const discountTotal = (parsed.data as any).discountTotal ?? lineItems.reduce((s, li) => s + li.discount, 0);
  const totalAmount = subtotal + taxTotal - discountTotal;

  // ── Insert sale with location columns via raw SQL (location_type/location_id not in Drizzle schema) ──
  const outletIdForInsert = locationType === 'outlet' ? locationId : null;
  const { rows: [row] } = await pgPool.query<any>(
    `INSERT INTO sales (invoice_number, outlet_id, location_type, location_id, customer_id, sale_date, line_items, subtotal, tax_total, discount_total, total_amount, payment_mode, coupon_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [invoiceNumber, outletIdForInsert, locationType, locationId,
     parsed.data.customerId ?? null, parsed.data.saleDate,
     JSON.stringify(lineItems), subtotal, taxTotal, discountTotal, totalAmount,
     parsed.data.paymentMode ?? 'cash', parsed.data.couponCode ?? null]
  );

  // ── Deduct stock from the selling location + consume batches (FEFO) ──────
  const lineItemsWithBatches: any[] = [];
  for (const li of lineItems) {
    const [existing] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, locationType as any),
        eq(stockEntriesTable.branchId, locationId)
      ))
      .limit(1);
    if (existing) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric - ${li.quantity}` })
        .where(eq(stockEntriesTable.id, existing.id));
    }
    const batchBreakdown = await consumeBatches(pool, {
      itemId: li.itemId, branchType: locationType, branchId: locationId, quantity: li.quantity,
    });
    lineItemsWithBatches.push({ ...li, batchBreakdown });
  }
  // Persist which batches served this sale (traceability + exact reversal on edit)
  await pool.query(`UPDATE sales SET line_items = $1::jsonb WHERE id = $2`, [JSON.stringify(lineItemsWithBatches), row.id]);

  // ── Update customer total purchases ───────────────────────────────────────
  if (parsed.data.customerId) {
    await db.update(customersTable)
      .set({ totalPurchases: sql`${customersTable.totalPurchases}::numeric + ${totalAmount}` })
      .where(eq(customersTable.id, parsed.data.customerId));
  }

  // ── Post accounting entry ─────────────────────────────────────────────────
  if (salesLedgerId) {
    // Determine which account to debit: customer debtor ledger (credit sale) or location cash (cash sale)
    let debitLedgerId = cashLedgerId;
    if (parsed.data.customerId && parsed.data.paymentMode !== 'cash') {
      const { rows: [custLedger] } = await pgPool.query<{ id: number }>(
        `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${parsed.data.customerId}`]
      );
      if (custLedger) debitLedgerId = custLedger.id;
    }
    if (debitLedgerId) {
      await pgPool.query(
        `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, voucher_number)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [parsed.data.saleDate, salesLedgerId, debitLedgerId, totalAmount,
         `Sale: ${invoiceNumber}${locationName ? ` at ${locationName}` : ''}`, invoiceNumber]
      );
    }
  }

  const customerName = parsed.data.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1))[0]?.name ?? null
    : null;

  logActivity({
    action: "CREATE", module: "sales", entityType: "sale", entityId: row.id,
    description: `New sale ${invoiceNumber} — ${customerName ?? "Walk-in"} — ₹${totalAmount.toFixed(2)}`,
    metadata: { after: { invoiceNumber, locationType, locationId, customerId: parsed.data.customerId, totalAmount, lineCount: lineItems.length } },
  }).catch(() => {});

  res.status(201).json({
    id: row.id,
    invoiceNumber: row.invoice_number,
    outletId: row.outlet_id,
    locationType: row.location_type,
    locationId: row.location_id,
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
    saleDate: row.sale_date,
    lineItems: lineItemsWithBatches,
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    discountTotal: Number(row.discount_total),
    totalAmount: Number(row.total_amount),
    paymentMode: row.payment_mode,
    couponCode: row.coupon_code,
    createdAt: row.created_at,
    paymentStatus: row.payment_status ?? 'unpaid',
    amountPaid: Number(row.amount_paid ?? 0),
    balanceDue: Math.max(0, totalAmount - Number(row.amount_paid ?? 0)),
  });
});

// ── Edit Sale ─────────────────────────────────────────────────────────────────
router.put("/sales/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const { pool: pgPool } = await import("@workspace/db");
  const { rows: [existingRaw] } = await pgPool.query<any>(`SELECT * FROM sales WHERE id = $1`, [id]);
  if (!existingRaw) { res.status(404).json({ error: "Sale not found" }); return; }

  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number;
  }>;

  // ── Determine new location ────────────────────────────────────────────────
  const rawBody = req.body as any;
  const newLocationType: 'outlet' | 'warehouse' = rawBody.locationType === 'warehouse' ? 'warehouse' : 'outlet';
  const newLocationId: number = rawBody.locationId ? Number(rawBody.locationId) : parsed.data.outletId;

  // Old location (for stock reversal)
  const oldLocationType: string = existingRaw.location_type ?? 'outlet';
  const oldLocationId: number = existingRaw.location_id ?? existingRaw.outlet_id;

  // Determine inter-state
  let company = (await db.select().from(companySettingsTable).limit(1))[0];
  if (!company) { [company] = await db.insert(companySettingsTable).values({}).returning(); }
  const companyState = (company.state ?? '').trim().toLowerCase();

  let customerState = '';
  if (parsed.data.customerId) {
    const [cust] = await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1);
    customerState = (cust?.state ?? '').trim().toLowerCase();
  }
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // Fetch item tax rates
  const itemIds = [...new Set(rawLineItems.map(li => li.itemId))];
  const itemsData = itemIds.length > 0
    ? await db.select({ id: itemsTable.id, taxRate: itemsTable.taxRate, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
        .from(itemsTable).where(inArray(itemsTable.id, itemIds))
    : [];
  const itemTaxMap = new Map(itemsData.map(i => [i.id, { taxRate: Number(i.taxRate), name: i.name, hsnCode: i.hsnCode, unit: i.unit }]));

  // Build enriched line items
  const lineItems = rawLineItems.map(li => {
    const itemInfo = itemTaxMap.get(li.itemId);
    const taxRate = itemInfo?.taxRate ?? 0;
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
      lineSubtotal: taxInfo.taxableAmount,
      ...taxInfo,
    };
  });

  const subtotal = lineItems.reduce((s, li) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s, li) => s + li.taxAmount, 0);
  const discountTotal = (parsed.data as any).discountTotal ?? lineItems.reduce((s, li) => s + li.discount, 0);
  const totalAmount = subtotal + taxTotal - discountTotal;

  // Reverse old stock deductions
  const oldLineItems = (existingRaw.line_items ?? []) as Array<{ itemId: number; quantity: number; batchBreakdown?: any[] }>;
  for (const li of oldLineItems) {
    const [se] = await db.select().from(stockEntriesTable)
      .where(and(eq(stockEntriesTable.itemId, li.itemId), eq(stockEntriesTable.branchType, oldLocationType as any), eq(stockEntriesTable.branchId, oldLocationId)))
      .limit(1);
    if (se) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric + ${li.quantity}` })
        .where(eq(stockEntriesTable.id, se.id));
    }
    // Restore the exact batches this sale consumed. Legacy lines without a
    // stored breakdown leave batches untouched (residual shows as untracked).
    await restoreBatches(pool, li.itemId, oldLocationType, oldLocationId, li.batchBreakdown, "sale", id);
  }

  // Update the sale row via raw SQL to include location columns
  const newOutletId = newLocationType === 'outlet' ? newLocationId : null;
  const { rows: [updated] } = await pgPool.query<any>(
    `UPDATE sales SET outlet_id=$1, location_type=$2, location_id=$3, customer_id=$4, sale_date=$5,
     line_items=$6::jsonb, subtotal=$7, tax_total=$8, discount_total=$9, total_amount=$10,
     payment_mode=$11, coupon_code=$12
     WHERE id=$13 RETURNING *`,
    [newOutletId, newLocationType, newLocationId, parsed.data.customerId ?? null,
     parsed.data.saleDate, JSON.stringify(lineItems), subtotal, taxTotal, discountTotal, totalAmount,
     parsed.data.paymentMode ?? 'cash', parsed.data.couponCode ?? null, id]
  );

  // Apply new stock deductions + consume batches (FEFO)
  const newLineItemsWithBatches: any[] = [];
  for (const li of lineItems) {
    const [se] = await db.select().from(stockEntriesTable)
      .where(and(eq(stockEntriesTable.itemId, li.itemId), eq(stockEntriesTable.branchType, newLocationType as any), eq(stockEntriesTable.branchId, newLocationId)))
      .limit(1);
    if (se) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric - ${li.quantity}` })
        .where(eq(stockEntriesTable.id, se.id));
    }
    const batchBreakdown = await consumeBatches(pool, {
      itemId: li.itemId, branchType: newLocationType, branchId: newLocationId, quantity: li.quantity,
    });
    newLineItemsWithBatches.push({ ...li, batchBreakdown });
  }
  await pool.query(`UPDATE sales SET line_items = $1::jsonb WHERE id = $2`, [JSON.stringify(newLineItemsWithBatches), id]);

  // Adjust customer total purchases
  const oldTotal = Number(existingRaw.total_amount);
  const oldCustomerId = existingRaw.customer_id;
  if (oldCustomerId) {
    await db.update(customersTable)
      .set({ totalPurchases: sql`${customersTable.totalPurchases}::numeric - ${oldTotal}` })
      .where(eq(customersTable.id, oldCustomerId));
  }
  if (parsed.data.customerId) {
    await db.update(customersTable)
      .set({ totalPurchases: sql`${customersTable.totalPurchases}::numeric + ${totalAmount}` })
      .where(eq(customersTable.id, parsed.data.customerId));
  }

  // Get location name for response
  let locationName = '';
  let locationUpiId = '';
  if (newLocationType === 'warehouse') {
    const { rows: [wh] } = await pgPool.query<{ name: string; upi_id: string | null }>(
      `SELECT name, upi_id FROM warehouses WHERE id = $1`, [newLocationId]
    );
    locationName = wh?.name ?? '';
    locationUpiId = wh?.upi_id ?? '';
  } else {
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, newLocationId)).limit(1);
    locationName = outlet?.name ?? '';
    locationUpiId = (outlet as any)?.upiId ?? '';
  }

  const customerName = parsed.data.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1))[0]?.name ?? null
    : null;

  logActivity({
    action: "UPDATE", module: "sales", entityType: "sale", entityId: id,
    description: `Sale ${existingRaw.invoice_number} updated — ₹${totalAmount.toFixed(2)}`,
    metadata: { before: { totalAmount: oldTotal }, after: { totalAmount } },
  }).catch(() => {});

  res.json({
    id: updated.id,
    invoiceNumber: updated.invoice_number,
    outletId: updated.outlet_id,
    locationType: updated.location_type,
    locationId: updated.location_id,
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
    saleDate: updated.sale_date,
    lineItems: updated.line_items ?? [],
    subtotal: Number(updated.subtotal),
    taxTotal: Number(updated.tax_total),
    discountTotal: Number(updated.discount_total),
    totalAmount: Number(updated.total_amount),
    paymentMode: updated.payment_mode,
    couponCode: updated.coupon_code,
    createdAt: updated.created_at,
    paymentStatus: updated.payment_status ?? 'paid',
    amountPaid: Number(updated.amount_paid ?? 0),
    balanceDue: Math.max(0, totalAmount - Number(updated.amount_paid ?? 0)),
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
  const { pool: pgPool } = await import("@workspace/db");
  const { rows: [row] } = await pgPool.query(`SELECT * FROM sales WHERE id = $1`, [id]);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const locationType: string = row.location_type ?? 'outlet';
  const locationId: number = row.location_id ?? row.outlet_id;
  let locationName = '';
  let locationUpiId = '';
  if (locationType === 'warehouse') {
    const { rows: [wh] } = await pgPool.query<{ name: string; upi_id: string | null }>(
      `SELECT name, upi_id FROM warehouses WHERE id = $1`, [locationId]
    );
    locationName = wh?.name ?? '';
    locationUpiId = wh?.upi_id ?? '';
  } else {
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outlet_id)).limit(1);
    locationName = outlet?.name ?? '';
    locationUpiId = (outlet as any)?.upiId ?? '';
  }
  const customerName = row.customer_id
    ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customer_id)).limit(1))[0]?.name ?? null
    : null;
  const totalAmount = Number(row.total_amount);
  const amountPaid  = Number(row.amount_paid ?? 0);
  res.json({
    id: row.id,
    invoiceNumber: row.invoice_number,
    outletId: row.outlet_id,
    locationType,
    locationId,
    customerId: row.customer_id,
    saleDate: row.sale_date,
    lineItems: row.line_items ?? [],
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    discountTotal: Number(row.discount_total),
    totalAmount,
    paymentMode: row.payment_mode,
    couponCode: row.coupon_code,
    createdAt: row.created_at,
    paymentStatus: row.payment_status ?? "paid",
    amountPaid,
    balanceDue: Math.max(0, totalAmount - amountPaid),
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
  });
});

export default router;

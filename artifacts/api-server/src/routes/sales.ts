import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable, companySettingsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { createInvoiceShareToken } from "../lib/shareToken";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches } from "../lib/batches";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";

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

router.post("/item-prices", requireModuleAction("Item Prices", "add"), async (req, res): Promise<void> => {
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

// GET /sales — optionally server-paginated (Phase 7).
// Without `page`/`limit` params the legacy full-array response is returned
// (backward compatible). With them: envelope { total, page, limit, rows }.
// Filters (usable in both modes): q (invoice/customer name/phone), from/to
// (YYYY-MM-DD), locationType+locationId, warehouseScope=<warehouseId>
// (warehouse itself + its child outlets — replaces client-side filtering),
// legacy outletId.
router.get("/sales", async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return;
  }

  const conds: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (from) { params.push(from); conds.push(`s.sale_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`s.sale_date <= $${params.length}::date`); }

  const lt = req.query.locationType;
  const lid = Number(req.query.locationId);
  if ((lt === 'warehouse' || lt === 'outlet') && Number.isFinite(lid) && lid > 0) {
    params.push(lt);  conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
    params.push(lid); conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
  } else if (req.query.outletId) {
    // Legacy exact filter (kept for existing callers)
    params.push(Number(req.query.outletId)); conds.push(`s.outlet_id = $${params.length}`);
  }
  const ws = Number(req.query.warehouseScope);
  if (Number.isFinite(ws) && ws > 0) {
    params.push(ws);
    const p = params.length;
    conds.push(`((COALESCE(s.location_type, 'outlet') = 'warehouse' AND COALESCE(s.location_id, s.outlet_id) = $${p})
      OR (COALESCE(s.location_type, 'outlet') = 'outlet' AND COALESCE(s.location_id, s.outlet_id) IN (SELECT id FROM outlets WHERE warehouse_id = $${p})))`);
  }
  // ── Server-side data scope: enforce branch visibility ─────────────────────
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeSalesWhere(scope, params));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const baseFrom = `FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;

  let total = 0;
  let page = 1;
  let limit = 0;
  let pageSql = '';
  if (paginated) {
    page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200);
    const { rows: [t] } = await pgPool.query(`SELECT COUNT(*)::int AS total ${baseFrom} ${where}`, params);
    total = Number(t?.total ?? 0);
    pageSql = ` LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
  }

  const { rows: rawRows } = await pgPool.query(`
    SELECT s.*, c.name AS _customer_name, c.phone AS _customer_phone
    ${baseFrom} ${where}
    ORDER BY s.id ${paginated ? 'DESC' : ''}${pageSql}
  `, params);

  const outlets = await db.select().from(outletsTable);
  const { rows: warehouses } = await pgPool.query<{ id: number; name: string; upi_id: string | null }>(
    `SELECT id, name, upi_id FROM warehouses ORDER BY id`
  );
  const oMap = new Map(outlets.map((o) => [o.id, { name: o.name, upiId: (o as any).upiId ?? "" }]));
  const wMap = new Map(warehouses.map((w) => [w.id, { name: w.name, upiId: w.upi_id ?? "" }]));

  const mapped = rawRows.map((r: any) => {
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
      customerName: r._customer_name ?? null,
      customerPhone: r._customer_phone ?? null,
    };
  });

  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

router.post("/sales", requireModuleAction(["Sales", "Point of Sale"], "add"), async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { pool: pgPool } = await import("@workspace/db");

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number;
  }>;

  // ── Validate per-line discounts ───────────────────────────────────────────
  // A line discount is ₹ off that line's gross (MRP × qty) and must never
  // exceed it — GST is back-calculated from the discounted gross.
  for (const li of rawLineItems) {
    const d = Number(li.discount ?? 0);
    const lineAmount = li.quantity * (li.unitPrice ?? 0);
    if (!Number.isFinite(d) || d < 0) {
      res.status(400).json({ error: `Line discount must be a non-negative amount (item ${li.itemId})` });
      return;
    }
    if (d > lineAmount + 0.004) {
      res.status(400).json({ error: `Line discount ₹${d.toFixed(2)} cannot exceed the line amount ₹${lineAmount.toFixed(2)} (item ${li.itemId})` });
      return;
    }
  }

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
  // Bill-level (coupon) discount ONLY. Per-line discounts are already netted
  // into lineSubtotal/taxAmount above — adding them here would double-count.
  // CreateSaleBody strips unknown keys, so read the raw body (same pattern as
  // locationType/locationId).
  const rawDiscountTotal = Number(rawBody.discountTotal ?? 0);
  if (!Number.isFinite(rawDiscountTotal) || rawDiscountTotal < 0) {
    res.status(400).json({ error: 'discountTotal must be a non-negative amount' });
    return;
  }
  if (rawDiscountTotal > subtotal + taxTotal + 0.004) {
    res.status(400).json({ error: 'Bill discount cannot exceed the invoice amount' });
    return;
  }
  const discountTotal = Math.round(rawDiscountTotal * 100) / 100;
  const totalAmount = subtotal + taxTotal - discountTotal;

  // ── Credit control + atomic sale insert ───────────────────────────────────
  // The credit-limit check, invoice-sequence increment, and sale INSERT run in
  // ONE transaction. A per-customer advisory lock serializes concurrent credit
  // sales so two requests cannot both pass the limit check, and a rejected
  // sale never burns an invoice number.
  const paymentModeIn = parsed.data.paymentMode ?? 'cash';
  // cash/upi/card are settled at the counter — mark them paid immediately so
  // outstanding, collections, and the credit check only track true credit
  // exposure. Only 'credit' (pay later) sales are credit-controlled.
  const settledAtSale = ['cash', 'upi', 'card'].includes(paymentModeIn);
  const isCreditControlled = !!parsed.data.customerId && paymentModeIn === 'credit';
  const overrideRequested = rawBody.creditOverride === true;

  // Credit (pay later) sales must have a customer — otherwise there is no
  // account to owe the balance and the credit check would be bypassed.
  if (paymentModeIn === 'credit' && !parsed.data.customerId) {
    res.status(400).json({
      error: 'Credit sales require a customer. Pick a customer or choose cash/UPI/card.',
      code: 'CREDIT_REQUIRES_CUSTOMER',
    });
    return;
  }

  // Server-side authorization for the override flag: hierarchy level 1 (top
  // authority) or an explicit Sales-module can_edit permission. The client
  // gates the override dialog the same way, but the API must not trust it.
  let overrideAllowed = false;
  if (isCreditControlled && overrideRequested) {
    const hierarchyId = req.employee?.hierarchyId ?? -1;
    const { rows: [h] } = await pgPool.query<{ level: number }>(
      `SELECT level FROM hierarchies WHERE id = $1`, [hierarchyId]
    );
    if (Number(h?.level) === 1) {
      overrideAllowed = true;
    } else {
      const { rows: [p] } = await pgPool.query<{ can_edit: boolean }>(
        `SELECT can_edit FROM permissions WHERE hierarchy_id = $1 AND module = 'Sales' LIMIT 1`,
        [hierarchyId]
      );
      overrideAllowed = p?.can_edit === true;
    }
  }

  const txClient = await pgPool.connect();
  let row: any;
  let invoiceNumber = '';
  try {
    await txClient.query('BEGIN');

    if (isCreditControlled) {
      // Serialize concurrent credit sales for this customer; the lock is
      // released automatically at COMMIT/ROLLBACK.
      await txClient.query(
        `SELECT pg_advisory_xact_lock(hashtext('customer-credit'), $1)`,
        [parsed.data.customerId]
      );
      const { rows: [cc] } = await txClient.query<{ credit_limit: string }>(
        `SELECT COALESCE(credit_limit, 0)::numeric AS credit_limit FROM customers WHERE id = $1`,
        [parsed.data.customerId]
      );
      const creditLimit = Number(cc?.credit_limit ?? 0);
      if (creditLimit > 0) {
        const { rows: [ob] } = await txClient.query<{ due: string }>(
          `SELECT COALESCE(SUM(total_amount::numeric - COALESCE(amount_paid, 0)::numeric), 0) AS due
           FROM sales WHERE customer_id = $1`,
          [parsed.data.customerId]
        );
        const { rows: [cnr] } = await txClient.query<{ amt: string }>(
          `SELECT COALESCE(SUM(v.total_amount::numeric), 0) AS amt
           FROM journal_vouchers v
           JOIN account_ledgers l ON l.id = v.party_ledger_id
           WHERE v.voucher_type = 'credit_note' AND l.code = $1`,
          [`CUST-${parsed.data.customerId}`]
        );
        const currentOutstanding = Math.max(0, Math.round((Number(ob?.due ?? 0) - Number(cnr?.amt ?? 0)) * 100) / 100);
        const projectedOutstanding = Math.round((currentOutstanding + totalAmount) * 100) / 100;
        const exceeded = projectedOutstanding > creditLimit + 0.009;
        if (exceeded && !(overrideRequested && overrideAllowed)) {
          await txClient.query('ROLLBACK');
          const figures = {
            creditLimit,
            currentOutstanding,
            saleAmount: Math.round(totalAmount * 100) / 100,
            projectedOutstanding,
          };
          if (overrideRequested && !overrideAllowed) {
            res.status(403).json({
              error: 'You are not authorized to override the credit limit. Ask a manager with Sales edit permission.',
              code: 'CREDIT_OVERRIDE_FORBIDDEN',
              ...figures,
            });
          } else {
            res.status(409).json({
              error: `Credit limit exceeded: current outstanding ₹${currentOutstanding.toFixed(2)} plus this sale of ₹${totalAmount.toFixed(2)} exceeds the credit limit of ₹${creditLimit.toFixed(2)}.`,
              code: 'CREDIT_LIMIT_EXCEEDED',
              ...figures,
            });
          }
          return;
        }
      }
    }

    // ── Atomically increment invoice sequence (same transaction) ────────────
    const { rows: [comp] } = await txClient.query<{
      invoice_sequence: number; financial_year: string | null; invoice_prefix: string | null;
    }>(
      `UPDATE company_settings SET invoice_sequence = invoice_sequence + 1
       WHERE id = $1 RETURNING invoice_sequence, financial_year, invoice_prefix`,
      [company.id]
    );
    const seq = comp.invoice_sequence;
    const fy = comp.financial_year || '2025-26';
    const prefix = comp.invoice_prefix || 'INV';
    invoiceNumber = computeInvoiceNumber(prefix, fy, seq);

    // ── Insert sale with location columns via raw SQL (location_type/location_id not in Drizzle schema) ──
    // Counter-settled modes are recorded fully paid; credit sales start unpaid.
    const outletIdForInsert = locationType === 'outlet' ? locationId : null;
    ({ rows: [row] } = await txClient.query<any>(
      `INSERT INTO sales (invoice_number, outlet_id, location_type, location_id, customer_id, sale_date, line_items, subtotal, tax_total, discount_total, total_amount, payment_mode, coupon_code, amount_paid, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [invoiceNumber, outletIdForInsert, locationType, locationId,
       parsed.data.customerId ?? null, parsed.data.saleDate,
       JSON.stringify(lineItems), subtotal, taxTotal, discountTotal, totalAmount,
       paymentModeIn, parsed.data.couponCode ?? null,
       settledAtSale ? totalAmount : 0, settledAtSale ? 'paid' : 'unpaid']
    ));

    await txClient.query('COMMIT');
  } catch (txErr) {
    try { await txClient.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    txClient.release();
  }

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
    // Debit routing follows settlement semantics: cash → location cash ledger,
    // upi/card (settled, awaiting bank) → Electronic Payment Clearing, and only
    // true credit sales → the customer debtor ledger.
    let debitLedgerId = cashLedgerId;
    if (paymentModeIn === 'upi' || paymentModeIn === 'card') {
      const { rows: [clr] } = await pgPool.query<{ id: number }>(
        `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
      );
      if (clr) debitLedgerId = clr.id;
    } else if (paymentModeIn === 'credit' && parsed.data.customerId) {
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
router.put("/sales/:id", requireModuleAction(["Sales", "Point of Sale"], "edit"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const { pool: pgPool } = await import("@workspace/db");
  const { rows: [existingRaw] } = await pgPool.query<any>(`SELECT * FROM sales WHERE id = $1`, [id]);
  if (!existingRaw) { res.status(404).json({ error: "Sale not found" }); return; }

  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Credit (pay later) sales must have a customer — same server-side rule as
  // creation, enforced before any stock reversal side effects run.
  if ((parsed.data.paymentMode ?? 'cash') === 'credit' && !parsed.data.customerId) {
    res.status(400).json({
      error: 'Credit sales require a customer. Pick a customer or choose cash/UPI/card.',
      code: 'CREDIT_REQUIRES_CUSTOMER',
    });
    return;
  }

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount: number; taxAmount: number;
  }>;

  // ── Validate per-line discounts (same rule as creation) ──────────────────
  for (const li of rawLineItems) {
    const d = Number(li.discount ?? 0);
    const lineAmount = li.quantity * (li.unitPrice ?? 0);
    if (!Number.isFinite(d) || d < 0) {
      res.status(400).json({ error: `Line discount must be a non-negative amount (item ${li.itemId})` });
      return;
    }
    if (d > lineAmount + 0.004) {
      res.status(400).json({ error: `Line discount ₹${d.toFixed(2)} cannot exceed the line amount ₹${lineAmount.toFixed(2)} (item ${li.itemId})` });
      return;
    }
  }

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
  // Bill-level (coupon) discount ONLY — see POST handler for the semantics.
  const rawDiscountTotal = Number(rawBody.discountTotal ?? 0);
  if (!Number.isFinite(rawDiscountTotal) || rawDiscountTotal < 0) {
    res.status(400).json({ error: 'discountTotal must be a non-negative amount' });
    return;
  }
  if (rawDiscountTotal > subtotal + taxTotal + 0.004) {
    res.status(400).json({ error: 'Bill discount cannot exceed the invoice amount' });
    return;
  }
  const discountTotal = Math.round(rawDiscountTotal * 100) / 100;
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

  // Update the sale row via raw SQL to include location columns.
  // Settlement fields: counter-settled modes (cash/upi/card) stay fully paid;
  // credit sales re-derive amount_paid from recorded sale_payments so an edit
  // never wipes out collected payments.
  const newPaymentMode = parsed.data.paymentMode ?? 'cash';
  let newAmountPaid = totalAmount;
  let newPaymentStatus = 'paid';
  if (!['cash', 'upi', 'card'].includes(newPaymentMode)) {
    const { rows: [pp] } = await pgPool.query<{ paid: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`, [id]
    );
    newAmountPaid = Number(pp?.paid ?? 0);
    newPaymentStatus = newAmountPaid >= totalAmount - 0.004 ? 'paid' : newAmountPaid > 0.004 ? 'partially_paid' : 'unpaid';
  }
  const newOutletId = newLocationType === 'outlet' ? newLocationId : null;
  const { rows: [updated] } = await pgPool.query<any>(
    `UPDATE sales SET outlet_id=$1, location_type=$2, location_id=$3, customer_id=$4, sale_date=$5,
     line_items=$6::jsonb, subtotal=$7, tax_total=$8, discount_total=$9, total_amount=$10,
     payment_mode=$11, coupon_code=$12, amount_paid=$13, payment_status=$14
     WHERE id=$15 RETURNING *`,
    [newOutletId, newLocationType, newLocationId, parsed.data.customerId ?? null,
     parsed.data.saleDate, JSON.stringify(lineItems), subtotal, taxTotal, discountTotal, totalAmount,
     newPaymentMode, parsed.data.couponCode ?? null, newAmountPaid, newPaymentStatus, id]
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

// Summary totals + per-location breakdown. Raw SQL because location_type /
// location_id are startup-migration columns invisible to drizzle — the old
// drizzle version grouped warehouse sales under their fallback outlet_id,
// losing them from the breakdown (bug #37).
router.get("/sales/summary", async (_req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const { rows } = await pgPool.query(`
    SELECT COALESCE(s.location_type, 'outlet')   AS location_type,
           COALESCE(s.location_id, s.outlet_id)  AS location_id,
           COUNT(*)::int                          AS invoice_count,
           COALESCE(SUM(s.total_amount::numeric), 0)::float AS sales_amount,
           COALESCE(SUM(s.tax_total::numeric), 0)::float    AS tax_amount
    FROM sales s
    GROUP BY 1, 2
  `);
  const outlets = await db.select().from(outletsTable);
  const oMap = new Map(outlets.map((o) => [o.id, o.name]));
  const { rows: warehouses } = await pgPool.query<{ id: number; name: string }>(`SELECT id, name FROM warehouses`);
  const wMap = new Map(warehouses.map((w) => [w.id, w.name]));

  let totalSales = 0, totalTax = 0, totalInvoices = 0;
  const byLocation: Array<{ locationType: string; locationId: number; locationName: string; salesAmount: number; invoiceCount: number }> = [];
  for (const r of rows) {
    totalSales += Number(r.sales_amount);
    totalTax += Number(r.tax_amount);
    totalInvoices += Number(r.invoice_count);
    const locationType = r.location_type as string;
    const locationId = Number(r.location_id);
    byLocation.push({
      locationType,
      locationId,
      locationName: (locationType === 'warehouse' ? wMap.get(locationId) : oMap.get(locationId)) ?? "",
      salesAmount: Number(r.sales_amount),
      invoiceCount: Number(r.invoice_count),
    });
  }
  byLocation.sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({
    totalSales,
    totalTax,
    totalInvoices,
    // Legacy shape: outlet rows only (warehouse sales now correctly excluded
    // instead of being misattributed to an outlet id)
    byOutlet: byLocation
      .filter((l) => l.locationType === 'outlet')
      .map((l) => ({ outletId: l.locationId, outletName: l.locationName, salesAmount: l.salesAmount, invoiceCount: l.invoiceCount })),
    byLocation,
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

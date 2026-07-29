import { Router } from "express";
import { requireModuleAction, requireModuleView, hasModuleAction, hasAnyModuleAction, type ModuleAction } from "../middleware/permissions";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable, companySettingsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { createInvoiceShareToken } from "../lib/shareToken";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches } from "../lib/batches";
import { writeStockLedger, batchResolveMeta } from "../lib/stockLedger";
import { buildBranchMaps } from "./stock";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { blockedByInactiveProducts, INACTIVE_PRODUCT_CODE } from "../lib/productIdentity";
import { SALE_PAYMENT_MODES, isSettledAtSale, clearsThroughBank } from "../lib/paymentModes";
import { availabilityAt, insufficientStockMessage } from "../lib/reservations";

const router = Router();

/**
 * `stock_entries` is polymorphic: it holds items, raw materials and packing
 * materials, and those three ID spaces overlap from 1. Every item-stock query
 * MUST carry this filter or a sale of item #1 can read — and deduct — the row
 * belonging to material #1 at the same location.
 *
 * `material_type` is added by a startup migration, so Drizzle's schema does not
 * know about it; it has to be expressed as raw SQL.
 */
const ITEM_ROWS_ONLY = sql`stock_entries.material_type = 'item'`;

/**
 * Who may sell past a customer's credit limit.
 *
 * These are the receivables pages — the people who chase the money are the
 * people who get to decide it is safe to extend more of it. Deliberately NOT
 * the Point of Sale page: edit rights there belong to every cashier, and
 * credit control that any cashier can wave through is not credit control.
 */
const CREDIT_OVERRIDE_PAGES = ["page:/outstanding", "page:/returns"];
const CREDIT_OVERRIDE_DENIED_MESSAGE =
  'You are not authorized to override the credit limit. Ask a manager with edit access to the Outstanding page.';

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

// Serves Item Prices and HO Sales (POS) pages.
router.get("/item-prices", requireModuleView(["page:/headoffice/item-price", "page:/sales/pos"]), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const qp = ListItemPricesQueryParams.safeParse(req.query);

  // Use raw SQL — location_type column is invisible to Drizzle (startup migration)
  const { rows } = await pgPool.query(`
    SELECT
      ip.id, ip.item_id, ip.outlet_id, ip.price, ip.updated_at,
      ip.valid_from, ip.valid_to,
      COALESCE(ip.location_type, 'outlet') AS location_type,
      i.name  AS item_name,
      CASE
        WHEN COALESCE(ip.location_type, 'outlet') = 'warehouse'  THEN w.name
        WHEN COALESCE(ip.location_type, 'outlet') = 'headoffice' THEN 'Head Office'
        ELSE o.name
      END AS outlet_name
    FROM item_prices ip
    LEFT JOIN items     i ON i.id = ip.item_id
    LEFT JOIN outlets   o ON o.id = ip.outlet_id AND COALESCE(ip.location_type, 'outlet') = 'outlet'
    LEFT JOIN warehouses w ON w.id = ip.outlet_id AND ip.location_type = 'warehouse'
    ORDER BY ip.id DESC
  `);

  let result = rows.map((r: any) => ({
    id:           r.id,
    itemId:       r.item_id,
    outletId:     r.outlet_id,
    locationType: r.location_type,
    price:        Number(r.price),
    validFrom:    r.valid_from ?? null,
    validTo:      r.valid_to   ?? null,
    itemName:     r.item_name  ?? '',
    outletName:   r.outlet_name ?? '',
    updatedAt:    r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));

  if (qp.success && qp.data.outletId) {
    result = result.filter((r: any) => r.outletId === Number(qp.data.outletId));
  }

  res.json(result);
});

router.post("/item-prices", requireModuleAction("page:/headoffice/item-price", "add"), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const parsed = SetItemPriceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const body = req.body as { validFrom?: string; validTo?: string; locationType?: string };
  const locationType = body.locationType ?? 'outlet';
  const locationId   = parsed.data.outletId; // reused field: holds warehouse/HO id too

  // No new or amended pricing for a retired outlet; existing outlet prices stay
  // readable so historical bills still explain themselves.
  if (locationType === 'outlet' && await outletWritesBlocked(pgPool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // For headoffice there's no sub-id — store 0
  const storedId = locationType === 'headoffice' ? 0 : locationId;

  const validFrom = body.validFrom || null;
  const validTo   = body.validTo   || null;

  // Upsert: match on item + location combo
  const { rows: existing } = await pgPool.query(
    `SELECT id FROM item_prices WHERE item_id = $1 AND outlet_id = $2 AND COALESCE(location_type,'outlet') = $3 LIMIT 1`,
    [parsed.data.itemId, storedId, locationType]
  );

  let row: any;
  if (existing.length > 0) {
    const { rows: updated } = await pgPool.query(
      `UPDATE item_prices SET price = $1, valid_from = $2, valid_to = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [String(parsed.data.price), validFrom, validTo, existing[0].id]
    );
    row = updated[0];
  } else {
    const { rows: inserted } = await pgPool.query(
      `INSERT INTO item_prices (item_id, outlet_id, location_type, price, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [parsed.data.itemId, storedId, locationType, String(parsed.data.price), validFrom, validTo]
    );
    row = inserted[0];
  }

  // Resolve display names
  const { rows: itemRows }   = await pgPool.query(`SELECT name FROM items WHERE id = $1 LIMIT 1`, [row.item_id]);
  let locationName = 'Head Office';
  if (locationType === 'warehouse') {
    const { rows: wRows } = await pgPool.query(`SELECT name FROM warehouses WHERE id = $1 LIMIT 1`, [storedId]);
    locationName = wRows[0]?.name ?? '';
  } else if (locationType === 'outlet') {
    const { rows: oRows } = await pgPool.query(`SELECT name FROM outlets WHERE id = $1 LIMIT 1`, [storedId]);
    locationName = oRows[0]?.name ?? '';
  }

  res.json({
    id:           row.id,
    itemId:       row.item_id,
    outletId:     row.outlet_id,
    locationType: row.location_type ?? 'outlet',
    price:        Number(row.price),
    validFrom:    row.valid_from  ?? null,
    validTo:      row.valid_to    ?? null,
    itemName:     itemRows[0]?.name ?? '',
    outletName:   locationName,
    updatedAt:    row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  });
});

// ── Sales ──────────────────────────────────────────────────────────────────

// GET /sales — optionally server-paginated (Phase 7).
// Without `page`/`limit` params the legacy full-array response is returned
// (backward compatible). With them: envelope { total, page, limit, rows }.
// Filters (usable in both modes): q (invoice/customer name/phone), from/to
// (YYYY-MM-DD), locationType+locationId, warehouseScope=<warehouseId>
// (warehouse itself + its child outlets — replaces client-side filtering),
// legacy outletId.
// Serves HO Sales/Payments (POS), Returns and the Sales Dashboard.
router.get("/sales", requireModuleView(["page:/sales/pos", "page:/returns", "page:/"]), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return;
  }

  // Branch-transfer tax invoices are not customer sales — they must never show
  // in the sales register (see gstTransfer.ts).
  const conds: string[] = ['s.branch_transfer_id IS NULL'];
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

router.post("/sales", requireModuleAction("page:/sales/pos", "add"), async (req, res): Promise<void> => {
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

  // ── Discontinued items can't be billed again ──────────────────────────────
  // Create-only: an existing invoice stays editable and refundable after the
  // item is retired, so history and returns are never stranded.
  const inactiveMsg = await blockedByInactiveProducts(
    pgPool, rawLineItems.map(li => ({ kind: "item" as const, id: Number(li.itemId) })),
  );
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }

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
    // Retired outlets are readable but frozen — no new bills may be raised at
    // one, otherwise the "no new outlet activity" rule leaks through the till.
    if (await outletWritesBlocked(pgPool)) {
      res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
    }
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

  // NOTE: stock availability is NOT checked here. It used to be — with a
  // non-locking read, several statements before the deduction, which let two
  // concurrent bills both pass the check and sell the same unit twice. The
  // check, the row lock and the deduction now happen together inside the sale
  // transaction below.

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
  // The generated zod schema types paymentMode as a plain string, so the mode
  // list is enforced here. Legacy 'card' / 'bank_transfer' rows are still
  // accepted so an old invoice can be edited without rewriting its mode.
  if (!isSettledAtSale(paymentModeIn) && paymentModeIn !== 'credit') {
    res.status(400).json({
      error: `paymentMode must be one of: ${SALE_PAYMENT_MODES.join(', ')}`,
    });
    return;
  }
  // cash/bank/upi are settled at the counter — mark them paid immediately so
  // outstanding, collections, and the credit check only track true credit
  // exposure. Only 'credit' (pay later) sales are credit-controlled.
  const settledAtSale = isSettledAtSale(paymentModeIn);
  const isCreditControlled = !!parsed.data.customerId && paymentModeIn === 'credit';
  const overrideRequested = rawBody.creditOverride === true;

  // Credit (pay later) sales must have a customer — otherwise there is no
  // account to owe the balance and the credit check would be bypassed.
  if (paymentModeIn === 'credit' && !parsed.data.customerId) {
    res.status(400).json({
      error: 'Credit sales require a customer. Pick a customer or choose cash, bank or UPI.',
      code: 'CREDIT_REQUIRES_CUSTOMER',
    });
    return;
  }

  // Server-side authorization for the override flag. The dialog is offered to
  // everyone, so this check is the only thing standing between a cashier and
  // selling past a customer's credit limit.
  let overrideAllowed = false;
  if (isCreditControlled && overrideRequested) {
    overrideAllowed = await hasModuleAction(req.employee?.hierarchyId, CREDIT_OVERRIDE_PAGES, "edit");
  }

  // ── Everything the sale transaction will need, resolved before it opens ───
  // The movement trail, the customer total and the accounting receipt all have
  // to commit WITH the sale (see below). These lookups are read-only, so they
  // run first rather than holding row locks open while they wait on the
  // database.
  const [ledgerMeta, branchNameOf] = await Promise.all([
    batchResolveMeta(pool, lineItems.map(li => ({ materialType: 'item' as const, refId: li.itemId }))),
    buildBranchMaps(),
  ]);
  let elecClrLedgerId: number | null = null;
  if (clearsThroughBank(paymentModeIn)) {
    const { rows: [clr] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    elecClrLedgerId = clr?.id ?? null;
  }
  let custLedgerId: number | null = null;
  if (paymentModeIn === 'credit' && parsed.data.customerId) {
    const { rows: [cl] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${parsed.data.customerId}`]
    );
    custLedgerId = cl?.id ?? null;
  }

  const txClient = await pgPool.connect();
  let row: any;
  let invoiceNumber = '';
  let lineItemsWithBatches: any[] = [];
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
              error: CREDIT_OVERRIDE_DENIED_MESSAGE,
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

    // ── Stock: check, lock and deduct in one transaction ────────────────────
    // This is the write that stops stock being promised twice. Each line's
    // stock_entries row is locked BEFORE its availability is judged, so a second
    // bill for the same item waits here and then sees the reduced quantity
    // instead of reading a figure that is about to change. Availability is
    // on-hand minus active holds — stock already committed to another document
    // cannot be sold from under it.
    //
    // Lines are locked in ascending item order so two concurrent bills covering
    // the same items acquire their locks in the same sequence and cannot
    // deadlock waiting on each other.
    //
    // It also runs before the invoice-sequence bump: a sale that cannot be
    // fulfilled must not hold a lock on company_settings (which would serialise
    // every till in the business) while it finds out.
    const stockOrder = lineItems.map((_, i) => i).sort((a, b) => lineItems[a].itemId - lineItems[b].itemId);
    const breakdowns: any[] = new Array(lineItems.length);
    for (const idx of stockOrder) {
      const li = lineItems[idx];
      const avail = await availabilityAt(txClient, {
        refId: li.itemId, materialType: 'item',
        branchType: locationType, branchId: locationId, lock: true,
      });
      if (avail.available + 0.001 < Number(li.quantity)) {
        await txClient.query('ROLLBACK');
        res.status(400).json({
          error: insufficientStockMessage({
            productName: li.itemName || `Item #${li.itemId}`,
            locationName, unit: li.unit,
            quantity: avail.quantity, reserved: avail.reserved,
            requested: Number(li.quantity),
          }),
          code: 'INSUFFICIENT_STOCK',
          itemId: li.itemId,
          available: avail.available,
          reserved: avail.reserved,
          onHand: avail.quantity,
          requested: Number(li.quantity),
        });
        return;
      }
      await txClient.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, avail.entryId]
      );
      // Draw the lots that serve this line, earliest expiry first, so the sale
      // carries its own batch trail and an edit can restore the exact lots.
      breakdowns[idx] = await consumeBatches(txClient, {
        itemId: li.itemId, branchType: locationType, branchId: locationId, quantity: li.quantity,
      });
    }
    lineItemsWithBatches = lineItems.map((li, i) => ({ ...li, batchBreakdown: breakdowns[i] ?? [] }));

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
       // Stored WITH the batch trail already resolved above, so the served lots
       // are committed with the bill rather than patched in afterwards.
       JSON.stringify(lineItemsWithBatches), subtotal, taxTotal, discountTotal, totalAmount,
       paymentModeIn, parsed.data.couponCode ?? null,
       settledAtSale ? totalAmount : 0, settledAtSale ? 'paid' : 'unpaid']
    ));

    // ── The rest of what a sale means, in the SAME transaction ──────────────
    // The movement trail, the customer's running total and the accounting
    // receipt used to run AFTER the commit — the ledger write fire-and-forget
    // with its errors swallowed by an empty catch. That is why the database
    // held 52 sales and not one sale movement row: every failure was discarded
    // in silence. All of it now commits with the sale or none of it does.
    await writeStockLedger(txClient, lineItems.map(li => {
      const m = ledgerMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: locationType, branchId: locationId,
        branchName: branchNameOf(locationType, locationId),
        qtyChange: -Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: row.id,
        // The table has no doc_number column, so the invoice number rides in
        // notes — without it the trail can't be tied back to a bill.
        notes: invoiceNumber,
      };
    }));

    if (parsed.data.customerId) {
      await txClient.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric + $1 WHERE id = $2`,
        [totalAmount, parsed.data.customerId]
      );
    }

    // Debit routing follows settlement semantics: cash → location cash ledger,
    // upi/card (settled, awaiting bank) → Electronic Payment Clearing, and only
    // true credit sales → the customer debtor ledger.
    if (salesLedgerId) {
      let debitLedgerId = cashLedgerId;
      if (clearsThroughBank(paymentModeIn) && elecClrLedgerId) debitLedgerId = elecClrLedgerId;
      else if (paymentModeIn === 'credit' && custLedgerId) debitLedgerId = custLedgerId;
      if (debitLedgerId) {
        await txClient.query(
          `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, voucher_number, location_type, location_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [parsed.data.saleDate, salesLedgerId, debitLedgerId, totalAmount,
           `Sale: ${invoiceNumber}${locationName ? ` at ${locationName}` : ''}`, invoiceNumber,
           locationType, locationId]
        );
      }
    }

    await txClient.query('COMMIT');
  } catch (txErr) {
    try { await txClient.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    txClient.release();
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
router.put("/sales/:id", requireModuleAction("page:/sales/pos", "edit"), async (req, res): Promise<void> => {
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
      error: 'Credit sales require a customer. Pick a customer or choose cash, bank or UPI.',
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

  // Retired outlets are read-only: a bill may not be moved ONTO an outlet, and a
  // historical outlet bill may not be rewritten (editing it would re-post that
  // outlet's stock and ledgers). Both ends are checked because either one is an
  // outlet write.
  if ((newLocationType === 'outlet' || oldLocationType === 'outlet') && await outletWritesBlocked(pgPool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

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

  // ── Credit limit check on edit ────────────────────────────────────────────
  // Mirror of the POST credit-limit guard so edits can't silently bypass it.
  const newPaymentModeForCredit = parsed.data.paymentMode ?? 'cash';
  const isEditCreditControlled = !!parsed.data.customerId && newPaymentModeForCredit === 'credit';

  if (isEditCreditControlled) {
    const editCustomerId = parsed.data.customerId!;
    const { rows: [editCC] } = await pgPool.query<{ credit_limit: string }>(
      `SELECT COALESCE(credit_limit, 0)::numeric AS credit_limit FROM customers WHERE id = $1`,
      [editCustomerId]
    );
    const editCreditLimit = Number(editCC?.credit_limit ?? 0);
    if (editCreditLimit > 0) {
      // Outstanding = all credit sales for customer (excluding this sale, which
      // we are replacing) minus all sale_payments collected for this customer.
      const { rows: [ous] } = await pgPool.query<{ outstanding: string }>(
        `SELECT GREATEST(
           COALESCE((SELECT SUM(total_amount::numeric) FROM sales
                     WHERE customer_id = $1 AND payment_mode = 'credit' AND id != $2), 0)
           -
           COALESCE((SELECT SUM(sp.amount::numeric) FROM sale_payments sp
                     JOIN sales s ON s.id = sp.sale_id WHERE s.customer_id = $1), 0)
         , 0)::numeric AS outstanding`,
        [editCustomerId, id]
      );
      const currentOutstanding = Number(ous?.outstanding ?? 0);
      const projectedOutstanding = currentOutstanding + totalAmount;

      if (projectedOutstanding > editCreditLimit + 0.009) {
        const editOverrideRequested = (req.body as any).creditOverride === true;
        if (editOverrideRequested) {
          const overrideAllowed = await hasModuleAction(req.employee?.hierarchyId, CREDIT_OVERRIDE_PAGES, "edit");
          if (!overrideAllowed) {
            res.status(403).json({
              error: CREDIT_OVERRIDE_DENIED_MESSAGE,
              code: 'CREDIT_LIMIT_OVERRIDE_DENIED',
            });
            return;
          }
        } else {
          res.status(422).json({
            error: `Credit limit exceeded: current outstanding ₹${currentOutstanding.toFixed(2)} plus this sale of ₹${totalAmount.toFixed(2)} exceeds the credit limit of ₹${editCreditLimit.toFixed(2)}.`,
            code: 'CREDIT_LIMIT_EXCEEDED',
            creditLimit: editCreditLimit,
            currentOutstanding,
            projectedOutstanding,
          });
          return;
        }
      }
    }
  }

  // ── Stock and sale row: one transaction ───────────────────────────────────
  // An edit reverses the bill's old lines and applies the new ones. Both halves
  // and the sale row itself move together: a failure part-way used to leave
  // stock credited back with the bill unchanged, and the re-apply had no
  // availability check at all, so an edit could overdraw a location until the
  // negative-stock constraint threw a raw database error at the user.
  //
  // Every stock_entries row is locked before it is judged, in ascending item
  // order, so a concurrent bill for the same item waits rather than reading a
  // quantity that is about to change.
  const oldLineItems = (existingRaw.line_items ?? []) as Array<{ itemId: number; quantity: number; batchBreakdown?: any[] }>;
  const oldTotal = Number(existingRaw.total_amount);
  const oldCustomerId = existingRaw.customer_id as number | null;
  const newPaymentMode = parsed.data.paymentMode ?? 'cash';
  let newAmountPaid = totalAmount;
  let newPaymentStatus = 'paid';
  if (!isSettledAtSale(newPaymentMode)) {
    // Credit sales re-derive amount_paid from recorded sale_payments so an edit
    // never wipes out collected payments.
    const { rows: [pp] } = await pgPool.query<{ paid: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`, [id]
    );
    newAmountPaid = Number(pp?.paid ?? 0);
    newPaymentStatus = newAmountPaid >= totalAmount - 0.004 ? 'paid' : newAmountPaid > 0.004 ? 'partially_paid' : 'unpaid';
  }
  const newOutletId = newLocationType === 'outlet' ? newLocationId : null;

  // ── Everything the edit transaction will need, resolved before it opens ───
  // An edit has to restate the accounting receipt as well as the stock, so the
  // ledgers for the (possibly new) location are looked up here rather than
  // inside the transaction.
  const { rows: [editLoc] } = await pgPool.query<{
    name: string; upi_id: string | null; cash_ledger_id: number | null; sales_ledger_id: number | null;
  }>(
    newLocationType === 'warehouse'
      ? `SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM warehouses WHERE id = $1`
      : `SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`,
    [newLocationId]
  );
  const locationName = editLoc?.name ?? '';
  const locationUpiId = editLoc?.upi_id ?? '';
  const editSalesLedgerId = editLoc?.sales_ledger_id ?? null;
  const editCashLedgerId = editLoc?.cash_ledger_id ?? null;

  let editElecClrId: number | null = null;
  if (clearsThroughBank(newPaymentMode)) {
    const { rows: [clr] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    editElecClrId = clr?.id ?? null;
  }
  let editCustLedgerId: number | null = null;
  if (newPaymentMode === 'credit' && parsed.data.customerId) {
    const { rows: [cl] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${parsed.data.customerId}`]
    );
    editCustLedgerId = cl?.id ?? null;
  }
  const [editMeta, editBranchNameOf] = await Promise.all([
    batchResolveMeta(pool, [...oldLineItems, ...lineItems].map(li => ({ materialType: 'item' as const, refId: li.itemId }))),
    buildBranchMaps(),
  ]);

  const editTx = await pgPool.connect();
  let updated: any;
  const newLineItemsWithBatches: any[] = [];
  try {
    await editTx.query('BEGIN');

    // 0. Take every stock lock this edit will need, up front, in one globally
    //    deterministic order.
    //
    //    Reversing the old lines and applying the new ones are two separate
    //    passes, each sorted only within itself. That is not enough: an edit
    //    moving item 1 -> item 2 locks 1 then 2, while a concurrent edit moving
    //    2 -> 1 locks 2 then 1, and the two deadlock. Ordering the union of both
    //    passes by (item, location) gives every concurrent edit the same
    //    acquisition order, so they queue instead of deadlocking.
    //
    //    Rows that do not exist yet cannot be locked here; the reversal pass
    //    inserts them, which is safe because a row nobody has can't be
    //    contended for its quantity.
    const lockKeys = Array.from(new Set([
      ...oldLineItems.map(li => `${Number(li.itemId)}|${oldLocationType}|${Number(oldLocationId)}`),
      ...lineItems.map(li => `${Number(li.itemId)}|${newLocationType}|${Number(newLocationId)}`),
    ]));
    if (lockKeys.length > 0) {
      await editTx.query(
        `SELECT id FROM stock_entries
          WHERE material_type = 'item'
            AND (item_id::text || '|' || branch_type || '|' || branch_id::text) = ANY($1::text[])
          ORDER BY item_id, branch_type, branch_id
          FOR UPDATE`,
        [lockKeys]
      );
    }

    // 1. Reverse the old lines: credit the quantity back and restore the exact
    //    lots the bill consumed. Legacy lines without a stored breakdown leave
    //    batches untouched (the residual shows as untracked).
    for (const li of [...oldLineItems].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
      const { rows: [se] } = await editTx.query<{ id: number }>(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
          LIMIT 1 FOR UPDATE`,
        [li.itemId, oldLocationType, oldLocationId]
      );
      if (se) {
        await editTx.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [li.quantity, se.id]
        );
      } else {
        await editTx.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, '0')`,
          [li.itemId, oldLocationType, oldLocationId, li.quantity]
        );
      }
      await restoreBatches(editTx, li.itemId, oldLocationType, oldLocationId, li.batchBreakdown, "sale", id);
    }

    // 2. Apply the new lines against available stock (on hand − held). The old
    //    lines are already back in stock above, so an edit that keeps the same
    //    quantity always passes.
    const editOrder = lineItems.map((_, i) => i).sort((a, b) => lineItems[a].itemId - lineItems[b].itemId);
    const editBreakdowns: any[] = new Array(lineItems.length);
    for (const idx of editOrder) {
      const li = lineItems[idx];
      const avail = await availabilityAt(editTx, {
        refId: li.itemId, materialType: 'item',
        branchType: newLocationType, branchId: newLocationId, lock: true,
      });
      if (avail.available + 0.001 < Number(li.quantity)) {
        await editTx.query('ROLLBACK');
        // Named only when refusing, so the happy path costs no extra query.
        const { rows: [locRow] } = await pgPool.query<{ name: string }>(
          newLocationType === 'warehouse'
            ? `SELECT name FROM warehouses WHERE id = $1`
            : `SELECT name FROM outlets WHERE id = $1`,
          [newLocationId]
        );
        res.status(400).json({
          error: insufficientStockMessage({
            productName: li.itemName || `Item #${li.itemId}`,
            locationName: locRow?.name ?? null, unit: li.unit,
            quantity: avail.quantity, reserved: avail.reserved,
            requested: Number(li.quantity),
          }),
          code: 'INSUFFICIENT_STOCK',
          itemId: li.itemId,
          available: avail.available,
          reserved: avail.reserved,
          onHand: avail.quantity,
          requested: Number(li.quantity),
        });
        return;
      }
      await editTx.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, avail.entryId]
      );
      editBreakdowns[idx] = await consumeBatches(editTx, {
        itemId: li.itemId, branchType: newLocationType, branchId: newLocationId, quantity: li.quantity,
      });
    }
    for (let i = 0; i < lineItems.length; i++) {
      newLineItemsWithBatches.push({ ...lineItems[i], batchBreakdown: editBreakdowns[i] ?? [] });
    }

    // 3. The sale row, carrying the lots that now serve it.
    ({ rows: [updated] } = await editTx.query<any>(
      `UPDATE sales SET outlet_id=$1, location_type=$2, location_id=$3, customer_id=$4, sale_date=$5,
       line_items=$6::jsonb, subtotal=$7, tax_total=$8, discount_total=$9, total_amount=$10,
       payment_mode=$11, coupon_code=$12, amount_paid=$13, payment_status=$14
       WHERE id=$15 RETURNING *`,
      [newOutletId, newLocationType, newLocationId, parsed.data.customerId ?? null,
       parsed.data.saleDate, JSON.stringify(newLineItemsWithBatches), subtotal, taxTotal, discountTotal, totalAmount,
       newPaymentMode, parsed.data.couponCode ?? null, newAmountPaid, newPaymentStatus, id]
    ));

    // 4. Ledger the reversal before the re-apply so the trail reads
    //    out → back-in → out again, and the running balance stays truthful.
    //    Inside the transaction: an edit that moved stock but lost its movement
    //    rows leaves a ledger that can never be reconciled to the quantity.
    await writeStockLedger(editTx, oldLineItems.map(li => {
      const m = editMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale_reversal', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: oldLocationType, branchId: oldLocationId,
        branchName: editBranchNameOf(oldLocationType, oldLocationId),
        qtyChange: Number(li.quantity),
        unitCost: Number((li as any).unitPrice ?? 0),
        docType: 'sale', docId: id,
        notes: `${existingRaw.invoice_number} — reversed for edit`,
      };
    }));
    await writeStockLedger(editTx, lineItems.map(li => {
      const m = editMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: newLocationType, branchId: newLocationId,
        branchName: editBranchNameOf(newLocationType, newLocationId),
        qtyChange: -Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: id,
        notes: `${existingRaw.invoice_number} — re-applied after edit`,
      };
    }));

    // 5. Customer running totals: take the old bill off, put the new one on.
    if (oldCustomerId) {
      await editTx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric - $1 WHERE id = $2`,
        [oldTotal, oldCustomerId]
      );
    }
    if (parsed.data.customerId) {
      await editTx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric + $1 WHERE id = $2`,
        [totalAmount, parsed.data.customerId]
      );
    }

    // 6. Restate the accounting receipt. An edit used to change the amount, the
    //    payment mode or the location and leave the original receipt standing,
    //    so the cash and bank books drifted away from the sales register with
    //    nothing to show why. The old receipt for this invoice is withdrawn and
    //    the current one written in its place, in the same transaction.
    await editTx.query(
      `DELETE FROM receipts WHERE voucher_number = $1`, [existingRaw.invoice_number]
    );
    if (editSalesLedgerId) {
      let debitLedgerId = editCashLedgerId;
      if (clearsThroughBank(newPaymentMode) && editElecClrId) debitLedgerId = editElecClrId;
      else if (newPaymentMode === 'credit' && editCustLedgerId) debitLedgerId = editCustLedgerId;
      if (debitLedgerId) {
        await editTx.query(
          `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, voucher_number, location_type, location_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [parsed.data.saleDate, editSalesLedgerId, debitLedgerId, totalAmount,
           `Sale: ${existingRaw.invoice_number}${locationName ? ` at ${locationName}` : ''}`,
           existingRaw.invoice_number, newLocationType, newLocationId]
        );
      }
    }

    await editTx.query('COMMIT');
  } catch (txErr) {
    try { await editTx.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    editTx.release();
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

// ── Cancel Sale ───────────────────────────────────────────────────────────────
//
// Cancelling used to be something only the branch-transfer code could do, by
// stamping `cancelled_at` and nothing else: stock stayed sold, the receipt
// stayed in the cash book, the customer stayed charged and the movement trail
// showed goods leaving that were still on the shelf. The GST and sales reports
// dropped the bill while the books kept it, so the two never agreed again.
//
// A cancellation now reverses every consequence of the sale in one transaction,
// and `buildDerivedPostings` skips cancelled customer invoices, so revenue,
// output GST and the debtor balance all fall away with it.
router.post("/sales/:id/cancel", requireModuleAction("page:/sales/pos", "delete"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
  const reason = typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).trim() : '';

  const { pool: pgPool } = await import("@workspace/db");
  const branchNameOf = await buildBranchMaps();

  const tx = await pgPool.connect();
  try {
    await tx.query('BEGIN');

    const { rows: [sale] } = await tx.query<any>(
      `SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!sale) {
      await tx.query('ROLLBACK');
      res.status(404).json({ error: "Sale not found" }); return;
    }
    if (sale.cancelled_at) {
      await tx.query('ROLLBACK');
      res.status(409).json({ error: `Invoice ${sale.invoice_number} is already cancelled.`, code: 'ALREADY_CANCELLED' }); return;
    }
    // A branch-transfer invoice is owned by the transfer that raised it. Reject
    // the transfer instead — that path raises the credit note which reverses
    // both legs and the tax with them.
    if (sale.branch_transfer_id != null) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: 'This invoice belongs to a branch transfer. Reject the transfer to reverse it.',
        code: 'BRANCH_TRANSFER_INVOICE',
      }); return;
    }
    // Money already banked, or goods already taken back, mean the bill has a
    // life of its own. Reversing it silently would strand those records.
    const { rows: [pay] } = await tx.query<{ n: string; amt: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount::numeric), 0)::text AS amt FROM sale_payments WHERE sale_id = $1`, [id]
    );
    if (Number(pay?.n ?? 0) > 0) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: `₹${Number(pay.amt).toFixed(2)} has already been collected against ${sale.invoice_number}. Refund or raise a credit note instead of cancelling.`,
        code: 'PAYMENTS_RECORDED',
      }); return;
    }
    const { rows: [ret] } = await tx.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales_returns WHERE sale_id = $1`, [id]
    );
    if (Number(ret?.n ?? 0) > 0) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: `${sale.invoice_number} already has a sales return against it. Cancel the return first.`,
        code: 'RETURN_EXISTS',
      }); return;
    }

    const locType: string = sale.location_type ?? 'outlet';
    const locId: number = sale.location_id ?? sale.outlet_id;
    if (locType === 'outlet' && await outletWritesBlocked(pgPool)) {
      await tx.query('ROLLBACK');
      res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
    }

    const lines = (sale.line_items ?? []) as Array<{ itemId: number; quantity: number; unitPrice?: number; batchBreakdown?: any[] }>;

    // Put the goods back, in ascending item order so a concurrent bill for the
    // same item queues behind this instead of deadlocking against it.
    for (const li of [...lines].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
      const { rows: [se] } = await tx.query<{ id: number }>(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
          LIMIT 1 FOR UPDATE`,
        [li.itemId, locType, locId]
      );
      if (se) {
        await tx.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [li.quantity, se.id]
        );
      } else {
        await tx.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, '0')`,
          [li.itemId, locType, locId, li.quantity]
        );
      }
      await restoreBatches(tx, li.itemId, locType, locId, li.batchBreakdown, "sale", id);
    }

    const meta = await batchResolveMeta(tx, lines.map(li => ({ materialType: 'item' as const, refId: li.itemId })));
    await writeStockLedger(tx, lines.map(li => {
      const m = meta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale_cancellation', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: locType, branchId: locId,
        branchName: branchNameOf(locType, locId),
        qtyChange: Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: id,
        notes: `${sale.invoice_number} — cancelled${reason ? `: ${reason}` : ''}`,
      };
    }));

    if (sale.customer_id) {
      await tx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric - $1 WHERE id = $2`,
        [Number(sale.total_amount), sale.customer_id]
      );
    }

    // Withdraw the cash-book side. The derived postings drop the revenue, the
    // output GST and the debtor leg on their own once `cancelled_at` is set.
    await tx.query(`DELETE FROM receipts WHERE voucher_number = $1`, [sale.invoice_number]);

    await tx.query(`UPDATE sales SET cancelled_at = now() WHERE id = $1`, [id]);

    await tx.query('COMMIT');

    logActivity({
      action: "DELETE", module: "sales", entityType: "sale", entityId: id,
      description: `Sale ${sale.invoice_number} cancelled — ₹${Number(sale.total_amount).toFixed(2)}${reason ? ` (${reason})` : ''}`,
      metadata: { before: { totalAmount: Number(sale.total_amount), lineCount: lines.length }, reason },
    }).catch(() => {});

    res.json({
      id,
      invoiceNumber: sale.invoice_number,
      cancelled: true,
      reversedLines: lines.length,
      totalAmount: Number(sale.total_amount),
    });
  } catch (txErr) {
    try { await tx.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    tx.release();
  }
});

// Summary totals + per-location breakdown. Raw SQL because location_type /
// location_id are startup-migration columns invisible to drizzle — the old
// drizzle version grouped warehouse sales under their fallback outlet_id,
// losing them from the breakdown (bug #37).
// No mapped consumer; serves the POS and Dashboard sales figures.
router.get("/sales/summary", requireModuleView(["page:/sales/pos", "page:/"]), async (req, res): Promise<void> => {
  // LBAC: scope summary to the employee's assigned location
  const { getUserDataScope, scopeSalesWhere } = await import("../lib/dataScope");
  const summEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const summScope = summEmp ? await getUserDataScope(summEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const summParams: any[] = [];
  const summScopeCond = scopeSalesWhere(summScope, summParams);

  const { pool: pgPool } = await import("@workspace/db");
  const { rows } = await pgPool.query(`
    SELECT COALESCE(s.location_type, 'outlet')   AS location_type,
           COALESCE(s.location_id, s.outlet_id)  AS location_id,
           COUNT(*)::int                          AS invoice_count,
           COALESCE(SUM(s.total_amount::numeric), 0)::float AS sales_amount,
           COALESCE(SUM(s.tax_total::numeric), 0)::float    AS tax_amount
    FROM sales s
    WHERE s.branch_transfer_id IS NULL
      AND s.cancelled_at IS NULL
      AND ${summScopeCond}
    GROUP BY 1, 2
  `, summParams);
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
//
// This token IS the document: whoever holds it can fetch the invoice PDF for a
// month without signing in. So the right to mint one is a document right, and
// the caller says which one it is exercising. It used to require `add` on the
// sales pages — recording a sale and releasing a copy of it are different
// things, and the roles that print invoices are frequently not the ones that
// write them.
const SHARE_INTENT_ACTIONS: Record<string, ModuleAction[]> = {
  download: ["download"],
  print: ["print"],
  // Reading it on screen, or sending the customer their copy, is satisfied by
  // either right — both pages offer those buttons to both kinds of user.
  preview: ["download", "print"],
  share: ["download", "print"],
};
const SHARE_PAGES = ["page:/sales/pos", "page:/outstanding"];

router.post("/sales/:id/share-token", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  // An unknown or absent intent falls back to the widest requirement (either
  // right), so an older client keeps working without being handed a new one.
  const intent = String((req.body as any)?.intent ?? "preview");
  const required = SHARE_INTENT_ACTIONS[intent] ?? SHARE_INTENT_ACTIONS.preview;
  const mayShare = await hasAnyModuleAction(req.employee?.hierarchyId, SHARE_PAGES, required);
  if (!mayShare) {
    res.status(403).json({
      error: `You don't have permission to ${required.join(" or ")} invoices`,
    });
    return;
  }
  // LBAC: a share link is a public, month-long window onto one invoice, so only
  // someone who can see the sale may mint one. Scoped through the same rule the
  // sales list uses, otherwise a branch user could publish any invoice by id.
  const shareScope = await getUserDataScope((req as any).employee);
  const shareParams: unknown[] = [id];
  const { rows: [row] } = await pool.query(
    `SELECT s.id FROM sales s WHERE s.id = $1 AND ${scopeSalesWhere(shareScope, shareParams)}`,
    shareParams,
  );
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { token, expiresAt } = createInvoiceShareToken(id);
  res.json({ token, expiresAt });
});

router.get("/sales/:id", requireModuleView("page:/sales/pos"), async (req, res): Promise<void> => {
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

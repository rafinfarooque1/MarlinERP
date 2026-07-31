/**
 * Phase 6 — Reports Center backend.
 *
 * Read-only aggregation endpoints that power /reports in the web app.
 * Everything is raw SQL against pg pool (sales.location_type / location_id are
 * startup-migration columns invisible to drizzle) with dates returned as
 * YYYY-MM-DD text.
 *
 * Conventions (match /productions/reports):
 *   • ?from=YYYY-MM-DD&to=YYYY-MM-DD — both optional, inclusive.
 *   • Money rounded to 2dp, quantities to 3dp.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, canViewStockValuation } from "../middleware/permissions";
import { lineTaxHeads } from "../lib/gst";
import { creditAdjustmentsExpr, outstandingExpr, computePaymentPosition } from "../lib/salePaymentPosition";
import { isIsoDate } from "../lib/dateInput";

const router = Router();

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return null;
  return { from, to };
}

// ── Location name maps (headoffice / outlet / warehouse) ────────────────────
type LocMaps = Record<string, Map<number, string>>;
async function locationMaps(): Promise<LocMaps> {
  const [o, w] = await Promise.all([
    pool.query<any>(`SELECT id, name FROM outlets`),
    pool.query<any>(`SELECT id, name FROM warehouses`),
  ]);
  return {
    outlet: new Map(o.rows.map((r: any) => [Number(r.id), String(r.name)])),
    warehouse: new Map(w.rows.map((r: any) => [Number(r.id), String(r.name)])),
    headoffice: new Map([[1, "Head Office"]]),
  };
}
function locName(maps: LocMaps, type: string, id: number): string {
  // Legacy rows stored as 'production' → treat as headoffice
  const t = (type === "production" || type === "production_unit") ? "headoffice" : type;
  if (t === "headoffice") return "Head Office";
  return maps[t]?.get(id) ?? `${type} #${id}`;
}

// Material name maps for purchase line items
async function materialNameMaps(): Promise<Record<string, Map<number, { name: string; unit: string }>>> {
  const q = (sql: string) => pool.query<any>(sql).catch(() => ({ rows: [] as any[] }));
  const [m, rm, it] = await Promise.all([
    q(`SELECT id, name, COALESCE(unit,'') AS unit FROM materials`),
    q(`SELECT id, name, COALESCE(unit,'') AS unit FROM raw_materials`),
    q(`SELECT id, name, COALESCE(unit,'') AS unit FROM items`),
  ]);
  const toMap = (rows: any[]) => new Map(rows.map((r: any) => [Number(r.id), { name: String(r.name), unit: String(r.unit) }]));
  return { material: toMap(m.rows), raw_material: toMap(rm.rows), item: toMap(it.rows) };
}

// ═════════════════════════════════════════════════════════════════════════════
// SALES
// ═════════════════════════════════════════════════════════════════════════════

// ── Sales register — one row per invoice ────────────────────────────────────
router.get("/reports/sales-register", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const locationType = typeof req.query.locationType === "string" ? req.query.locationType : "";
  const locationId = typeof req.query.locationId === "string" ? parseInt(req.query.locationId, 10) : 0;
  if (locationType && !["outlet", "warehouse", "headoffice"].includes(locationType)) {
    res.status(400).json({ error: "locationType must be outlet, warehouse or headoffice" }); return;
  }

  // Build params array and apply server-side scope for non-HO users
  const { getUserDataScope: getScope, scopeSalesWhere: salesScope } = await import("../lib/dataScope");
  const rparams: unknown[] = [range.from, range.to, locationType, Number.isFinite(locationId) ? locationId : 0];
  let scopeCond = "TRUE";
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== "headoffice") {
    const scope = await getScope(scopeEmp);
    scopeCond = salesScope(scope, rparams);
  }

  const { rows } = await pool.query<any>(
    `SELECT s.id, s.invoice_number, to_char(s.sale_date,'YYYY-MM-DD') AS sale_date,
            COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            s.customer_id, c.name AS customer_name,
            COALESCE(s.subtotal,0) AS subtotal, COALESCE(s.discount_total,0) AS discount_total,
            COALESCE(s.tax_total,0) AS tax_total, s.total_amount,
            COALESCE(s.amount_paid,0) AS amount_paid,
            ${creditAdjustmentsExpr("s")} AS credit_adjustments,
            COALESCE(s.payment_mode,'cash') AS payment_mode
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ($3 = '' OR COALESCE(s.location_type,'outlet') = $3)
       AND ($4 = 0 OR COALESCE(s.location_id, s.outlet_id) = $4)
       AND (${scopeCond})
     ORDER BY s.sale_date, s.id`,
    rparams,
  );
  const maps = await locationMaps();

  const list = rows.map((r: any) => {
    // Balance and status come from the shared derivation, so the register agrees
    // with the invoice, its QR and receivables. Cancelled bills are already
    // excluded by the WHERE clause above.
    const position = computePaymentPosition({
      totalAmount: r.total_amount,
      amountReceived: r.amount_paid,
      creditAdjustments: r.credit_adjustments,
      cancelledAt: null,
    });
    return {
      id: Number(r.id),
      invoiceNumber: r.invoice_number ?? `#${r.id}`,
      date: r.sale_date,
      locationType: r.location_type,
      locationId: Number(r.location_id),
      locationName: locName(maps, r.location_type, Number(r.location_id)),
      customerName: r.customer_name ?? "Walk-in",
      subtotal: r2(Number(r.subtotal)),
      discount: r2(Number(r.discount_total)),
      tax: r2(Number(r.tax_total)),
      total: r2(Number(r.total_amount)),
      paid: position.amountReceived,
      creditNotes: position.creditAdjustments,
      balance: position.outstanding,
      paymentMode: r.payment_mode,
      paymentStatus: position.status,
    };
  });

  const totals = {
    invoices: list.length,
    subtotal: r2(list.reduce((s, r) => s + r.subtotal, 0)),
    discount: r2(list.reduce((s, r) => s + r.discount, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
    paid: r2(list.reduce((s, r) => s + r.paid, 0)),
    balance: r2(list.reduce((s, r) => s + r.balance, 0)),
  };
  res.json({ rows: list, totals });
});

// ── Sales by item ────────────────────────────────────────────────────────────
router.get("/reports/sales-by-item", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { getUserDataScope: getScope2, scopeSalesWhere: sScope2 } = await import("../lib/dataScope");
  const emp2 = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope2 = emp2 ? await getScope2(emp2) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const itemParams: any[] = [range.from, range.to];
  const itemScopeCond = sScope2(scope2, itemParams);

  const { rows } = await pool.query<any>(
    `SELECT (li->>'itemId')::int AS item_id,
            SUM(COALESCE((li->>'quantity')::numeric,0))     AS qty,
            SUM(COALESCE((li->>'lineSubtotal')::numeric,0)) AS taxable,
            SUM(COALESCE((li->>'taxAmount')::numeric,0))    AS tax,
            SUM(COALESCE((li->>'lineTotal')::numeric,
                         COALESCE((li->>'lineSubtotal')::numeric,0) + COALESCE((li->>'taxAmount')::numeric,0))) AS total,
            COUNT(DISTINCT s.id)                            AS invoices
     FROM sales s, jsonb_array_elements(s.line_items) li
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ${itemScopeCond}
     GROUP BY 1 ORDER BY 4 DESC NULLS LAST`,
    itemParams,
  );
  const { rows: items } = await pool.query<any>(`SELECT id, name, COALESCE(unit,'') AS unit FROM items`);
  const iMap = new Map<number, { name: string; unit: string }>(items.map((i: any) => [Number(i.id), { name: String(i.name), unit: String(i.unit) }]));

  const list = rows.map((r: any) => {
    const info = iMap.get(Number(r.item_id));
    return {
      itemId: Number(r.item_id),
      itemName: info?.name ?? `Item #${r.item_id}`,
      unit: info?.unit ?? "",
      invoices: Number(r.invoices),
      qty: r3(Number(r.qty)),
      taxable: r2(Number(r.taxable)),
      tax: r2(Number(r.tax)),
      total: r2(Number(r.total)),
    };
  });
  const totals = {
    items: list.length,
    qty: r3(list.reduce((s, r) => s + r.qty, 0)),
    taxable: r2(list.reduce((s, r) => s + r.taxable, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
  };
  res.json({ rows: list, totals });
});

// ── Sales by location (includes warehouse sales) ────────────────────────────
router.get("/reports/sales-by-location", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { getUserDataScope: getScope3, scopeSalesWhere: sScope3 } = await import("../lib/dataScope");
  const emp3 = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope3 = emp3 ? await getScope3(emp3) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const locParams: any[] = [range.from, range.to];
  const locScopeCond = sScope3(scope3, locParams);

  const { rows } = await pool.query<any>(
    `SELECT COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            COUNT(*) AS invoices,
            SUM(COALESCE(s.subtotal,0)) AS taxable,
            SUM(COALESCE(s.tax_total,0)) AS tax,
            SUM(s.total_amount) AS total,
            SUM(COALESCE(s.amount_paid,0)) AS paid,
            -- Outstanding per invoice, then summed: the shared expression already
            -- nets credit notes and clamps, so a report cannot drift from the
            -- invoice, the QR or the customer's balance.
            SUM(${outstandingExpr("s")}) AS outstanding
     FROM sales s
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ${locScopeCond}
     GROUP BY 1, 2 ORDER BY 6 DESC NULLS LAST`,
    locParams,
  );
  const maps = await locationMaps();
  const list = rows.map((r: any) => ({
    locationType: r.location_type,
    locationId: Number(r.location_id),
    locationName: locName(maps, r.location_type, Number(r.location_id)),
    invoices: Number(r.invoices),
    taxable: r2(Number(r.taxable)),
    tax: r2(Number(r.tax)),
    total: r2(Number(r.total)),
    paid: r2(Number(r.paid)),
    outstanding: r2(Number(r.outstanding)),
  }));
  const totals = {
    invoices: list.reduce((s, r) => s + r.invoices, 0),
    taxable: r2(list.reduce((s, r) => s + r.taxable, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
    paid: r2(list.reduce((s, r) => s + r.paid, 0)),
    outstanding: r2(list.reduce((s, r) => s + r.outstanding, 0)),
  };
  res.json({ rows: list, totals });
});

// ── Discount report — one row per discounted invoice ────────────────────────
// itemDiscount = Σ per-line ITEM discounts only. New-format lines store
// discount = itemDiscount + billDiscountShare, so the share is subtracted
// back out (legacy lines have no share — the subtraction is a no-op).
// billDiscount = the pre-tax invoice-level bill discount PLUS the post-tax
// coupon (discount_total) — both are invoice-level, matching the UI's
// "Bill / Coupon Discounts" column. gross = subtotal + tax + itemDiscount +
// bill_discount, i.e. what the customer would have paid at full MRP.
router.get("/reports/discounts", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const locationType = typeof req.query.locationType === "string" ? req.query.locationType : "";
  const locationId = typeof req.query.locationId === "string" ? parseInt(req.query.locationId, 10) : 0;
  if (locationType && !["outlet", "warehouse", "headoffice"].includes(locationType)) {
    res.status(400).json({ error: "locationType must be outlet, warehouse or headoffice" }); return;
  }
  const args = [range.from, range.to, locationType, Number.isFinite(locationId) ? locationId : 0];

  // LBAC: mandatory scope enforcement — non-HO users can only see their own location's data
  const { getUserDataScope: discScope, scopeSalesWhere: discSales } = await import("../lib/dataScope");
  const discEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const discS = discEmp ? await discScope(discEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const discScopeCond = discSales(discS, args); // appends scope params to args

  const { rows } = await pool.query<any>(
    `SELECT s.id, s.invoice_number, to_char(s.sale_date,'YYYY-MM-DD') AS sale_date,
            COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            c.name AS customer_name, s.coupon_code,
            COALESCE(s.payment_mode,'cash') AS payment_mode,
            COALESCE(s.subtotal,0) AS subtotal,
            COALESCE(s.tax_total,0) AS tax_total,
            COALESCE(s.discount_total,0) + COALESCE(s.bill_discount,0) AS bill_discount,
            COALESCE(s.bill_discount,0) AS pre_tax_bill_discount,
            d.item_discount,
            s.total_amount
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(SUM(GREATEST(0,
                COALESCE((li->>'discount')::numeric, 0)
                - COALESCE((li->>'billDiscountShare')::numeric, 0))), 0) AS item_discount
       FROM jsonb_array_elements(COALESCE(s.line_items, '[]'::jsonb)) AS li
     ) d
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ($3 = '' OR COALESCE(s.location_type,'outlet') = $3)
       AND ($4 = 0 OR COALESCE(s.location_id, s.outlet_id) = $4)
       AND ${discScopeCond}
       AND (d.item_discount > 0 OR COALESCE(s.discount_total,0) > 0 OR COALESCE(s.bill_discount,0) > 0)
     ORDER BY s.sale_date, s.id`,
    args,
  );

  // All invoices in the same range/location so the UI can show "X of Y".
  // args already includes scope params from discScopeCond above
  const countArgs = args.slice(); // same params, no extra scope needed (scope already appended)
  const { rows: [cnt] } = await pool.query<any>(
    `SELECT COUNT(*) AS n FROM sales s
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ($3 = '' OR COALESCE(s.location_type,'outlet') = $3)
       AND ($4 = 0 OR COALESCE(s.location_id, s.outlet_id) = $4)
       AND ${discScopeCond}`,
    countArgs,
  );

  const maps = await locationMaps();
  const list = rows.map((r: any) => {
    const itemDiscount = Number(r.item_discount);
    const billDiscount = Number(r.bill_discount);
    const totalDiscount = itemDiscount + billDiscount;
    // Full-MRP gross adds back the PRE-tax deductions only (item + bill
    // discount reduced subtotal/tax); the coupon is post-tax, so
    // subtotal + tax already stands before it.
    const gross = Number(r.subtotal) + Number(r.tax_total) + itemDiscount + Number(r.pre_tax_bill_discount);
    return {
      id: Number(r.id),
      invoiceNumber: r.invoice_number ?? `#${r.id}`,
      date: r.sale_date,
      locationType: r.location_type,
      locationId: Number(r.location_id),
      locationName: locName(maps, r.location_type, Number(r.location_id)),
      customerName: r.customer_name ?? "Walk-in",
      couponCode: r.coupon_code ?? "",
      paymentMode: r.payment_mode,
      gross: r2(gross),
      itemDiscount: r2(itemDiscount),
      billDiscount: r2(billDiscount),
      totalDiscount: r2(totalDiscount),
      net: r2(Number(r.total_amount)),
      discountPct: gross > 0 ? r2((totalDiscount / gross) * 100) : 0,
    };
  });

  const sumGross = list.reduce((s, r) => s + r.gross, 0);
  const sumDiscount = list.reduce((s, r) => s + r.totalDiscount, 0);
  const totals = {
    invoices: list.length,
    allInvoices: Number(cnt?.n ?? 0),
    gross: r2(sumGross),
    itemDiscount: r2(list.reduce((s, r) => s + r.itemDiscount, 0)),
    billDiscount: r2(list.reduce((s, r) => s + r.billDiscount, 0)),
    totalDiscount: r2(sumDiscount),
    net: r2(list.reduce((s, r) => s + r.net, 0)),
    discountPct: sumGross > 0 ? r2((sumDiscount / sumGross) * 100) : 0,
  };
  res.json({ rows: list, totals });
});

// ═════════════════════════════════════════════════════════════════════════════
// PURCHASES
// ═════════════════════════════════════════════════════════════════════════════

// ── Purchase register — one row per bill ────────────────────────────────────
// LBAC: all purchases are at Head Office; non-HO users receive an empty report.
router.get("/reports/purchase-register", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const prEmp = (req as any).employee as { branchType: string } | undefined;
  if (prEmp && prEmp.branchType !== 'headoffice') {
    res.json({
      rows: [],
      totals: { bills: 0, subtotal: 0, discount: 0, tax: 0, total: 0, gross: 0, inputGst: 0, net: 0 },
      reconciliation: "gross − input GST = net purchases (agrees with the P&L Purchases line, before any journal-voucher adjustments)",
    }); return;
  }
  const vendorId = typeof req.query.vendorId === "string" ? parseInt(req.query.vendorId, 10) : 0;

  const { rows } = await pool.query<any>(
    `SELECT p.id, p.invoice_number, to_char(p.purchase_date,'YYYY-MM-DD') AS purchase_date,
            p.vendor_id, v.name AS vendor_name,
            (p.total_amount - COALESCE(p.round_off,0) - COALESCE(p.tax_total,0) + COALESCE(p.discount_total,0)) AS subtotal,
            COALESCE(p.discount_total,0) AS discount_total,
            COALESCE(p.tax_total,0) AS tax_total, p.total_amount, p.line_items
     FROM purchases p
     LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE p.branch_transfer_id IS NULL AND p.cancelled_at IS NULL
       AND ($1 = '' OR p.purchase_date >= $1::date)
       AND ($2 = '' OR p.purchase_date <= $2::date)
       AND ($3 = 0 OR p.vendor_id = $3)
     ORDER BY p.purchase_date, p.id`,
    [range.from, range.to, Number.isFinite(vendorId) ? vendorId : 0],
  );

  // Input GST is derived per-line via the cgst/sgst/igst heads — exactly the
  // way buildDerivedPostings (routes/journal.ts) books it — NOT from
  // purchases.tax_total, because legacy purchases store tax_total = 0 while
  // still carrying per-line GST. The head split is only trusted (claimed as
  // recoverable input tax) when it is internally consistent: the per-line head
  // sum must agree with the per-line taxAmount sum AND with the stored document
  // tax_total when that is non-zero; otherwise the whole amount stays as cost.
  const list = rows.map((r: any) => {
    const li: any[] = Array.isArray(r.line_items) ? r.line_items : [];
    let cg = 0, sg = 0, ig = 0;
    for (const l of li) { const h = lineTaxHeads(l); cg += h.cgst; sg += h.sgst; ig += h.igst; }
    cg = r2(cg); sg = r2(sg); ig = r2(ig);
    const inputTax = r2(cg + sg + ig);
    const amt = Number(r.total_amount);
    const lineTaxSum = r2(li.reduce((a, l) => a + Number(l?.taxAmount ?? 0), 0));
    const pTaxTotal = Number(r.tax_total ?? 0);
    const consistent =
      (lineTaxSum <= 0.004 || Math.abs(inputTax - lineTaxSum) <= 0.05) &&
      (pTaxTotal <= 0.004 || Math.abs(inputTax - pTaxTotal) <= 0.05);
    const recoverable = inputTax > 0.004 && inputTax < amt && consistent ? inputTax : 0;
    return {
      id: Number(r.id),
      billNumber: r.invoice_number ?? `#${r.id}`,
      date: r.purchase_date,
      vendorId: r.vendor_id == null ? null : Number(r.vendor_id),
      vendorName: r.vendor_name ?? "—",
      subtotal: r2(Number(r.subtotal)),
      discount: r2(Number(r.discount_total)),
      // Legacy fields kept for backward compatibility: `tax` is the recoverable
      // input GST, `total` is the gross invoice value.
      tax: r2(recoverable),
      total: r2(amt),
      // gross = full invoice value; inputGst = recoverable ITC (claimed to the
      // GST heads); net = the cost that actually hits the Purchases ledger.
      gross: r2(amt),
      inputGst: r2(recoverable),
      net: r2(amt - recoverable),
      // Document tax_total is retained for reference; note legacy bills carry 0.
      docTaxTotal: r2(pTaxTotal),
    };
  });
  const totals = {
    bills: list.length,
    subtotal: r2(list.reduce((s, r) => s + r.subtotal, 0)),
    discount: r2(list.reduce((s, r) => s + r.discount, 0)),
    tax: r2(list.reduce((s, r) => s + r.inputGst, 0)),
    total: r2(list.reduce((s, r) => s + r.gross, 0)),
    gross: r2(list.reduce((s, r) => s + r.gross, 0)),
    inputGst: r2(list.reduce((s, r) => s + r.inputGst, 0)),
    net: r2(list.reduce((s, r) => s + r.net, 0)),
  };
  res.json({
    rows: list,
    totals,
    // Explicit tie-out: gross − input GST = net purchases. The net figure is
    // what the P&L 'Purchases' line is built from (buildDerivedPostings splits
    // recoverable input GST out to the Input CGST/SGST/IGST ledgers). The P&L
    // line may differ by the net effect of manual journal vouchers.
    reconciliation: "gross − input GST = net purchases (agrees with the P&L Purchases line, before any journal-voucher adjustments)",
  });
});

// ── Purchases by vendor ──────────────────────────────────────────────────────
// LBAC: purchases are Head Office only.
router.get("/reports/purchases-by-vendor", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const pvEmp = (req as any).employee as { branchType: string } | undefined;
  if (pvEmp && pvEmp.branchType !== 'headoffice') {
    res.json({ rows: [], totals: { vendors: 0, bills: 0, taxable: 0, tax: 0, total: 0 } }); return;
  }

  const { rows } = await pool.query<any>(
    `SELECT p.vendor_id, v.name AS vendor_name,
            COUNT(*) AS bills,
            SUM(p.total_amount - COALESCE(p.round_off,0) - COALESCE(p.tax_total,0) + COALESCE(p.discount_total,0)) AS taxable,
            SUM(COALESCE(p.tax_total,0)) AS tax,
            SUM(p.total_amount) AS total
     FROM purchases p
     LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE p.branch_transfer_id IS NULL AND p.cancelled_at IS NULL
       AND ($1 = '' OR p.purchase_date >= $1::date)
       AND ($2 = '' OR p.purchase_date <= $2::date)
     GROUP BY 1, 2 ORDER BY 6 DESC NULLS LAST`,
    [range.from, range.to],
  );
  const list = rows.map((r: any) => ({
    vendorId: r.vendor_id == null ? null : Number(r.vendor_id),
    vendorName: r.vendor_name ?? "—",
    bills: Number(r.bills),
    taxable: r2(Number(r.taxable)),
    tax: r2(Number(r.tax)),
    total: r2(Number(r.total)),
  }));
  const totals = {
    vendors: list.length,
    bills: list.reduce((s, r) => s + r.bills, 0),
    taxable: r2(list.reduce((s, r) => s + r.taxable, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
  };
  res.json({ rows: list, totals });
});

// ── Purchases by material ────────────────────────────────────────────────────
// LBAC: purchases are Head Office only.
router.get("/reports/purchases-by-material", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const pmEmp = (req as any).employee as { branchType: string } | undefined;
  if (pmEmp && pmEmp.branchType !== 'headoffice') {
    res.json({ rows: [], totals: { materials: 0, taxable: 0, tax: 0, total: 0 } }); return;
  }

  const { rows } = await pool.query<any>(
    `SELECT li->>'materialType' AS material_type,
            (li->>'materialId')::int AS material_id,
            SUM(COALESCE((li->>'quantity')::numeric,0))      AS qty,
            SUM(COALESCE((li->>'taxableValue')::numeric,0))  AS taxable,
            SUM(COALESCE((li->>'taxAmount')::numeric,0))     AS tax,
            SUM(COALESCE((li->>'lineTotal')::numeric,0))     AS total,
            COUNT(DISTINCT p.id) AS bills
     FROM purchases p, jsonb_array_elements(p.line_items) li
     WHERE p.branch_transfer_id IS NULL AND p.cancelled_at IS NULL
       AND ($1 = '' OR p.purchase_date >= $1::date)
       AND ($2 = '' OR p.purchase_date <= $2::date)
     GROUP BY 1, 2 ORDER BY 6 DESC NULLS LAST`,
    [range.from, range.to],
  );
  const maps = await materialNameMaps();
  const typeLabel: Record<string, string> = { material: "Raw Material", raw_material: "Packing Material", item: "Item Name (SKU)" };
  const list = rows.map((r: any) => {
    const info = maps[String(r.material_type)]?.get(Number(r.material_id));
    return {
      materialType: String(r.material_type),
      materialTypeLabel: typeLabel[String(r.material_type)] ?? String(r.material_type),
      materialId: Number(r.material_id),
      materialName: info?.name ?? `${typeLabel[String(r.material_type)] ?? "Material"} #${r.material_id}`,
      unit: info?.unit ?? "",
      bills: Number(r.bills),
      qty: r3(Number(r.qty)),
      taxable: r2(Number(r.taxable)),
      tax: r2(Number(r.tax)),
      total: r2(Number(r.total)),
    };
  });
  const totals = {
    materials: list.length,
    taxable: r2(list.reduce((s, r) => s + r.taxable, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
  };
  res.json({ rows: list, totals });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROFITABILITY
// ═════════════════════════════════════════════════════════════════════════════
//
// Revenue  = ex-tax line subtotal.
// COGS     = Σ batchBreakdown(qty × unitCost); any un-tracked remainder is
//            costed at the item's moving average cost (fallback: standard cost).
router.get("/reports/profitability", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const groupBy = typeof req.query.groupBy === "string" ? req.query.groupBy : "item";
  if (!["item", "location"].includes(groupBy)) {
    res.status(400).json({ error: "groupBy must be item or location" }); return;
  }

  const { getUserDataScope: getScope4, scopeSalesWhere: sScope4 } = await import("../lib/dataScope");
  const emp4 = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope4 = emp4 ? await getScope4(emp4) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const profitParams: any[] = [range.from, range.to];
  const profitScopeCond = sScope4(scope4, profitParams);

  const { rows: sales } = await pool.query<any>(
    `SELECT s.id, COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id, s.line_items
     FROM sales s
     WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
       AND ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ${profitScopeCond}`,
    profitParams,
  );
  const { rows: items } = await pool.query<any>(
    `SELECT id, name, COALESCE(unit,'') AS unit,
            COALESCE(avg_cost, cost, 0) AS fallback_cost
     FROM items`,
  );
  const iMap = new Map<number, { name: string; unit: string; cost: number }>(items.map((i: any) => [Number(i.id), { name: String(i.name), unit: String(i.unit), cost: Number(i.fallback_cost) }]));
  const maps = groupBy === "location" ? await locationMaps() : null;

  type Agg = { key: string; label: string; unit: string; qty: number; revenue: number; cogs: number; untrackedQty: number };
  const agg = new Map<string, Agg>();

  for (const s of sales) {
    const lineItems: any[] = Array.isArray(s.line_items) ? s.line_items : [];
    for (const li of lineItems) {
      const itemId = Number(li.itemId);
      const qty = Number(li.quantity) || 0;
      const revenue = Number(li.lineSubtotal) || 0;
      const info = iMap.get(itemId);

      const bb: any[] = Array.isArray(li.batchBreakdown) ? li.batchBreakdown : [];
      let trackedQty = 0;
      let cogs = 0;
      for (const b of bb) {
        const bq = Number(b.quantity) || 0;
        trackedQty += bq;
        cogs += bq * (Number(b.unitCost) || 0);
      }
      const untracked = Math.max(0, qty - trackedQty);
      cogs += untracked * (info?.cost ?? 0);

      const key = groupBy === "item"
        ? `i${itemId}`
        : `${s.location_type}:${s.location_id}`;
      const label = groupBy === "item"
        ? (info?.name ?? `Item #${itemId}`)
        : locName(maps!, String(s.location_type), Number(s.location_id));
      const unit = groupBy === "item" ? (info?.unit ?? "") : "";

      const a = agg.get(key) ?? { key, label, unit, qty: 0, revenue: 0, cogs: 0, untrackedQty: 0 };
      a.qty += qty;
      a.revenue += revenue;
      a.cogs += cogs;
      a.untrackedQty += untracked;
      agg.set(key, a);
    }
  }

  const list = [...agg.values()]
    .map((a) => ({
      label: a.label,
      unit: a.unit,
      qty: r3(a.qty),
      revenue: r2(a.revenue),
      cogs: r2(a.cogs),
      grossProfit: r2(a.revenue - a.cogs),
      marginPct: a.revenue > 0 ? r2(((a.revenue - a.cogs) / a.revenue) * 100) : 0,
      estimatedCostQty: r3(a.untrackedQty),
    }))
    .sort((x, y) => y.revenue - x.revenue);

  const totals = {
    revenue: r2(list.reduce((s, r) => s + r.revenue, 0)),
    cogs: r2(list.reduce((s, r) => s + r.cogs, 0)),
    grossProfit: r2(list.reduce((s, r) => s + r.grossProfit, 0)),
    marginPct: 0 as number,
  };
  totals.marginPct = totals.revenue > 0 ? r2((totals.grossProfit / totals.revenue) * 100) : 0;
  // Basis declaration: this report costs each sale line at its actual issued
  // batch cost (moving-average / standard-cost fallback for any untracked
  // remainder) — a PERPETUAL, per-item COGS. This is deliberately a different
  // gross-profit basis from the Profit & Loss statement, which uses the
  // PERIODIC method (opening stock + purchases − closing stock). The two will
  // not match by construction; neither is wrong.
  res.json({
    groupBy,
    basis: "perpetual-per-item",
    basisLabel: "Perpetual (per-item batch COGS)",
    reconciliationNote:
      "Gross profit here is computed per item from the actual batch cost of goods sold (perpetual method). The Profit & Loss statement instead derives gross profit from opening stock + purchases − closing stock (periodic method), so the two gross-profit figures are legitimately different and will not tie out.",
    rows: list,
    totals,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// COMBINED SALES & STOCK SUMMARY (management handout)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/reports/sales-stock-combined", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { getUserDataScope: getScope5, scopeSalesWhere: sScope5 } = await import("../lib/dataScope");
  const emp5 = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope5 = emp5 ? await getScope5(emp5) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };

  const aggParams: any[] = [range.from, range.to];
  const aggScope = sScope5(scope5, aggParams);
  const locParams: any[] = [range.from, range.to];
  const locScope = sScope5(scope5, locParams);
  const topParams: any[] = [range.from, range.to];
  const topScope = sScope5(scope5, topParams);

  const [salesAgg, byLoc, topItems, stockRows, maps] = await Promise.all([
    pool.query<any>(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total_amount),0) AS revenue,
              COALESCE(SUM(COALESCE(tax_total,0)),0) AS tax,
              COALESCE(SUM(COALESCE(amount_paid,0)),0) AS collected,
              -- Not revenue − collected: that ignores credit notes. Sum the
              -- shared per-invoice outstanding so this agrees with every other
              -- surface.
              COALESCE(SUM(${outstandingExpr("s")}),0) AS outstanding
       FROM sales s
       WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
         AND ($1 = '' OR s.sale_date >= $1::date) AND ($2 = '' OR s.sale_date <= $2::date)
         AND ${aggScope}`,
      aggParams,
    ),
    pool.query<any>(
      // Aliased `s` because scopeSalesWhere() emits `s.`-qualified columns.
      // Head-office callers never noticed: their scope fragment is a constant
      // TRUE, so the alias is only referenced for the branch users it restricts.
      `SELECT COALESCE(s.location_type,'outlet') AS location_type,
              COALESCE(s.location_id, s.outlet_id) AS location_id,
              COUNT(*) AS invoices, SUM(s.total_amount) AS revenue
       FROM sales s
       WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
         AND ($1 = '' OR s.sale_date >= $1::date) AND ($2 = '' OR s.sale_date <= $2::date)
         AND ${locScope}
       GROUP BY 1, 2 ORDER BY 4 DESC NULLS LAST`,
      locParams,
    ),
    pool.query<any>(
      `SELECT (li->>'itemId')::int AS item_id,
              SUM(COALESCE((li->>'quantity')::numeric,0)) AS qty,
              SUM(COALESCE((li->>'lineTotal')::numeric,
                           COALESCE((li->>'lineSubtotal')::numeric,0) + COALESCE((li->>'taxAmount')::numeric,0))) AS revenue
       FROM sales s, jsonb_array_elements(s.line_items) li
       WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL
         AND ($1 = '' OR s.sale_date >= $1::date) AND ($2 = '' OR s.sale_date <= $2::date)
         AND ${topScope}
       GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 10`,
      topParams,
    ),
    pool.query<any>(
      `SELECT se.branch_type, se.branch_id,
              COUNT(*) FILTER (WHERE se.quantity > 0) AS skus,
              COALESCE(SUM(se.quantity),0) AS total_qty,
              COALESCE(SUM(se.quantity * COALESCE(i.avg_cost, i.cost, 0)),0) AS stock_value
       FROM stock_entries se
       JOIN items i ON i.id = se.item_id
       WHERE se.material_type = 'item'
       GROUP BY 1, 2 ORDER BY 5 DESC`,
    ),
    locationMaps(),
  ]);

  const { rows: items } = await pool.query<any>(`SELECT id, name, COALESCE(unit,'') AS unit FROM items`);
  const iMap = new Map<number, { name: string; unit: string }>(items.map((i: any) => [Number(i.id), { name: String(i.name), unit: String(i.unit) }]));

  const s0 = salesAgg.rows[0] ?? {};
  const revenue = Number(s0.revenue ?? 0);
  const collected = Number(s0.collected ?? 0);
  const outstanding = Number(s0.outstanding ?? 0);

  // This report pairs sales with stock, so it carries the same closing value as
  // the valuation report. Reaching it needs only the Reports right, which is a
  // weaker key than the one guarding that report — so the money half is dropped
  // for anyone who lacks the valuation right. Quantities and sales are untouched.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  res.json({
    period: { from: range.from || null, to: range.to || null },
    sales: {
      invoices: Number(s0.invoices ?? 0),
      revenue: r2(revenue),
      tax: r2(Number(s0.tax ?? 0)),
      collected: r2(collected),
      outstanding: r2(outstanding),
    },
    salesByLocation: byLoc.rows.map((r: any) => ({
      locationType: r.location_type,
      locationName: locName(maps, r.location_type, Number(r.location_id)),
      invoices: Number(r.invoices),
      revenue: r2(Number(r.revenue)),
    })),
    topItems: topItems.rows.map((r: any) => {
      const info = iMap.get(Number(r.item_id));
      return {
        itemName: info?.name ?? `Item #${r.item_id}`,
        unit: info?.unit ?? "",
        qty: r3(Number(r.qty)),
        revenue: r2(Number(r.revenue)),
      };
    }),
    stockByLocation: stockRows.rows.map((r: any) => {
      const row: Record<string, unknown> = {
        locationType: r.branch_type,
        locationName: locName(maps, r.branch_type, Number(r.branch_id)),
        skus: Number(r.skus),
        totalQty: r3(Number(r.total_qty)),
      };
      if (showValuation) row.stockValue = r2(Number(r.stock_value));
      return row;
    }),
    ...(showValuation
      ? { stockValueTotal: r2(stockRows.rows.reduce((s: number, r: any) => s + Number(r.stock_value), 0)) }
      : {}),
    canViewValuation: showValuation,
  });
});

// ── GST Transfers — cross-GSTIN stock movements that are taxable supplies ────
//
// Transfers between two of the company's own GSTINs are supplies under GST and
// carry a real tax invoice, so they belong in GSTR-1 — but they are not sales.
// This is the one report where both figures sit side by side, precisely because
// everywhere else they must never be mixed: Customer Sales is what the business
// earned, Branch Transfer Sales is stock moved between its own registrations,
// and only the two together reconcile to the outward supplies in the return.
router.get("/reports/gst-transfers", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.status(403).json({ error: "GST reporting is available at Head Office only" });
    return;
  }
  const range = parseRange(req);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return; }

  const [{ rows: transfers }, { rows: [cust] }, maps] = await Promise.all([
    // Driven from the transfer, not from `sales`, so a transfer still in transit
    // or since rejected is visible with its document — an invoice raised and
    // then credited is exactly what a reviewer needs to see.
    pool.query<any>(
      `SELECT t.id, t.challan_number, t.transfer_date, t.status,
              t.from_type, t.from_id, t.to_type, t.to_id,
              t.from_gstin, t.to_gstin, t.transfer_type, t.tax_type,
              COALESCE(t.transfer_value, 0) AS taxable,
              COALESCE(t.gst_amount, 0)     AS tax,
              t.transfer_invoice_number, t.sale_id, t.purchase_id, t.credit_note_voucher_id,
              t.document_mode,
              s.cancelled_at
         FROM stock_transfers t
         LEFT JOIN sales s ON s.id = t.sale_id
        -- EVERY cross-GSTIN transfer, invoiced or not. A taxable movement that
        -- carries no invoice is the one thing a reviewer most needs to see, so
        -- it is listed and quantified rather than filtered out.
        WHERE COALESCE(t.transfer_type, 'internal') <> 'internal'
          AND ($1 = '' OR t.transfer_date >= $1::date)
          AND ($2 = '' OR t.transfer_date <= $2::date)
        ORDER BY t.transfer_date DESC, t.id DESC`,
      [range.from, range.to],
    ),
    pool.query<any>(
      `SELECT COUNT(*) AS invoices,
              COALESCE(SUM(COALESCE(subtotal, 0)), 0)  AS taxable,
              COALESCE(SUM(COALESCE(tax_total, 0)), 0) AS tax,
              COALESCE(SUM(total_amount), 0)           AS total
         FROM sales
        WHERE branch_transfer_id IS NULL AND cancelled_at IS NULL
          AND ($1 = '' OR sale_date >= $1::date)
          AND ($2 = '' OR sale_date <= $2::date)`,
      [range.from, range.to],
    ),
    locationMaps(),
  ]);

  const rows = transfers.map((t: any) => {
    const taxable = r2(Number(t.taxable));
    const tax = r2(Number(t.tax));
    const half = r2(tax / 2);
    return {
      id: Number(t.id),
      challanNumber: t.challan_number,
      invoiceNumber: t.transfer_invoice_number ?? null,
      date: t.transfer_date,
      status: t.status,
      fromName: locName(maps, t.from_type, Number(t.from_id)),
      toName: locName(maps, t.to_type, Number(t.to_id)),
      fromGstin: t.from_gstin ?? "",
      toGstin: t.to_gstin ?? "",
      supplyType: t.transfer_type === 'interstate' ? 'Inter-State' : 'Intra-State',
      taxType: t.tax_type ?? 'none',
      taxable,
      cgst: t.tax_type === 'cgst_sgst' ? half : 0,
      sgst: t.tax_type === 'cgst_sgst' ? r2(tax - half) : 0,
      igst: t.tax_type === 'igst' ? tax : 0,
      tax,
      total: r2(taxable + tax),
      // A credited invoice is reported so nobody wonders where the number went;
      // it is excluded from the totals below because the credit note reversed it.
      creditNoted: t.credit_note_voucher_id != null || t.cancelled_at != null,
      inwardBooked: t.purchase_id != null,
      // Transfers that moved under the old voucher treatment (or with invoicing
      // switched off) are taxable supplies with no invoice behind them. They
      // cannot be added to the GST figures, so they are counted separately.
      invoiced: String(t.document_mode ?? 'voucher') === 'invoice' && t.transfer_invoice_number != null,
    };
  });

  const invoiced = rows.filter(r => r.invoiced);
  const live = invoiced.filter(r => !r.creditNoted);
  const sum = (f: (r: typeof rows[number]) => number) => r2(live.reduce((a, r) => a + f(r), 0));
  const branchTransfer = {
    invoices: live.length,
    taxable: sum(r => r.taxable),
    cgst: sum(r => r.cgst),
    sgst: sum(r => r.sgst),
    igst: sum(r => r.igst),
    tax: sum(r => r.tax),
    total: sum(r => r.total),
  };
  const uninvoiced = rows.filter(r => !r.invoiced);
  const notInvoiced = {
    transfers: uninvoiced.length,
    taxable: r2(uninvoiced.reduce((a, r) => a + r.taxable, 0)),
    tax: r2(uninvoiced.reduce((a, r) => a + r.tax, 0)),
    total: r2(uninvoiced.reduce((a, r) => a + r.total, 0)),
  };
  const customerSales = {
    invoices: Number(cust?.invoices ?? 0),
    taxable: r2(Number(cust?.taxable ?? 0)),
    tax: r2(Number(cust?.tax ?? 0)),
    total: r2(Number(cust?.total ?? 0)),
  };

  res.json({
    from: range.from, to: range.to,
    customerSales,
    branchTransfer,
    combined: {
      taxable: r2(customerSales.taxable + branchTransfer.taxable),
      tax: r2(customerSales.tax + branchTransfer.tax),
      total: r2(customerSales.total + branchTransfer.total),
    },
    creditNoted: {
      invoices: invoiced.length - live.length,
      total: r2(invoiced.filter(r => r.creditNoted).reduce((a, r) => a + r.total, 0)),
    },
    notInvoiced,
    rows,
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANCH TRANSFERS (stock transfers between the company's own locations)
// ═════════════════════════════════════════════════════════════════════════════
//
// Read-only. One row per transfer LINE, so item / batch / quantity are
// meaningful instead of a challan-level lump.
//
// Terminology: the sending side is "Transfer Out", the receiving side is
// "Transfer In". Operationally they behave like a sale and a purchase, but a
// transfer is neither: no revenue is earned and nothing is bought, so the
// figures here never join the sales or purchase totals.
//
// Location scope is enforced in SQL by scopeTransferWhere — a transfer is
// visible only when one of the caller's own locations is its source and/or its
// destination. The sourceType/sourceId and destType/destId query params can
// only NARROW that set; asking for somebody else's location returns nothing.
router.get("/reports/branch-transfers", requireModuleView("page:/reports/sales"), async (req, res): Promise<void> => {
  const q = req.query as Record<string, unknown>;
  const fromDate = typeof q.fromDate === "string" ? q.fromDate : "";
  const toDate = typeof q.toDate === "string" ? q.toDate : "";
  if ((fromDate && !isIsoDate(fromDate)) || (toDate && !isIsoDate(toDate))) {
    res.status(400).json({ error: "fromDate/toDate must be YYYY-MM-DD dates" }); return;
  }

  const LOC_TYPES = ["warehouse", "outlet"];
  const sourceType = typeof q.sourceType === "string" ? q.sourceType : "";
  const destType = typeof q.destType === "string" ? q.destType : "";
  if ((sourceType && !LOC_TYPES.includes(sourceType)) || (destType && !LOC_TYPES.includes(destType))) {
    res.status(400).json({ error: "sourceType/destType must be warehouse or outlet" }); return;
  }
  const intParam = (v: unknown): number | null => {
    if (typeof v !== "string" || v === "") return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const sourceId = intParam(q.sourceId);
  const destId = intParam(q.destId);
  const itemId = intParam(q.itemId);
  if (sourceId === null || destId === null || itemId === null) {
    res.status(400).json({ error: "sourceId/destId/itemId must be non-negative integers" }); return;
  }

  // Ids OVERLAP across the three product tables — item #7, material #7 and
  // packing material #7 are different products. Filtering on the id alone
  // therefore matches lines of the wrong kind, so the filter is compound and
  // the caller may pin the kind alongside the id.
  const MATERIAL_TYPES = ["item", "material", "raw_material"];
  const materialTypeFilter = typeof q.materialType === "string" ? q.materialType : "";
  if (materialTypeFilter && !MATERIAL_TYPES.includes(materialTypeFilter)) {
    res.status(400).json({ error: "materialType must be item, material or raw_material" }); return;
  }

  // 'pending' is a legacy spelling of 'in_transit' (routes/stock.ts treats the
  // two the same), so asking for one has to return the other as well.
  const status = typeof q.status === "string" ? q.status : "";
  const STATUSES = ["in_transit", "pending", "completed", "rejected"];
  if (status && !STATUSES.includes(status)) {
    res.status(400).json({ error: "status must be in_transit, completed or rejected" }); return;
  }
  const statusList = status === "" ? [] : (status === "in_transit" || status === "pending") ? ["in_transit", "pending"] : [status];

  const { getUserDataScope: btScope, scopeTransferWhere: btWhere, isLocationInScope: btInScope } =
    await import("../lib/dataScope");
  const btEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope = btEmp ? await btScope(btEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };

  const params: unknown[] = [fromDate, toDate, sourceType, sourceId, destType, destId, statusList, itemId, materialTypeFilter];
  // The alias below MUST be the alias used in the query, or the fragment would
  // reference a relation that isn't there and the scope would silently break.
  const scopeCond = btWhere(scope, params, "t");

  const { rows: transfers } = await pool.query<any>(
    `SELECT t.id, t.challan_number,
            to_char(t.transfer_date,'YYYY-MM-DD')        AS transfer_date,
            t.from_type, t.from_id, t.to_type, t.to_id,
            t.line_items, t.received_line_items, t.status,
            -- There is no dispatch timestamp column: the row is written at
            -- dispatch, so created_at IS the dispatch moment. Receipt is
            -- stamped by the approve transition.
            to_char(t.created_at,'YYYY-MM-DD')           AS dispatch_date,
            to_char(t.approved_at,'YYYY-MM-DD')          AS received_date,
            t.approved_by, e.name                        AS handled_by_name
       FROM stock_transfers t
       LEFT JOIN LATERAL (
         SELECT emp.name FROM employees emp
          WHERE t.approved_by IS NOT NULL
            AND (emp.username = t.approved_by OR emp.name = t.approved_by)
          ORDER BY emp.id LIMIT 1
       ) e ON TRUE
      WHERE ($1 = '' OR t.transfer_date >= $1::date)
        AND ($2 = '' OR t.transfer_date <= $2::date)
        AND ($3 = '' OR t.from_type = $3)
        AND ($4 = 0  OR t.from_id = $4)
        AND ($5 = '' OR t.to_type = $5)
        AND ($6 = 0  OR t.to_id = $6)
        AND (cardinality($7::text[]) = 0 OR t.status = ANY($7::text[]))
        -- line_items is free-form JSON written by the transfer routes. A blind
        -- ::int cast on a value that isn't numeric aborts the whole query, so
        -- the cast is guarded by CASE (which has defined evaluation order)
        -- rather than by AND, and a junk id simply fails to match.
        AND ($8 = 0 OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(t.line_items,'[]'::jsonb)) fli
               WHERE CASE WHEN jsonb_typeof(fli->'itemId') = 'number' THEN (fli->>'itemId')::int
                          WHEN fli->>'itemId' ~ '^[0-9]+$'            THEN (fli->>'itemId')::int
                          ELSE NULL END = $8
                 AND ($9 = '' OR COALESCE(fli->>'materialType', 'item') = $9)))
        AND ($9 = '' OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(t.line_items,'[]'::jsonb)) mli
               WHERE COALESCE(mli->>'materialType', 'item') = $9))
        AND ${scopeCond}
      ORDER BY t.transfer_date DESC, t.id DESC`,
    params,
  );

  const [maps, nameMaps] = await Promise.all([locationMaps(), materialNameMaps()]);
  // Ids OVERLAP between items / materials / raw_materials, so a line's name and
  // UOM are only correct when resolved through its own materialType.
  const resolve = (materialType: string, id: number) => nameMaps[materialType]?.get(id);
  const TYPE_LABEL: Record<string, string> = { item: "Item (SKU)", material: "Raw Material", raw_material: "Packing Material" };

  interface Row {
    transferId: number; challanNumber: string; transferDate: string;
    sourceType: string; sourceId: number; sourceName: string;
    destType: string; destId: number; destName: string;
    itemId: number; itemName: string; materialType: string; materialTypeLabel: string;
    batchNumbers: string[]; quantity: number; unit: string; unitCost: number; lineValue: number;
    status: string; quantityBasis: "received" | "dispatched";
    dispatchDate: string | null; receivedDate: string | null;
    handledBy: string | null;
    /** No dispatcher is recorded anywhere on the transfer — there is no column
     *  for it. Reported as null rather than guessed from approved_by. */
    dispatchedBy: null;
  }

  const rows: Row[] = [];
  const summary = {
    transferOut: { qty: 0, value: 0, transfers: 0 },
    transferIn: { qty: 0, value: 0, transfers: 0 },
    inTransit: { qty: 0, value: 0, transfers: 0 },
  };

  for (const t of transfers) {
    const statusRaw = String(t.status ?? "");
    const isCompleted = statusRaw === "completed";
    const isInTransit = statusRaw === "in_transit" || statusRaw === "pending";
    const dispatched: any[] = Array.isArray(t.line_items) ? t.line_items : [];
    const received: any[] = Array.isArray(t.received_line_items) ? t.received_line_items : [];

    // A completed transfer is reported at what actually ARRIVED. Received lines
    // are keyed on (materialType, itemId) because the three id spaces overlap.
    //
    // One transfer may carry SEVERAL dispatched lines for the same product —
    // different batches of the same SKU, for instance. Holding one received
    // line per product and reading it back for each of those dispatched lines
    // would report the same arrival two or three times over. Received
    // quantities are therefore pooled per product and drawn down across the
    // dispatched lines in order, so the report can never exceed what the
    // receiver actually recorded.
    const receivedPool = new Map<string, { qty: number; costPrice: number | null }>();
    for (const rl of received) {
      const k = `${String(rl?.materialType ?? "item")}:${Number(rl?.itemId)}`;
      const cur = receivedPool.get(k) ?? { qty: 0, costPrice: null };
      cur.qty += Number(rl?.quantity ?? 0);
      if (cur.costPrice === null && rl?.costPrice != null) cur.costPrice = Number(rl.costPrice);
      receivedPool.set(k, cur);
    }
    const lastRowIndexByKey = new Map<string, number>();

    let tQty = 0, tValue = 0;

    for (const li of dispatched) {
      const lineItemId = Number(li?.itemId);
      const materialType = String(li?.materialType ?? "item");
      if (itemId !== 0 && lineItemId !== itemId) continue;
      if (materialTypeFilter !== "" && materialType !== materialTypeFilter) continue;

      const poolKey = `${materialType}:${lineItemId}`;
      const rpool = isCompleted ? receivedPool.get(poolKey) : undefined;
      const useReceived = Boolean(rpool);
      const dispatchedQty = Number(li?.quantity ?? 0);
      let quantity: number;
      if (rpool) {
        const take = Math.min(rpool.qty, dispatchedQty);
        rpool.qty = r3(rpool.qty - take);
        quantity = r3(take);
      } else {
        quantity = r3(dispatchedQty);
      }
      const unitCost = r2(Number((useReceived ? (rpool!.costPrice ?? li?.costPrice) : li?.costPrice) ?? 0));
      const info = resolve(materialType, lineItemId);
      const bb: any[] = Array.isArray(li?.batchBreakdown) ? li.batchBreakdown : [];

      const lineValue = r2(quantity * unitCost);
      tQty += quantity;
      tValue += lineValue;

      lastRowIndexByKey.set(poolKey, rows.length);
      rows.push({
        transferId: Number(t.id),
        challanNumber: t.challan_number ?? `#${t.id}`,
        transferDate: t.transfer_date,
        sourceType: String(t.from_type),
        sourceId: Number(t.from_id),
        sourceName: locName(maps, String(t.from_type), Number(t.from_id)),
        destType: String(t.to_type),
        destId: Number(t.to_id),
        destName: locName(maps, String(t.to_type), Number(t.to_id)),
        itemId: lineItemId,
        itemName: info?.name ?? `${TYPE_LABEL[materialType] ?? "Product"} #${lineItemId}`,
        materialType,
        materialTypeLabel: TYPE_LABEL[materialType] ?? materialType,
        batchNumbers: bb.map((b) => String(b?.batchNumber ?? "")).filter(Boolean),
        quantity,
        unit: info?.unit ?? "",
        unitCost,
        lineValue,
        status: statusRaw,
        quantityBasis: useReceived ? "received" : "dispatched",
        dispatchDate: t.dispatch_date ?? null,
        receivedDate: t.received_date ?? null,
        handledBy: t.handled_by_name ?? t.approved_by ?? null,
        dispatchedBy: null,
      });
    }

    // If MORE arrived than was dispatched, the surplus is still sitting in the
    // pool after every dispatched line has drawn from it. Dropping it would
    // under-report the receipt, so it is attached to that product's last line.
    if (isCompleted) {
      for (const [k, rpool] of receivedPool) {
        if (rpool.qty <= 0) continue;
        const idx = lastRowIndexByKey.get(k);
        if (idx === undefined) continue;      // product filtered out of this run
        const row = rows[idx]!;
        row.quantity = r3(row.quantity + rpool.qty);
        const newValue = r2(row.quantity * row.unitCost);
        tQty += rpool.qty;
        tValue += newValue - row.lineValue;
        row.lineValue = newValue;
        rpool.qty = 0;
      }
    }

    // Only COMPLETED movements count as Transfer Out / Transfer In. Goods still
    // on the road are a separate figure — folding them in would report stock as
    // delivered before anybody received it.
    const sourceMine = btInScope(scope, String(t.from_type), Number(t.from_id));
    const destMine = btInScope(scope, String(t.to_type), Number(t.to_id));
    if (isCompleted) {
      if (sourceMine) { summary.transferOut.qty += tQty; summary.transferOut.value += tValue; summary.transferOut.transfers += 1; }
      if (destMine) { summary.transferIn.qty += tQty; summary.transferIn.value += tValue; summary.transferIn.transfers += 1; }
    } else if (isInTransit) {
      summary.inTransit.qty += tQty; summary.inTransit.value += tValue; summary.inTransit.transfers += 1;
    }
  }

  for (const k of ["transferOut", "transferIn", "inTransit"] as const) {
    summary[k].qty = r3(summary[k].qty);
    summary[k].value = r2(summary[k].value);
  }

  const totals = {
    lines: rows.length,
    transfers: new Set(rows.map((r) => r.transferId)).size,
    qty: r3(rows.reduce((s, r) => s + r.quantity, 0)),
    value: r2(rows.reduce((s, r) => s + r.lineValue, 0)),
  };

  // Same rule as the Stock page: what a transfer's contents COST is withheld
  // from roles without the valuation right. Quantities, batches, routes and
  // dates — everything operational — stay. The figures are still computed
  // above because the report's own arithmetic depends on them; only what is
  // serialised changes.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);
  const outRows = showValuation ? rows : rows.map(({ unitCost, lineValue, ...rest }) => rest);
  const outTotals = showValuation ? totals : { lines: totals.lines, transfers: totals.transfers, qty: totals.qty };
  const outSummary = showValuation
    ? summary
    : {
        transferOut: { qty: summary.transferOut.qty, transfers: summary.transferOut.transfers },
        transferIn: { qty: summary.transferIn.qty, transfers: summary.transferIn.transfers },
        inTransit: { qty: summary.inTransit.qty, transfers: summary.inTransit.transfers },
      };

  res.json({
    rows: outRows,
    totals: outTotals,
    summary: outSummary,
    canViewValuation: showValuation,
    scope: { isHeadOffice: scope.isHeadOffice },
    basisNote:
      "Completed transfers are reported at received quantities where the receiver recorded them, otherwise at dispatched quantities; in-transit transfers are always at dispatched quantities. Transfer Out and Transfer In count completed transfers only — goods still in transit are reported separately and never folded into either total.",
  });
});

export default router;

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
import { requireModuleView } from "../middleware/permissions";

const router = Router();

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) return null;
  return { from, to };
}

// ── Location name maps (outlet / warehouse / production) ────────────────────
type LocMaps = Record<string, Map<number, string>>;
async function locationMaps(): Promise<LocMaps> {
  const [o, w, p] = await Promise.all([
    pool.query<any>(`SELECT id, name FROM outlets`),
    pool.query<any>(`SELECT id, name FROM warehouses`),
    pool.query<any>(`SELECT id, name FROM production_units`).catch(() => ({ rows: [] as any[] })),
  ]);
  return {
    outlet: new Map(o.rows.map((r: any) => [Number(r.id), String(r.name)])),
    warehouse: new Map(w.rows.map((r: any) => [Number(r.id), String(r.name)])),
    production: new Map(p.rows.map((r: any) => [Number(r.id), String(r.name)])),
  };
}
function locName(maps: LocMaps, type: string, id: number): string {
  const t = type === "production_unit" ? "production" : type;
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
router.get("/reports/sales-register", requireModuleView("Sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const locationType = typeof req.query.locationType === "string" ? req.query.locationType : "";
  const locationId = typeof req.query.locationId === "string" ? parseInt(req.query.locationId, 10) : 0;
  if (locationType && !["outlet", "warehouse", "production"].includes(locationType)) {
    res.status(400).json({ error: "locationType must be outlet, warehouse or production" }); return;
  }

  const { rows } = await pool.query<any>(
    `SELECT s.id, s.invoice_number, to_char(s.sale_date,'YYYY-MM-DD') AS sale_date,
            COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            s.customer_id, c.name AS customer_name,
            COALESCE(s.subtotal,0) AS subtotal, COALESCE(s.discount_total,0) AS discount_total,
            COALESCE(s.tax_total,0) AS tax_total, s.total_amount,
            COALESCE(s.amount_paid,0) AS amount_paid,
            COALESCE(s.payment_mode,'cash') AS payment_mode,
            COALESCE(s.payment_status,'pending') AS payment_status
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
       AND ($3 = '' OR COALESCE(s.location_type,'outlet') = $3)
       AND ($4 = 0 OR COALESCE(s.location_id, s.outlet_id) = $4)
     ORDER BY s.sale_date, s.id`,
    [range.from, range.to, locationType, Number.isFinite(locationId) ? locationId : 0],
  );
  const maps = await locationMaps();

  const list = rows.map((r: any) => ({
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
    paid: r2(Number(r.amount_paid)),
    balance: r2(Number(r.total_amount) - Number(r.amount_paid)),
    paymentMode: r.payment_mode,
    paymentStatus: r.payment_status,
  }));

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
router.get("/reports/sales-by-item", requireModuleView("Sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { rows } = await pool.query<any>(
    `SELECT (li->>'itemId')::int AS item_id,
            SUM(COALESCE((li->>'quantity')::numeric,0))     AS qty,
            SUM(COALESCE((li->>'lineSubtotal')::numeric,0)) AS taxable,
            SUM(COALESCE((li->>'taxAmount')::numeric,0))    AS tax,
            SUM(COALESCE((li->>'lineTotal')::numeric,
                         COALESCE((li->>'lineSubtotal')::numeric,0) + COALESCE((li->>'taxAmount')::numeric,0))) AS total,
            COUNT(DISTINCT s.id)                            AS invoices
     FROM sales s, jsonb_array_elements(s.line_items) li
     WHERE ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
     GROUP BY 1 ORDER BY 4 DESC NULLS LAST`,
    [range.from, range.to],
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
router.get("/reports/sales-by-location", requireModuleView("Sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { rows } = await pool.query<any>(
    `SELECT COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            COUNT(*) AS invoices,
            SUM(COALESCE(s.subtotal,0)) AS taxable,
            SUM(COALESCE(s.tax_total,0)) AS tax,
            SUM(s.total_amount) AS total,
            SUM(COALESCE(s.amount_paid,0)) AS paid
     FROM sales s
     WHERE ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)
     GROUP BY 1, 2 ORDER BY 6 DESC NULLS LAST`,
    [range.from, range.to],
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
    outstanding: r2(Number(r.total) - Number(r.paid)),
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

// ═════════════════════════════════════════════════════════════════════════════
// PURCHASES
// ═════════════════════════════════════════════════════════════════════════════

// ── Purchase register — one row per bill ────────────────────────────────────
router.get("/reports/purchase-register", requireModuleView("Purchases"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const vendorId = typeof req.query.vendorId === "string" ? parseInt(req.query.vendorId, 10) : 0;

  const { rows } = await pool.query<any>(
    `SELECT p.id, p.invoice_number, to_char(p.purchase_date,'YYYY-MM-DD') AS purchase_date,
            p.vendor_id, v.name AS vendor_name,
            (p.total_amount - COALESCE(p.round_off,0) - COALESCE(p.tax_total,0) + COALESCE(p.discount_total,0)) AS subtotal,
            COALESCE(p.discount_total,0) AS discount_total,
            COALESCE(p.tax_total,0) AS tax_total, p.total_amount
     FROM purchases p
     LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE ($1 = '' OR p.purchase_date >= $1::date)
       AND ($2 = '' OR p.purchase_date <= $2::date)
       AND ($3 = 0 OR p.vendor_id = $3)
     ORDER BY p.purchase_date, p.id`,
    [range.from, range.to, Number.isFinite(vendorId) ? vendorId : 0],
  );
  const list = rows.map((r: any) => ({
    id: Number(r.id),
    billNumber: r.invoice_number ?? `#${r.id}`,
    date: r.purchase_date,
    vendorId: r.vendor_id == null ? null : Number(r.vendor_id),
    vendorName: r.vendor_name ?? "—",
    subtotal: r2(Number(r.subtotal)),
    discount: r2(Number(r.discount_total)),
    tax: r2(Number(r.tax_total)),
    total: r2(Number(r.total_amount)),
  }));
  const totals = {
    bills: list.length,
    subtotal: r2(list.reduce((s, r) => s + r.subtotal, 0)),
    discount: r2(list.reduce((s, r) => s + r.discount, 0)),
    tax: r2(list.reduce((s, r) => s + r.tax, 0)),
    total: r2(list.reduce((s, r) => s + r.total, 0)),
  };
  res.json({ rows: list, totals });
});

// ── Purchases by vendor ──────────────────────────────────────────────────────
router.get("/reports/purchases-by-vendor", requireModuleView("Purchases"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { rows } = await pool.query<any>(
    `SELECT p.vendor_id, v.name AS vendor_name,
            COUNT(*) AS bills,
            SUM(p.total_amount - COALESCE(p.round_off,0) - COALESCE(p.tax_total,0) + COALESCE(p.discount_total,0)) AS taxable,
            SUM(COALESCE(p.tax_total,0)) AS tax,
            SUM(p.total_amount) AS total
     FROM purchases p
     LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE ($1 = '' OR p.purchase_date >= $1::date)
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
router.get("/reports/purchases-by-material", requireModuleView("Purchases"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const { rows } = await pool.query<any>(
    `SELECT li->>'materialType' AS material_type,
            (li->>'materialId')::int AS material_id,
            SUM(COALESCE((li->>'quantity')::numeric,0))      AS qty,
            SUM(COALESCE((li->>'taxableValue')::numeric,0))  AS taxable,
            SUM(COALESCE((li->>'taxAmount')::numeric,0))     AS tax,
            SUM(COALESCE((li->>'lineTotal')::numeric,0))     AS total,
            COUNT(DISTINCT p.id) AS bills
     FROM purchases p, jsonb_array_elements(p.line_items) li
     WHERE ($1 = '' OR p.purchase_date >= $1::date)
       AND ($2 = '' OR p.purchase_date <= $2::date)
     GROUP BY 1, 2 ORDER BY 6 DESC NULLS LAST`,
    [range.from, range.to],
  );
  const maps = await materialNameMaps();
  const typeLabel: Record<string, string> = { material: "Packaging", raw_material: "Raw material", item: "Finished good" };
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
router.get("/reports/profitability", requireModuleView("Chart of Accounts"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }
  const groupBy = typeof req.query.groupBy === "string" ? req.query.groupBy : "item";
  if (!["item", "location"].includes(groupBy)) {
    res.status(400).json({ error: "groupBy must be item or location" }); return;
  }

  const { rows: sales } = await pool.query<any>(
    `SELECT s.id, COALESCE(s.location_type,'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id, s.line_items
     FROM sales s
     WHERE ($1 = '' OR s.sale_date >= $1::date)
       AND ($2 = '' OR s.sale_date <= $2::date)`,
    [range.from, range.to],
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
  res.json({ groupBy, rows: list, totals });
});

// ═════════════════════════════════════════════════════════════════════════════
// COMBINED SALES & STOCK SUMMARY (management handout)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/reports/sales-stock-combined", requireModuleView("Sales"), async (req, res): Promise<void> => {
  const range = parseRange(req as any);
  if (!range) { res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" }); return; }

  const [salesAgg, byLoc, topItems, stockRows, maps] = await Promise.all([
    pool.query<any>(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total_amount),0) AS revenue,
              COALESCE(SUM(COALESCE(tax_total,0)),0) AS tax,
              COALESCE(SUM(COALESCE(amount_paid,0)),0) AS collected
       FROM sales
       WHERE ($1 = '' OR sale_date >= $1::date) AND ($2 = '' OR sale_date <= $2::date)`,
      [range.from, range.to],
    ),
    pool.query<any>(
      `SELECT COALESCE(location_type,'outlet') AS location_type,
              COALESCE(location_id, outlet_id) AS location_id,
              COUNT(*) AS invoices, SUM(total_amount) AS revenue
       FROM sales
       WHERE ($1 = '' OR sale_date >= $1::date) AND ($2 = '' OR sale_date <= $2::date)
       GROUP BY 1, 2 ORDER BY 4 DESC NULLS LAST`,
      [range.from, range.to],
    ),
    pool.query<any>(
      `SELECT (li->>'itemId')::int AS item_id,
              SUM(COALESCE((li->>'quantity')::numeric,0)) AS qty,
              SUM(COALESCE((li->>'lineTotal')::numeric,
                           COALESCE((li->>'lineSubtotal')::numeric,0) + COALESCE((li->>'taxAmount')::numeric,0))) AS revenue
       FROM sales s, jsonb_array_elements(s.line_items) li
       WHERE ($1 = '' OR s.sale_date >= $1::date) AND ($2 = '' OR s.sale_date <= $2::date)
       GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 10`,
      [range.from, range.to],
    ),
    pool.query<any>(
      `SELECT se.branch_type, se.branch_id,
              COUNT(*) FILTER (WHERE se.quantity > 0) AS skus,
              COALESCE(SUM(se.quantity),0) AS total_qty,
              COALESCE(SUM(se.quantity * COALESCE(i.avg_cost, i.cost, 0)),0) AS stock_value
       FROM stock_entries se
       JOIN items i ON i.id = se.item_id
       GROUP BY 1, 2 ORDER BY 5 DESC`,
    ),
    locationMaps(),
  ]);

  const { rows: items } = await pool.query<any>(`SELECT id, name, COALESCE(unit,'') AS unit FROM items`);
  const iMap = new Map<number, { name: string; unit: string }>(items.map((i: any) => [Number(i.id), { name: String(i.name), unit: String(i.unit) }]));

  const s0 = salesAgg.rows[0] ?? {};
  const revenue = Number(s0.revenue ?? 0);
  const collected = Number(s0.collected ?? 0);

  res.json({
    period: { from: range.from || null, to: range.to || null },
    sales: {
      invoices: Number(s0.invoices ?? 0),
      revenue: r2(revenue),
      tax: r2(Number(s0.tax ?? 0)),
      collected: r2(collected),
      outstanding: r2(revenue - collected),
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
    stockByLocation: stockRows.rows.map((r: any) => ({
      locationType: r.branch_type,
      locationName: locName(maps, r.branch_type, Number(r.branch_id)),
      skus: Number(r.skus),
      totalQty: r3(Number(r.total_qty)),
      stockValue: r2(Number(r.stock_value)),
    })),
    stockValueTotal: r2(stockRows.rows.reduce((s: number, r: any) => s + Number(r.stock_value), 0)),
  });
});

export default router;

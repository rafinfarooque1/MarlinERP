import { Router } from "express";
import { db, pool, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable, productionsTable, expensesTable } from "@workspace/db";
import { count, sum, eq, and, sql, inArray } from "drizzle-orm";
import { getUserDataScope, scopeSalesWhere, scopeBranchWhere, type DataScope } from "../lib/dataScope";
import { pushLocationFilter, type ParsedLocationFilter } from "../lib/queryFilters";
import { stockValuation } from "../lib/valuation";
import { requireModuleView, canViewStockValuation } from "../middleware/permissions";
import { buildDerivedPostings } from "./journal";
import { companyBalances, companyFinancials, rangeMoneyFlows, ledgerSubtreeLookup } from "../lib/dashboardFinancials";
import { outstandingExpr, outstandingAsOfExpr } from "../lib/salePaymentPosition";
import { isIsoDate } from "../lib/dateInput";
import { getLocationFilter, getPostingLocationFilter } from "../lib/requestLocation";

const router = Router();

/** `stock_entries` holds items, raw materials and packing materials, and those
 *  ID spaces overlap. Dashboard stock value and low-stock alerts are about
 *  finished items only — without this filter they would join material rows to
 *  unrelated items and invent both value and alerts. */
const ITEM_ROWS_ONLY = sql`stock_entries.material_type = 'item'`;

/**
 * LBAC + view scoping shared by the legacy dashboard endpoints.
 *
 * Mirrors scopeBranchWhere, but over arbitrary SQL expressions — several
 * tables carry their location in COALESCE'd raw-migration columns rather
 * than branch_type/branch_id.
 */
function scopeLocWhere(scope: DataScope, params: unknown[], typeExpr: string, idExpr: string): string {
  if (scope.isHeadOffice) return "TRUE";
  const conds: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(`(${typeExpr} = 'warehouse' AND ${idExpr} = ANY($${params.length}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(`(${typeExpr} = 'outlet' AND ${idExpr} = ANY($${params.length}::int[]))`);
  }
  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

const HO_SCOPE: DataScope = { isHeadOffice: true, warehouseIds: [], outletIds: [] } as DataScope;

/** Unconditional LBAC scope + the view-only location context, resolved once. */
async function dashboardScope(req: any): Promise<{ scope: DataScope; viewLoc: ParsedLocationFilter | null }> {
  const emp = req.employee as { branchType: string; branchId: number } | undefined;
  const scope = emp ? await getUserDataScope(emp) : HO_SCOPE;
  return { scope, viewLoc: getLocationFilter(req) };
}

router.get("/dashboard/summary", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const today = new Date().toISOString().split("T")[0];

  // Every figure below applies the caller's LBAC scope unconditionally, then
  // ANDs the global location context (a view request) on top — the same
  // two-gate rule as /dashboard/bi. A branch login sees its own slice; Head
  // Office sees the selected location's slice, or the whole company.
  const { scope, viewLoc } = await dashboardScope(req);

  // ── COA ledger-based bank & cash balances ─────────────────────────────
  // Cash and bank are read from the same derived posting stream that produces
  // the Trial Balance, the Cash Book and the Balance Sheet.
  //
  // These two tiles used to add up the `payments` and `receipts` tables on
  // their own. That is not what a cash balance is. It missed every sale
  // settled at the till — the books derive those from the sale row itself, not
  // from a receipt — and it counted the few sale receipts that do exist, which
  // the books deliberately exclude to avoid double-counting. The dashboard
  // showed cash of -125.01 on a day the Cash Book and the Balance Sheet both
  // said 29,609.90. One source now feeds all of them — and the same helper
  // feeds /dashboard/bi, so the two dashboards cannot disagree either.
  //
  // Located views read the located posting slice; a branch login is forced to
  // its own location's slice even with no selector set.
  const postingLoc = getPostingLocationFilter(req)
    ?? (!scope.isHeadOffice
      ? ({ type: (req as any).employee.branchType, id: (req as any).employee.branchId } as any)
      : null);
  // The stream is built ONCE and feeds both the balance tiles and today's
  // money-movement tiles, so "cash in hand" and "cash in today" cannot
  // disagree about what today's postings were.
  const allPostings = await buildDerivedPostings({});
  const { bankBalance, cashBalance } = await companyBalances(
    (async () => allPostings) as unknown as typeof buildDerivedPostings,
    { location: postingLoc },
  );
  const todayMoney = rangeMoneyFlows(allPostings as never[], {
    fromDate: today, toDate: today, location: postingLoc, subtree: await ledgerSubtreeLookup(),
  });

  // ── Other metrics ─────────────────────────────────────────────────────
  const salesConds = ["s.branch_transfer_id IS NULL", "s.cancelled_at IS NULL"];
  const salesParams: unknown[] = [];
  pushLocationFilter(salesConds, salesParams, viewLoc, "COALESCE(s.location_type, 'outlet')", "COALESCE(s.location_id, s.outlet_id)");
  if (!scope.isHeadOffice) salesConds.push(scopeSalesWhere(scope, salesParams));

  const empConds = ["e.is_active = TRUE"];
  const empParams: unknown[] = [];
  pushLocationFilter(empConds, empParams, viewLoc, "e.branch_type", "e.branch_id");
  if (!scope.isHeadOffice) empConds.push(scopeBranchWhere(scope, empParams, "e"));

  // Transfers touch two locations; a transfer is "at" a location when either
  // end is that location.
  const trConds = [`t.status IN ('pending', 'in_transit')`];
  const trParams: unknown[] = [];
  if (viewLoc) {
    if (viewLoc.locationType === "headoffice") {
      trConds.push(`(t.from_type = 'headoffice' OR t.to_type = 'headoffice')`);
    } else {
      trParams.push(viewLoc.locationType, viewLoc.locationId);
      trConds.push(`((t.from_type = $${trParams.length - 1} AND t.from_id = $${trParams.length}) OR (t.to_type = $${trParams.length - 1} AND t.to_id = $${trParams.length}))`);
    }
  }
  if (!scope.isHeadOffice) {
    const ends: string[] = [];
    if (scope.warehouseIds.length > 0) {
      trParams.push(scope.warehouseIds);
      ends.push(`(t.from_type = 'warehouse' AND t.from_id = ANY($${trParams.length}::int[])) OR (t.to_type = 'warehouse' AND t.to_id = ANY($${trParams.length}::int[]))`);
    }
    if (scope.outletIds.length > 0) {
      trParams.push(scope.outletIds);
      ends.push(`(t.from_type = 'outlet' AND t.from_id = ANY($${trParams.length}::int[])) OR (t.to_type = 'outlet' AND t.to_id = ANY($${trParams.length}::int[]))`);
    }
    trConds.push(ends.length > 0 ? `(${ends.join(" OR ")})` : "FALSE");
  }

  const stockConds = ["se.material_type = 'item'", "se.quantity::numeric < COALESCE(i.reorder_level, 10)::numeric"];
  const stockParams: unknown[] = [];
  pushLocationFilter(stockConds, stockParams, viewLoc, "se.branch_type", "se.branch_id");
  if (!scope.isHeadOffice) stockConds.push(scopeBranchWhere(scope, stockParams, "se"));

  const expConds = ["TRUE"];
  const expParams: unknown[] = [];
  pushLocationFilter(expConds, expParams, viewLoc, "COALESCE(ex.location_type, 'headoffice')", "COALESCE(ex.location_id, 0)");
  if (!scope.isHeadOffice) expConds.push(scopeLocWhere(scope, expParams, "COALESCE(ex.location_type, 'headoffice')", "COALESCE(ex.location_id, 0)"));

  // Legacy production runs predate the location columns and belong to Head
  // Office — same COALESCE rule as the production list endpoints.
  const prodConds = ["TRUE"];
  const prodParams: unknown[] = [];
  pushLocationFilter(prodConds, prodParams, viewLoc, "COALESCE(p.location_type, 'headoffice')", "COALESCE(p.location_id, 1)");
  if (!scope.isHeadOffice) prodConds.push(scopeLocWhere(scope, prodParams, "COALESCE(p.location_type, 'headoffice')", "COALESCE(p.location_id, 1)"));

  const [
    [itemsCount],
    salesSumQ,
    stockValue,
    activeEmpsQ,
    pendingTransfersQ,
    todayAttQ,
    pendingLeavesQ,
    lowStockQ,
    expenseSumQ,
    batchRows,
  ] = await Promise.all([
    // Catalog size is master data — global by design.
    db.select({ count: count() }).from(itemsTable),
    // Turnover means money customers owe us. Branch-transfer invoices are
    // statutory paperwork for moving our own stock between our own locations,
    // and cancelled bills never happened; counting either one reported revenue
    // the company never earned, and made this tile disagree with the Sales
    // Register and the GST return for the same period.
    pool.query(`SELECT COALESCE(SUM(s.total_amount::numeric), 0)::float AS total FROM sales s WHERE ${salesConds.join(" AND ")}`, salesParams),
    // Stock value comes from the one shared valuation function, so the tile, the
    // Stock Valuation report and the P&L closing stock cannot disagree.
    stockValuation(pool, {
      includeInTransit: true,
      ...(scope.isHeadOffice ? {} : { dataScope: scope }),
      ...(viewLoc ? { branchType: viewLoc.locationType, ...(viewLoc.locationType === "headoffice" ? {} : { branchId: viewLoc.locationId }) } : {}),
    }),
    pool.query(`SELECT COUNT(*)::int AS count FROM employees e WHERE ${empConds.join(" AND ")}`, empParams),
    // Transfers awaiting action: legacy rows use "pending"; the dispatch →
    // approve lifecycle creates them as "in_transit".
    pool.query(`SELECT COUNT(*)::int AS count FROM stock_transfers t WHERE ${trConds.join(" AND ")}`, trParams),
    pool.query(`SELECT COUNT(*)::int AS count FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.date = $${empParams.length + 1} AND ${empConds.join(" AND ")}`, [...empParams, today]),
    pool.query(`SELECT COUNT(*)::int AS count FROM leaves l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'pending' AND ${empConds.join(" AND ")}`, empParams),
    pool.query(`SELECT COUNT(*)::int AS count FROM stock_entries se LEFT JOIN items i ON i.id = se.item_id WHERE ${stockConds.join(" AND ")}`, stockParams),
    pool.query(`SELECT COALESCE(SUM(ex.amount::numeric), 0)::float AS total FROM expenses ex WHERE ${expConds.join(" AND ")}`, expParams),
    pool.query(`SELECT COUNT(*)::int AS batch_count, COALESCE(SUM(p.produced_quantity::numeric), 0)::float AS total_qty FROM productions p WHERE ${prodConds.join(" AND ")}`, prodParams),
  ]);

  const salesSum = { total: Number(salesSumQ.rows[0]?.total ?? 0) };
  const activeEmps = { count: Number(activeEmpsQ.rows[0]?.count ?? 0) };
  const pendingTransfers = { count: Number(pendingTransfersQ.rows[0]?.count ?? 0) };
  const todayAtt = { count: Number(todayAttQ.rows[0]?.count ?? 0) };
  const pendingLeaves = { count: Number(pendingLeavesQ.rows[0]?.count ?? 0) };
  const lowStock = { count: Number(lowStockQ.rows[0]?.count ?? 0) };
  const expenseSum = { total: Number(expenseSumQ.rows[0]?.total ?? 0) };
  const batchRow = (batchRows.rows[0] ?? {}) as any;

  // Hiding the Value column on the Stock screen is pointless if the same
  // number is sitting on a dashboard tile, so the tiles obey the same right.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  res.json({
    totalItemsProduced:   itemsCount.count,
    totalSalesAmount:     Number(salesSum.total ?? 0),
    canViewValuation:     showValuation,
    ...(showValuation ? {
      totalStockValue:     stockValue.grandTotal,
      stockValueOnHand:    stockValue.onHandValue,
      stockValueInTransit: stockValue.inTransitValue,
    } : {}),
    activeEmployees:      activeEmps.count,
    pendingTransfers:     pendingTransfers.count,
    todayAttendance:      todayAtt.count,
    pendingLeaves:        pendingLeaves.count,
    lowStockCount:        lowStock.count,
    totalExpense:         Number(expenseSum.total ?? 0),
    todayMoney,
    totalBatchesCreated:  Number(batchRow.batch_count ?? 0),
    totalBatchQuantity:   Number(batchRow.total_qty ?? 0),
    bankBalance,
    cashBalance,
  });
});

router.get("/dashboard/stock-alerts", requireModuleView("page:/"), async (req, res): Promise<void> => {
  // Same two-gate scoping as /dashboard/summary: LBAC always, view context on top.
  const { scope, viewLoc } = await dashboardScope(req);
  const conds = ["se.material_type = 'item'", "se.quantity::numeric < COALESCE(i.reorder_level, 10)::numeric"];
  const params: unknown[] = [];
  pushLocationFilter(conds, params, viewLoc, "se.branch_type", "se.branch_id");
  if (!scope.isHeadOffice) conds.push(scopeBranchWhere(scope, params, "se"));
  const { rows: alerts } = await pool.query(
    `SELECT se.id, se.item_id AS "itemId", i.name AS "itemName",
            se.branch_type AS "branchType", se.branch_id AS "branchId",
            se.quantity, COALESCE(i.reorder_level, 10) AS "reorderLevel"
       FROM stock_entries se
       LEFT JOIN items i ON i.id = se.item_id
      WHERE ${conds.join(" AND ")}
      LIMIT 20`,
    params,
  );

  res.json(alerts.map((a: any) => ({
    itemId: a.itemId,
    itemName: a.itemName ?? "",
    branchName: `${a.branchType} #${a.branchId}`,
    branchType: a.branchType,
    quantity: Number(a.quantity),
    reorderLevel: Number(a.reorderLevel),
  })));
});

router.get("/dashboard/recent-activity", requireModuleView("page:/"), async (req, res): Promise<void> => {
  // The activity log carries no location column, so its rows cannot be
  // narrowed to a branch. It is therefore a Head-Office-only feed: a branch
  // login gets an empty list rather than a company-wide one. (For HO users the
  // location selector is a view convenience over data they may already see, so
  // the un-narrowable feed stays visible rather than going blank.)
  const { scope } = await dashboardScope(req);
  if (!scope.isHeadOffice) {
    res.json([]);
    return;
  }
  const { activityLogTable } = await import("@workspace/db");
  const { desc } = await import("drizzle-orm");
  const activities = await db.select().from(activityLogTable).orderBy(desc(activityLogTable.createdAt)).limit(15);

  res.json(activities.map((a) => ({
    id: a.id,
    type: a.type,
    description: a.description,
    user: a.user,
    timestamp: a.createdAt.toISOString(),
  })));
});

// ── Analytics endpoints ──────────────────────────────────────────────────────

// Shared sales filter builder (Phase 7): from/to (YYYY-MM-DD) override the
// legacy `days` window; optional locationType+locationId or
// warehouseScope=<warehouseId> (warehouse + its child outlets). All conditions
// use COALESCE because location_type/location_id are raw-migration columns
// that are null on legacy rows (outlet sales).
function salesWhere(query: Record<string, unknown>): { conds: string[]; params: unknown[]; error?: string } {
  // Branch-transfer invoices live in `sales` so GST returns can see them, but
  // they are statutory documents for moving own stock — not business revenue.
  // Every sales analytic excludes them or the dashboard reports turnover the
  // company never earned.
  // A cancelled invoice is not turnover either — it was dropped from the GST
  // and sales reports but left in the dashboard analytics, so the two told
  // different stories about the same day.
  const conds: string[] = ['s.branch_transfer_id IS NULL', 's.cancelled_at IS NULL'];
  const params: unknown[] = [];
  const from = typeof query.from === 'string' ? query.from : '';
  const to = typeof query.to === 'string' ? query.to : '';
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    return { conds, params, error: 'from/to must be YYYY-MM-DD' };
  }
  if (from) { params.push(from); conds.push(`s.sale_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`s.sale_date <= $${params.length}::date`); }
  if (!from && !to) {
    const days = Math.min(Math.max(parseInt(String(query.days)) || 30, 1), 365);
    params.push(days);
    conds.push(`s.sale_date >= CURRENT_DATE - ($${params.length}::int * INTERVAL '1 day')`);
  }
  const lt = query.locationType;
  const lid = Number(query.locationId);
  if ((lt === 'warehouse' || lt === 'outlet') && Number.isFinite(lid) && lid > 0) {
    params.push(lt);  conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
    params.push(lid); conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
  } else if (lt === 'headoffice') {
    params.push('headoffice'); conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
  }
  const ws = Number(query.warehouseScope);
  if (Number.isFinite(ws) && ws > 0) {
    params.push(ws);
    const p = params.length;
    conds.push(`((COALESCE(s.location_type, 'outlet') = 'warehouse' AND COALESCE(s.location_id, s.outlet_id) = $${p})
      OR (COALESCE(s.location_type, 'outlet') = 'outlet' AND COALESCE(s.location_id, s.outlet_id) IN (SELECT id FROM outlets WHERE warehouse_id = $${p})))`);
  }
  return { conds, params };
}

router.get("/dashboard/sales-trend", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const f = salesWhere({ ...(req.query as Record<string, unknown>), ...(getLocationFilter(req) ?? {}) });
  if (f.error) { res.status(400).json({ error: f.error }); return; }
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    f.conds.push(scopeSalesWhere(scope, f.params));
  }
  const { rows } = await pool.query(`
    SELECT
      s.sale_date::text                            AS date,
      COALESCE(SUM(s.total_amount::numeric), 0)::float AS revenue,
      COUNT(*)::int                                AS invoices
    FROM sales s
    WHERE ${f.conds.join(' AND ')}
    GROUP BY s.sale_date
    ORDER BY s.sale_date
  `, f.params);
  res.json(rows);
});

router.get("/dashboard/top-items", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const f = salesWhere({ ...(req.query as Record<string, unknown>), ...(getLocationFilter(req) ?? {}) });
  if (f.error) { res.status(400).json({ error: f.error }); return; }
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    f.conds.push(scopeSalesWhere(scope, f.params));
  }
  const { rows } = await pool.query(`
    SELECT
      (li->>'itemId')::int                                                        AS item_id,
      COALESCE(i.name, 'Unknown')                                                  AS item_name,
      COALESCE(SUM((li->>'quantity')::numeric
        * COALESCE((li->>'unitPrice')::numeric, 0)), 0)::float                    AS revenue,
      COALESCE(SUM((li->>'quantity')::numeric), 0)::float                         AS quantity
    FROM sales s
    CROSS JOIN LATERAL jsonb_array_elements(s.line_items) AS li
    LEFT JOIN items i ON i.id = (li->>'itemId')::int
    WHERE ${f.conds.join(' AND ')}
    GROUP BY (li->>'itemId')::int, i.name
    ORDER BY revenue DESC
    LIMIT 10
  `, f.params);
  res.json(rows);
});

// Per-location sales breakdown for the dashboard (Phase 7). Includes
// warehouse-located sales correctly (bug #37).
router.get("/dashboard/sales-by-location", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const f = salesWhere({ ...(req.query as Record<string, unknown>), ...(getLocationFilter(req) ?? {}) });
  if (f.error) { res.status(400).json({ error: f.error }); return; }
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    f.conds.push(scopeSalesWhere(scope, f.params));
  }
  const { rows } = await pool.query(`
    SELECT COALESCE(s.location_type, 'outlet')  AS location_type,
           COALESCE(s.location_id, s.outlet_id) AS location_id,
           COALESCE(w.name, o.name, 'Unknown')  AS location_name,
           COUNT(*)::int                        AS invoices,
           COALESCE(SUM(s.total_amount::numeric), 0)::float AS revenue
    FROM sales s
    LEFT JOIN warehouses w ON COALESCE(s.location_type, 'outlet') = 'warehouse' AND w.id = COALESCE(s.location_id, s.outlet_id)
    LEFT JOIN outlets    o ON COALESCE(s.location_type, 'outlet') = 'outlet'    AND o.id = COALESCE(s.location_id, s.outlet_id)
    WHERE ${f.conds.join(' AND ')}
    GROUP BY 1, 2, 3
    ORDER BY revenue DESC
  `, f.params);
  res.json(rows.map((r: any) => ({
    locationType: r.location_type,
    locationId: Number(r.location_id),
    locationName: r.location_name,
    invoices: Number(r.invoices),
    revenue: Number(r.revenue),
  })));
});

// ── Business-intelligence figure set (Task #10 / #37) ──────────────────────────
// One server-computed payload so the dashboard never sums lists itself. Every
// revenue figure excludes branch-transfer invoices (statutory own-stock moves,
// not turnover). sales.location_type / location_id are startup-migration columns
// invisible to drizzle, so all sales/purchase/production reads go through `pool`.
const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
const qty = (n: unknown) => Math.round(Number(n ?? 0) * 1000) / 1000;
const asISODate = (d: unknown): string => {
  // Postgres date columns come back as JS Date objects, never 'YYYY-MM-DD'
  // strings — format them, never compare with ===.
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const s = String(d ?? "");
  return s.length >= 10 ? s.slice(0, 10) : s;
};

router.get("/dashboard/bi", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const q = req.query as Record<string, unknown>;
  const fromDate = typeof q.fromDate === "string" ? q.fromDate : "";
  const toDate = typeof q.toDate === "string" ? q.toDate : "";
  if ((fromDate && !isIsoDate(fromDate)) || (toDate && !isIsoDate(toDate))) {
    res.status(400).json({ error: "fromDate/toDate must be YYYY-MM-DD" });
    return;
  }
  // Explicit query params win; otherwise the global location context headers
  // (x-location-type / x-location-id) supply the active working location.
  const headerLoc = getLocationFilter(req);
  let reqLocType = typeof q.locationType === "string" ? q.locationType : "";
  let reqLocId = Number(q.locationId);
  if (!reqLocType && headerLoc) {
    reqLocType = headerLoc.locationType;
    reqLocId = headerLoc.locationId;
  }
  if (reqLocType && !["warehouse", "outlet", "headoffice"].includes(reqLocType)) {
    res.status(400).json({ error: "locationType must be warehouse, outlet or headoffice" });
    return;
  }

  // ── Resolve effective scope ─────────────────────────────────────────────
  // A non-headoffice employee only ever sees their own location, regardless of
  // query params. Head Office may filter to any single location or see all.
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const scope = emp ? await getUserDataScope(emp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };

  let effLocType: string | null = null;
  let effLocId: number | null = null;
  if (scope.isHeadOffice) {
    if (reqLocType === "headoffice") {
      // Head Office is singular and its placeholder id varies by table
      // (vouchers store 0, sales/stock store 1), so every predicate below
      // must match it on TYPE ALONE — an id equality would drop valid rows.
      effLocType = "headoffice";
      effLocId = 0;
    } else if ((reqLocType === "warehouse" || reqLocType === "outlet") && Number.isFinite(reqLocId) && reqLocId > 0) {
      effLocType = reqLocType;
      effLocId = reqLocId;
    }
  } else if (emp) {
    // Forced to the employee's own location.
    effLocType = emp.branchType;
    effLocId = emp.branchId;
  }

  // Resolve a friendly scope label.
  let scopeLabel = "All locations";
  if (effLocType && effLocId != null) {
    if (effLocType === "warehouse") {
      const { rows } = await pool.query(`SELECT name FROM warehouses WHERE id = $1`, [effLocId]);
      scopeLabel = rows[0]?.name ?? `Warehouse #${effLocId}`;
    } else if (effLocType === "outlet") {
      const { rows } = await pool.query(`SELECT name FROM outlets WHERE id = $1`, [effLocId]);
      scopeLabel = rows[0]?.name ?? `Outlet #${effLocId}`;
    } else {
      scopeLabel = "Head Office";
    }
  }

  // ── WHERE-builder for the `sales` table (alias s) ─────────────────────────
  // Always excludes branch transfers and cancelled invoices; applies date and
  // location filters; applies mandatory LBAC scope for non-HO users.
  function salesConds(): { where: string; params: unknown[] } {
    const conds = ["s.branch_transfer_id IS NULL", "s.cancelled_at IS NULL"];
    const params: unknown[] = [];
    if (fromDate) { params.push(fromDate); conds.push(`s.sale_date >= $${params.length}::date`); }
    if (toDate) { params.push(toDate); conds.push(`s.sale_date <= $${params.length}::date`); }
    if (effLocType === "headoffice") {
      conds.push(`COALESCE(s.location_type,'outlet') = 'headoffice'`);
    } else if (effLocType && effLocId != null) {
      params.push(effLocType); conds.push(`COALESCE(s.location_type,'outlet') = $${params.length}`);
      params.push(effLocId); conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
    } else if (!scope.isHeadOffice) {
      conds.push(scopeSalesWhere(scope, params));
    }
    return { where: conds.join(" AND "), params };
  }

  // ── WHERE-builder for tables with location_type/location_id (alias p) ─────
  // Used for purchases, productions, receipts, payments. Non-HO users can only
  // see their own location; if a non-HO location has no rows it returns FALSE.
  function locConds(alias: string, opts: { dateCol: string; dateCast?: string } ): { where: string; params: unknown[] } {
    const cast = opts.dateCast ?? "::date";
    const conds: string[] = [];
    const params: unknown[] = [];
    if (fromDate) { params.push(fromDate); conds.push(`${alias}.${opts.dateCol}${cast} >= $${params.length}::date`); }
    if (toDate) { params.push(toDate); conds.push(`${alias}.${opts.dateCol}${cast} <= $${params.length}::date`); }
    if (effLocType === "headoffice") {
      conds.push(`COALESCE(${alias}.location_type,'headoffice') = 'headoffice'`);
    } else if (effLocType && effLocId != null) {
      params.push(effLocType); conds.push(`COALESCE(${alias}.location_type,'headoffice') = $${params.length}`);
      params.push(effLocId); conds.push(`COALESCE(${alias}.location_id,0) = $${params.length}`);
    } else if (!scope.isHeadOffice) {
      const parts: string[] = [];
      if (scope.warehouseIds.length > 0) {
        params.push(scope.warehouseIds);
        parts.push(`(${alias}.location_type = 'warehouse' AND ${alias}.location_id = ANY($${params.length}::int[]))`);
      }
      if (scope.outletIds.length > 0) {
        params.push(scope.outletIds);
        parts.push(`(${alias}.location_type = 'outlet' AND ${alias}.location_id = ANY($${params.length}::int[]))`);
      }
      conds.push(parts.length > 0 ? `(${parts.join(" OR ")})` : "FALSE");
    }
    return { where: conds.length ? conds.join(" AND ") : "TRUE", params };
  }

  const sc = salesConds();

  // ── Accounting figures (Expenses, Cash/Bank, Receivables/Payables) ───────
  // Derived postings carry the source document's location, so these tiles can
  // honestly show one location's slice of the SAME stream that produces the
  // P&L and Balance Sheet (never a re-sum of source tables — that drifts).
  // Consolidated view: company-wide figures incl. opening balances. Location
  // view (picked by HO, or forced for a branch login): that location's slice,
  // opening balances excluded (they carry no location attribution). A branch
  // login therefore sees its own slice — location-scoped data, not a
  // company-wide leak.
  const postingLoc =
    effLocType === "headoffice"
      ? ({ type: "headoffice", id: null } as const)
      : effLocType && effLocId != null
      ? ({ type: effLocType as "warehouse" | "outlet", id: effLocId } as const)
      : null;
  // One posting build per distinct cap. companyFinancials and the money-flow
  // tiles both want the stream capped at the selected range's end, so they
  // share a single build per toDate.
  const postingsCache = new Map<string, ReturnType<typeof buildDerivedPostings>>();
  const cachedPostings: typeof buildDerivedPostings = (opts) => {
    const key = (opts as { toDate?: string | null } | undefined)?.toDate ?? "";
    let p = postingsCache.get(key);
    if (!p) { p = buildDerivedPostings(opts); postingsCache.set(key, p); }
    return p;
  };
  const accountingP = scope.isHeadOffice || postingLoc
    ? companyFinancials(cachedPostings, {
        fromDate: fromDate || null,
        toDate: toDate || null,
        location: postingLoc,
      })
    : Promise.resolve(null);
  // Cash/bank movement for the SELECTED range and location, off the SAME
  // stream as the balance tiles — the Money In/Out tiles follow the date
  // filter like every other KPI, so "yesterday" shows yesterday's flows and
  // an empty range means all-time totals.
  const moneyFlowsP = scope.isHeadOffice || postingLoc
    ? (async () => rangeMoneyFlows(
        (await cachedPostings(toDate ? { toDate } : {})) as never[],
        {
          fromDate: fromDate || null, toDate: toDate || null,
          location: postingLoc, subtree: await ledgerSubtreeLookup(),
        },
      ))()
    : Promise.resolve(null);

  // ── Run everything in parallel ────────────────────────────────────────────
  const [
    salesTotals,
    salesByDay,
    salesByLoc,
    salesByPay,
    topItemsRows,
    topCustomersRows,
    purchaseTotals,
    purchaseByDay,
    productionAgg,
    productionByDay,
    receivablesRows,
    cashInRows,
    cashOutRows,
    valuation,
    lowStockRow,
    expiringRow,
  ] = await Promise.all([
    // sales totals
    pool.query(
      `SELECT COALESCE(SUM(s.total_amount::numeric),0)::float AS total, COUNT(*)::int AS count
         FROM sales s WHERE ${sc.where}`, sc.params),
    // sales by day
    pool.query(
      `SELECT s.sale_date AS date,
              COALESCE(SUM(s.total_amount::numeric),0)::float AS total,
              COUNT(*)::int AS count
         FROM sales s WHERE ${sc.where}
        GROUP BY s.sale_date ORDER BY s.sale_date`, sc.params),
    // sales by location
    pool.query(
      `SELECT COALESCE(s.location_type,'outlet') AS location_type,
              COALESCE(s.location_id, s.outlet_id) AS location_id,
              COALESCE(w.name, o.name, 'Unknown') AS name,
              COALESCE(SUM(s.total_amount::numeric),0)::float AS total,
              COUNT(*)::int AS count
         FROM sales s
         LEFT JOIN warehouses w ON COALESCE(s.location_type,'outlet') = 'warehouse' AND w.id = COALESCE(s.location_id, s.outlet_id)
         LEFT JOIN outlets    o ON COALESCE(s.location_type,'outlet') = 'outlet'    AND o.id = COALESCE(s.location_id, s.outlet_id)
        WHERE ${sc.where}
        GROUP BY 1,2,3 ORDER BY total DESC`, sc.params),
    // sales by payment mode
    pool.query(
      `SELECT COALESCE(s.payment_mode,'unknown') AS mode,
              COALESCE(SUM(s.total_amount::numeric),0)::float AS total,
              COUNT(*)::int AS count
         FROM sales s WHERE ${sc.where}
        GROUP BY 1 ORDER BY total DESC`, sc.params),
    // top items (by revenue) from line_items
    pool.query(
      `SELECT (li->>'itemId')::int AS item_id,
              COALESCE(i.name,'Unknown') AS name,
              COALESCE(SUM((li->>'quantity')::numeric),0)::float AS qty,
              COALESCE(SUM((li->>'quantity')::numeric * COALESCE((li->>'unitPrice')::numeric,0)),0)::float AS revenue
         FROM sales s
         CROSS JOIN LATERAL jsonb_array_elements(s.line_items) AS li
         LEFT JOIN items i ON i.id = (li->>'itemId')::int
        WHERE ${sc.where}
        GROUP BY 1,2 ORDER BY revenue DESC LIMIT 8`, sc.params),
    // top customers
    pool.query(
      `SELECT s.customer_id AS customer_id,
              COALESCE(c.name, 'Walk-in') AS name,
              COALESCE(SUM(s.total_amount::numeric),0)::float AS revenue,
              COUNT(*)::int AS count
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${sc.where} AND s.customer_id IS NOT NULL
        GROUP BY 1,2 ORDER BY revenue DESC LIMIT 8`, sc.params),
    // purchases totals — exclude branch transfers
    (() => { const p = locConds("p", { dateCol: "purchase_date" });
      return pool.query(
        `SELECT COALESCE(SUM(p.total_amount::numeric),0)::float AS total, COUNT(*)::int AS count
           FROM purchases p WHERE p.branch_transfer_id IS NULL AND p.cancelled_at IS NULL AND ${p.where}`, p.params); })(),
    // purchases by day
    (() => { const p = locConds("p", { dateCol: "purchase_date" });
      return pool.query(
        `SELECT p.purchase_date AS date, COALESCE(SUM(p.total_amount::numeric),0)::float AS total
           FROM purchases p WHERE p.branch_transfer_id IS NULL AND p.cancelled_at IS NULL AND ${p.where}
          GROUP BY p.purchase_date ORDER BY p.purchase_date`, p.params); })(),
    // production aggregate
    (() => { const p = locConds("p", { dateCol: "production_date" });
      return pool.query(
        `SELECT COUNT(*)::int AS batches,
                COALESCE(SUM(p.produced_quantity::numeric),0)::float AS output_qty,
                COALESCE(SUM(p.wastage_qty::numeric),0)::float AS wastage_qty
           FROM productions p WHERE ${p.where}`, p.params); })(),
    // production by day
    (() => { const p = locConds("p", { dateCol: "production_date" });
      return pool.query(
        `SELECT p.production_date AS date, COALESCE(SUM(p.produced_quantity::numeric),0)::float AS qty
           FROM productions p WHERE ${p.where}
          GROUP BY p.production_date ORDER BY p.production_date`, p.params); })(),
    // receivables — outstanding on non-transfer, non-cancelled sales (all-time
    // exposure, not period-bound); overdue = outstanding on sales older than 30d.
    (() => {
      // Filtered on the derived figure rather than the stored payment_status: a
      // credit note can settle a bill without that column being rewritten, and
      // a stale status would keep money in receivables that nobody owes.
      const conds = ["s.branch_transfer_id IS NULL", "s.cancelled_at IS NULL"];
      const params: unknown[] = [];
      // With an end date the exposure is priced AT that date: only invoices
      // issued by then, netted by only the payments and credit notes that had
      // happened by then — the same as-of rule the receivables report uses.
      // Undated keeps the original all-time expression untouched.
      let outsSql = outstandingExpr("s");
      if (toDate) {
        params.push(toDate);
        const ph = `$${params.length}`;
        outsSql = outstandingAsOfExpr("s", ph);
        conds.push(`s.sale_date::date <= ${ph}::date`);
      }
      conds.push(`${outsSql} > 0.009`);
      if (effLocType === "headoffice") {
        conds.push(`COALESCE(s.location_type,'outlet') = 'headoffice'`);
      } else if (effLocType && effLocId != null) {
        params.push(effLocType); conds.push(`COALESCE(s.location_type,'outlet') = $${params.length}`);
        params.push(effLocId); conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
      } else if (!scope.isHeadOffice) {
        conds.push(scopeSalesWhere(scope, params));
      }
      const refDate = toDate || null;
      params.push(refDate);
      const refIdx = params.length;
      return pool.query(
        `SELECT COALESCE(SUM(${outsSql}),0)::float AS total,
                COUNT(*)::int AS count,
                COALESCE(SUM(CASE WHEN s.sale_date < (COALESCE($${refIdx}::date, CURRENT_DATE) - INTERVAL '30 day')
                     THEN ${outsSql} ELSE 0 END),0)::float AS overdue
           FROM sales s WHERE ${conds.join(" AND ")}`, params); })(),
    // cash inflow — receipts
    (() => { const p = locConds("r", { dateCol: "receipt_date", dateCast: "::date" });
      return pool.query(
        `SELECT COALESCE(SUM(r.amount::numeric),0)::float AS total FROM receipts r WHERE ${p.where}`, p.params); })(),
    // cash outflow — payments
    (() => { const p = locConds("py", { dateCol: "payment_date", dateCast: "::date" });
      return pool.query(
        `SELECT COALESCE(SUM(py.amount::numeric),0)::float AS total FROM payments py WHERE ${p.where}`, p.params); })(),
    // inventory valuation — the one shared function
    stockValuation(pool, {
      includeInTransit: true,
      dataScope: scope,
      branchType: effLocType ?? undefined,
      // HO stock rows carry branch_id 1 while effLocId is the voucher-side 0
      // placeholder — filter HO by type alone or its stock would vanish.
      branchId: effLocType === "headoffice" ? undefined : effLocId ?? undefined,
    }),
    // low-stock count (finished items only)
    (() => {
      const conds = [`stock_entries.material_type = 'item'`, `stock_entries.quantity::numeric < COALESCE(items.reorder_level, 10)::numeric`];
      const params: unknown[] = [];
      if (effLocType === "headoffice") {
        conds.push(`stock_entries.branch_type = 'headoffice'`);
      } else if (effLocType && effLocId != null) {
        params.push(effLocType); conds.push(`stock_entries.branch_type = $${params.length}`);
        params.push(effLocId); conds.push(`stock_entries.branch_id = $${params.length}`);
      } else if (!scope.isHeadOffice) {
        const parts: string[] = [];
        if (scope.warehouseIds.length > 0) { params.push(scope.warehouseIds); parts.push(`(stock_entries.branch_type='warehouse' AND stock_entries.branch_id = ANY($${params.length}::int[]))`); }
        if (scope.outletIds.length > 0) { params.push(scope.outletIds); parts.push(`(stock_entries.branch_type='outlet' AND stock_entries.branch_id = ANY($${params.length}::int[]))`); }
        conds.push(parts.length ? `(${parts.join(" OR ")})` : "FALSE");
      }
      return pool.query(
        `SELECT COUNT(*)::int AS count FROM stock_entries
           LEFT JOIN items ON stock_entries.item_id = items.id
          WHERE ${conds.join(" AND ")}`, params); })(),
    // expiring soon — batches expiring within 30 days that still hold stock
    (() => {
      // Comparing expiry_date to '' would make Postgres cast '' to date and
      // raise 22007, so NULL is the only "no expiry" test. The ::date casts are
      // deliberate: they are a no-op while the column is a real DATE, and they
      // keep the comparison legal if it is ever text again (a bare
      // `text >= CURRENT_DATE` has no operator and 500s the whole dashboard).
      const conds = ["sb.quantity::numeric > 0", "sb.expiry_date IS NOT NULL",
        "sb.expiry_date::date >= CURRENT_DATE", "sb.expiry_date::date <= CURRENT_DATE + INTERVAL '30 day'"];
      const params: unknown[] = [];
      if (effLocType === "headoffice") {
        conds.push(`sb.branch_type = 'headoffice'`);
      } else if (effLocType && effLocId != null) {
        params.push(effLocType); conds.push(`sb.branch_type = $${params.length}`);
        params.push(effLocId); conds.push(`sb.branch_id = $${params.length}`);
      } else if (!scope.isHeadOffice) {
        const parts: string[] = [];
        if (scope.warehouseIds.length > 0) { params.push(scope.warehouseIds); parts.push(`(sb.branch_type='warehouse' AND sb.branch_id = ANY($${params.length}::int[]))`); }
        if (scope.outletIds.length > 0) { params.push(scope.outletIds); parts.push(`(sb.branch_type='outlet' AND sb.branch_id = ANY($${params.length}::int[]))`); }
        conds.push(parts.length ? `(${parts.join(" OR ")})` : "FALSE");
      }
      return pool.query(
        `SELECT COUNT(*)::int AS count FROM stock_batches sb WHERE ${conds.join(" AND ")}`, params); })(),
  ]);

  const salesTotal = money(salesTotals.rows[0]?.total);
  const salesCount = Number(salesTotals.rows[0]?.count ?? 0);
  const outputQty = qty(productionAgg.rows[0]?.output_qty);
  const wastageQty = qty(productionAgg.rows[0]?.wastage_qty);
  const [accounting, moneyFlows] = await Promise.all([accountingP, moneyFlowsP]);
  // Same rule as the Stock screen: no valuation right, no valuation figure.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  res.json({
    canViewValuation: showValuation,
    period: { fromDate: fromDate || null, toDate: toDate || null },
    scope: {
      locationType: effLocType,
      locationId: effLocId,
      label: scopeLabel,
      isHeadOffice: scope.isHeadOffice,
    },
    sales: {
      total: salesTotal,
      count: salesCount,
      avgTicket: salesCount > 0 ? money(salesTotal / salesCount) : 0,
      byDay: salesByDay.rows.map((r: any) => ({ date: asISODate(r.date), total: money(r.total), count: Number(r.count) })),
      byLocation: salesByLoc.rows.map((r: any) => ({
        locationType: r.location_type, locationId: Number(r.location_id),
        name: r.name, total: money(r.total), count: Number(r.count),
      })),
      byPaymentMode: salesByPay.rows.map((r: any) => ({ mode: r.mode, total: money(r.total), count: Number(r.count) })),
    },
    purchases: {
      total: money(purchaseTotals.rows[0]?.total),
      count: Number(purchaseTotals.rows[0]?.count ?? 0),
      byDay: purchaseByDay.rows.map((r: any) => ({ date: asISODate(r.date), total: money(r.total) })),
    },
    production: {
      batches: Number(productionAgg.rows[0]?.batches ?? 0),
      outputQty,
      wastageQty,
      wastagePct: outputQty + wastageQty > 0 ? Math.round((wastageQty / (outputQty + wastageQty)) * 10000) / 100 : 0,
      byDay: productionByDay.rows.map((r: any) => ({ date: asISODate(r.date), qty: qty(r.qty) })),
    },
    inventory: {
      ...(showValuation ? { valuation: valuation.grandTotal } : {}),
      itemCount: valuation.byProduct.filter((p) => p.quantity > 0).length,
      lowStockCount: Number(lowStockRow.rows[0]?.count ?? 0),
      expiringSoonCount: Number(expiringRow.rows[0]?.count ?? 0),
    },
    receivables: {
      // Sundry Debtors from the posting stream — the same figure the Balance
      // Sheet shows, so a receipt voucher or a journal against a customer moves
      // it. Summing invoice dues could not see either.
      total: accounting ? accounting.accountsReceivable : null,
      basis: accounting ? "ledger" : null,
      companyWide: !postingLoc,
      // Invoice-level exposure for the selected period and location. Ageing needs
      // invoice dates, so `overdue` can only ever come from the documents.
      invoiceExposure: money(receivablesRows.rows[0]?.total),
      overdue: money(receivablesRows.rows[0]?.overdue),
      count: Number(receivablesRows.rows[0]?.count ?? 0),
    },
    payables: {
      // Sundry Creditors from the posting stream — the same figure the Balance
      // Sheet shows. The old tile was a raw sum of purchase invoices with no
      // payment subtraction at all, so paying a vendor in full left the payables
      // card completely unchanged.
      total: accounting ? accounting.accountsPayable : null,
      basis: accounting ? "ledger" : null,
      companyWide: !postingLoc,
      // Salary owed to employees. Kept as its own figure rather than folded into
      // `total`, which is the Sundry Creditors control account and must keep
      // agreeing with the Balance Sheet line of that name. `allPayables` is the
      // number to show when the question is "what do we owe", because trade
      // creditors alone silently omitted every rupee of accrued salary.
      salaryPayable: accounting ? accounting.salaryPayable : null,
      // Rent owed to landlords — accrued daily to RENT-PAY-* ledgers under
      // Current Liabilities, so like salary it is invisible to the Sundry
      // Creditors control account and needs its own line here.
      rentPayable: accounting ? accounting.rentPayable : null,
      allPayables: accounting
        ? Math.round((accounting.accountsPayable + accounting.salaryPayable + accounting.rentPayable) * 100) / 100
        : null,
      // Source-document exposure for the selected period and location. Kept
      // because it is location-answerable and the control total is not, but
      // named so it can never be mistaken for the payables balance.
      purchaseExposure: money(purchaseTotals.rows[0]?.total),
      count: Number(purchaseTotals.rows[0]?.count ?? 0),
    },
    cash: {
      // Voucher flows for the period — receipts and payments only. These are
      // movements, not a position; the balance below is the position.
      inflow: money(cashInRows.rows[0]?.total),
      outflow: money(cashOutRows.rows[0]?.total),
      net: money(Number(cashInRows.rows[0]?.total ?? 0) - Number(cashOutRows.rows[0]?.total ?? 0)),
      // Cash in hand from the posting stream, so a contra, a journal or a till
      // sale moves it. Mirrors the bank tile below.
      balance: accounting ? accounting.cashBalance : null,
      companyWide: !postingLoc,
    },
    // Direct + indirect expenses for the period, from the same derived
    // postings as the P&L. Purchases are excluded because the Purchases tile
    // above already shows them. `null` means the caller's scope is a single
    // location, where a company-level figure would be both wrong and a leak.
    expenses: {
      total: accounting ? accounting.expenses.total : null,
      direct: accounting ? accounting.expenses.direct : null,
      indirect: accounting ? accounting.expenses.indirect : null,
      // Salary/Rent subtree totals off the same P&L build as `total`;
      // `other` = total − salary − rent, so the tile hint always reconciles.
      salary: accounting ? accounting.expenses.salary : null,
      rent: accounting ? accounting.expenses.rent : null,
      other: accounting ? accounting.expenses.other : null,
      companyWide: !postingLoc,
    },
    // Gross and net profit for the selected period, read off the SAME
    // buildBooks output as the expenses tile (never recomputed here), so the
    // GP/NP tiles always equal the Profit & Loss for the same range and
    // location. Null exactly when the other accounting figures are null.
    profit: {
      gross: accounting ? accounting.profit.gross : null,
      net: accounting ? accounting.profit.net : null,
      // COGS from the same P&L summary — the tile equals the statement's
      // "Cost of Goods Sold" line for the same range and location.
      cogs: accounting ? accounting.profit.cogs : null,
      companyWide: !postingLoc,
    },
    // Bank only — physical cash stays in the separate `cash` figures, matching
    // this ERP's existing STD-BANK / STD-CASH split.
    bank: {
      balance: accounting ? accounting.bankBalance : null,
      companyWide: !postingLoc,
    },
    // Money movement for the SELECTED range — debits (in) and credits (out)
    // over the cash and bank ledger subtrees, following the date filter and
    // location like every other KPI. Null exactly when the balance tiles are
    // null. Kept under the legacy `todayMoney` key too so an older client
    // build (or the mobile app) keeps rendering during rollout.
    moneyFlows,
    todayMoney: moneyFlows,
    topItems: topItemsRows.rows.map((r: any) => ({
      itemId: Number(r.item_id), name: r.name, qty: qty(r.qty), revenue: money(r.revenue),
    })),
    topCustomers: topCustomersRows.rows.map((r: any) => ({
      customerId: Number(r.customer_id), name: r.name, revenue: money(r.revenue), count: Number(r.count),
    })),
  });
});

router.get("/dashboard/production-trend", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
  // Same two-gate scoping as /dashboard/summary; legacy runs with no location
  // columns belong to Head Office.
  const { scope, viewLoc } = await dashboardScope(req);
  const params: unknown[] = [days];
  const conds = [`p.production_date >= CURRENT_DATE - ($1::int * INTERVAL '1 day')`];
  pushLocationFilter(conds, params, viewLoc, "COALESCE(p.location_type, 'headoffice')", "COALESCE(p.location_id, 1)");
  if (!scope.isHeadOffice) conds.push(scopeLocWhere(scope, params, "COALESCE(p.location_type, 'headoffice')", "COALESCE(p.location_id, 1)"));
  const { rows } = await pool.query(`
    SELECT
      p.production_date::text                          AS date,
      COALESCE(SUM(p.produced_quantity), 0)::float     AS quantity,
      COUNT(*)::int                                    AS batches
    FROM productions p
    WHERE ${conds.join(" AND ")}
    GROUP BY p.production_date
    ORDER BY p.production_date
  `, params);
  res.json(rows);
});

export default router;

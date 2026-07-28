import { Router } from "express";
import { db, pool, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable, productionsTable, expensesTable } from "@workspace/db";
import { count, sum, eq, and, sql, inArray } from "drizzle-orm";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { stockValuation } from "../lib/valuation";
import { requireModuleView } from "../middleware/permissions";

const router = Router();

/** `stock_entries` holds items, raw materials and packing materials, and those
 *  ID spaces overlap. Dashboard stock value and low-stock alerts are about
 *  finished items only — without this filter they would join material rows to
 *  unrelated items and invent both value and alerts. */
const ITEM_ROWS_ONLY = sql`stock_entries.material_type = 'item'`;

router.get("/dashboard/summary", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const today = new Date().toISOString().split("T")[0];

  // ── COA ledger-based bank & cash balances ─────────────────────────────
  // Build a lightweight ledger tree to find STD-BANK / STD-CASH subtrees
  const { rows: allLedgers } = await pool.query(
    `SELECT id, parent_id, code FROM account_ledgers`
  );
  const childrenOf = new Map<number, number[]>();
  const codeToId   = new Map<string, number>();
  for (const r of allLedgers) {
    const id = Number(r.id);
    if (r.code) codeToId.set(r.code as string, id);
    if (!childrenOf.has(id)) childrenOf.set(id, []);
    if (r.parent_id) {
      const pid = Number(r.parent_id);
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(id);
    }
  }
  const subtreeIds = (code: string): number[] => {
    const root = codeToId.get(code);
    if (!root) return [];
    const ids: number[] = [];
    const visit = (id: number) => { ids.push(id); (childrenOf.get(id) ?? []).forEach(visit); };
    visit(root);
    return ids;
  };

  // Net balance for a set of ledger IDs: sum all payment/receipt movements
  const { rows: txnRows } = await pool.query(`
    SELECT ledger_id, COALESCE(SUM(net), 0)::float AS balance
    FROM (
      SELECT paid_to_ledger_id      AS ledger_id,  amount::numeric AS net FROM payments
      UNION ALL
      SELECT paid_from_ledger_id    AS ledger_id, -amount::numeric AS net FROM payments
      UNION ALL
      SELECT received_in_ledger_id  AS ledger_id,  amount::numeric AS net FROM receipts
      UNION ALL
      SELECT received_from_ledger_id AS ledger_id, -amount::numeric AS net FROM receipts
    ) t
    GROUP BY ledger_id
  `);
  const txnBalMap = new Map<number, number>();
  for (const r of txnRows) txnBalMap.set(Number(r.ledger_id), Number(r.balance));

  const sumSubtree = (ids: number[]) =>
    Math.round(ids.reduce((s, id) => s + (txnBalMap.get(id) ?? 0), 0) * 100) / 100;

  const bankBalance = sumSubtree(subtreeIds('STD-BANK'));
  const cashBalance = sumSubtree(subtreeIds('STD-CASH'));

  // ── Other metrics ─────────────────────────────────────────────────────
  const [
    [itemsCount],
    [salesSum],
    stockValue,
    [activeEmps],
    [pendingTransfers],
    [todayAtt],
    [pendingLeaves],
    [lowStock],
    [expenseSum],
    batchRows,
  ] = await Promise.all([
    db.select({ count: count() }).from(itemsTable),
    db.select({ total: sum(salesTable.totalAmount) }).from(salesTable),
    // Stock value comes from the one shared valuation function, so the tile, the
    // Stock Valuation report and the P&L closing stock cannot disagree. It used
    // to multiply quantity by `stock_entries.cost_price` — a cost frozen at the
    // row's creation — and to count finished goods only, ignoring every raw and
    // packing material in the building.
    stockValuation(pool, { includeInTransit: true }),
    db.select({ count: count() }).from(employeesTable).where(eq(employeesTable.isActive, true)),
    // Transfers awaiting action: legacy rows use "pending"; the dispatch →
    // approve lifecycle creates them as "in_transit".
    db.select({ count: count() }).from(stockTransfersTable).where(inArray(stockTransfersTable.status, ["pending", "in_transit"])),
    db.select({ count: count() }).from(attendanceTable).where(eq(attendanceTable.date, today)),
    db.select({ count: count() }).from(leavesTable).where(eq(leavesTable.status, "pending")),
    db.select({ count: count() }).from(stockEntriesTable)
      .leftJoin(itemsTable, eq(stockEntriesTable.itemId, itemsTable.id))
      .where(and(ITEM_ROWS_ONLY, sql`${stockEntriesTable.quantity}::numeric < COALESCE(items.reorder_level, 10)::numeric`)),
    db.select({ total: sum(expensesTable.amount) }).from(expensesTable),
    db.execute(sql`SELECT COUNT(*)::int AS batch_count, COALESCE(SUM(produced_quantity::numeric), 0)::float AS total_qty FROM productions`),
  ]);

  const batchRow = (batchRows.rows[0] ?? {}) as any;

  res.json({
    totalItemsProduced:   itemsCount.count,
    totalSalesAmount:     Number(salesSum.total ?? 0),
    totalStockValue:      stockValue.grandTotal,
    stockValueOnHand:     stockValue.onHandValue,
    stockValueInTransit:  stockValue.inTransitValue,
    activeEmployees:      activeEmps.count,
    pendingTransfers:     pendingTransfers.count,
    todayAttendance:      todayAtt.count,
    pendingLeaves:        pendingLeaves.count,
    lowStockCount:        lowStock.count,
    totalExpense:         Number(expenseSum.total ?? 0),
    totalBatchesCreated:  Number(batchRow.batch_count ?? 0),
    totalBatchQuantity:   Number(batchRow.total_qty ?? 0),
    bankBalance,
    cashBalance,
  });
});

router.get("/dashboard/stock-alerts", requireModuleView("page:/"), async (req, res): Promise<void> => {
  const alerts = await db
    .select({
      id: stockEntriesTable.id,
      itemId: stockEntriesTable.itemId,
      itemName: itemsTable.name,
      branchType: stockEntriesTable.branchType,
      branchId: stockEntriesTable.branchId,
      quantity: stockEntriesTable.quantity,
      reorderLevel: sql<string>`COALESCE(items.reorder_level, 10)`,
    })
    .from(stockEntriesTable)
    .leftJoin(itemsTable, eq(stockEntriesTable.itemId, itemsTable.id))
    .where(and(ITEM_ROWS_ONLY, sql`${stockEntriesTable.quantity}::numeric < COALESCE(items.reorder_level, 10)::numeric`))
    .limit(20);

  res.json(alerts.map((a) => ({
    itemId: a.itemId,
    itemName: a.itemName ?? "",
    branchName: `${a.branchType} #${a.branchId}`,
    branchType: a.branchType,
    quantity: Number(a.quantity),
    reorderLevel: Number(a.reorderLevel),
  })));
});

router.get("/dashboard/recent-activity", requireModuleView("page:/"), async (req, res): Promise<void> => {
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function salesWhere(query: Record<string, unknown>): { conds: string[]; params: unknown[]; error?: string } {
  // Branch-transfer invoices live in `sales` so GST returns can see them, but
  // they are statutory documents for moving own stock — not business revenue.
  // Every sales analytic excludes them or the dashboard reports turnover the
  // company never earned.
  const conds: string[] = ['s.branch_transfer_id IS NULL'];
  const params: unknown[] = [];
  const from = typeof query.from === 'string' ? query.from : '';
  const to = typeof query.to === 'string' ? query.to : '';
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
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
  const f = salesWhere(req.query as Record<string, unknown>);
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
  const f = salesWhere(req.query as Record<string, unknown>);
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
  const f = salesWhere(req.query as Record<string, unknown>);
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
const BI_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
  if ((fromDate && !BI_DATE_RE.test(fromDate)) || (toDate && !BI_DATE_RE.test(toDate))) {
    res.status(400).json({ error: "fromDate/toDate must be YYYY-MM-DD" });
    return;
  }
  const reqLocType = typeof q.locationType === "string" ? q.locationType : "";
  const reqLocId = Number(q.locationId);
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
    if ((reqLocType === "warehouse" || reqLocType === "outlet") && Number.isFinite(reqLocId) && reqLocId > 0) {
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
    if (effLocType && effLocId != null) {
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
    if (effLocType && effLocId != null) {
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
      const conds = ["s.branch_transfer_id IS NULL", "s.cancelled_at IS NULL", "s.payment_status <> 'paid'"];
      const params: unknown[] = [];
      if (effLocType && effLocId != null) {
        params.push(effLocType); conds.push(`COALESCE(s.location_type,'outlet') = $${params.length}`);
        params.push(effLocId); conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
      } else if (!scope.isHeadOffice) {
        conds.push(scopeSalesWhere(scope, params));
      }
      const refDate = toDate || null;
      params.push(refDate);
      const refIdx = params.length;
      return pool.query(
        `SELECT COALESCE(SUM(s.total_amount::numeric - s.amount_paid::numeric),0)::float AS total,
                COUNT(*)::int AS count,
                COALESCE(SUM(CASE WHEN s.sale_date < (COALESCE($${refIdx}::date, CURRENT_DATE) - INTERVAL '30 day')
                     THEN s.total_amount::numeric - s.amount_paid::numeric ELSE 0 END),0)::float AS overdue
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
      branchId: effLocId ?? undefined,
    }),
    // low-stock count (finished items only)
    (() => {
      const conds = [`stock_entries.material_type = 'item'`, `stock_entries.quantity::numeric < COALESCE(items.reorder_level, 10)::numeric`];
      const params: unknown[] = [];
      if (effLocType && effLocId != null) {
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
      const conds = ["sb.quantity::numeric > 0", "sb.expiry_date IS NOT NULL", "sb.expiry_date <> ''",
        "sb.expiry_date::date >= CURRENT_DATE", "sb.expiry_date::date <= CURRENT_DATE + INTERVAL '30 day'"];
      const params: unknown[] = [];
      if (effLocType && effLocId != null) {
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

  res.json({
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
      valuation: valuation.grandTotal,
      itemCount: valuation.byProduct.filter((p) => p.quantity > 0).length,
      lowStockCount: Number(lowStockRow.rows[0]?.count ?? 0),
      expiringSoonCount: Number(expiringRow.rows[0]?.count ?? 0),
    },
    receivables: {
      total: money(receivablesRows.rows[0]?.total),
      overdue: money(receivablesRows.rows[0]?.overdue),
      count: Number(receivablesRows.rows[0]?.count ?? 0),
    },
    payables: {
      // Purchases carry no payment tracking, so the full non-transfer purchase
      // value in the period is the payables exposure.
      total: money(purchaseTotals.rows[0]?.total),
      count: Number(purchaseTotals.rows[0]?.count ?? 0),
    },
    cash: {
      inflow: money(cashInRows.rows[0]?.total),
      outflow: money(cashOutRows.rows[0]?.total),
      net: money(Number(cashInRows.rows[0]?.total ?? 0) - Number(cashOutRows.rows[0]?.total ?? 0)),
    },
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
  const rows = await db.execute(sql`
    SELECT
      production_date::text                          AS date,
      COALESCE(SUM(produced_quantity), 0)::float     AS quantity,
      COUNT(*)::int                                  AS batches
    FROM productions
    WHERE production_date >= CURRENT_DATE - (${days}::int * INTERVAL '1 day')
    GROUP BY production_date
    ORDER BY production_date
  `);
  res.json(rows.rows);
});

export default router;

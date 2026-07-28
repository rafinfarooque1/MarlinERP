import { Router } from "express";
import { db, pool, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable, productionsTable, expensesTable } from "@workspace/db";
import { count, sum, eq, and, sql, inArray } from "drizzle-orm";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { stockValuation } from "../lib/valuation";

const router = Router();

/** `stock_entries` holds items, raw materials and packing materials, and those
 *  ID spaces overlap. Dashboard stock value and low-stock alerts are about
 *  finished items only — without this filter they would join material rows to
 *  unrelated items and invent both value and alerts. */
const ITEM_ROWS_ONLY = sql`stock_entries.material_type = 'item'`;

router.get("/dashboard/summary", async (req, res): Promise<void> => {
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

router.get("/dashboard/stock-alerts", async (req, res): Promise<void> => {
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

router.get("/dashboard/recent-activity", async (req, res): Promise<void> => {
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
  const conds: string[] = [];
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

router.get("/dashboard/sales-trend", async (req, res): Promise<void> => {
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

router.get("/dashboard/top-items", async (req, res): Promise<void> => {
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
router.get("/dashboard/sales-by-location", async (req, res): Promise<void> => {
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

router.get("/dashboard/production-trend", async (req, res): Promise<void> => {
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

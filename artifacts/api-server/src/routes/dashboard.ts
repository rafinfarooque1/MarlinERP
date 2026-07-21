import { Router } from "express";
import { db, pool, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable, productionsTable, expensesTable } from "@workspace/db";
import { count, sum, eq, sql } from "drizzle-orm";

const router = Router();

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
    [stockSum],
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
    db.select({ total: sql<number>`sum(${stockEntriesTable.quantity}::numeric * ${stockEntriesTable.costPrice}::numeric)` }).from(stockEntriesTable),
    db.select({ count: count() }).from(employeesTable).where(eq(employeesTable.isActive, true)),
    db.select({ count: count() }).from(stockTransfersTable).where(eq(stockTransfersTable.status, "pending")),
    db.select({ count: count() }).from(attendanceTable).where(eq(attendanceTable.date, today)),
    db.select({ count: count() }).from(leavesTable).where(eq(leavesTable.status, "pending")),
    db.select({ count: count() }).from(stockEntriesTable).where(sql`${stockEntriesTable.quantity}::numeric < 10`),
    db.select({ total: sum(expensesTable.amount) }).from(expensesTable),
    db.execute(sql`SELECT COUNT(*)::int AS batch_count, COALESCE(SUM(produced_quantity::numeric), 0)::float AS total_qty FROM productions`),
  ]);

  const batchRow = (batchRows.rows[0] ?? {}) as any;

  res.json({
    totalItemsProduced:   itemsCount.count,
    totalSalesAmount:     Number(salesSum.total ?? 0),
    totalStockValue:      Number(stockSum.total ?? 0),
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
    })
    .from(stockEntriesTable)
    .leftJoin(itemsTable, eq(stockEntriesTable.itemId, itemsTable.id))
    .where(sql`${stockEntriesTable.quantity}::numeric < 10`)
    .limit(20);

  res.json(alerts.map((a) => ({
    itemId: a.itemId,
    itemName: a.itemName ?? "",
    branchName: `${a.branchType} #${a.branchId}`,
    branchType: a.branchType,
    quantity: Number(a.quantity),
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

router.get("/dashboard/sales-trend", async (req, res): Promise<void> => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
  const rows = await db.execute(sql`
    SELECT
      sale_date::text            AS date,
      COALESCE(SUM(total_amount), 0)::float  AS revenue,
      COUNT(*)::int              AS invoices
    FROM sales
    WHERE sale_date >= CURRENT_DATE - (${days}::int * INTERVAL '1 day')
    GROUP BY sale_date
    ORDER BY sale_date
  `);
  res.json(rows.rows);
});

router.get("/dashboard/top-items", async (req, res): Promise<void> => {
  const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
  const rows = await db.execute(sql`
    SELECT
      (li->>'itemId')::int                                                        AS item_id,
      COALESCE(i.name, 'Unknown')                                                  AS item_name,
      COALESCE(SUM((li->>'quantity')::numeric
        * COALESCE((li->>'unitPrice')::numeric, 0)), 0)::float                    AS revenue,
      COALESCE(SUM((li->>'quantity')::numeric), 0)::float                         AS quantity
    FROM sales s
    CROSS JOIN LATERAL jsonb_array_elements(s.line_items) AS li
    LEFT JOIN items i ON i.id = (li->>'itemId')::int
    WHERE s.sale_date >= CURRENT_DATE - (${days}::int * INTERVAL '1 day')
    GROUP BY (li->>'itemId')::int, i.name
    ORDER BY revenue DESC
    LIMIT 10
  `);
  res.json(rows.rows);
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

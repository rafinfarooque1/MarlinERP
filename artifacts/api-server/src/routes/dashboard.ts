import { Router } from "express";
import { db, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable, productionsTable } from "@workspace/db";
import { count, sum, eq, sql } from "drizzle-orm";

const router = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const [itemsCount] = await db.select({ count: count() }).from(itemsTable);
  const [salesSum] = await db.select({ total: sum(salesTable.totalAmount) }).from(salesTable);
  const [stockSum] = await db.select({ total: sql<number>`sum(${stockEntriesTable.quantity}::numeric * ${stockEntriesTable.costPrice}::numeric)` }).from(stockEntriesTable);
  const [activeEmps] = await db.select({ count: count() }).from(employeesTable).where(eq(employeesTable.isActive, true));
  const [pendingTransfers] = await db.select({ count: count() }).from(stockTransfersTable).where(eq(stockTransfersTable.status, "pending"));

  const today = new Date().toISOString().split("T")[0];
  const [todayAtt] = await db.select({ count: count() }).from(attendanceTable).where(eq(attendanceTable.date, today));
  const [pendingLeaves] = await db.select({ count: count() }).from(leavesTable).where(eq(leavesTable.status, "pending"));

  const [lowStock] = await db.select({ count: count() }).from(stockEntriesTable).where(sql`${stockEntriesTable.quantity}::numeric < 10`);

  res.json({
    totalItemsProduced: itemsCount.count,
    totalSalesAmount: Number(salesSum.total ?? 0),
    totalStockValue: Number(stockSum.total ?? 0),
    activeEmployees: activeEmps.count,
    pendingTransfers: pendingTransfers.count,
    todayAttendance: todayAtt.count,
    pendingLeaves: pendingLeaves.count,
    lowStockCount: lowStock.count,
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

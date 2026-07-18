import { Router } from "express";
import { db, itemsTable, salesTable, stockEntriesTable, employeesTable, stockTransfersTable, attendanceTable, leavesTable } from "@workspace/db";
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

export default router;

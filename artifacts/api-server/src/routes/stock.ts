import { Router } from "express";
import { db, stockEntriesTable, stockTransfersTable, itemsTable, warehousesTable, outletsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { CreateStockTransferBody, GetStockTransferParams, ListStockQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";

const router = Router();

async function getBranchName(branchType: string, branchId: number): Promise<string> {
  if (branchType === "production") return "Production Unit";
  if (branchType === "headoffice") return "Head Office";
  if (branchType === "warehouse") {
    const [w] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, branchId)).limit(1);
    return w?.name ?? `Warehouse #${branchId}`;
  }
  if (branchType === "outlet") {
    const [o] = await db.select().from(outletsTable).where(eq(outletsTable.id, branchId)).limit(1);
    return o?.name ?? `Outlet #${branchId}`;
  }
  return `Branch #${branchId}`;
}

router.get("/stock", async (req, res): Promise<void> => {
  const qp = ListStockQueryParams.safeParse(req.query);
  let rows = await db.select().from(stockEntriesTable);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i]));

  if (qp.success && qp.data.branchType) {
    rows = rows.filter((r) => r.branchType === qp.data.branchType);
  }
  if (qp.success && qp.data.branchId) {
    rows = rows.filter((r) => r.branchId === Number(qp.data.branchId));
  }

  const branchNames: Record<string, string> = {};
  const enriched = await Promise.all(rows.map(async (r) => {
    const key = `${r.branchType}:${r.branchId}`;
    if (!branchNames[key]) branchNames[key] = await getBranchName(r.branchType, r.branchId);
    const item = iMap.get(r.itemId);
    return {
      id: r.id,
      itemId: r.itemId,
      itemName: item?.name ?? "",
      hsnCode: item?.hsnCode ?? "",
      branchType: r.branchType,
      branchId: r.branchId,
      branchName: branchNames[key],
      quantity: Number(r.quantity),
      costPrice: Number(r.costPrice),
      unit: item?.unit ?? "",
    };
  }));

  res.json(enriched);
});

router.get("/stock/transfers", async (_req, res): Promise<void> => {
  const rows = await db.select().from(stockTransfersTable).orderBy(stockTransfersTable.id);
  const enriched = await Promise.all(rows.map(async (r) => ({
    ...r,
    fromName: await getBranchName(r.fromType, r.fromId),
    toName: await getBranchName(r.toType, r.toId),
    lineItems: r.lineItems ?? [],
  })));
  res.json(enriched);
});

router.post("/stock/transfers", async (req, res): Promise<void> => {
  const parsed = CreateStockTransferBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const lineItems = parsed.data.lineItems as Array<{ itemId: number; quantity: number; costPrice: number }>;
  const challanNumber = `CHN-${Date.now()}`;

  // Determine if interstate
  let isInterstate = false;
  if (parsed.data.fromType === "warehouse" && parsed.data.toType === "warehouse") {
    const [from] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, parsed.data.fromId)).limit(1);
    const [to] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, parsed.data.toId)).limit(1);
    if (from && to && from.state !== to.state) isInterstate = true;
  }

  const [row] = await db.insert(stockTransfersTable).values({
    challanNumber,
    fromType: parsed.data.fromType,
    fromId: parsed.data.fromId,
    toType: parsed.data.toType,
    toId: parsed.data.toId,
    transferDate: parsed.data.transferDate,
    lineItems: lineItems,
    isInterstate,
    status: "completed",
    notes: parsed.data.notes ?? null,
  }).returning();

  // Update stock entries (deduct from source, add to destination)
  for (const li of lineItems) {
    // Deduct from source
    const [srcExisting] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, parsed.data.fromType),
        eq(stockEntriesTable.branchId, parsed.data.fromId)
      )).limit(1);

    if (srcExisting) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric - ${li.quantity}` })
        .where(eq(stockEntriesTable.id, srcExisting.id));
    }

    // Add to destination
    const destType = parsed.data.toType === "headoffice" ? "warehouse" : parsed.data.toType;
    const destId = parsed.data.toType === "headoffice" ? 0 : parsed.data.toId;

    const [dstExisting] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, destType),
        eq(stockEntriesTable.branchId, destId)
      )).limit(1);

    if (dstExisting) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric + ${li.quantity}`, costPrice: String(li.costPrice ?? 0) })
        .where(eq(stockEntriesTable.id, dstExisting.id));
    } else {
      await db.insert(stockEntriesTable).values({
        itemId: li.itemId,
        branchType: destType,
        branchId: destId,
        quantity: String(li.quantity),
        costPrice: String(li.costPrice ?? 0),
      });
    }
  }

  const fromName = await getBranchName(row.fromType, row.fromId);
  const toName   = await getBranchName(row.toType,   row.toId);

  logActivity({
    action: "CREATE", module: "transfers", entityType: "stock_transfer", entityId: row.id,
    description: `Stock transfer ${challanNumber}: ${fromName} → ${toName} (${lineItems.length} line${lineItems.length !== 1 ? 's' : ''})`,
    metadata: { after: { challanNumber, fromType: row.fromType, fromId: row.fromId, fromName, toType: row.toType, toId: row.toId, toName, lineCount: lineItems.length, isInterstate } },
  }).catch(() => {});

  res.status(201).json({ ...row, fromName, toName, lineItems: row.lineItems ?? [] });
});

router.get("/stock/transfers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(stockTransfersTable).where(eq(stockTransfersTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({
    ...row,
    fromName: await getBranchName(row.fromType, row.fromId),
    toName: await getBranchName(row.toType, row.toId),
    lineItems: row.lineItems ?? [],
  });
});

export default router;

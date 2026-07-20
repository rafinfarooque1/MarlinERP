import { Router } from "express";
import { db, stockEntriesTable, stockTransfersTable, itemsTable, warehousesTable, outletsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { CreateStockTransferBody, GetStockTransferParams, ListStockQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { pool } from "@workspace/db";

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
  const result = await pool.query(`
    SELECT id, challan_number, from_type, from_id, to_type, to_id, transfer_date,
           line_items, is_interstate, status, notes, created_at,
           approved_by, approved_at, received_line_items, rejection_reason
    FROM stock_transfers ORDER BY id DESC
  `);
  const rows = result.rows;
  const enriched = await Promise.all(rows.map(async (r: any) => ({
    id: r.id,
    challanNumber: r.challan_number,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    transferDate: r.transfer_date,
    lineItems: r.line_items ?? [],
    isInterstate: r.is_interstate,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    receivedLineItems: r.received_line_items ?? [],
    rejectionReason: r.rejection_reason,
    fromName: await getBranchName(r.from_type, r.from_id),
    toName: await getBranchName(r.to_type, r.to_id),
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

  // Use pool.query directly so status: 'in_transit' is never overridden by the Drizzle schema default
  const insertResult = await pool.query(
    `INSERT INTO stock_transfers
       (challan_number, from_type, from_id, to_type, to_id, transfer_date, line_items, is_interstate, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_transit',$9)
     RETURNING id, challan_number, from_type, from_id, to_type, to_id, transfer_date, line_items, is_interstate, status, notes, created_at`,
    [
      challanNumber,
      parsed.data.fromType, parsed.data.fromId,
      parsed.data.toType,   parsed.data.toId,
      parsed.data.transferDate,
      JSON.stringify(lineItems),
      isInterstate,
      parsed.data.notes ?? null,
    ]
  );
  const row = insertResult.rows[0];

  // Deduct from source immediately (goods have left the location)
  for (const li of lineItems) {
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
  }
  // NOTE: destination stock is NOT updated here — only on approval

  const fromName = await getBranchName(row.from_type, row.from_id);
  const toName   = await getBranchName(row.to_type,   row.to_id);

  logActivity({
    action: "CREATE", module: "transfers", entityType: "stock_transfer", entityId: row.id,
    description: `Transfer dispatched ${challanNumber}: ${fromName} → ${toName} (${lineItems.length} line${lineItems.length !== 1 ? 's' : ''}) — awaiting receiver approval`,
    metadata: { after: { challanNumber, fromType: row.from_type, fromId: row.from_id, fromName, toType: row.to_type, toId: row.to_id, toName, lineCount: lineItems.length, isInterstate } },
  }).catch(() => {});

  res.status(201).json({
    id: row.id,
    challanNumber: row.challan_number,
    fromType: row.from_type, fromId: row.from_id, fromName,
    toType: row.to_type, toId: row.to_id, toName,
    transferDate: row.transfer_date,
    lineItems: row.line_items ?? [],
    isInterstate: row.is_interstate,
    status: row.status,   // will be 'in_transit'
    notes: row.notes,
    createdAt: row.created_at,
  });
});

// Approve a transfer — receiver verifies physical stock and enters actual received quantities
router.patch("/stock/transfers/:id/approve", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { receivedLineItems, approvedBy } = req.body as { receivedLineItems: Array<{ itemId: number; quantity: number; costPrice?: number }>; approvedBy?: string };

  const result = await pool.query(
    `SELECT id, from_type, from_id, to_type, to_id, status, line_items, challan_number FROM stock_transfers WHERE id = $1 LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) { res.status(404).json({ error: "Transfer not found" }); return; }
  if (row.status !== "in_transit") { res.status(400).json({ error: `Cannot approve a transfer with status "${row.status}"` }); return; }

  const linesToCredit = receivedLineItems ?? (row.line_items as any[]);

  const destType = row.to_type === "headoffice" ? "warehouse" : row.to_type;
  const destId   = row.to_type === "headoffice" ? 0 : row.to_id;

  // Credit destination with received quantities
  for (const li of linesToCredit) {
    if (!li.quantity || li.quantity <= 0) continue;
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

  await pool.query(
    `UPDATE stock_transfers SET status = 'completed', approved_by = $1, approved_at = now(), received_line_items = $2 WHERE id = $3`,
    [approvedBy || 'admin', JSON.stringify(linesToCredit), id]
  );

  const fromName = await getBranchName(row.from_type, row.from_id);
  const toName   = await getBranchName(row.to_type, row.to_id);

  logActivity({
    action: "UPDATE", module: "transfers", entityType: "stock_transfer", entityId: id,
    description: `Transfer ${row.challan_number} approved by ${approvedBy || 'admin'}: stock credited to ${toName}`,
    metadata: { after: { status: "completed", receivedLineItems: linesToCredit } },
  }).catch(() => {});

  res.json({ success: true, id, status: "completed", fromName, toName });
});

// Reject a transfer — reverses the source deduction
router.patch("/stock/transfers/:id/reject", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rejectionReason } = req.body as { rejectionReason?: string };

  const result = await pool.query(
    `SELECT id, from_type, from_id, to_type, to_id, status, line_items, challan_number FROM stock_transfers WHERE id = $1 LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) { res.status(404).json({ error: "Transfer not found" }); return; }
  if (row.status !== "in_transit") { res.status(400).json({ error: `Cannot reject a transfer with status "${row.status}"` }); return; }

  const lineItems = row.line_items as Array<{ itemId: number; quantity: number }>;

  // Reverse source deduction (goods returned)
  for (const li of lineItems) {
    const [srcExisting] = await db.select().from(stockEntriesTable)
      .where(and(
        eq(stockEntriesTable.itemId, li.itemId),
        eq(stockEntriesTable.branchType, row.from_type),
        eq(stockEntriesTable.branchId, row.from_id)
      )).limit(1);

    if (srcExisting) {
      await db.update(stockEntriesTable)
        .set({ quantity: sql`${stockEntriesTable.quantity}::numeric + ${li.quantity}` })
        .where(eq(stockEntriesTable.id, srcExisting.id));
    } else {
      await db.insert(stockEntriesTable).values({
        itemId: li.itemId,
        branchType: row.from_type,
        branchId: row.from_id,
        quantity: String(li.quantity),
        costPrice: "0",
      });
    }
  }

  await pool.query(
    `UPDATE stock_transfers SET status = 'rejected', rejection_reason = $1 WHERE id = $2`,
    [rejectionReason || null, id]
  );

  const fromName = await getBranchName(row.from_type, row.from_id);
  logActivity({
    action: "UPDATE", module: "transfers", entityType: "stock_transfer", entityId: id,
    description: `Transfer ${row.challan_number} rejected — stock reversed to ${fromName}`,
    metadata: { after: { status: "rejected", rejectionReason } },
  }).catch(() => {});

  res.json({ success: true, id, status: "rejected" });
});

router.get("/stock/transfers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const result = await pool.query(
    `SELECT id, challan_number, from_type, from_id, to_type, to_id, transfer_date,
            line_items, is_interstate, status, notes, created_at,
            approved_by, approved_at, received_line_items, rejection_reason
     FROM stock_transfers WHERE id = $1 LIMIT 1`,
    [id]
  );
  const r = result.rows[0];
  if (!r) { res.status(404).json({ error: "Not found" }); return; }
  res.json({
    id: r.id,
    challanNumber: r.challan_number,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    transferDate: r.transfer_date,
    lineItems: r.line_items ?? [],
    isInterstate: r.is_interstate,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    receivedLineItems: r.received_line_items ?? [],
    rejectionReason: r.rejection_reason,
    fromName: await getBranchName(r.from_type, r.from_id),
    toName: await getBranchName(r.to_type, r.to_id),
  });
});

export default router;

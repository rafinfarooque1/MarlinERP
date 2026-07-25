import { Router } from "express";
import { db, stockEntriesTable, itemsTable, warehousesTable, outletsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { CreateStockTransferBody, ListStockQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches, creditBatch, validateBatchOverride, type BatchBreakdownEntry } from "../lib/batches";

const router = Router();

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ── Branch-name lookup with preloaded maps (no per-row DB hits) ────────────────
export async function buildBranchMaps() {
  const [warehouses, outlets] = await Promise.all([
    db.select({ id: warehousesTable.id, name: warehousesTable.name }).from(warehousesTable),
    db.select({ id: outletsTable.id, name: outletsTable.name }).from(outletsTable),
  ]);
  const wMap = new Map(warehouses.map(w => [w.id, w.name]));
  const oMap = new Map(outlets.map(o => [o.id, o.name]));
  return (type: string, id: number): string => {
    if (type === "production") return "Production Unit";
    if (type === "headoffice") return "Head Office";
    if (type === "warehouse") return wMap.get(id) ?? `Warehouse #${id}`;
    if (type === "outlet") return oMap.get(id) ?? `Outlet #${id}`;
    return `Branch #${id}`;
  };
}

router.get("/stock", async (req, res): Promise<void> => {
  const qp = ListStockQueryParams.safeParse(req.query);

  // Fetch all three in parallel (items via raw SQL to include reorder/avg-cost columns)
  const [rows, itemsResult, branchName] = await Promise.all([
    db.select().from(stockEntriesTable),
    pool.query(`SELECT id, name, hsn_code, unit, reorder_level, avg_cost, cost FROM items`),
    buildBranchMaps(),
  ]);
  const iMap = new Map(itemsResult.rows.map((i: any) => [i.id, i]));

  let filtered = rows;
  if (qp.success && qp.data.branchType) filtered = filtered.filter(r => r.branchType === qp.data.branchType);
  if (qp.success && qp.data.branchId)   filtered = filtered.filter(r => r.branchId  === Number(qp.data.branchId));

  const enriched = filtered.map(r => {
    const item = iMap.get(r.itemId);
    const qty = Number(r.quantity);
    const avgCost = Number(item?.avg_cost ?? 0) > 0 ? Number(item.avg_cost) : Number(item?.cost ?? 0);
    const reorderLevel = Number(item?.reorder_level ?? 10);
    return {
      id: r.id,
      itemId: r.itemId,
      itemName: item?.name ?? "",
      hsnCode: item?.hsn_code ?? "",
      branchType: r.branchType,
      branchId: r.branchId,
      branchName: branchName(r.branchType, r.branchId),
      quantity: qty,
      costPrice: Number(r.costPrice),
      unit: item?.unit ?? "",
      reorderLevel,
      avgCost,
      stockValue: Math.round(qty * avgCost * 100) / 100,
      lowStock: qty < reorderLevel,
    };
  });

  res.json(enriched);
});

router.get("/stock/transfers", async (_req, res): Promise<void> => {
  const [result, branchName] = await Promise.all([
    pool.query(`
      SELECT id, challan_number, from_type, from_id, to_type, to_id, transfer_date,
             line_items, is_interstate, status, notes, created_at,
             approved_by, approved_at, received_line_items, rejection_reason
      FROM stock_transfers ORDER BY id DESC
    `),
    buildBranchMaps(),
  ]);
  const enriched = result.rows.map((r: any) => ({
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
    fromName: branchName(r.from_type, r.from_id),
    toName: branchName(r.to_type, r.to_id),
  }));
  res.json(enriched);
});

router.post("/stock/transfers", async (req, res): Promise<void> => {
  const parsed = CreateStockTransferBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // batchOverride per line (optional) comes from the raw body — zod strips unknown keys
  const rawLines = (req.body?.lineItems ?? []) as Array<{ itemId: number; quantity: number; costPrice: number; batchOverride?: Array<{ batchId: number; quantity: number }> }>;
  const lineItems = parsed.data.lineItems as Array<{ itemId: number; quantity: number; costPrice: number }>;

  // Defensive input integrity (beyond the schema): a negative or zero quantity
  // would CREDIT the source on "deduction" and warp stock.
  if (lineItems.length === 0) {
    res.status(400).json({ error: "At least one line item is required" }); return;
  }
  for (const li of lineItems) {
    if (!Number.isInteger(Number(li.itemId)) || Number(li.itemId) <= 0 ||
        !Number.isFinite(Number(li.quantity)) || Number(li.quantity) <= 0) {
      res.status(400).json({ error: "Each line item needs a valid itemId and a quantity greater than zero" }); return;
    }
  }
  const challanNumber = `CHN-${Date.now()}`;

  // Determine if interstate
  let isInterstate = false;
  if (parsed.data.fromType === "warehouse" && parsed.data.toType === "warehouse") {
    const [from] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, parsed.data.fromId)).limit(1);
    const [to] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, parsed.data.toId)).limit(1);
    if (from && to && from.state !== to.state) isInterstate = true;
  }

  // All stock effects happen in ONE transaction: manual batch picks are
  // validated server-side (ownership + availability + exact total), the source
  // stock rows are row-locked before deduction, and batches are consumed FEFO
  // (or per validated override). A failure on any line leaves nothing behind.
  // Raw SQL (not Drizzle) so status: 'in_transit' is never overridden by the
  // schema default and everything runs on the same client.
  const client = await pool.connect();
  let row: any;
  const enrichedLines: any[] = [];
  try {
    await client.query("BEGIN");

    for (let i = 0; i < lineItems.length; i++) {
      const override = rawLines[i]?.batchOverride;
      if (override == null) continue;
      if (!Array.isArray(override)) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "batchOverride must be an array of { batchId, quantity }" });
        return;
      }
      const v = await validateBatchOverride(client, {
        itemId: lineItems[i].itemId,
        branchType: parsed.data.fromType,
        branchId: parsed.data.fromId,
        quantity: lineItems[i].quantity,
        override,
      });
      if (!v.ok) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: v.error });
        return;
      }
    }

    const insertResult = await client.query(
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
    row = insertResult.rows[0];

    // Deduct from source immediately (goods have left the location); the
    // consumed batch breakdown is stored on each line so approval can credit
    // the same batches at the destination and rejection can restore exactly.
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const { rows: [srcExisting] } = await client.query(
        `SELECT id, quantity::numeric AS quantity FROM stock_entries WHERE item_id = $1 AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
        [li.itemId, parsed.data.fromType, parsed.data.fromId]
      );
      // Source must actually hold the goods — otherwise approval would credit
      // the destination with stock that never existed anywhere.
      if (!srcExisting || Number(srcExisting.quantity) + 0.001 < Number(li.quantity)) {
        await client.query("ROLLBACK");
        const { rows: [it] } = await pool.query(`SELECT name FROM items WHERE id = $1`, [li.itemId]);
        const itemName = it?.name ?? `Item #${li.itemId}`;
        const available = srcExisting ? Number(srcExisting.quantity) : 0;
        res.status(400).json({ error: `Insufficient stock of ${itemName} at the source location (available ${available}, requested ${li.quantity})` });
        return;
      }
      await client.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, srcExisting.id]
      );
      const batchBreakdown = await consumeBatches(client, {
        itemId: li.itemId,
        branchType: parsed.data.fromType,
        branchId: parsed.data.fromId,
        quantity: li.quantity,
        override: rawLines[i]?.batchOverride,
      });
      enrichedLines.push({ ...li, batchBreakdown });
    }
    await client.query(`UPDATE stock_transfers SET line_items = $1 WHERE id = $2`, [JSON.stringify(enrichedLines), row.id]);
    // NOTE: destination stock is NOT updated here — only on approval
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const branchName = await buildBranchMaps();
  const fromName = branchName(row.from_type, row.from_id);
  const toName   = branchName(row.to_type,   row.to_id);

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
    lineItems: enrichedLines,
    isInterstate: row.is_interstate,
    status: row.status,   // will be 'in_transit'
    notes: row.notes,
    createdAt: row.created_at,
  });
});

/** Allocate a received quantity over the dispatched batch breakdown, in FEFO
 *  dispatch order. Non-final entries cap at their dispatched quantity; the
 *  final entry absorbs any excess (receiver counted more than dispatched). */
function allocateReceived(breakdown: BatchBreakdownEntry[], receivedQty: number): BatchBreakdownEntry[] {
  const out: BatchBreakdownEntry[] = [];
  let remaining = receivedQty;
  for (let i = 0; i < breakdown.length; i++) {
    if (remaining <= 0) break;
    const b = breakdown[i];
    const isLast = i === breakdown.length - 1;
    const take = isLast ? remaining : Math.min(Number(b.quantity), remaining);
    if (take > 0) out.push({ ...b, quantity: r3(take) });
    remaining = r3(remaining - take);
  }
  return out;
}

// Approve a transfer — receiver verifies physical stock and enters actual received quantities
router.patch("/stock/transfers/:id/approve", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { receivedLineItems, approvedBy } = req.body as { receivedLineItems?: Array<{ itemId: number; quantity: number; costPrice?: number }>; approvedBy?: string };

  const client = await pool.connect();
  let row: any;
  let linesToCredit: Array<{ itemId: number; quantity: number; costPrice: number }>;
  try {
    await client.query("BEGIN");

    // Atomic claim: flips status only if still in transit, so a concurrent
    // approve/reject gets zero rows instead of double-applying stock effects.
    const claim = await client.query(
      `UPDATE stock_transfers SET status = 'completed', approved_by = $1, approved_at = now()
       WHERE id = $2 AND status = 'in_transit'
       RETURNING id, from_type, from_id, to_type, to_id, line_items, challan_number`,
      [approvedBy || 'admin', id]
    );
    row = claim.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      const { rows: [chk] } = await pool.query(`SELECT status FROM stock_transfers WHERE id = $1 LIMIT 1`, [id]);
      if (!chk) { res.status(404).json({ error: "Transfer not found" }); return; }
      res.status(400).json({ error: `Cannot approve a transfer with status "${chk.status}"` });
      return;
    }

    const dispatchedLines = (row.line_items ?? []) as Array<{ itemId: number; quantity: number; costPrice?: number; batchBreakdown?: BatchBreakdownEntry[] }>;

    // Received lines may only confirm (or short-receive) what was dispatched —
    // never new items, never more than dispatched, and cost always comes from
    // the dispatched line, not the payload.
    if (receivedLineItems != null) {
      if (!Array.isArray(receivedLineItems)) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "receivedLineItems must be an array" });
        return;
      }
      const seen = new Set<number>();
      const validated: Array<{ itemId: number; quantity: number; costPrice: number }> = [];
      for (const li of receivedLineItems) {
        const itemId = Number(li?.itemId);
        const qty = Number(li?.quantity);
        if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isFinite(qty) || qty < 0) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "Each received line needs a valid itemId and a non-negative quantity" });
          return;
        }
        if (seen.has(itemId)) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Duplicate received line for item ${itemId}` });
          return;
        }
        seen.add(itemId);
        const d = dispatchedLines.find(x => Number(x.itemId) === itemId);
        if (!d) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Item ${itemId} was not part of this transfer` });
          return;
        }
        if (qty > Number(d.quantity) + 0.001) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Received quantity for item ${itemId} (${qty}) exceeds dispatched quantity (${d.quantity})` });
          return;
        }
        validated.push({ itemId, quantity: qty, costPrice: Number(d.costPrice ?? 0) });
      }
      linesToCredit = validated;
    } else {
      linesToCredit = dispatchedLines.map(d => ({ itemId: Number(d.itemId), quantity: Number(d.quantity), costPrice: Number(d.costPrice ?? 0) }));
    }

    const destType = row.to_type === "headoffice" ? "warehouse" : row.to_type;
    const destId   = row.to_type === "headoffice" ? 0 : row.to_id;

    // Credit destination with received quantities (stock entry + batches)
    for (const li of linesToCredit) {
      if (!li.quantity || li.quantity <= 0) continue;
      const { rows: [dstExisting] } = await client.query(
        `SELECT id FROM stock_entries WHERE item_id = $1 AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
        [li.itemId, destType, destId]
      );
      if (dstExisting) {
        await client.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, cost_price = $2, updated_at = now() WHERE id = $3`,
          [li.quantity, String(li.costPrice ?? 0), dstExisting.id]
        );
      } else {
        await client.query(
          `INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price) VALUES ($1,$2,$3,$4,$5)`,
          [li.itemId, destType, destId, li.quantity, String(li.costPrice ?? 0)]
        );
      }

      // Batches travel with the goods: same batch numbers/dates arrive at the
      // destination. Legacy transfers without a breakdown get a challan batch.
      const dispatched = dispatchedLines.find(d => Number(d.itemId) === Number(li.itemId));
      const breakdown = dispatched?.batchBreakdown ?? [];
      if (breakdown.length > 0) {
        const allocation = allocateReceived(breakdown, Number(li.quantity));
        for (const b of allocation) {
          await creditBatch(client, {
            itemId: li.itemId, branchType: destType, branchId: destId,
            batchNumber: b.batchNumber, mfgDate: b.mfgDate, expiryDate: b.expiryDate,
            quantity: b.quantity, unitCost: b.unitCost, source: "transfer", sourceId: id,
          });
        }
      } else {
        await creditBatch(client, {
          itemId: li.itemId, branchType: destType, branchId: destId,
          batchNumber: `TRF-${row.challan_number}`, quantity: Number(li.quantity),
          unitCost: Number(li.costPrice ?? 0), source: "transfer", sourceId: id,
        });
      }
    }

    await client.query(`UPDATE stock_transfers SET received_line_items = $1 WHERE id = $2`, [JSON.stringify(linesToCredit), id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const branchName = await buildBranchMaps();
  const fromName = branchName(row.from_type, row.from_id);
  const toName   = branchName(row.to_type, row.to_id);

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

  const client = await pool.connect();
  let row: any;
  try {
    await client.query("BEGIN");

    // Atomic claim (see approve): only one of approve/reject can win.
    const claim = await client.query(
      `UPDATE stock_transfers SET status = 'rejected', rejection_reason = $1
       WHERE id = $2 AND status = 'in_transit'
       RETURNING id, from_type, from_id, to_type, to_id, line_items, challan_number`,
      [rejectionReason || null, id]
    );
    row = claim.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      const { rows: [chk] } = await pool.query(`SELECT status FROM stock_transfers WHERE id = $1 LIMIT 1`, [id]);
      if (!chk) { res.status(404).json({ error: "Transfer not found" }); return; }
      res.status(400).json({ error: `Cannot reject a transfer with status "${chk.status}"` });
      return;
    }

    const lineItems = row.line_items as Array<{ itemId: number; quantity: number; batchBreakdown?: BatchBreakdownEntry[] }>;

    // Reverse source deduction (goods returned)
    for (const li of lineItems) {
      const { rows: [srcExisting] } = await client.query(
        `SELECT id FROM stock_entries WHERE item_id = $1 AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
        [li.itemId, row.from_type, row.from_id]
      );
      if (srcExisting) {
        await client.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [li.quantity, srcExisting.id]
        );
      } else {
        await client.query(
          `INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price) VALUES ($1,$2,$3,$4,'0')`,
          [li.itemId, row.from_type, row.from_id, li.quantity]
        );
      }

      // Restore exactly the batches that were consumed at dispatch
      await restoreBatches(client, li.itemId, row.from_type, row.from_id, li.batchBreakdown, "transfer", id);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const branchName = await buildBranchMaps();
  const fromName = branchName(row.from_type, row.from_id);
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
  const branchName = await buildBranchMaps();
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
    fromName: branchName(r.from_type, r.from_id),
    toName: branchName(r.to_type, r.to_id),
  });
});

export default router;

import { Router } from "express";
import { db, stockEntriesTable, itemsTable, warehousesTable, outletsTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { eq, and, sql } from "drizzle-orm";
import { CreateStockTransferBody, ListStockQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches, creditBatch, updateAvgCostOnInbound, validateBatchOverride, type BatchBreakdownEntry } from "../lib/batches";
import { writeStockLedger, batchResolveMeta } from "../lib/stockLedger";
import { resolveLocationGst, classifyTransfer, computeTransferGst, createDispatchVoucher, createReceiveVoucher, type TaxType, type GstTotals } from "../lib/gstTransfer";
import { getUserDataScope, scopeBranchWhere } from "../lib/dataScope";

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
    if (type === "headoffice") return "Head Office";
    if (type === "warehouse") return wMap.get(id) ?? `Warehouse #${id}`;
    if (type === "outlet") return oMap.get(id) ?? `Outlet #${id}`;
    return `Branch #${id}`;
  };
}

// GET /stock — server-paginated. Unions Item (SKU) from stock_entries,
// Raw Material from materials table, and Packing Material from raw_materials table.
// Optional query params: branchType, branchId, q (search), materialType (item|material|raw_material)
router.get("/stock", async (req, res): Promise<void> => {
  const qp = ListStockQueryParams.safeParse(req.query);
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const matTypeFilter = typeof req.query.materialType === 'string' ? req.query.materialType.trim() : '';

  // All conditions are applied to the outer query over the UNION CTE alias `u`
  const conds: string[] = [];
  const params: unknown[] = [];

  if (qp.success && qp.data.branchType) {
    params.push(qp.data.branchType);
    conds.push(`u.branch_type = $${params.length}`);
  }
  if (qp.success && qp.data.branchId) {
    params.push(Number(qp.data.branchId));
    conds.push(`u.branch_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`u.item_name ILIKE $${params.length}`);
  }
  if (matTypeFilter && ['item', 'material', 'raw_material'].includes(matTypeFilter)) {
    params.push(matTypeFilter);
    conds.push(`u.material_type = $${params.length}`);
  }

  // Non-headoffice employees: scope to their branch items only (materials are HO-global)
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(`u.material_type = 'item'`);
    conds.push(scopeBranchWhere(scope, params, 'u'));
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // UNION CTE: items (stock_entries) + raw materials + packing materials
  const cte = `
    WITH u AS (
      SELECT
        se.id                                   AS entry_id,
        se.item_id                              AS ref_id,
        'item'                                  AS material_type,
        COALESCE(i.name, '')                    AS item_name,
        COALESCE(i.unit, '')                    AS unit,
        COALESCE(i.hsn_code, '')                AS hsn_code,
        COALESCE(i.reorder_level, 10)::numeric  AS reorder_level,
        COALESCE(i.avg_cost, 0)::numeric        AS avg_cost,
        COALESCE(i.cost, 0)::numeric            AS cost,
        se.branch_type,
        se.branch_id::int,
        se.quantity::numeric                    AS quantity,
        se.cost_price::numeric                  AS cost_price
      FROM stock_entries se
      LEFT JOIN items i ON i.id = se.item_id

      UNION ALL

      SELECT
        NULL                AS entry_id,
        m.id                AS ref_id,
        'material'          AS material_type,
        m.name              AS item_name,
        COALESCE(m.unit, '') AS unit,
        ''                  AS hsn_code,
        0::numeric          AS reorder_level,
        COALESCE(m.avg_cost, 0)::numeric AS avg_cost,
        COALESCE(m.cost,     0)::numeric AS cost,
        'headoffice'        AS branch_type,
        0                   AS branch_id,
        m.current_stock::numeric AS quantity,
        0::numeric          AS cost_price
      FROM materials m
      WHERE m.current_stock::numeric > 0

      UNION ALL

      SELECT
        NULL                  AS entry_id,
        rm.id                 AS ref_id,
        'raw_material'        AS material_type,
        rm.name               AS item_name,
        COALESCE(rm.unit, '') AS unit,
        ''                    AS hsn_code,
        0::numeric            AS reorder_level,
        COALESCE(rm.avg_cost, 0)::numeric AS avg_cost,
        COALESCE(rm.cost,     0)::numeric AS cost,
        'headoffice'          AS branch_type,
        0                     AS branch_id,
        rm.current_stock::numeric AS quantity,
        0::numeric            AS cost_price
      FROM raw_materials rm
      WHERE rm.current_stock::numeric > 0
    )
  `;

  let total = 0;
  let page = 1;
  let limit = 0;
  if (paginated) {
    page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200);
    const { rows: [t] } = await pool.query(
      `${cte} SELECT COUNT(*)::int AS total FROM u ${where}`, params
    );
    total = Number(t?.total ?? 0);
  }

  const [result, branchName] = await Promise.all([
    pool.query(
      `${cte}
       SELECT entry_id, ref_id, material_type, item_name, unit, hsn_code,
              reorder_level, avg_cost, cost, branch_type, branch_id, quantity, cost_price
       FROM u ${where}
       ORDER BY ${paginated ? 'item_name ASC NULLS LAST, ref_id' : 'ref_id'}
       ${limit ? `LIMIT ${limit} OFFSET ${(page - 1) * limit}` : ''}`,
      params
    ),
    buildBranchMaps(),
  ]);

  const enriched = result.rows.map((r: any) => {
    const qty      = Number(r.quantity);
    const avgCost  = Number(r.avg_cost ?? 0) > 0 ? Number(r.avg_cost) : Number(r.cost ?? 0);
    const reorderLevel = Number(r.reorder_level ?? 10);
    return {
      id:           r.entry_id,
      itemId:       r.ref_id,
      materialType: r.material_type,
      itemName:     r.item_name ?? "",
      hsnCode:      r.hsn_code ?? "",
      branchType:   r.branch_type,
      branchId:     r.branch_id,
      branchName:   branchName(r.branch_type, r.branch_id),
      quantity:     qty,
      costPrice:    Number(r.cost_price),
      unit:         r.unit ?? "",
      reorderLevel,
      avgCost,
      stockValue:   Math.round(qty * avgCost * 100) / 100,
      lowStock:     r.material_type === 'item' && qty < reorderLevel,
    };
  });

  if (paginated) {
    res.json({ total, page, limit, rows: enriched });
  } else {
    res.json(enriched);
  }
});

router.get("/stock/ledger", requireModuleView(["Stock", "Inventory Reports"]), async (req, res): Promise<void> => {
  const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10));
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? 50), 10)));
  const offset = (page - 1) * limit;
  const q            = typeof req.query.q            === 'string' ? req.query.q.trim()     : '';
  const from         = typeof req.query.from         === 'string' ? req.query.from         : '';
  const to           = typeof req.query.to           === 'string' ? req.query.to           : '';
  const materialType = typeof req.query.materialType === 'string' ? req.query.materialType : '';
  const txnType      = typeof req.query.txnType      === 'string' ? req.query.txnType      : '';

  const conds: string[] = [];
  const params: unknown[] = [];
  const p = () => `$${params.length}`;

  if (q)            { params.push(`%${q}%`);    conds.push(`sl.item_name ILIKE ${p()}`); }
  if (from)         { params.push(from);          conds.push(`sl.created_at::date >= ${p()}::date`); }
  if (to)           { params.push(to);            conds.push(`sl.created_at::date <= ${p()}::date`); }
  if (materialType) { params.push(materialType);  conds.push(`sl.material_type = ${p()}`); }
  if (txnType)      { params.push(txnType);       conds.push(`sl.txn_type = ${p()}`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // Running balance computed over ALL history for each item/branch via window function.
  // The outer WHERE then filters to the requested criteria.
  const baseQuery = `
    WITH ranked AS (
      SELECT
        sl.*,
        SUM(sl.qty_change) OVER (
          PARTITION BY sl.material_type, sl.ref_id, sl.branch_type, sl.branch_id
          ORDER BY sl.created_at, sl.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_balance
      FROM stock_ledger sl
    )
    SELECT * FROM ranked
    ${where}
  `;

  const [countRes, rowsRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM (${baseQuery}) AS c`, params),
    pool.query(`${baseQuery} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
  ]);

  const total = parseInt(countRes.rows[0]?.total ?? '0', 10);
  const rows = rowsRes.rows.map((r: any) => ({
    id:             Number(r.id),
    txnType:        r.txn_type,
    materialType:   r.material_type,
    refId:          Number(r.ref_id),
    itemName:       r.item_name,
    unit:           r.unit,
    branchType:     r.branch_type,
    branchId:       Number(r.branch_id),
    branchName:     r.branch_name,
    qtyChange:      Number(r.qty_change),
    runningBalance: Number(r.running_balance),
    unitCost:       Number(r.unit_cost),
    docType:        r.doc_type,
    docId:          r.doc_id ? Number(r.doc_id) : null,
    notes:          r.notes ?? null,
    createdAt:      r.created_at,
  }));

  res.json({ total, page, limit, rows });
});

router.get("/stock/transfers", requireModuleView(["HO Transfers"]), async (req, res): Promise<void> => {
  // Optional ?from&to (YYYY-MM-DD, inclusive), ?status and ?limit filters so
  // heavy consumers (e.g. the Reports Center) don't pull the entire history.
  // Without params the full list is returned (existing pages unchanged).
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 0;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    return;
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  if (from) { params.push(from); conds.push(`transfer_date::date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`transfer_date::date <= $${params.length}::date`); }
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }

  // Non-headoffice employees only see transfers involving their own branch
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (emp && emp.branchType !== "headoffice" && emp.branchId) {
    params.push(emp.branchType);
    const btIdx = params.length;
    params.push(Number(emp.branchId));
    const biIdx = params.length;
    conds.push(`((from_type = $${btIdx} AND from_id = $${biIdx}) OR (to_type = $${btIdx} AND to_id = $${biIdx}))`);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const [result, branchName] = await Promise.all([
    pool.query(`
      SELECT id, challan_number, from_type, from_id, to_type, to_id, transfer_date,
             line_items, is_interstate, status, notes, created_at,
             approved_by, approved_at, received_line_items, rejection_reason,
             transfer_type, from_gstin, to_gstin, tax_type,
             transfer_value, gst_amount
      FROM stock_transfers ${where} ORDER BY id DESC ${limit ? `LIMIT ${limit}` : ""}
    `, params),
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
    transferType: r.transfer_type ?? 'internal',
    fromGstin: r.from_gstin ?? null,
    toGstin: r.to_gstin ?? null,
    taxType: r.tax_type ?? 'none',
    transferValue: r.transfer_value != null ? Number(r.transfer_value) : null,
    gstAmount: r.gst_amount != null ? Number(r.gst_amount) : null,
    fromName: branchName(r.from_type, r.from_id),
    toName: branchName(r.to_type, r.to_id),
  }));
  res.json(enriched);
});

router.post("/stock/transfers", requireModuleAction(["HO Transfers"], "add"), async (req, res): Promise<void> => {
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

  // GST-aware transfer classification — compare source + destination GSTINs
  const [fromGst, toGst] = await Promise.all([
    resolveLocationGst(pool, parsed.data.fromType, parsed.data.fromId),
    resolveLocationGst(pool, parsed.data.toType, parsed.data.toId),
  ]);
  const { transferType, taxType, isInterstate } = classifyTransfer(fromGst, toGst);

  // All stock effects happen in ONE transaction: manual batch picks are
  // validated server-side (ownership + availability + exact total), the source
  // stock rows are row-locked before deduction, and batches are consumed FEFO
  // (or per validated override). A failure on any line leaves nothing behind.
  // Raw SQL (not Drizzle) so status: 'in_transit' is never overridden by the
  // schema default and everything runs on the same client.
  const client = await pool.connect();
  let row: any;
  const branchFn = await buildBranchMaps();
  const enrichedLines: any[] = [];
  const dispatchLedgerEntries: any[] = [];
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
         (challan_number, from_type, from_id, to_type, to_id, transfer_date, line_items, is_interstate, status, notes,
          transfer_type, from_gstin, to_gstin, tax_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_transit',$9,$10,$11,$12,$13)
       RETURNING id, challan_number, from_type, from_id, to_type, to_id, transfer_date, line_items, is_interstate, status, notes, created_at,
                 transfer_type, from_gstin, to_gstin, tax_type`,
      [
        challanNumber,
        parsed.data.fromType, parsed.data.fromId,
        parsed.data.toType,   parsed.data.toId,
        parsed.data.transferDate,
        JSON.stringify(lineItems),
        isInterstate,
        parsed.data.notes ?? null,
        transferType,
        fromGst.gstin ?? null,
        toGst.gstin ?? null,
        taxType,
      ]
    );
    row = insertResult.rows[0];

    // Deduct from source immediately (goods have left the location); the
    // consumed batch breakdown is stored on each line so approval can credit
    // the same batches at the destination and rejection can restore exactly.
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const materialType: string = (rawLines[i] as any)?.materialType ?? 'item';

      if (materialType === 'material') {
        // Raw Material: check availability then deduct
        const { rows: [mat] } = await client.query(
          `SELECT id, name, unit, current_stock::numeric AS current_stock FROM materials WHERE id = $1 FOR UPDATE`,
          [li.itemId]
        );
        if (!mat) { await client.query("ROLLBACK"); res.status(400).json({ error: `Raw Material #${li.itemId} not found` }); return; }
        if (Number(mat.current_stock) + 0.001 < Number(li.quantity)) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Insufficient stock of ${mat.name} (available ${mat.current_stock}, requested ${li.quantity})` });
          return;
        }
        await client.query(`UPDATE materials SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`, [li.quantity, li.itemId]);
        enrichedLines.push({ ...li, materialType, batchBreakdown: [] });
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'material', refId: li.itemId, itemName: mat.name ?? '', unit: mat.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      } else if (materialType === 'raw_material') {
        // Packing Material: check availability then deduct
        const { rows: [rm] } = await client.query(
          `SELECT id, name, unit, current_stock::numeric AS current_stock FROM raw_materials WHERE id = $1 FOR UPDATE`,
          [li.itemId]
        );
        if (!rm) { await client.query("ROLLBACK"); res.status(400).json({ error: `Packing Material #${li.itemId} not found` }); return; }
        if (Number(rm.current_stock) + 0.001 < Number(li.quantity)) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Insufficient stock of ${rm.name} (available ${rm.current_stock}, requested ${li.quantity})` });
          return;
        }
        await client.query(`UPDATE raw_materials SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`, [li.quantity, li.itemId]);
        enrichedLines.push({ ...li, materialType, batchBreakdown: [] });
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'raw_material', refId: li.itemId, itemName: rm.name ?? '', unit: rm.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      } else {
        // Item (SKU): deduct from stock_entries
        const { rows: [srcExisting] } = await client.query(
          `SELECT id, quantity::numeric AS quantity FROM stock_entries WHERE item_id = $1 AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
          [li.itemId, parsed.data.fromType, parsed.data.fromId]
        );
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
        enrichedLines.push({ ...li, materialType: 'item', batchBreakdown });
        const { rows: [itemMeta] } = await pool.query(`SELECT name, unit FROM items WHERE id = $1`, [li.itemId]);
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'item', refId: li.itemId, itemName: itemMeta?.name ?? '', unit: itemMeta?.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      }
    }
    await writeStockLedger(client, dispatchLedgerEntries);

    // Taxable inter-branch transfer: create source-side accounting JV inside the transaction
    if (transferType !== 'internal') {
      const itemLines = enrichedLines.filter((l: any) => (l.materialType ?? 'item') === 'item');
      if (itemLines.length > 0) {
        const gst = await computeTransferGst(pool, itemLines.map((l: any) => ({ itemId: l.itemId, quantity: l.quantity, costPrice: l.costPrice ?? 0 })), taxType);
        if (gst.taxableValue > 0) {
          const dispatchVoucherId = await createDispatchVoucher({
            client,
            challanNumber,
            transferDate: parsed.data.transferDate,
            fromLocation: fromGst,
            gst,
            taxType,
            narration: `Inter-branch transfer ${challanNumber}: ${fromGst.name} → ${toGst.name}`,
            createdBy: null,
          });
          await client.query(
            `UPDATE stock_transfers SET transfer_value = $1, gst_amount = $2, dispatch_voucher_id = $3 WHERE id = $4`,
            [gst.taxableValue, gst.totalGst, dispatchVoucherId, row.id],
          );
        }
      }
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

  const fromName = branchFn(row.from_type, row.from_id);
  const toName   = branchFn(row.to_type,   row.to_id);

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
router.patch("/stock/transfers/:id/approve", requireModuleAction(["HO Transfers"], "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { receivedLineItems, approvedBy } = req.body as { receivedLineItems?: Array<{ itemId: number; quantity: number; costPrice?: number }>; approvedBy?: string };

  const client = await pool.connect();
  let row: any;
  let linesToCredit: Array<{ itemId: number; quantity: number; costPrice: number; materialType?: string }>;
  try {
    await client.query("BEGIN");

    // Atomic claim: flips status only if still in transit, so a concurrent
    // approve/reject gets zero rows instead of double-applying stock effects.
    const claim = await client.query(
      `UPDATE stock_transfers SET status = 'completed', approved_by = $1, approved_at = now()
       WHERE id = $2 AND status = 'in_transit'
       RETURNING id, from_type, from_id, to_type, to_id, line_items, challan_number,
                 transfer_type, tax_type, transfer_date, transfer_value, gst_amount`,
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

    const dispatchedLines = (row.line_items ?? []) as Array<{ itemId: number; quantity: number; costPrice?: number; batchBreakdown?: BatchBreakdownEntry[]; materialType?: string }>;

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
      const validated: Array<{ itemId: number; quantity: number; costPrice: number; materialType?: string }> = [];
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
        validated.push({ itemId, quantity: qty, costPrice: Number(d.costPrice ?? 0), materialType: d.materialType ?? 'item' });
      }
      linesToCredit = validated;
    } else {
      linesToCredit = dispatchedLines.map(d => ({ itemId: Number(d.itemId), quantity: Number(d.quantity), costPrice: Number(d.costPrice ?? 0), materialType: d.materialType ?? 'item' }));
    }

    const destType = row.to_type === "headoffice" ? "warehouse" : row.to_type;
    const destId   = row.to_type === "headoffice" ? 0 : row.to_id;

    // Credit destination with received quantities
    for (const li of linesToCredit) {
      if (!li.quantity || li.quantity <= 0) continue;
      const matType = li.materialType ?? 'item';

      if (matType === 'material') {
        // Raw Material: credit to materials.current_stock
        await client.query(`UPDATE materials SET current_stock = current_stock::numeric + $1 WHERE id = $2`, [li.quantity, li.itemId]);
      } else if (matType === 'raw_material') {
        // Packing Material: credit to raw_materials.current_stock
        await client.query(`UPDATE raw_materials SET current_stock = current_stock::numeric + $1 WHERE id = $2`, [li.quantity, li.itemId]);
      } else {
        // Item (SKU): credit stock_entries + batches
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
        // Batches travel with the goods
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
        // Update destination average cost (same formula as a regular inbound purchase)
        await updateAvgCostOnInbound(client, li.itemId, Number(li.quantity), Number(li.costPrice ?? 0));
      }
    }

    // Taxable inter-branch transfer: create destination-side accounting JV inside the transaction
    let receiveVoucherId: number | null = null;
    if (row.transfer_type && row.transfer_type !== 'internal' && Number(row.transfer_value ?? 0) > 0) {
      const toLocGst = await resolveLocationGst(pool, row.to_type, Number(row.to_id));
      const gstAmt = Number(row.gst_amount ?? 0);
      const storedGst: GstTotals = {
        taxableValue: Number(row.transfer_value),
        cgst:  row.tax_type === 'cgst_sgst' ? gstAmt / 2 : 0,
        sgst:  row.tax_type === 'cgst_sgst' ? gstAmt / 2 : 0,
        igst:  row.tax_type === 'igst'       ? gstAmt     : 0,
        totalGst: gstAmt,
        totalWithGst: Number(row.transfer_value) + gstAmt,
      };
      receiveVoucherId = await createReceiveVoucher({
        client,
        challanNumber: row.challan_number,
        transferDate: row.transfer_date
          ? new Date(row.transfer_date).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        toLocation: toLocGst,
        gst: storedGst,
        taxType: (row.tax_type ?? 'none') as TaxType,
        narration: `Inter-branch transfer ${row.challan_number} — received at ${toLocGst.name}`,
        createdBy: approvedBy ?? null,
      });
    }

    await client.query(`UPDATE stock_transfers SET received_line_items = $1, receive_voucher_id = $2 WHERE id = $3`, [JSON.stringify(linesToCredit), receiveVoucherId, id]);

    // ── Stock ledger — inside the transaction so it rolls back with everything ─
    const approveLedgerLines = (linesToCredit as any[]).filter((l: any) => l.quantity > 0);
    if (approveLedgerLines.length > 0) {
      const approveBm   = await buildBranchMaps();
      const approveMeta = await batchResolveMeta(pool, approveLedgerLines.map((l: any) => ({ materialType: l.materialType ?? 'item', refId: Number(l.itemId) })));
      const approveDestType = row.to_type === 'headoffice' ? 'warehouse' : row.to_type;
      const approveDestId   = row.to_type === 'headoffice' ? 0 : Number(row.to_id);
      await writeStockLedger(client, approveLedgerLines.map((l: any) => {
        const mt   = l.materialType ?? 'item';
        const info = approveMeta.get(`${mt}:${l.itemId}`) ?? { name: '', unit: '' };
        return { txnType: 'transfer_in', materialType: mt, refId: Number(l.itemId), itemName: info.name, unit: info.unit, branchType: approveDestType, branchId: approveDestId, branchName: approveBm(row.to_type, Number(row.to_id)), qtyChange: Number(l.quantity), unitCost: Number(l.costPrice ?? 0), docType: 'stock_transfer', docId: id };
      }));
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
  const toName   = branchName(row.to_type, row.to_id);

  logActivity({
    action: "UPDATE", module: "transfers", entityType: "stock_transfer", entityId: id,
    description: `Transfer ${row.challan_number} approved by ${approvedBy || 'admin'}: stock credited to ${toName}`,
    metadata: { after: { status: "completed", receivedLineItems: linesToCredit } },
  }).catch(() => {});

  res.json({ success: true, id, status: "completed", fromName, toName });
});

// Reject a transfer — reverses the source deduction
router.patch("/stock/transfers/:id/reject", requireModuleAction(["HO Transfers"], "edit"), async (req, res): Promise<void> => {
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

    const lineItems = row.line_items as Array<{ itemId: number; quantity: number; batchBreakdown?: BatchBreakdownEntry[]; materialType?: string }>;

    // Reverse source deduction (goods returned)
    for (const li of lineItems) {
      const matType = li.materialType ?? 'item';

      if (matType === 'material') {
        await client.query(`UPDATE materials SET current_stock = current_stock::numeric + $1 WHERE id = $2`, [li.quantity, li.itemId]);
      } else if (matType === 'raw_material') {
        await client.query(`UPDATE raw_materials SET current_stock = current_stock::numeric + $1 WHERE id = $2`, [li.quantity, li.itemId]);
      } else {
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

  // ── Stock ledger (reject: stock returned to source — fire-and-forget) ──────
  ;(async () => {
    const rLines = (row.line_items as any[]) ?? [];
    const meta = await batchResolveMeta(pool, rLines.map((l: any) => ({ materialType: l.materialType ?? 'item', refId: Number(l.itemId) })));
    await writeStockLedger(pool, rLines.map((l: any) => {
      const mt   = l.materialType ?? 'item';
      const info = meta.get(`${mt}:${l.itemId}`) ?? { name: '', unit: '' };
      return { txnType: 'transfer_in', materialType: mt, refId: Number(l.itemId), itemName: info.name, unit: info.unit, branchType: row.from_type, branchId: Number(row.from_id), branchName: fromName, qtyChange: Number(l.quantity), unitCost: Number(l.costPrice ?? 0), docType: 'stock_transfer', docId: id, notes: 'Transfer rejected — stock returned to source' };
    }));
  })().catch((e: any) => console.error('[stock-ledger] reject write failed', e));

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
            approved_by, approved_at, received_line_items, rejection_reason,
            transfer_type, from_gstin, to_gstin, tax_type, transfer_value, gst_amount
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
    transferType: r.transfer_type ?? 'internal',
    fromGstin: r.from_gstin ?? null,
    toGstin: r.to_gstin ?? null,
    taxType: r.tax_type ?? 'none',
    transferValue: r.transfer_value != null ? Number(r.transfer_value) : null,
    gstAmount: r.gst_amount != null ? Number(r.gst_amount) : null,
    fromName: branchName(r.from_type, r.from_id),
    toName: branchName(r.to_type, r.to_id),
  });
});

export default router;

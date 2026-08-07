import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router } from "express";
import { db, stockEntriesTable, itemsTable, warehousesTable, outletsTable } from "@workspace/db";
import { requireModuleView, requireModuleAction, canViewStockValuation } from "../middleware/permissions";
import { eq, and, sql } from "drizzle-orm";
import { CreateStockTransferBody, ListStockQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches, creditBatch, updateAvgCostOnInbound, validateBatchOverride, type BatchBreakdownEntry } from "../lib/batches";
import { writeStockLedger, batchResolveMeta } from "../lib/stockLedger";
import { isIsoDate } from "../lib/dateInput";
import {
  resolveLocationGst, classifyTransfer, computeTransferGst, createDispatchVoucher, createReceiveVoucher,
  buildTransferInvoiceLines, totalsFromLines, isTransferInvoicingEnabled, nextTransferInvoiceNumber,
  createTransferSaleInvoice, createTransferPurchaseInvoice, createTransferCreditNote,
  type TaxType, type GstTotals, type TransferInvoiceLine,
} from "../lib/gstTransfer";
import { getUserDataScope, isLocationInScope, scopeBranchWhere, scopeTransferWhere } from "../lib/dataScope";
import { getLocationFilter } from "../lib/requestLocation";
import { deductMaterialAt, creditMaterialAt } from "../lib/materialStock";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { productBatchIdentity, blockedByInactiveProducts, INACTIVE_PRODUCT_CODE, isProductKind } from "../lib/productIdentity";
import {
  reservedSql, availabilityAt, insufficientStockMessage, reserveStock, releaseReservations,
  type ReservationProductKind, type ReservationLine,
} from "../lib/reservations";

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

/**
 * Record dispatched goods as in transit, owned by the sender.
 *
 * Dispatch deducts the source's stock_entries row, so between dispatch and
 * receipt the goods sit in no location's on-hand figure. These rows are the only
 * record that they exist, which is what lets valuation keep counting them
 * instead of watching inventory dip for the length of every transfer. Lot rows
 * come from the consumed FEFO breakdown; whatever the lot layer could not cover
 * is reserved as one untracked remainder, exactly as the batch layer treats it.
 *
 * They are `in_transit`, never `hold`: the quantity has already left the source
 * row, so subtracting it from availability again would deduct it twice.
 */
async function reserveDispatchedInTransit(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  args: {
    transferId: number; challanNumber: string;
    refId: number; materialType: ReservationProductKind;
    branchType: string; branchId: number;
    quantity: number; breakdown?: BatchBreakdownEntry[] | null; fallbackCost: number;
  },
): Promise<void> {
  const breakdown = args.breakdown ?? [];
  const lines: ReservationLine[] = breakdown
    .filter((b) => Number(b?.quantity ?? 0) > 0)
    .map((b) => ({
      batchId: (b as any).batchId ?? null,
      batchNumber: b.batchNumber ?? null,
      quantity: Number(b.quantity),
      unitCost: Number((b as any).unitCost ?? 0) > 0 ? Number((b as any).unitCost) : args.fallbackCost,
    }));
  const tracked = lines.reduce((s, l) => s + l.quantity, 0);
  const remainder = r3(args.quantity - tracked);
  if (remainder > 0) lines.push({ batchId: null, batchNumber: null, quantity: remainder, unitCost: args.fallbackCost });
  await reserveStock(client, {
    kind: "in_transit",
    docType: "stock_transfer", docId: args.transferId,
    refId: args.refId, materialType: args.materialType,
    branchType: args.branchType, branchId: args.branchId,
    lines,
    notes: `In transit on challan ${args.challanNumber}`,
  });
}

// GET /stock — server-paginated. Every row comes from stock_entries, which is
// the single quantity truth for items, raw materials and packing materials
// alike; `material_type` says which master table `ref_id` points at. Materials
// used to be read from their own global counters here, which is why they always
// appeared at Head Office with no real location.
// Optional query params: branchType, branchId, q (search), materialType (item|material|raw_material)
// Serves Dashboard, Item Master, Stock Verification, HO Sales (POS), Stock and Transfers.
router.get("/stock", requireModuleView(["page:/", "page:/production/item-master", "page:/headoffice/stock-verification", "page:/sales/pos", "page:/headoffice/stock", "page:/transfers"]), async (req, res): Promise<void> => {
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
  // Global location context (headers) — only when the page didn't ask for a
  // specific branch itself. HO matches on type alone, as everywhere else.
  if (!(qp.success && (qp.data.branchType || qp.data.branchId))) {
    const viewLoc = getLocationFilter(req);
    if (viewLoc) {
      params.push(viewLoc.locationType);
      conds.push(`u.branch_type = $${params.length}`);
      if (viewLoc.locationType !== 'headoffice') {
        params.push(viewLoc.locationId);
        conds.push(`u.branch_id = $${params.length}`);
      }
    }
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

  // One CTE over stock_entries, joined to whichever master table the row's
  // material_type points at. The three id spaces overlap from 1, so each JOIN
  // must be guarded by material_type or a material row would pick up an
  // unrelated item's name and cost.
  const cte = `
    WITH u AS (
      SELECT
        se.id                                     AS entry_id,
        se.item_id                                AS ref_id,
        se.material_type,
        COALESCE(i.name, m.name, rm.name, '')     AS item_name,
        COALESCE(i.unit, m.unit, rm.unit, '')     AS unit,
        COALESCE(i.hsn_code, m.hsn_code, rm.hsn_code, '') AS hsn_code,
        CASE WHEN se.material_type = 'item'
             THEN COALESCE(i.reorder_level, 10)::numeric
             ELSE 0::numeric END                  AS reorder_level,
        COALESCE(i.avg_cost, m.avg_cost, rm.avg_cost, 0)::numeric AS avg_cost,
        COALESCE(i.cost,     m.cost,     rm.cost,     0)::numeric AS cost,
        se.branch_type,
        se.branch_id::int,
        se.quantity::numeric                      AS quantity,
        ${reservedSql('se')}                      AS reserved,
        se.cost_price::numeric                    AS cost_price
      FROM stock_entries se
      LEFT JOIN items         i  ON se.material_type = 'item'         AND i.id  = se.item_id
      LEFT JOIN materials     m  ON se.material_type = 'material'     AND m.id  = se.item_id
      LEFT JOIN raw_materials rm ON se.material_type = 'raw_material' AND rm.id = se.item_id
    )
  `;

  let total = 0;
  let page = 1;
  let limit = 0;
  if (paginated) {
    page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    // limit=0 is an explicit "everything in one list" request — the envelope
    // (total + canViewValuation) still travels, only the LIMIT/OFFSET is gone.
    // Only the literal string '0' qualifies: parseInt would also map '0.5' or
    // '0abc' to zero, silently turning malformed values into an uncapped read.
    const allRows = String(req.query.limit ?? '').trim() === '0';
    limit = allRows ? 0 : Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200);
    if (limit) {
      const { rows: [t] } = await pool.query(
        `${cte} SELECT COUNT(*)::int AS total FROM u ${where}`, params
      );
      total = Number(t?.total ?? 0);
    }
  }

  const [result, branchName] = await Promise.all([
    pool.query(
      `${cte}
       SELECT entry_id, ref_id, material_type, item_name, unit, hsn_code,
              reorder_level, avg_cost, cost, branch_type, branch_id, quantity, reserved, cost_price
       FROM u ${where}
       ORDER BY ${paginated ? 'item_name ASC NULLS LAST, ref_id' : 'ref_id'}
       ${limit ? `LIMIT ${limit} OFFSET ${(page - 1) * limit}` : ''}`,
      params
    ),
    buildBranchMaps(),
  ]);

  // Quantities are operational, valuation is commercial. A role without the
  // inventory-valuation right gets the same rows with the money fields absent
  // from the payload — not zeroed, not blanked client-side. Nothing about how
  // the numbers are stored or costed changes; they are simply not serialised.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  const enriched = result.rows.map((r: any) => {
    const qty      = Number(r.quantity);
    const avgCost  = Number(r.avg_cost ?? 0) > 0 ? Number(r.avg_cost) : Number(r.cost ?? 0);
    const reorderLevel = Number(r.reorder_level ?? 10);
    // Reserved is what is already committed to a document that has not shipped;
    // available is what a new commitment may draw on. Low stock is judged on
    // available, not on-hand — stock that is spoken for cannot cover an order.
    const reserved = r3(Number(r.reserved ?? 0));
    const available = r3(Math.max(0, qty - reserved));
    const row: Record<string, unknown> = {
      id:           r.entry_id,
      itemId:       r.ref_id,
      materialType: r.material_type,
      itemName:     r.item_name ?? "",
      hsnCode:      r.hsn_code ?? "",
      branchType:   r.branch_type,
      branchId:     r.branch_id,
      branchName:   branchName(r.branch_type, r.branch_id),
      quantity:     qty,
      reserved,
      available,
      unit:         r.unit ?? "",
      reorderLevel,
      lowStock:     r.material_type === 'item' && available < reorderLevel,
    };
    if (showValuation) {
      row.costPrice  = Number(r.cost_price);
      row.avgCost    = avgCost;
      row.stockValue = Math.round(qty * avgCost * 100) / 100;
    }
    return row;
  });

  if (paginated) {
    // The flag travels with the page so the table can drop its money columns
    // and its footer total. It is a rendering hint, not the control — the
    // fields are already gone from `rows` when it is false.
    res.json({ total: limit ? total : enriched.length, page, limit, rows: enriched, canViewValuation: showValuation });
  } else {
    res.json(enriched);
  }
});

router.get("/stock/ledger", requireModuleView(["page:/headoffice/stock-ledger", "page:/headoffice/inventory-reports", "page:/headoffice/stock"]), async (req, res): Promise<void> => {
  const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10));
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? 50), 10)));
  const offset = (page - 1) * limit;
  const q            = typeof req.query.q            === 'string' ? req.query.q.trim()     : '';
  const from         = typeof req.query.from         === 'string' ? req.query.from         : '';
  const to           = typeof req.query.to           === 'string' ? req.query.to           : '';
  const materialType = typeof req.query.materialType === 'string' ? req.query.materialType : '';
  const txnType      = typeof req.query.txnType      === 'string' ? req.query.txnType      : '';

  // from/to are compared against a date below, so an impossible date has to be
  // rejected here instead of raising 22007 inside the driver.
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    res.status(400).json({ error: "from/to must be real calendar dates in YYYY-MM-DD form" }); return;
  }

  const conds: string[] = [];
  const params: unknown[] = [];
  const p = () => `$${params.length}`;

  // These conditions are applied to the `ranked` CTE below, not to the base
  // table, so they must be qualified with `ranked` — `sl` only exists inside
  // the CTE and any `sl.`-qualified filter here fails with 42P01.
  if (q)            { params.push(`%${q}%`);    conds.push(`ranked.item_name ILIKE ${p()}`); }
  if (from)         { params.push(from);          conds.push(`ranked.created_at::date >= ${p()}::date`); }
  if (to)           { params.push(to);            conds.push(`ranked.created_at::date <= ${p()}::date`); }
  if (materialType) { params.push(materialType);  conds.push(`ranked.material_type = ${p()}`); }
  if (txnType)      { params.push(txnType);       conds.push(`ranked.txn_type = ${p()}`); }

  // Global location context — narrows the movement history to one branch.
  // View request only; HO matches on type alone.
  const viewLoc = getLocationFilter(req);
  if (viewLoc) {
    params.push(viewLoc.locationType); conds.push(`ranked.branch_type = ${p()}`);
    if (viewLoc.locationType !== 'headoffice') {
      params.push(viewLoc.locationId); conds.push(`ranked.branch_id = ${p()}`);
    }
  }

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
  // The ledger is a movement history first and a cost record second. A role
  // without the valuation right keeps every movement, quantity and running
  // balance and loses only the rate each movement went in at.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);
  const rows = rowsRes.rows.map((r: any) => {
    const row: Record<string, unknown> = {
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
      docType:        r.doc_type,
      docId:          r.doc_id ? Number(r.doc_id) : null,
      notes:          r.notes ?? null,
      createdAt:      r.created_at,
    };
    if (showValuation) row.unitCost = Number(r.unit_cost);
    return row;
  });

  res.json({ total, page, limit, rows, canViewValuation: showValuation });
});

/**
 * Transfer lines carry the cost each unit moved at — the same figure the Stock
 * page withholds — so it comes out of the payload for roles without the
 * valuation right. Quantities, batches and every other line field stay.
 *
 * Safe because receipt does NOT trust the client: the approve handler rebuilds
 * each credited line's cost from the stored transfer row, so a client that
 * echoes the (now absent) field back as 0 cannot change what the destination is
 * credited at. Never remove that server-side sourcing.
 */
const stripLineCost = (lines: unknown): unknown[] =>
  (Array.isArray(lines) ? lines : []).map((li: any) => {
    if (!li || typeof li !== "object") return li;
    const { costPrice, unitCost, lineValue, value, batchBreakdown, ...rest } = li;
    // The per-lot breakdown repeats the same cost one level down, so removing
    // it from the line alone leaves it in plain sight. Lot number, dates and
    // quantity stay — those are traceability, not money.
    if (Array.isArray(batchBreakdown)) {
      rest.batchBreakdown = batchBreakdown.map((b: any) => {
        if (!b || typeof b !== "object") return b;
        const { unitCost: _u, costPrice: _c, value: _v, ...bRest } = b;
        return bRest;
      });
    }
    return rest;
  });

router.get("/stock/transfers", requireModuleView("page:/transfers"), async (req, res): Promise<void> => {
  // Optional ?from&to (YYYY-MM-DD, inclusive), ?status and ?limit filters so
  // heavy consumers (e.g. the Reports Center) don't pull the entire history.
  // Without params the full list is returned (existing pages unchanged).
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 0;
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    return;
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  if (from) { params.push(from); conds.push(`transfer_date::date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`transfer_date::date <= $${params.length}::date`); }
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }

  // Global location context — a transfer belongs to the selected location's
  // view when that location is EITHER endpoint (dispatches and receipts both
  // matter to a branch). HO matches on type alone.
  const viewLoc = getLocationFilter(req);
  if (viewLoc) {
    if (viewLoc.locationType === 'headoffice') {
      params.push('headoffice');
      conds.push(`(from_type = $${params.length} OR to_type = $${params.length})`);
    } else {
      params.push(viewLoc.locationType);
      params.push(viewLoc.locationId);
      const t = params.length - 1, i = params.length;
      conds.push(`((from_type = $${t} AND from_id = $${i}) OR (to_type = $${t} AND to_id = $${i}))`);
    }
  }

  // Non-HO employees only see transfers involving their warehouse OR one of
  // that warehouse's mapped outlets. The old branchId equality leaked none of
  // the child-outlet work to a warehouse manager and encouraged client filters.
  // The alias must name what this query actually selects FROM: the list query
  // uses the bare table, while the detail query aliases it `t`. A mismatch here
  // is invisible to head-office users (their fragment is a constant TRUE) and
  // only 500s for the branch users the scope exists to restrict.
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (emp) conds.push(scopeTransferWhere(await getUserDataScope(emp), params, "stock_transfers"));

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
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  const enriched = result.rows.map((r: any) => ({
    id: r.id,
    challanNumber: r.challan_number,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    transferDate: r.transfer_date,
    lineItems: showValuation ? (r.line_items ?? []) : stripLineCost(r.line_items),
    isInterstate: r.is_interstate,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    receivedLineItems: showValuation ? (r.received_line_items ?? []) : stripLineCost(r.received_line_items),
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

router.post("/stock/transfers", requireModuleAction("page:/transfers", "add"), async (req, res): Promise<void> => {
  const parsed = CreateStockTransferBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const transferScope = await getUserDataScope((req as any).employee);
  // Dispatch is authorized by the source. A warehouse manager may send its
  // own stock to another warehouse; requiring the destination to be theirs
  // would make legitimate inter-warehouse dispatch impossible.
  if (!isLocationInScope(transferScope, parsed.data.fromType, parsed.data.fromId)) {
    res.status(403).json({ error: "You can only dispatch stock from a location in your assigned scope." }); return;
  }

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
  // Retired outlets take no part in new stock movement, in either direction.
  if ((parsed.data.fromType === 'outlet' || parsed.data.toType === 'outlet') && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  // A disabled warehouse takes no part in NEW stock movement, in either
  // direction. Transfers already in flight stay receivable so nothing is
  // stranded mid-journey.
  {
    const disabledMsg = await disabledWarehouseError(pool, [
      { type: parsed.data.fromType, id: parsed.data.fromId },
      { type: parsed.data.toType, id: parsed.data.toId },
    ]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }
  // Discontinued products take no part in NEW movement. Transfers already in
  // flight are unaffected — dispatch, receive and reject stay open so nothing
  // gets stranded mid-journey. materialType rides on the raw body (zod strips it).
  const inactiveMsg = await blockedByInactiveProducts(
    pool,
    rawLines
      .map((li, i) => ({
        kind: ((rawLines[i] as any)?.materialType ?? 'item') as any,
        id: Number(li.itemId),
      }))
      .filter(ref => isProductKind(ref.kind)),
  );
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }
  const challanNumber = `CHN-${Date.now()}`;

  // GST-aware transfer classification — compare source + destination GSTINs
  const [fromGst, toGst] = await Promise.all([
    resolveLocationGst(pool, parsed.data.fromType, parsed.data.fromId),
    resolveLocationGst(pool, parsed.data.toType, parsed.data.toId),
  ]);
  const { transferType, taxType, isInterstate } = classifyTransfer(fromGst, toGst);
  // Read once, outside the transaction: the switch decides which document this
  // transfer gets, and it must not change halfway through.
  const invoicingEnabled = await isTransferInvoicingEnabled(pool);

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
  let transferInvoiceNumber: string | null = null;
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
        materialType: ((rawLines[i] as any)?.materialType ?? 'item') as any,
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
        // Raw Material: availability is now per location, not a global counter.
        const { rows: [mat] } = await client.query(
          `SELECT id, name, unit FROM materials WHERE id = $1 FOR UPDATE`,
          [li.itemId]
        );
        if (!mat) { await client.query("ROLLBACK"); res.status(400).json({ error: `Raw Material #${li.itemId} not found` }); return; }
        // Stock already committed elsewhere cannot be dispatched, so the check
        // is against available (on hand − held), not the raw on-hand figure.
        const avail = await availabilityAt(client, {
          refId: li.itemId, materialType: 'material',
          branchType: parsed.data.fromType, branchId: parsed.data.fromId, lock: true,
        });
        if (avail.available + 0.001 < Number(li.quantity)) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: mat.name ?? `Raw Material #${li.itemId}`,
              locationName: branchFn(parsed.data.fromType, parsed.data.fromId),
              unit: mat.unit, quantity: avail.quantity, reserved: avail.reserved,
              requested: Number(li.quantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        // mirror stays put: a dispatch relocates goods, it does not change the
        // company-wide total. The mirror is corrected only on receive/reject.
        const moved = await deductMaterialAt(
          client, 'material', li.itemId, parsed.data.fromType, parsed.data.fromId, Number(li.quantity)
        );
        if (!moved.ok) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: mat.name ?? `Raw Material #${li.itemId}`,
              locationName: branchFn(parsed.data.fromType, parsed.data.fromId),
              unit: mat.unit, quantity: moved.available, reserved: avail.reserved,
              requested: Number(li.quantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        // Materials carry lots too: pull FEFO so mfg/expiry dates travel with
        // the goods and a rejection can restore the exact lots.
        const matBreakdown = await consumeBatches(client, {
          itemId: li.itemId, materialType: 'material',
          branchType: parsed.data.fromType, branchId: parsed.data.fromId,
          quantity: Number(li.quantity),
          override: rawLines[i]?.batchOverride,
        });
        await reserveDispatchedInTransit(client, {
          transferId: row.id, challanNumber, refId: li.itemId, materialType: 'material',
          branchType: row.from_type, branchId: row.from_id,
          quantity: Number(li.quantity), breakdown: matBreakdown, fallbackCost: Number(li.costPrice ?? 0),
        });
        enrichedLines.push({ ...li, materialType, batchBreakdown: matBreakdown });
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'material', refId: li.itemId, itemName: mat.name ?? '', unit: mat.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      } else if (materialType === 'raw_material') {
        // Packing Material: availability is now per location, not a global counter.
        const { rows: [rm] } = await client.query(
          `SELECT id, name, unit FROM raw_materials WHERE id = $1 FOR UPDATE`,
          [li.itemId]
        );
        if (!rm) { await client.query("ROLLBACK"); res.status(400).json({ error: `Packing Material #${li.itemId} not found` }); return; }
        const avail = await availabilityAt(client, {
          refId: li.itemId, materialType: 'raw_material',
          branchType: parsed.data.fromType, branchId: parsed.data.fromId, lock: true,
        });
        if (avail.available + 0.001 < Number(li.quantity)) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: rm.name ?? `Packing Material #${li.itemId}`,
              locationName: branchFn(parsed.data.fromType, parsed.data.fromId),
              unit: rm.unit, quantity: avail.quantity, reserved: avail.reserved,
              requested: Number(li.quantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        const moved = await deductMaterialAt(
          client, 'raw_material', li.itemId, parsed.data.fromType, parsed.data.fromId, Number(li.quantity)
        );
        if (!moved.ok) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: rm.name ?? `Packing Material #${li.itemId}`,
              locationName: branchFn(parsed.data.fromType, parsed.data.fromId),
              unit: rm.unit, quantity: moved.available, reserved: avail.reserved,
              requested: Number(li.quantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        const rmBreakdown = await consumeBatches(client, {
          itemId: li.itemId, materialType: 'raw_material',
          branchType: parsed.data.fromType, branchId: parsed.data.fromId,
          quantity: Number(li.quantity),
          override: rawLines[i]?.batchOverride,
        });
        await reserveDispatchedInTransit(client, {
          transferId: row.id, challanNumber, refId: li.itemId, materialType: 'raw_material',
          branchType: row.from_type, branchId: row.from_id,
          quantity: Number(li.quantity), breakdown: rmBreakdown, fallbackCost: Number(li.costPrice ?? 0),
        });
        enrichedLines.push({ ...li, materialType, batchBreakdown: rmBreakdown });
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'raw_material', refId: li.itemId, itemName: rm.name ?? '', unit: rm.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      } else {
        // Item (SKU): deduct from stock_entries. The row is locked and the check
        // is against available, so a concurrent dispatch or sale of the same
        // stock waits here rather than passing the same quantity twice.
        const avail = await availabilityAt(client, {
          refId: li.itemId, materialType: 'item',
          branchType: parsed.data.fromType, branchId: parsed.data.fromId, lock: true,
        });
        if (avail.available + 0.001 < Number(li.quantity)) {
          await client.query("ROLLBACK");
          const { rows: [it] } = await pool.query(`SELECT name, unit FROM items WHERE id = $1`, [li.itemId]);
          res.status(400).json({
            error: insufficientStockMessage({
              productName: it?.name ?? `Item #${li.itemId}`,
              locationName: branchFn(parsed.data.fromType, parsed.data.fromId),
              unit: it?.unit, quantity: avail.quantity, reserved: avail.reserved,
              requested: Number(li.quantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        await client.query(
          `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
          [li.quantity, avail.entryId]
        );
        const batchBreakdown = await consumeBatches(client, {
          itemId: li.itemId,
          branchType: parsed.data.fromType,
          branchId: parsed.data.fromId,
          quantity: li.quantity,
          override: rawLines[i]?.batchOverride,
        });
        await reserveDispatchedInTransit(client, {
          transferId: row.id, challanNumber, refId: li.itemId, materialType: 'item',
          branchType: row.from_type, branchId: row.from_id,
          quantity: Number(li.quantity), breakdown: batchBreakdown, fallbackCost: Number(li.costPrice ?? 0),
        });
        enrichedLines.push({ ...li, materialType: 'item', batchBreakdown });
        const { rows: [itemMeta] } = await pool.query(`SELECT name, unit FROM items WHERE id = $1`, [li.itemId]);
        dispatchLedgerEntries.push({ txnType: 'transfer_out', materialType: 'item', refId: li.itemId, itemName: itemMeta?.name ?? '', unit: itemMeta?.unit ?? '', branchType: row.from_type, branchId: row.from_id, branchName: branchFn(row.from_type, row.from_id), qtyChange: -Number(li.quantity), unitCost: Number(li.costPrice ?? 0), docType: 'stock_transfer', docId: row.id });
      }
    }
    await writeStockLedger(client, dispatchLedgerEntries);

    // ── Taxable inter-branch transfer: source-side document ─────────────────
    // Same GSTIN ('internal') is a delivery challan only — no supply, no tax,
    // no document. Different GSTIN is a taxable supply and gets EITHER a tax
    // invoice (the default) OR the legacy journal voucher (module switched
    // off), never both: the invoice and the voucher record the same postings,
    // so raising both would double revenue, tax and the inter-branch balance.
    if (transferType !== 'internal') {
      // All dispatched kinds are priced, not just finished goods — a packing
      // material crossing a GSTIN boundary is just as taxable.
      const invLines = await buildTransferInvoiceLines(
        client,
        enrichedLines.map((l: any) => ({ itemId: l.itemId, quantity: l.quantity, costPrice: l.costPrice ?? 0, materialType: l.materialType ?? 'item' })),
        taxType,
      );
      const gst = totalsFromLines(invLines);
      if (gst.taxableValue > 0) {
        if (invoicingEnabled) {
          const invoiceNumber = await nextTransferInvoiceNumber(client);
          const saleId = await createTransferSaleInvoice({
            client, transferId: row.id, invoiceNumber,
            transferDate: parsed.data.transferDate,
            fromLocation: fromGst, toLocation: toGst,
            lines: invLines, totals: gst, challanNumber,
          });
          await client.query(
            `UPDATE stock_transfers
                SET transfer_value = $1, gst_amount = $2, document_mode = 'invoice',
                    transfer_invoice_number = $3, sale_id = $4
              WHERE id = $5`,
            [gst.taxableValue, gst.totalGst, invoiceNumber, saleId, row.id],
          );
          transferInvoiceNumber = invoiceNumber;
        } else {
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
          // Stamp 'voucher' explicitly. The receive/reject legs read the stamp,
          // not the current setting, so a transfer dispatched while invoicing is
          // off must never be received as an invoice if someone flips the switch
          // mid-flight. NULL is read as 'voucher' too, but leaving it NULL makes
          // "never invoiced" indistinguishable from "predates the column".
          await client.query(
            `UPDATE stock_transfers
                SET transfer_value = $1, gst_amount = $2, document_mode = 'voucher',
                    dispatch_voucher_id = $3
              WHERE id = $4`,
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
    transferType,
    taxType,
    transferInvoiceNumber,
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
router.patch("/stock/transfers/:id/approve", requireModuleAction("page:/transfers", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { receivedLineItems, approvedBy } = req.body as { receivedLineItems?: Array<{ itemId: number; quantity: number; costPrice?: number }>; approvedBy?: string };
  const approveScope = await getUserDataScope((req as any).employee);

  const client = await pool.connect();
  let row: any;
  let linesToCredit: Array<{ itemId: number; quantity: number; costPrice: number; materialType?: string }>;
  const shortReceived: Array<{ itemId: number; materialType: string; dispatched: number; received: number; shortfall: number }> = [];
  try {
    await client.query("BEGIN");
    // Receiving is authorized by the destination, not merely by either side of
    // the transfer. Lock first so the scope check and status transition refer to
    // the same immutable endpoints.
    const { rows: [visible] } = await client.query(
      `SELECT to_type, to_id FROM stock_transfers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!visible) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Transfer not found" }); return;
    }
    if (!isLocationInScope(approveScope, visible.to_type, Number(visible.to_id))) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Transfer not found" }); return;
    }

    // Atomic claim: flips status only if still in transit, so a concurrent
    // approve/reject gets zero rows instead of double-applying stock effects.
    const claim = await client.query(
      `UPDATE stock_transfers SET status = 'completed', approved_by = $1, approved_at = now()
       WHERE id = $2 AND status = 'in_transit'
       RETURNING id, from_type, from_id, to_type, to_id, line_items, challan_number,
                 transfer_type, tax_type, transfer_date, transfer_value, gst_amount,
                 document_mode, transfer_invoice_number`,
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

    // The shipment has landed: it is no longer in transit, so its in-transit
    // reservations are settled here. The destination credit below puts the goods
    // back into a location's on-hand figure, and leaving the reservations active
    // would then count the same stock twice. Released inside this transaction so
    // a failure downstream leaves the transfer in flight, not counted nowhere.
    await releaseReservations(client, {
      docType: 'stock_transfer', docId: id, kind: 'in_transit',
      notes: `Received on challan ${row.challan_number}`,
    });

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
      // Items, materials and packing materials share one id space, so a single
      // transfer can legitimately carry the same numeric id twice under two
      // different kinds. Every lookup below therefore resolves on the
      // (materialType, itemId) pair — keying on the id alone would reject valid
      // transfers and credit the wrong lots.
      const seen = new Set<string>();
      const validated: Array<{ itemId: number; quantity: number; costPrice: number; materialType?: string }> = [];
      for (const li of receivedLineItems) {
        const itemId = Number(li?.itemId);
        const qty = Number(li?.quantity);
        if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isFinite(qty) || qty < 0) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "Each received line needs a valid itemId and a non-negative quantity" });
          return;
        }
        const rawType = typeof (li as any)?.materialType === 'string' ? (li as any).materialType : null;
        const candidates = dispatchedLines.filter(x => Number(x.itemId) === itemId);
        const d = rawType
          ? candidates.find(x => (x.materialType ?? 'item') === rawType)
          : candidates.length === 1 ? candidates[0] : undefined;
        if (!d) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: candidates.length > 1
              ? `This transfer carries item ${itemId} under more than one product type — each received line must name its materialType`
              : `Item ${itemId} was not part of this transfer`,
          });
          return;
        }
        const key = `${d.materialType ?? 'item'}:${itemId}`;
        if (seen.has(key)) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Duplicate received line for item ${itemId}` });
          return;
        }
        seen.add(key);
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

      if (matType === 'material' || matType === 'raw_material') {
        // Material: land it at the destination location. The dispatch already
        // took it off the source, so the company-wide mirror is untouched — a
        // completed transfer relocates goods without changing the total.
        await creditMaterialAt(
          client, matType, li.itemId, destType, destId, Number(li.quantity), Number(li.costPrice ?? 0)
        );
        // Material lots travel with the goods, same rule as finished items:
        // land the dispatched lots at the destination, allocated across a
        // partial receipt, and fall back to a challan-named lot when the
        // dispatch predates material lot tracking.
        const matDispatched = dispatchedLines.find(
          d => Number(d.itemId) === Number(li.itemId) && (d.materialType ?? 'item') === matType
        );
        const matBreakdown = matDispatched?.batchBreakdown ?? [];
        if (matBreakdown.length > 0) {
          for (const b of allocateReceived(matBreakdown, Number(li.quantity))) {
            await creditBatch(client, {
              itemId: li.itemId, materialType: matType,
              branchType: destType, branchId: destId,
              batchNumber: b.batchNumber, mfgDate: b.mfgDate, expiryDate: b.expiryDate,
              quantity: b.quantity, unitCost: b.unitCost, source: "transfer", sourceId: id,
              ...(await productBatchIdentity(client, matType as any, Number(li.itemId))),
            });
          }
        } else {
          await creditBatch(client, {
            itemId: li.itemId, materialType: matType,
            branchType: destType, branchId: destId,
            batchNumber: `TRF-${row.challan_number}`, quantity: Number(li.quantity),
            unitCost: Number(li.costPrice ?? 0), source: "transfer", sourceId: id,
            ...(await productBatchIdentity(client, matType as any, Number(li.itemId))),
          });
        }
      } else {
        // Item (SKU): credit stock_entries + batches
        const { rows: [dstExisting] } = await client.query(
          `SELECT id FROM stock_entries
            WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
          [li.itemId, destType, destId]
        );
        if (dstExisting) {
          await client.query(
            `UPDATE stock_entries SET quantity = quantity::numeric + $1, cost_price = $2, updated_at = now() WHERE id = $3`,
            [li.quantity, String(li.costPrice ?? 0), dstExisting.id]
          );
        } else {
          await client.query(
            `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price) VALUES ($1,'item',$2,$3,$4,$5)`,
            [li.itemId, destType, destId, li.quantity, String(li.costPrice ?? 0)]
          );
        }
        // Batches travel with the goods. Match on the (kind, id) pair: a
        // material line can share this numeric id, and inheriting its lots
        // would credit the finished item with another product's provenance.
        const dispatched = dispatchedLines.find(
          d => Number(d.itemId) === Number(li.itemId) && (d.materialType ?? 'item') === 'item'
        );
        const breakdown = dispatched?.batchBreakdown ?? [];
        if (breakdown.length > 0) {
          const allocation = allocateReceived(breakdown, Number(li.quantity));
          for (const b of allocation) {
            await creditBatch(client, {
              itemId: li.itemId, branchType: destType, branchId: destId,
              batchNumber: b.batchNumber, mfgDate: b.mfgDate, expiryDate: b.expiryDate,
              quantity: b.quantity, unitCost: b.unitCost, source: "transfer", sourceId: id,
              ...(await productBatchIdentity(client, "item", Number(li.itemId))),
            });
          }
        } else {
          await creditBatch(client, {
            itemId: li.itemId, branchType: destType, branchId: destId,
            batchNumber: `TRF-${row.challan_number}`, quantity: Number(li.quantity),
            unitCost: Number(li.costPrice ?? 0), source: "transfer", sourceId: id,
            ...(await productBatchIdentity(client, "item", Number(li.itemId))),
          });
        }
        // Update destination average cost (same formula as a regular inbound purchase)
        await updateAvgCostOnInbound(client, li.itemId, Number(li.quantity), Number(li.costPrice ?? 0));
      }
    }

    // ── Taxable inter-branch transfer: destination-side document ────────────
    // Mirrors whichever document the dispatch raised. The stamp on the transfer
    // decides, not the current setting — a transfer that left as a voucher must
    // land as a voucher even if the module was switched on mid-flight, or the
    // two legs would post to different ledgers and never offset.
    let receiveVoucherId: number | null = null;
    let purchaseInvoiceId: number | null = null;
    if (row.transfer_type && row.transfer_type !== 'internal' && Number(row.transfer_value ?? 0) > 0) {
      const txnDate = row.transfer_date
        ? new Date(row.transfer_date).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      const taxType = (row.tax_type ?? 'none') as TaxType;

      if (String(row.document_mode ?? 'voucher') === 'invoice' && row.transfer_invoice_number) {
        const [fromLocGst, toLocGst] = await Promise.all([
          resolveLocationGst(pool, row.from_type, Number(row.from_id)),
          resolveLocationGst(pool, row.to_type, Number(row.to_id)),
        ]);
        // Priced from the DISPATCHED lines so the inward invoice is the same
        // document as the sender's outward one. Short receipts do not shrink it
        // (see createTransferPurchaseInvoice).
        const invLines: TransferInvoiceLine[] = await buildTransferInvoiceLines(
          client,
          dispatchedLines.map(l => ({ itemId: Number(l.itemId), quantity: Number(l.quantity), costPrice: Number(l.costPrice ?? 0), materialType: l.materialType ?? 'item' })),
          taxType,
        );
        purchaseInvoiceId = await createTransferPurchaseInvoice({
          client, transferId: id,
          invoiceNumber: String(row.transfer_invoice_number),
          transferDate: txnDate,
          fromLocation: fromLocGst, toLocation: toLocGst,
          lines: invLines, totals: totalsFromLines(invLines),
          challanNumber: row.challan_number,
        });
      } else {
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
          transferDate: txnDate,
          toLocation: toLocGst,
          gst: storedGst,
          taxType,
          narration: `Inter-branch transfer ${row.challan_number} — received at ${toLocGst.name}`,
          createdBy: approvedBy ?? null,
        });
      }
    }

    // ── Short receipt: goods dispatched that never arrived ───────────────────
    // The destination is credited with what it actually counted, which may be
    // less than what left the source. That difference is not nothing: the
    // source's stock is already gone, so releasing the whole document's
    // in-transit rows here would make the missing units — and their value —
    // disappear from every location and every total at once.
    //
    // So the shortfall stays an ACTIVE in-transit commitment owned by the
    // sender: still out of everyone's on-hand figure (it is not on a shelf),
    // still valued as the sender's stock, and visibly unreconciled until
    // somebody decides whether it was lost, stolen or is still coming. It does
    // not reduce available quantity, because those units were deducted at
    // dispatch. Writing the loss off against a ledger is a business decision,
    // not something to do silently here.
    for (const d of dispatchedLines) {
      const kind = (d.materialType ?? 'item') as 'item' | 'material' | 'raw_material';
      const received = linesToCredit.find(
        l => Number(l.itemId) === Number(d.itemId) && (l.materialType ?? 'item') === kind
      );
      const shortfall = r3(Number(d.quantity) - Number(received?.quantity ?? 0));
      if (shortfall <= 0.001) continue;
      shortReceived.push({
        itemId: Number(d.itemId), materialType: kind,
        dispatched: r3(Number(d.quantity)),
        received: r3(Number(received?.quantity ?? 0)),
        shortfall,
      });
      await reserveStock(client, {
        kind: 'in_transit',
        docType: 'stock_transfer', docId: id,
        refId: Number(d.itemId), materialType: kind,
        branchType: row.from_type, branchId: Number(row.from_id),
        lines: [{ quantity: shortfall, unitCost: Number(d.costPrice ?? 0) }],
        notes: `Short receipt on challan ${row.challan_number}: ${shortfall} of ${r3(Number(d.quantity))} dispatched units were never received — unreconciled`,
      });
    }

    await client.query(
      `UPDATE stock_transfers SET received_line_items = $1, receive_voucher_id = $2, purchase_id = $3 WHERE id = $4`,
      [JSON.stringify(linesToCredit), receiveVoucherId, purchaseInvoiceId, id],
    );

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

  // shortReceived is surfaced, never swallowed: a receipt that came up short is
  // an exception someone has to act on, not a rounding detail.
  res.json({
    success: true, id, status: "completed", fromName, toName,
    shortReceived,
    ...(shortReceived.length > 0
      ? { shortReceivedNote: `${shortReceived.length} line(s) were received short. The missing quantity stays recorded against ${fromName} as unreconciled in-transit stock until it is found or written off.` }
      : {}),
  });
});

// Reject a transfer — reverses the source deduction
router.patch("/stock/transfers/:id/reject", requireModuleAction("page:/transfers", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rejectionReason } = req.body as { rejectionReason?: string };
  const rejectScope = await getUserDataScope((req as any).employee);

  const client = await pool.connect();
  let row: any;
  let fromName = '';
  try {
    await client.query("BEGIN");
    // A rejection reverses stock to the source, so it is a sender-side action.
    // Do not let a user who only happens to know a challan id reverse another
    // warehouse's outbound movement.
    const { rows: [visible] } = await client.query(
      `SELECT from_type, from_id FROM stock_transfers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!visible) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Transfer not found" }); return;
    }
    if (!isLocationInScope(rejectScope, visible.from_type, Number(visible.from_id))) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Transfer not found" }); return;
    }

    // Atomic claim (see approve): only one of approve/reject can win.
    const claim = await client.query(
      `UPDATE stock_transfers SET status = 'rejected', rejection_reason = $1
       WHERE id = $2 AND status = 'in_transit'
       RETURNING id, from_type, from_id, to_type, to_id, line_items, challan_number,
                 transfer_type, tax_type, transfer_date, transfer_value, gst_amount,
                 document_mode, transfer_invoice_number, sale_id`,
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

    const lineItems = row.line_items as Array<{ itemId: number; quantity: number; costPrice?: number; batchBreakdown?: BatchBreakdownEntry[]; materialType?: string }>;

    // Nothing is in flight any more — the goods are going back to the sender's
    // on-hand stock below, so the in-transit rows must go or the returned
    // quantity would be counted both as on hand and as in transit.
    await releaseReservations(client, {
      docType: 'stock_transfer', docId: id, kind: 'in_transit',
      notes: `Rejected — returned to source on challan ${row.challan_number}`,
    });

    // Reverse source deduction (goods returned)
    for (const li of lineItems) {
      const matType = li.materialType ?? 'item';

      if (matType === 'material' || matType === 'raw_material') {
        // Rejected: put the material back exactly where it was dispatched from.
        await creditMaterialAt(
          client, matType, li.itemId, row.from_type, row.from_id, Number(li.quantity), Number(li.costPrice ?? 0)
        );
        await restoreBatches(client, li.itemId, row.from_type, row.from_id, li.batchBreakdown, "transfer", id, matType);
      } else {
        const { rows: [srcExisting] } = await client.query(
          `SELECT id FROM stock_entries
            WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
          [li.itemId, row.from_type, row.from_id]
        );
        if (srcExisting) {
          await client.query(
            `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
            [li.quantity, srcExisting.id]
          );
        } else {
          await client.query(
            `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price) VALUES ($1,'item',$2,$3,$4,$5)`,
            [li.itemId, row.from_type, row.from_id, li.quantity, String(li.costPrice ?? 0)]
          );
        }
        // Restore exactly the batches that were consumed at dispatch
        await restoreBatches(client, li.itemId, row.from_type, row.from_id, li.batchBreakdown, "transfer", id);
      }
    }

    // ── Stock ledger — inside the transaction so it rolls back atomically ──────
    const rejectBm = await buildBranchMaps();
    fromName = rejectBm(row.from_type, Number(row.from_id));
    const rejectMeta = await batchResolveMeta(client, lineItems.map(l => ({ materialType: (l.materialType ?? 'item') as string, refId: Number(l.itemId) })));
    await writeStockLedger(client, lineItems.map(l => {
      const mt   = (l.materialType ?? 'item') as string;
      const info = rejectMeta.get(`${mt}:${l.itemId}`) ?? { name: '', unit: '' };
      return { txnType: 'transfer_in', materialType: mt, refId: Number(l.itemId), itemName: info.name, unit: info.unit, branchType: row.from_type, branchId: Number(row.from_id), branchName: fromName, qtyChange: Number(l.quantity), unitCost: Number(l.costPrice ?? 0), docType: 'stock_transfer', docId: id, notes: 'Transfer rejected — stock returned to source' };
    }));

    // ── Rejected after a tax invoice was raised → credit note ────────────────
    // The stock has gone back, but the invoice is a filed-or-filable document:
    // it cannot just vanish. Reversing it needs its own numbered voucher, and
    // the invoice has to stop feeding the GST returns. Voucher-mode transfers
    // are untouched here — that hole is pre-existing and outside this change.
    if (String(row.document_mode ?? 'voucher') === 'invoice' && row.sale_id && Number(row.transfer_value ?? 0) > 0) {
      const [fromLocGst, toLocGst] = await Promise.all([
        resolveLocationGst(pool, row.from_type, Number(row.from_id)),
        resolveLocationGst(pool, row.to_type, Number(row.to_id)),
      ]);
      const gstAmt = Number(row.gst_amount ?? 0);
      const taxable = Number(row.transfer_value);
      const cnHalf = Math.round(gstAmt / 2 * 100) / 100;
      const cnTotals: GstTotals = {
        taxableValue: taxable,
        cgst: row.tax_type === 'cgst_sgst' ? cnHalf : 0,
        sgst: row.tax_type === 'cgst_sgst' ? Math.round((gstAmt - cnHalf) * 100) / 100 : 0,
        igst: row.tax_type === 'igst' ? gstAmt : 0,
        totalGst: gstAmt,
        totalWithGst: Math.round((taxable + gstAmt) * 100) / 100,
      };
      const cnId = await createTransferCreditNote({
        client, transferId: id, saleId: Number(row.sale_id),
        invoiceNumber: String(row.transfer_invoice_number ?? `#${row.sale_id}`),
        transferDate: row.transfer_date
          ? new Date(row.transfer_date).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        fromLocation: fromLocGst, toLocation: toLocGst,
        totals: cnTotals, taxType: (row.tax_type ?? 'none') as TaxType,
        challanNumber: row.challan_number,
        reason: rejectionReason || null,
        createdBy: null,
      });
      if (cnId) {
        await client.query(`UPDATE stock_transfers SET credit_note_voucher_id = $1 WHERE id = $2`, [cnId, id]);
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "UPDATE", module: "transfers", entityType: "stock_transfer", entityId: id,
    description: `Transfer ${row.challan_number} rejected — stock reversed to ${fromName}`,
    metadata: { after: { status: "rejected", rejectionReason } },
  }).catch(() => {});

  res.json({ success: true, id, status: "rejected" });
});

router.get("/stock/transfers/:id", requireModuleView("page:/transfers"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid transfer id" }); return; }
  const transferScope = await getUserDataScope((req as any).employee);
  const transferParams: unknown[] = [id];
  const result = await pool.query(
    `SELECT id, challan_number, from_type, from_id, to_type, to_id, transfer_date,
            line_items, is_interstate, status, notes, created_at,
            approved_by, approved_at, received_line_items, rejection_reason,
            transfer_type, from_gstin, to_gstin, tax_type, transfer_value, gst_amount
     FROM stock_transfers t WHERE id = $1 AND ${scopeTransferWhere(transferScope, transferParams)} LIMIT 1`,
    transferParams
  );
  const r = result.rows[0];
  if (!r) { res.status(404).json({ error: "Not found" }); return; }
  const branchName = await buildBranchMaps();
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);
  res.json({
    id: r.id,
    challanNumber: r.challan_number,
    fromType: r.from_type,
    fromId: r.from_id,
    toType: r.to_type,
    toId: r.to_id,
    transferDate: r.transfer_date,
    lineItems: showValuation ? (r.line_items ?? []) : stripLineCost(r.line_items),
    isInterstate: r.is_interstate,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    receivedLineItems: showValuation ? (r.received_line_items ?? []) : stripLineCost(r.received_line_items),
    rejectionReason: r.rejection_reason,
    transferType: r.transfer_type ?? 'internal',
    fromGstin: r.from_gstin ?? null,
    toGstin: r.to_gstin ?? null,
    taxType: r.tax_type ?? 'none',
    transferValue: r.transfer_value != null ? Number(r.transfer_value) : null,
    gstAmount: r.gst_amount != null ? Number(r.gst_amount) : null,
    documentMode: r.document_mode ?? 'voucher',
    transferInvoiceNumber: r.transfer_invoice_number ?? null,
    saleId: r.sale_id ?? null,
    purchaseId: r.purchase_id ?? null,
    creditNoteVoucherId: r.credit_note_voucher_id ?? null,
    fromName: branchName(r.from_type, r.from_id),
    toName: branchName(r.to_type, r.to_id),
  });
});

export default router;

/**
 * Item Tracking — the complete lifecycle of one product in one view.
 *
 * Read-only. For a given product (finished item / raw material / packing
 * material) it collects, from the SOURCE documents (never a derived cache):
 *   • purchase history        — purchases JSONB lines (vendor, invoice, batch, rate)
 *   • sales history           — sales JSONB lines (invoice, customer, rate, GST)
 *   • sales / purchase returns
 *   • transfers               — stock_transfers (both directions, any status)
 *   • production              — productions (items: output; materials: consumption)
 *   • adjustments             — stock_verifications variance lines (items only)
 *   • current stock           — stock_entries truth, per location
 *
 * Summary buckets follow the memory rules: cancelled documents are excluded,
 * and cross-GSTIN branch-transfer invoices (branch_transfer_id NOT NULL) count
 * as TRANSFERS, never as purchases/sales — they are still listed in history,
 * flagged, so nothing is hidden.
 *
 * Cost figures (purchase rate, avg cost, stock value, production cost) are
 * OMITTED — not zeroed — for callers without the inventory-valuation right.
 * Sale prices ride the page view right: they are commercial but not cost data.
 *
 * LBAC: head office sees everything; branch users see documents whose
 * location falls inside their scope, same gates as the source modules.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, canViewStockValuation } from "../middleware/permissions";
import { getUserDataScope, scopeSalesWhere, scopeBranchWhere, scopeTransferWhere, type DataScope } from "../lib/dataScope";
import { buildBranchMaps } from "./stock";

const router: IRouter = Router();
const KINDS = new Set(["item", "material", "raw_material"]);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const HISTORY_CAP = 200;

/** location_type/location_id scope fragment (purchases, productions, sales_returns). */
function scopeLocWhere(scope: DataScope, params: unknown[], alias: string): string {
  if (scope.isHeadOffice) return "TRUE";
  const conds: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(`(${alias}.location_type = 'warehouse' AND ${alias}.location_id = ANY($${params.length}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(`(${alias}.location_type = 'outlet' AND ${alias}.location_id = ANY($${params.length}::int[]))`);
  }
  return conds.length ? `(${conds.join(" OR ")})` : "FALSE";
}

router.get("/item-tracking", requireModuleView(["page:/headoffice/stock", "page:/production/item-master"]), async (req, res): Promise<void> => {
  const materialType = String(req.query.materialType ?? "item");
  const itemId = Number(req.query.itemId);
  if (!KINDS.has(materialType)) { res.status(400).json({ error: "Invalid materialType" }); return; }
  if (!Number.isInteger(itemId) || itemId <= 0) { res.status(400).json({ error: "Invalid itemId" }); return; }

  const emp = (req as any).employee as { branchType: string; branchId: number; hierarchyId?: number } | undefined;
  const scope = await getUserDataScope(emp ?? { branchType: "headoffice", branchId: 1 });
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  // ── Master row (three overlapping id spaces — never cross the kind) ────────
  const masterTable = materialType === "item" ? "items" : materialType === "material" ? "materials" : "raw_materials";
  const { rows: [master] } = await pool.query(
    `SELECT id, name, unit, hsn_code, avg_cost, cost${materialType === "item" ? ", mrp, item_code" : ""} FROM ${masterTable} WHERE id = $1`,
    [itemId]);
  if (!master) { res.status(404).json({ error: "Product not found" }); return; }

  const branchNamesP = buildBranchMaps();

  // ── Purchases (JSONB line scan; lines key the product as materialId+materialType)
  const purParams: unknown[] = [itemId, materialType];
  const purScope = scopeLocWhere(scope, purParams, "p");
  const purchasesP = pool.query(
    `SELECT p.id, p.invoice_number, p.vendor_invoice_date, p.purchase_date, p.location_type, p.location_id,
            p.cancelled_at, p.branch_transfer_id, COALESCE(v.name, p.party_name, '') AS vendor_name,
            li->>'batchNumber' AS batch_number,
            (li->>'quantity')::numeric AS quantity,
            COALESCE(li->>'costPerUnit', li->>'unitCost') AS rate,
            (li->>'taxableValue')::numeric AS taxable_value
       FROM purchases p
       LEFT JOIN vendors v ON v.id = p.vendor_id,
            jsonb_array_elements(p.line_items) li
      WHERE (li->>'materialId')::int = $1 AND COALESCE(li->>'materialType', 'item') = $2
        AND ${purScope}
      ORDER BY p.purchase_date DESC, p.id DESC
      LIMIT ${HISTORY_CAP}`, purParams);

  // ── Sales (finished items only — sales lines carry itemId) ────────────────
  const salesP = materialType === "item" ? (() => {
    const sParams: unknown[] = [itemId];
    const sScope = scopeSalesWhere(scope, sParams);
    return pool.query(
      `SELECT s.id, s.invoice_number, s.sale_date, s.location_type, COALESCE(s.location_id, s.outlet_id) AS location_id,
              s.cancelled_at, s.branch_transfer_id, COALESCE(c.name, 'Walk-in') AS customer_name,
              (li->>'quantity')::numeric  AS quantity,
              (li->>'unitPrice')::numeric AS unit_price,
              COALESCE((li->>'discount')::numeric, 0)  AS discount,
              COALESCE((li->>'taxAmount')::numeric, 0) AS gst
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id,
              jsonb_array_elements(s.line_items) li
        WHERE (li->>'itemId')::int = $1
          AND ${sScope}
        ORDER BY s.sale_date DESC, s.id DESC
        LIMIT ${HISTORY_CAP}`, sParams);
  })() : Promise.resolve({ rows: [] as any[] });

  // ── Sales returns (items only) ─────────────────────────────────────────────
  const salesReturnsP = materialType === "item" ? (() => {
    const srParams: unknown[] = [itemId];
    const srScope = scopeLocWhere(scope, srParams, "sr");
    return pool.query(
      `SELECT sr.id, sr.return_number, sr.return_date, sr.location_type, sr.location_id,
              s.invoice_number, COALESCE(c.name, 'Walk-in') AS customer_name,
              (li->>'quantity')::numeric AS quantity,
              COALESCE((li->>'taxableAmount')::numeric, 0) + COALESCE((li->>'taxAmount')::numeric, 0) AS amount
         FROM sales_returns sr
         JOIN sales s ON s.id = sr.sale_id
         LEFT JOIN customers c ON c.id = sr.customer_id,
              jsonb_array_elements(sr.line_items) li
        WHERE (li->>'itemId')::int = $1
          AND ${srScope}
        ORDER BY sr.return_date DESC, sr.id DESC
        LIMIT ${HISTORY_CAP}`, srParams);
  })() : Promise.resolve({ rows: [] as any[] });

  // ── Purchase returns (location rides the parent purchase) ─────────────────
  const prParams: unknown[] = [itemId, materialType];
  const prScope = scopeLocWhere(scope, prParams, "p");
  const purchaseReturnsP = pool.query(
    `SELECT pr.id, pr.return_number, pr.return_date, COALESCE(v.name, '') AS vendor_name,
            p.invoice_number, p.location_type, p.location_id,
            (li->>'quantity')::numeric AS quantity
       FROM purchase_returns pr
       JOIN purchases p ON p.id = pr.purchase_id
       LEFT JOIN vendors v ON v.id = pr.vendor_id,
            jsonb_array_elements(pr.line_items) li
      WHERE (li->>'materialId')::int = $1 AND COALESCE(li->>'materialType', 'item') = $2
        AND ${prScope}
      ORDER BY pr.return_date DESC, pr.id DESC
      LIMIT ${HISTORY_CAP}`, prParams);

  // ── Transfers (both directions, any status — status shown per row) ────────
  const tParams: unknown[] = [itemId, materialType];
  const tScope = scopeTransferWhere(scope, tParams, "t");
  const transfersP = pool.query(
    `SELECT t.id, t.challan_number, t.transfer_date, t.from_type, t.from_id, t.to_type, t.to_id, t.status,
            (li->>'quantity')::numeric AS quantity
       FROM stock_transfers t,
            jsonb_array_elements(t.line_items) li
      WHERE (li->>'itemId')::int = $1 AND COALESCE(li->>'materialType', 'item') = $2
        AND ${tScope}
      ORDER BY t.transfer_date DESC, t.id DESC
      LIMIT ${HISTORY_CAP}`, tParams);

  // ── Production — items: output rows; materials: consumption rows ──────────
  const prodParams: unknown[] = [itemId];
  const prodScope = scopeLocWhere(scope, prodParams, "p");
  const productionsP = materialType === "item"
    ? pool.query(
        `SELECT p.id, p.batch_number, p.production_date, p.produced_quantity AS quantity,
                p.cost_per_unit, p.location_type, p.location_id, NULL::text AS role
           FROM productions p
          WHERE p.item_id = $1 AND ${prodScope}
          ORDER BY p.production_date DESC, p.id DESC
          LIMIT ${HISTORY_CAP}`, prodParams)
    : (() => {
        const mp: unknown[] = [itemId, materialType];
        const mScope = scopeLocWhere(scope, mp, "p");
        return pool.query(
          `SELECT p.id, p.batch_number, p.production_date, (mu->>'usedQuantity')::numeric AS quantity,
                  p.cost_per_unit, p.location_type, p.location_id, 'consumed'::text AS role
             FROM productions p,
                  jsonb_array_elements(p.material_used) mu
            WHERE (mu->>'materialId')::int = $1 AND mu->>'materialType' = $2
              AND ${mScope}
            ORDER BY p.production_date DESC, p.id DESC
            LIMIT ${HISTORY_CAP}`, mp);
      })();

  // ── Adjustments — stock verification variances (items only) ───────────────
  const adjP = materialType === "item" ? (() => {
    const aParams: unknown[] = [itemId];
    const aScope = scopeBranchWhere(scope, aParams, "sv");
    return pool.query(
      `SELECT sv.id, sv.verify_date, sv.branch_type, sv.branch_id, sv.created_by,
              (l->>'countedQty')::numeric AS counted_qty,
              (l->>'variance')::numeric   AS variance,
              l->>'reason'                AS reason
         FROM stock_verifications sv,
              jsonb_array_elements(sv.lines) l
        WHERE (l->>'itemId')::int = $1 AND COALESCE((l->>'variance')::numeric, 0) <> 0
          AND ${aScope}
        ORDER BY sv.verify_date DESC, sv.id DESC
        LIMIT ${HISTORY_CAP}`, aParams);
  })() : Promise.resolve({ rows: [] as any[] });

  // ── Current stock per location + in-transit (sender-owned) ────────────────
  const stParams: unknown[] = [itemId, materialType];
  const stScope = scopeBranchWhere(scope, stParams, "se");
  const stockP = pool.query(
    `SELECT se.branch_type, se.branch_id, SUM(se.quantity)::numeric AS qty
       FROM stock_entries se
      WHERE se.item_id = $1 AND se.material_type = $2 AND ${stScope}
      GROUP BY se.branch_type, se.branch_id
      HAVING SUM(se.quantity) <> 0
      ORDER BY se.branch_type, se.branch_id`, stParams);

  const [purchases, sales, salesReturns, purchaseReturns, transfers, productions, adjustments, stock, branchName] =
    await Promise.all([purchasesP, salesP, salesReturnsP, purchaseReturnsP, transfersP, productionsP, adjP, stockP, branchNamesP]);

  // ── Summary buckets ────────────────────────────────────────────────────────
  const live = (r: any) => r.cancelled_at == null && r.branch_transfer_id == null;
  const sum = (rows: any[], f: (r: any) => number) => r3(rows.reduce((s, r) => s + f(r), 0));

  const purchasedQty = sum(purchases.rows.filter(live), r => Number(r.quantity));
  const soldQty = sum(sales.rows.filter(live), r => Number(r.quantity));
  const salesReturnQty = sum(salesReturns.rows, r => Number(r.quantity));
  const purchaseReturnQty = sum(purchaseReturns.rows, r => Number(r.quantity));
  const activeTransfers = transfers.rows.filter((r: any) => r.status !== "rejected");
  const transferQty = sum(activeTransfers, r => Number(r.quantity));
  const producedQty = materialType === "item" ? sum(productions.rows, r => Number(r.quantity)) : 0;
  const consumedQty = materialType !== "item" ? sum(productions.rows, r => Number(r.quantity)) : 0;
  const adjustmentQty = sum(adjustments.rows, r => Number(r.variance));
  const currentStock = sum(stock.rows, r => Number(r.qty));
  const avgCost = Number(master.avg_cost ?? 0) > 0 ? Number(master.avg_cost) : Number(master.cost ?? 0);

  const summary: Record<string, unknown> = {
    purchasedQty, soldQty, salesReturnQty, purchaseReturnQty,
    transferQty, producedQty, consumedQty, adjustmentQty, currentStock,
    // History lists are capped; when a cap is hit the buckets above cover only
    // the newest rows, and the client shows a "showing latest N" note.
    truncated: [purchases, sales, salesReturns, purchaseReturns, transfers, productions, adjustments]
      .some(r => r.rows.length >= HISTORY_CAP),
  };
  if (showValuation) {
    summary.avgCost = r2(avgCost);
    summary.currentValue = r2(currentStock * avgCost);
  }

  res.json({
    item: {
      id: Number(master.id), materialType,
      name: String(master.name), unit: String(master.unit ?? ""),
      hsnCode: String(master.hsn_code ?? ""),
      ...(materialType === "item" ? { mrp: master.mrp != null ? Number(master.mrp) : null, itemCode: master.item_code ?? null } : {}),
    },
    summary,
    stockByLocation: stock.rows.map((r: any) => ({
      branchType: String(r.branch_type), branchId: Number(r.branch_id),
      branchName: branchName(String(r.branch_type), Number(r.branch_id)),
      quantity: r3(Number(r.qty)),
    })),
    purchaseHistory: purchases.rows.map((r: any) => {
      const row: Record<string, unknown> = {
        purchaseId: Number(r.id), invoiceNumber: r.invoice_number ?? "",
        vendorName: String(r.vendor_name), purchaseDate: r.purchase_date,
        vendorInvoiceDate: r.vendor_invoice_date ?? null,
        batchNumber: r.batch_number ?? "", quantity: r3(Number(r.quantity)),
        location: branchName(String(r.location_type), Number(r.location_id)),
        cancelled: r.cancelled_at != null, isBranchTransfer: r.branch_transfer_id != null,
      };
      if (showValuation) row.rate = r.rate != null ? r2(Number(r.rate)) : null;
      return row;
    }),
    salesHistory: sales.rows.map((r: any) => ({
      saleId: Number(r.id), invoiceNumber: String(r.invoice_number),
      customerName: String(r.customer_name), saleDate: r.sale_date,
      quantity: r3(Number(r.quantity)),
      // Sale line unitPrice is GROSS (incl. GST) — labelled so in the UI.
      unitPrice: r2(Number(r.unit_price)), discount: r2(Number(r.discount)), gst: r2(Number(r.gst)),
      location: branchName(String(r.location_type), Number(r.location_id ?? 0)),
      cancelled: r.cancelled_at != null, isBranchTransfer: r.branch_transfer_id != null,
    })),
    salesReturns: salesReturns.rows.map((r: any) => ({
      returnId: Number(r.id), returnNumber: String(r.return_number),
      againstInvoice: String(r.invoice_number), customerName: String(r.customer_name),
      returnDate: r.return_date, quantity: r3(Number(r.quantity)), amount: r2(Number(r.amount)),
      location: branchName(String(r.location_type), Number(r.location_id)),
    })),
    purchaseReturns: purchaseReturns.rows.map((r: any) => ({
      returnId: Number(r.id), returnNumber: String(r.return_number),
      againstInvoice: r.invoice_number ?? "", vendorName: String(r.vendor_name),
      returnDate: r.return_date, quantity: r3(Number(r.quantity)),
      location: branchName(String(r.location_type), Number(r.location_id)),
    })),
    transfers: transfers.rows.map((r: any) => ({
      transferId: Number(r.id), challanNumber: String(r.challan_number),
      transferDate: r.transfer_date, status: String(r.status),
      from: branchName(String(r.from_type), Number(r.from_id)),
      to: branchName(String(r.to_type), Number(r.to_id)),
      quantity: r3(Number(r.quantity)),
    })),
    production: productions.rows.map((r: any) => {
      const row: Record<string, unknown> = {
        productionId: Number(r.id), batchNumber: r.batch_number ?? "",
        productionDate: r.production_date, quantity: r3(Number(r.quantity)),
        role: r.role ?? "produced",
        location: branchName(String(r.location_type), Number(r.location_id)),
      };
      if (showValuation && materialType === "item") row.costPerUnit = r.cost_per_unit != null ? r2(Number(r.cost_per_unit)) : null;
      return row;
    }),
    adjustments: adjustments.rows.map((r: any) => ({
      verificationId: Number(r.id), verifyDate: r.verify_date,
      location: branchName(String(r.branch_type), Number(r.branch_id)),
      countedQty: r.counted_qty != null ? r3(Number(r.counted_qty)) : null,
      variance: r3(Number(r.variance)), reason: r.reason ?? null,
      createdBy: r.created_by ?? null,
    })),
    canViewValuation: showValuation,
  });
});

export default router;

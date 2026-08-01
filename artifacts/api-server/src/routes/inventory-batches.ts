import { Router } from "express";
import { pool } from "@workspace/db";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { requireModuleView, requireModuleAction, canViewStockValuation } from "../middleware/permissions";
import { logActivity } from "../lib/audit";
import { isIsoDate } from "../lib/dateInput";
import { buildBranchMaps } from "./stock";
import { consumeBatches, creditBatch, planFEFO, inboundCostForItem } from "../lib/batches";
import { writeStockLedger } from "../lib/stockLedger";
import { productBatchIdentity } from "../lib/productIdentity";
import { getUserDataScope, scopeBranchWhere } from "../lib/dataScope";
import { stockValuation, PRODUCT_UNIT_COST_SQL, PRODUCT_MASTER_JOINS, PRODUCT_KIND_LABELS, type ProductKind } from "../lib/valuation";
import { batchReservedSql, reservedSql } from "../lib/reservations";
import {
  expiryBucket, expiryStatus, summarizeExpiryBuckets, EXPIRY_BUCKET_LABELS, EXPIRY_BUCKET_TONE,
  EXPIRY_TIER_DAYS, EXPIRY_BUCKETS, movementClass, MOVEMENT_CLASSES, MOVEMENT_CLASS_LABELS,
  MOVEMENT_CLASS_DAYS, type MovementClass,
} from "../lib/inventoryAging";

const router = Router();

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const VERIFY_REASONS = ["damage", "wastage", "count_correction", "expired"] as const;
const BATCH_KINDS = ["item", "material", "raw_material"] as const;

/**
 * stock_batches is polymorphic: item_id points at items, materials or
 * raw_materials depending on material_type, and those id spaces overlap from 1.
 * Every join therefore has to carry the discriminator, or a lot of material #1
 * renders under item #1's name.
 */
const BATCH_NAME_JOIN = `
  LEFT JOIN items         i  ON i.id  = sb.item_id AND sb.material_type = 'item'
  LEFT JOIN materials     m  ON m.id  = sb.item_id AND sb.material_type = 'material'
  LEFT JOIN raw_materials rm ON rm.id = sb.item_id AND sb.material_type = 'raw_material'`;
const BATCH_NAME_COLS = `
  COALESCE(i.name, m.name, rm.name)          AS item_name,
  COALESCE(i.unit, m.unit, rm.unit)          AS unit,
  COALESCE(i.item_code, m.item_code, rm.item_code) AS item_code,
  -- Lots created before batch identity existed carry no barcode/MRP of their
  -- own. Fall back to the parent product for DISPLAY only: identity is stable,
  -- and an unstamped price is shown as today's list price rather than blank.
  COALESCE(NULLIF(sb.barcode, ''), i.barcode, m.barcode, rm.barcode) AS barcode,
  NULLIF(COALESCE(sb.mrp, i.mrp, m.mrp, rm.mrp), 0) AS mrp`;

// ── Batch listing (drill-down for stock pages) ────────────────────────────────
// Serves Stock (HO + sales), Transfers pages.
router.get("/stock/batches", requireModuleView(["page:/headoffice/stock", "page:/transfers"]), async (req, res): Promise<void> => {
  const { branchType, branchId, itemId, materialType } = req.query as Record<string, string | undefined>;
  const nearDays = Math.max(1, Number(req.query.nearDays ?? 30) || 30);

  if (materialType && !BATCH_KINDS.includes(materialType as any)) {
    res.status(400).json({ error: `materialType must be one of: ${BATCH_KINDS.join(", ")}` });
    return;
  }

  const conds: string[] = ["sb.quantity > 0"];
  const params: any[] = [];
  if (branchType) { params.push(branchType); conds.push(`sb.branch_type = $${params.length}`); }
  if (branchId != null && branchId !== "") { params.push(Number(branchId)); conds.push(`sb.branch_id = $${params.length}`); }
  // itemId is only meaningful alongside a kind — the id spaces overlap. When no
  // kind is given it defaults to items, preserving the previous behaviour of
  // every caller that passes itemId on its own.
  if (itemId) {
    params.push(Number(itemId)); conds.push(`sb.item_id = $${params.length}`);
    params.push(materialType ?? "item"); conds.push(`sb.material_type = $${params.length}`);
  } else if (materialType) {
    params.push(materialType); conds.push(`sb.material_type = $${params.length}`);
  }
  // ── Server-side data scope ─────────────────────────────────────────────────
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeBranchWhere(scope, params, 'sb'));
  }

  // Same rule as the stock rows these lots hang off: without the valuation
  // right the lot keeps its identity, dates and quantities and loses its money.
  const showValuation = await canViewStockValuation((req as any).employee?.hierarchyId);

  const [result, branchName] = await Promise.all([
    pool.query(
      `SELECT sb.id, sb.item_id, sb.material_type, sb.branch_type, sb.branch_id, sb.batch_number,
              sb.mfg_date, sb.expiry_date, sb.quantity, sb.unit_cost, sb.source,
              (sb.expiry_date::date - CURRENT_DATE) AS days_to_expiry,
              ${batchReservedSql('sb')} AS reserved,
              ${BATCH_NAME_COLS}
       FROM stock_batches sb
       ${BATCH_NAME_JOIN}
       WHERE ${conds.join(" AND ")}
       ORDER BY sb.expiry_date ASC NULLS LAST, sb.id ASC`,
      params
    ),
    buildBranchMaps(),
  ]);

  res.json(result.rows.map((b: any) => {
    const days = b.days_to_expiry == null ? null : Number(b.days_to_expiry);
    const quantity = Number(b.quantity);
    // Holds recorded against this specific lot. Reservations that name no lot
    // (untracked stock) sit at product level and are shown on the stock row, not
    // here — a lot must never claim a hold that was never pinned to it.
    const reserved = r3(Number(b.reserved ?? 0));
    const unitCost = Number(b.unit_cost);
    const bucket = expiryBucket(days);
    const lot: Record<string, unknown> = {
      id: b.id,
      itemId: b.item_id,
      materialType: b.material_type ?? "item",
      itemName: b.item_name ?? "",
      unit: b.unit ?? "",
      branchType: b.branch_type,
      branchId: b.branch_id,
      branchName: branchName(b.branch_type, b.branch_id),
      batchNumber: b.batch_number,
      mfgDate: b.mfg_date,
      expiryDate: b.expiry_date,
      quantity,
      reserved,
      available: r3(Math.max(0, quantity - reserved)),
      source: b.source,
      itemCode: b.item_code ?? "",
      barcode: b.barcode ?? "",
      // A zero MRP means "never priced", not "free" — keep it null so the UI
      // can say so instead of printing ₹0.00.
      mrp: b.mrp == null ? null : Number(b.mrp),
      daysToExpiry: days,
      status: expiryStatus(days, nearDays),
      bucket,
      bucketLabel: EXPIRY_BUCKET_LABELS[bucket],
      tone: EXPIRY_BUCKET_TONE[bucket],
    };
    if (showValuation) {
      lot.unitCost = unitCost;
      lot.value = Math.round(quantity * unitCost * 100) / 100;
    }
    return lot;
  }));
});

// ── FEFO suggestion for a planned outbound ───────────────────────────────────
router.get("/stock/batches/suggest", requireModuleView("page:/transfers"), async (req, res): Promise<void> => {
  const itemId = Number(req.query.itemId);
  const branchType = String(req.query.branchType ?? "");
  const branchId = Number(req.query.branchId);
  const quantity = Number(req.query.quantity);
  const materialType = String(req.query.materialType ?? "item");
  if (!itemId || !branchType || !Number.isFinite(branchId) || !(quantity > 0)) {
    res.status(400).json({ error: "itemId, branchType, branchId and quantity are required" });
    return;
  }
  if (!BATCH_KINDS.includes(materialType as any)) {
    res.status(400).json({ error: `materialType must be one of: ${BATCH_KINDS.join(", ")}` });
    return;
  }
  const { plan, shortfall } = await planFEFO(pool, itemId, branchType, branchId, quantity, false, materialType as any);
  res.json({ plan, shortfall });
});

// ── Expiry report ─────────────────────────────────────────────────────────────
// Tiered rather than a single "near expiry" cliff: a lot 85 days out and a lot
// 3 days out need different actions, and the widest tier (90 days) is the one
// that still leaves time to discount, transfer or push the stock.
//
// `status` selects which side of today to look at, so the same endpoint answers
// both report tabs:
//   near_expiry → dated ahead of today, inside the window
//   expired     → already past, regardless of how long ago
//   all         → both (default)
router.get("/stock/expiry-report", requireModuleView("page:/headoffice/inventory-reports"), async (req, res): Promise<void> => {
  const widest = EXPIRY_TIER_DAYS[EXPIRY_TIER_DAYS.length - 1];
  const days = Math.max(1, Number(req.query.days ?? widest) || widest);
  const status = String(req.query.status ?? "all");
  if (!["all", "near_expiry", "expired"].includes(status)) {
    res.status(400).json({ error: "status must be all, near_expiry or expired" }); return;
  }
  const { branchType, branchId, itemId, materialType, from, to } = req.query as Record<string, string | undefined>;
  if (materialType && !BATCH_KINDS.includes(materialType as any)) {
    res.status(400).json({ error: `materialType must be one of: ${BATCH_KINDS.join(", ")}` }); return;
  }

  const conds: string[] = ["sb.quantity > 0", "sb.expiry_date IS NOT NULL"];
  const params: any[] = [];
  if (status === "expired") {
    conds.push("sb.expiry_date::date < CURRENT_DATE");
  } else if (status === "near_expiry") {
    params.push(days);
    conds.push(`sb.expiry_date::date >= CURRENT_DATE AND sb.expiry_date::date <= CURRENT_DATE + $${params.length}::int`);
  } else {
    params.push(days);
    conds.push(`sb.expiry_date::date <= CURRENT_DATE + $${params.length}::int`);
  }
  if (branchType) { params.push(branchType); conds.push(`sb.branch_type = $${params.length}`); }
  if (branchId != null && branchId !== "") { params.push(Number(branchId)); conds.push(`sb.branch_id = $${params.length}`); }
  if (itemId) {
    params.push(Number(itemId)); conds.push(`sb.item_id = $${params.length}`);
    params.push(materialType ?? "item"); conds.push(`sb.material_type = $${params.length}`);
  } else if (materialType) {
    params.push(materialType); conds.push(`sb.material_type = $${params.length}`);
  }
  // The date filter reads as "expiring between", which is what a manager means
  // when they scope an expiry report to a month.
  if (from) { params.push(from); conds.push(`sb.expiry_date::date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`sb.expiry_date::date <= $${params.length}::date`); }

  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== "headoffice") {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeBranchWhere(scope, params, "sb"));
  }

  const [result, branchName] = await Promise.all([
    pool.query(
      // Raw and packing materials expire too, so the report spans all three
      // kinds rather than finished goods alone.
      `SELECT sb.id, sb.item_id, sb.material_type, sb.branch_type, sb.branch_id, sb.batch_number,
              sb.mfg_date, sb.expiry_date, sb.quantity, sb.unit_cost,
              (sb.expiry_date::date - CURRENT_DATE) AS days_to_expiry,
              ${batchReservedSql('sb')} AS reserved,
              ${BATCH_NAME_COLS}
       FROM stock_batches sb
       ${BATCH_NAME_JOIN}
       WHERE ${conds.join(" AND ")}
       ORDER BY sb.expiry_date ASC, sb.id ASC`,
      params
    ),
    buildBranchMaps(),
  ]);

  const rows = result.rows.map((b: any) => {
    const daysLeft = Number(b.days_to_expiry);
    const qty = Number(b.quantity);
    const reserved = r3(Number(b.reserved ?? 0));
    const value = Math.round(qty * Number(b.unit_cost) * 100) / 100;
    const bucket = expiryBucket(daysLeft);
    return {
      id: b.id,
      itemId: b.item_id,
      materialType: b.material_type ?? "item",
      typeLabel: PRODUCT_KIND_LABELS[(b.material_type ?? "item") as ProductKind] ?? "Item",
      itemName: b.item_name ?? "",
      itemCode: b.item_code ?? "",
      unit: b.unit ?? "",
      branchType: b.branch_type,
      branchId: b.branch_id,
      branchName: branchName(b.branch_type, b.branch_id),
      batchNumber: b.batch_number,
      mfgDate: b.mfg_date,
      expiryDate: b.expiry_date,
      mrp: b.mrp == null ? null : Number(b.mrp),
      quantity: qty,
      reserved,
      available: r3(Math.max(0, qty - reserved)),
      unitCost: Number(b.unit_cost),
      value,
      daysToExpiry: daysLeft,
      status: daysLeft < 0 ? "expired" : "near_expiry",
      bucket,
      bucketLabel: EXPIRY_BUCKET_LABELS[bucket],
      tone: EXPIRY_BUCKET_TONE[bucket],
    };
  });

  const expired = rows.filter(r => r.status === "expired");
  const nearExpiry = rows.filter(r => r.status === "near_expiry");
  res.json({
    days,
    status,
    tiers: EXPIRY_TIER_DAYS,
    rows,
    // One row per tier, always present (zeroed when empty) so the UI can render a
    // stable set of cards instead of a list that changes shape with the data.
    buckets: summarizeExpiryBuckets(rows),
    bucketOrder: EXPIRY_BUCKETS,
    summary: {
      expiredBatches: expired.length,
      expiredQuantity: r3(expired.reduce((s, r) => s + r.quantity, 0)),
      expiredValue: Math.round(expired.reduce((s, r) => s + r.value, 0) * 100) / 100,
      nearExpiryBatches: nearExpiry.length,
      nearExpiryQuantity: r3(nearExpiry.reduce((s, r) => s + r.quantity, 0)),
      nearExpiryValue: Math.round(nearExpiry.reduce((s, r) => s + r.value, 0) * 100) / 100,
    },
  });
});

// ── Stock valuation (weighted-average, at cost) ───────────────────────────────
// Delegates entirely to the one valuation function, so this report, the dashboard
// tile and the P&L closing stock are literally the same number. It used to cover
// finished goods only; raw and packing materials are stock the business owns and
// are now included, as is stock dispatched but not yet received (valued as the
// sender's until it lands, because it belongs to nobody else).
router.get("/stock/valuation", requireModuleView("page:/headoffice/inventory-reports"), async (req, res): Promise<void> => {
  const { branchType, branchId, materialType } = req.query as Record<string, string | undefined>;
  if (materialType && !BATCH_KINDS.includes(materialType as any)) {
    res.status(400).json({ error: `materialType must be one of: ${BATCH_KINDS.join(", ")}` }); return;
  }

  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const dataScope = scopeEmp && scopeEmp.branchType !== "headoffice" ? await getUserDataScope(scopeEmp) : undefined;

  const [valuation, branchName] = await Promise.all([
    stockValuation(pool, {
      branchType: branchType || undefined,
      branchId: branchId != null && branchId !== "" ? Number(branchId) : undefined,
      materialType: (materialType as ProductKind | undefined) || undefined,
      dataScope,
    }),
    buildBranchMaps(),
  ]);

  const rows = valuation.rows.map((r) => ({
    // `itemId` is kept for callers that predate materials being included; refId is
    // the honest name now that the id space is polymorphic.
    itemId: r.refId,
    refId: r.refId,
    materialType: r.materialType,
    typeLabel: PRODUCT_KIND_LABELS[r.materialType] ?? "Item",
    itemName: r.itemName,
    unit: r.unit,
    branchType: r.branchType,
    branchId: r.branchId,
    // In-transit stock is owned by the sender, so it is labelled as that
    // location's — with the qualifier, so nobody looks for it on the shelf.
    branchName: r.inTransit ? `${branchName(r.branchType, r.branchId)} (in transit)` : branchName(r.branchType, r.branchId),
    quantity: r.quantity,
    reserved: r.reserved,
    available: r.available,
    avgCost: r.unitCost,
    unitCost: r.unitCost,
    value: r.value,
    inTransit: r.inTransit,
  }));

  res.json({
    rows,
    locations: valuation.byLocation.map((l) => ({
      branchType: l.branchType,
      branchId: l.branchId,
      branchName: branchName(l.branchType, l.branchId),
      totalValue: l.value,
      onHandValue: l.onHandValue,
      inTransitValue: l.inTransitValue,
      itemCount: l.lines,
      totalQuantity: l.quantity,
    })),
    byType: valuation.byType,
    byProduct: valuation.byProduct,
    onHandValue: valuation.onHandValue,
    inTransitValue: valuation.inTransitValue,
    reservedQuantity: valuation.reservedQuantity,
    grandTotal: valuation.grandTotal,
  });
});

// ── Movement analysis (dead / slow-moving stock) ───────────────────────────────
// Classified on days since the last OUTBOUND movement, because that is what
// "moving" means for stock: receiving more of something that never leaves does
// not make it alive. Both dates are returned so the UI can show either.
router.get("/stock/movement-analysis", requireModuleView("page:/headoffice/inventory-reports"), async (req, res): Promise<void> => {
  const { branchType, branchId, materialType, itemId } = req.query as Record<string, string | undefined>;
  const cls = String(req.query.class ?? "all");
  if (materialType && !BATCH_KINDS.includes(materialType as any)) {
    res.status(400).json({ error: `materialType must be one of: ${BATCH_KINDS.join(", ")}` }); return;
  }
  if (cls !== "all" && !MOVEMENT_CLASSES.includes(cls as MovementClass)) {
    res.status(400).json({ error: `class must be all or one of: ${MOVEMENT_CLASSES.join(", ")}` }); return;
  }

  const conds: string[] = ["se.quantity::numeric > 0"];
  const params: any[] = [];
  if (branchType) { params.push(branchType); conds.push(`se.branch_type = $${params.length}`); }
  if (branchId != null && branchId !== "") { params.push(Number(branchId)); conds.push(`se.branch_id = $${params.length}`); }
  if (itemId) {
    params.push(Number(itemId)); conds.push(`se.item_id = $${params.length}`);
    params.push(materialType ?? "item"); conds.push(`se.material_type = $${params.length}`);
  } else if (materialType) {
    params.push(materialType); conds.push(`se.material_type = $${params.length}`);
  }
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== "headoffice") {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeBranchWhere(scope, params, "se"));
  }

  const [result, branchName, ledgerStartRow] = await Promise.all([
    pool.query(
      `SELECT se.item_id, se.material_type, se.branch_type, se.branch_id,
              se.quantity::numeric AS qty,
              ${PRODUCT_UNIT_COST_SQL} AS unit_cost,
              ${reservedSql('se')} AS reserved,
              COALESCE(i.name, m.name, rm.name, '')                AS product_name,
              COALESCE(i.item_code, m.item_code, rm.item_code, '') AS product_code,
              COALESCE(i.unit, m.unit, rm.unit, '')                AS unit,
              mv.last_at, mv.last_out_at,
              (CURRENT_DATE - mv.last_at::date)     AS days_since_movement,
              (CURRENT_DATE - mv.last_out_at::date) AS days_since_outbound
       FROM stock_entries se
       ${PRODUCT_MASTER_JOINS}
       LEFT JOIN LATERAL (
         SELECT MAX(sl.created_at) AS last_at,
                MAX(CASE WHEN sl.qty_change::numeric < 0 THEN sl.created_at END) AS last_out_at
         FROM stock_ledger sl
         WHERE sl.ref_id = se.item_id
           AND sl.material_type = se.material_type
           AND sl.branch_type = se.branch_type
           AND sl.branch_id = se.branch_id
       ) mv ON TRUE
       WHERE ${conds.join(" AND ")}
       ORDER BY days_since_outbound DESC NULLS FIRST, se.quantity::numeric DESC`,
      params
    ),
    buildBranchMaps(),
    // The ledger has a start date. Stock that has never moved may simply predate
    // it, so the answer is qualified rather than presented as fact.
    pool.query(`SELECT MIN(created_at) AS started_at FROM stock_ledger`),
  ]);

  const rows = result.rows.map((r: any) => {
    const quantity = Number(r.qty);
    const unitCost = Number(r.unit_cost ?? 0);
    const reserved = r3(Number(r.reserved ?? 0));
    const daysSinceOutbound = r.days_since_outbound == null ? null : Number(r.days_since_outbound);
    const daysSinceMovement = r.days_since_movement == null ? null : Number(r.days_since_movement);
    const mt = (r.material_type ?? "item") as ProductKind;
    const klass = movementClass(daysSinceOutbound);
    return {
      refId: Number(r.item_id),
      itemId: Number(r.item_id),
      materialType: mt,
      typeLabel: PRODUCT_KIND_LABELS[mt] ?? "Item",
      itemName: r.product_name || `#${r.item_id}`,
      itemCode: r.product_code ?? "",
      unit: r.unit ?? "",
      branchType: r.branch_type,
      branchId: Number(r.branch_id),
      branchName: branchName(r.branch_type, Number(r.branch_id)),
      quantity,
      reserved,
      available: r3(Math.max(0, quantity - reserved)),
      unitCost,
      value: Math.round(quantity * unitCost * 100) / 100,
      lastMovementAt: r.last_at ?? null,
      lastOutboundAt: r.last_out_at ?? null,
      daysSinceMovement,
      daysSinceOutbound,
      class: klass,
      classLabel: MOVEMENT_CLASS_LABELS[klass],
      // No ledger row at all: counted as dead, but flagged so the UI can say
      // "nothing recorded" instead of implying the stock was watched and ignored.
      noHistory: r.last_at == null,
    };
  }).filter((r) => cls === "all" || r.class === cls);

  const summary = MOVEMENT_CLASSES.map((k) => {
    const inClass = rows.filter((r) => r.class === k);
    return {
      class: k,
      label: MOVEMENT_CLASS_LABELS[k],
      lines: inClass.length,
      quantity: r3(inClass.reduce((s, r) => s + r.quantity, 0)),
      value: Math.round(inClass.reduce((s, r) => s + r.value, 0) * 100) / 100,
    };
  });

  res.json({
    basis: "last_outbound_movement",
    ledgerStart: ledgerStartRow.rows[0]?.started_at ?? null,
    thresholds: MOVEMENT_CLASS_DAYS,
    classOrder: MOVEMENT_CLASSES,
    rows,
    summary,
    totalValue: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100,
  });
});

// ── Reorder report (per-item reorder levels) ─────────────────────────────────
router.get("/stock/reorder-report", requireModuleView("page:/headoffice/inventory-reports"), async (_req, res): Promise<void> => {
  const [result, branchName] = await Promise.all([
    pool.query(
      `SELECT se.branch_type, se.branch_id, se.item_id, se.quantity::numeric AS qty,
              i.name AS item_name, i.unit, COALESCE(i.reorder_level, 10)::numeric AS reorder_level
       FROM stock_entries se
       JOIN items i ON i.id = se.item_id
       WHERE se.material_type = 'item'
         AND se.quantity::numeric < COALESCE(i.reorder_level, 10)::numeric
       ORDER BY (COALESCE(i.reorder_level, 10)::numeric - se.quantity::numeric) DESC`
    ),
    buildBranchMaps(),
  ]);

  res.json(result.rows.map((r: any) => ({
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    branchType: r.branch_type,
    branchId: r.branch_id,
    branchName: branchName(r.branch_type, r.branch_id),
    quantity: Number(r.qty),
    reorderLevel: Number(r.reorder_level),
    shortfall: r3(Number(r.reorder_level) - Number(r.qty)),
  })));
});

// ── Physical stock verification ──────────────────────────────────────────────
router.post("/stock/verifications", requireModuleAction("page:/headoffice/stock-verification", "add"), async (req, res): Promise<void> => {
  const { branchType, branchId, verifyDate, notes, createdBy, lines } = req.body as {
    branchType?: string; branchId?: number; verifyDate?: string; notes?: string; createdBy?: string;
    lines?: Array<{ itemId: number; countedQty: number; reason?: string }>;
  };

  if (!branchType || !["headoffice", "warehouse", "outlet"].includes(branchType)) {
    res.status(400).json({ error: "branchType must be headoffice, warehouse or outlet" }); return;
  }
  if (branchId == null || !Number.isFinite(Number(branchId))) {
    res.status(400).json({ error: "branchId is required" }); return;
  }
  // A stock count adjusts stock. A retired outlet must not gain or lose stock,
  // so counting one is blocked while the module is off — otherwise this route
  // becomes a side door for creating outlet inventory.
  if (branchType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  if (!verifyDate) { res.status(400).json({ error: "verifyDate is required" }); return; }
  if (!isIsoDate(verifyDate)) { res.status(400).json({ error: "verifyDate must be a real calendar date in YYYY-MM-DD form" }); return; }
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: "At least one counted line is required" }); return;
  }
  for (const l of lines) {
    if (!l.itemId || !Number.isFinite(Number(l.countedQty)) || Number(l.countedQty) < 0) {
      res.status(400).json({ error: "Each line needs an itemId and a non-negative countedQty" }); return;
    }
    if (l.reason && !VERIFY_REASONS.includes(l.reason as any)) {
      res.status(400).json({ error: `reason must be one of: ${VERIFY_REASONS.join(", ")}` }); return;
    }
  }

  const bId = Number(branchId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: [verif] } = await client.query(
      `INSERT INTO stock_verifications (branch_type, branch_id, verify_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [branchType, bId, verifyDate, notes ?? null, createdBy ?? "admin"]
    );

    const resultLines: any[] = [];
    const ledgerEntries: Array<Record<string, unknown>> = [];
    let adjustedCount = 0;

    for (const l of lines) {
      const itemId = Number(l.itemId);
      const counted = r3(Number(l.countedQty));
      const { rows: [item] } = await client.query(`SELECT name, unit FROM items WHERE id = $1`, [itemId]);
      const { rows: [se] } = await client.query(
        `SELECT id, quantity::numeric AS quantity FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 LIMIT 1 FOR UPDATE`,
        [itemId, branchType, bId]
      );
      const systemQty = se ? Number(se.quantity) : 0;
      const variance = r3(counted - systemQty);
      const reason = l.reason ?? "count_correction";

      if (variance !== 0) {
        adjustedCount++;
        if (se) {
          await client.query(`UPDATE stock_entries SET quantity = $1, updated_at = now() WHERE id = $2`, [counted, se.id]);
        } else {
          await client.query(
            `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price) VALUES ($1,'item',$2,$3,$4,0)`,
            [itemId, branchType, bId, counted]
          );
        }
        // Keep the parallel-maintained production stock counter in sync
        // (finished-goods stock at Head Office, where production lives)
        if (branchType === "headoffice") {
          await client.query(
            `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric + $1), updated_at = now() WHERE id = $2`,
            [variance, itemId]
          );
        }
        // Batches: shrinkage consumes FEFO (oldest stock is what spoils/breaks);
        // surplus lands in an explicit, auditable adjustment batch.
        let adjUnitCost = 0;
        if (variance < 0) {
          await consumeBatches(client, { itemId, materialType: "item", branchType, branchId: bId, quantity: -variance });
        } else {
          adjUnitCost = await inboundCostForItem(client, itemId);
          await creditBatch(client, {
            itemId, materialType: "item", branchType, branchId: bId,
            batchNumber: `ADJ-${verif.id}`, quantity: variance, unitCost: adjUnitCost,
            source: "adjustment", sourceId: verif.id,
            ...(await productBatchIdentity(client, "item", itemId)),
          });
        }
        // Physical adjustments are stock movements like any other: without a
        // ledger row the audit trail shows quantities jumping with no cause.
        ledgerEntries.push({
          txnType: 'adjustment', materialType: 'item', refId: itemId,
          itemName: item?.name ?? '', unit: item?.unit ?? '',
          branchType, branchId: bId, branchName: '',
          qtyChange: variance, unitCost: adjUnitCost,
          docType: 'stock_verification', docId: verif.id,
          notes: reason, txnDate: verifyDate,
        });
      }

      resultLines.push({
        itemId,
        itemName: item?.name ?? "",
        unit: item?.unit ?? "",
        systemQty,
        countedQty: counted,
        variance,
        reason: variance !== 0 ? reason : null,
      });
    }

    await client.query(`UPDATE stock_verifications SET lines = $1 WHERE id = $2`, [JSON.stringify(resultLines), verif.id]);
    await writeStockLedger(client, ledgerEntries as any);
    await client.query("COMMIT");

    const branchName = await buildBranchMaps();
    const locName = branchName(branchType, bId);
    logActivity({
      action: "CREATE", module: "stock", entityType: "stock_verification", entityId: verif.id,
      description: `Physical stock verification at ${locName}: ${lines.length} item${lines.length !== 1 ? "s" : ""} counted, ${adjustedCount} adjusted`,
      metadata: { after: { branchType, branchId: bId, verifyDate, adjustedCount, lines: resultLines.filter(rl => rl.variance !== 0) } },
    }).catch(() => {});

    res.status(201).json({
      id: verif.id,
      branchType, branchId: bId, branchName: locName,
      verifyDate, notes: notes ?? null, createdBy: createdBy ?? "admin",
      lines: resultLines,
      adjustedCount,
      createdAt: verif.created_at,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});

router.get("/stock/verifications", requireModuleView("page:/headoffice/stock-verification"), async (req, res): Promise<void> => {
  const { branchType, branchId } = req.query as Record<string, string | undefined>;
  const conds: string[] = ["true"];
  const params: any[] = [];
  if (branchType) { params.push(branchType); conds.push(`branch_type = $${params.length}`); }
  if (branchId != null && branchId !== "") { params.push(Number(branchId)); conds.push(`branch_id = $${params.length}`); }

  const [result, branchName] = await Promise.all([
    pool.query(
      `SELECT id, branch_type, branch_id, verify_date, notes, created_by, lines, created_at
       FROM stock_verifications WHERE ${conds.join(" AND ")} ORDER BY id DESC`,
      params
    ),
    buildBranchMaps(),
  ]);

  res.json(result.rows.map((v: any) => {
    const vLines = (v.lines ?? []) as any[];
    return {
      id: v.id,
      branchType: v.branch_type,
      branchId: v.branch_id,
      branchName: branchName(v.branch_type, v.branch_id),
      verifyDate: v.verify_date,
      notes: v.notes,
      createdBy: v.created_by,
      lineCount: vLines.length,
      adjustedCount: vLines.filter(l => Number(l.variance) !== 0).length,
      lines: vLines,
      createdAt: v.created_at,
    };
  }));
});

router.get("/stock/verifications/:id", requireModuleView("page:/headoffice/stock-verification"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [v] } = await pool.query(
    `SELECT id, branch_type, branch_id, verify_date, notes, created_by, lines, created_at
     FROM stock_verifications WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!v) { res.status(404).json({ error: "Not found" }); return; }
  const branchName = await buildBranchMaps();
  res.json({
    id: v.id,
    branchType: v.branch_type,
    branchId: v.branch_id,
    branchName: branchName(v.branch_type, v.branch_id),
    verifyDate: v.verify_date,
    notes: v.notes,
    createdBy: v.created_by,
    lines: v.lines ?? [],
    createdAt: v.created_at,
  });
});

export default router;

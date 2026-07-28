import { Router } from "express";
import { pool } from "@workspace/db";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { logActivity } from "../lib/audit";
import { buildBranchMaps } from "./stock";
import { consumeBatches, creditBatch, planFEFO, inboundCostForItem } from "../lib/batches";
import { productBatchIdentity } from "../lib/productIdentity";
import { getUserDataScope, scopeBranchWhere } from "../lib/dataScope";
import { ITEM_UNIT_COST_SQL } from "../lib/valuation";

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

function expiryStatus(daysToExpiry: number | null, nearDays: number): "ok" | "near_expiry" | "expired" | "no_expiry" {
  if (daysToExpiry == null) return "no_expiry";
  if (daysToExpiry < 0) return "expired";
  if (daysToExpiry <= nearDays) return "near_expiry";
  return "ok";
}

// ── Batch listing (drill-down for stock pages) ────────────────────────────────
router.get("/stock/batches", async (req, res): Promise<void> => {
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

  const [result, branchName] = await Promise.all([
    pool.query(
      `SELECT sb.id, sb.item_id, sb.material_type, sb.branch_type, sb.branch_id, sb.batch_number,
              sb.mfg_date, sb.expiry_date, sb.quantity, sb.unit_cost, sb.source,
              (sb.expiry_date::date - CURRENT_DATE) AS days_to_expiry,
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
    return {
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
      quantity: Number(b.quantity),
      unitCost: Number(b.unit_cost),
      source: b.source,
      itemCode: b.item_code ?? "",
      barcode: b.barcode ?? "",
      // A zero MRP means "never priced", not "free" — keep it null so the UI
      // can say so instead of printing ₹0.00.
      mrp: b.mrp == null ? null : Number(b.mrp),
      daysToExpiry: days,
      status: expiryStatus(days, nearDays),
    };
  }));
});

// ── FEFO suggestion for a planned outbound ───────────────────────────────────
router.get("/stock/batches/suggest", async (req, res): Promise<void> => {
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
router.get("/stock/expiry-report", requireModuleView("Stock"), async (req, res): Promise<void> => {
  const days = Math.max(1, Number(req.query.days ?? 30) || 30);
  const [result, branchName] = await Promise.all([
    pool.query(
      // Raw and packing materials expire too, so the report spans all three
      // kinds rather than finished goods alone.
      `SELECT sb.id, sb.item_id, sb.material_type, sb.branch_type, sb.branch_id, sb.batch_number,
              sb.mfg_date, sb.expiry_date, sb.quantity, sb.unit_cost,
              (sb.expiry_date::date - CURRENT_DATE) AS days_to_expiry,
              ${BATCH_NAME_COLS}
       FROM stock_batches sb
       ${BATCH_NAME_JOIN}
       WHERE sb.quantity > 0 AND sb.expiry_date IS NOT NULL
         AND sb.expiry_date::date <= CURRENT_DATE + $1::int
       ORDER BY sb.expiry_date ASC, sb.id ASC`,
      [days]
    ),
    buildBranchMaps(),
  ]);

  const rows = result.rows.map((b: any) => {
    const daysLeft = Number(b.days_to_expiry);
    const qty = Number(b.quantity);
    const value = Math.round(qty * Number(b.unit_cost) * 100) / 100;
    return {
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
      quantity: qty,
      unitCost: Number(b.unit_cost),
      value,
      daysToExpiry: daysLeft,
      status: daysLeft < 0 ? "expired" : "near_expiry",
    };
  });

  const expired = rows.filter(r => r.status === "expired");
  const nearExpiry = rows.filter(r => r.status === "near_expiry");
  res.json({
    days,
    rows,
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

// ── Stock valuation (weighted-average) ───────────────────────────────────────
router.get("/stock/valuation", requireModuleView("Stock"), async (_req, res): Promise<void> => {
  const [result, branchName] = await Promise.all([
    pool.query(
      // Unit cost comes from the shared constant so this per-location report and
      // the P&L closing-stock total can never value the same item differently.
      `SELECT se.branch_type, se.branch_id, se.item_id, se.quantity::numeric AS qty,
              i.name AS item_name, i.unit,
              ${ITEM_UNIT_COST_SQL} AS avg_cost
       FROM stock_entries se
       JOIN items i ON i.id = se.item_id
       WHERE se.material_type = 'item' AND se.quantity::numeric > 0
       ORDER BY se.branch_type, se.branch_id, i.name`
    ),
    buildBranchMaps(),
  ]);

  const rows = result.rows.map((r: any) => {
    const qty = Number(r.qty);
    const avgCost = Number(r.avg_cost);
    return {
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      branchType: r.branch_type,
      branchId: r.branch_id,
      branchName: branchName(r.branch_type, r.branch_id),
      quantity: qty,
      avgCost,
      value: Math.round(qty * avgCost * 100) / 100,
    };
  });

  const locMap = new Map<string, { branchType: string; branchId: number; branchName: string; totalValue: number; itemCount: number; totalQuantity: number }>();
  for (const r of rows) {
    const key = `${r.branchType}:${r.branchId}`;
    const loc = locMap.get(key) ?? { branchType: r.branchType, branchId: r.branchId, branchName: r.branchName, totalValue: 0, itemCount: 0, totalQuantity: 0 };
    loc.totalValue = Math.round((loc.totalValue + r.value) * 100) / 100;
    loc.itemCount += 1;
    loc.totalQuantity = r3(loc.totalQuantity + r.quantity);
    locMap.set(key, loc);
  }

  res.json({
    rows,
    locations: [...locMap.values()],
    grandTotal: Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100,
  });
});

// ── Reorder report (per-item reorder levels) ─────────────────────────────────
router.get("/stock/reorder-report", requireModuleView("Stock"), async (_req, res): Promise<void> => {
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
router.post("/stock/verifications", requireModuleAction("Stock Verification", "add"), async (req, res): Promise<void> => {
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
        if (variance < 0) {
          await consumeBatches(client, { itemId, materialType: "item", branchType, branchId: bId, quantity: -variance });
        } else {
          const unitCost = await inboundCostForItem(client, itemId);
          await creditBatch(client, {
            itemId, materialType: "item", branchType, branchId: bId,
            batchNumber: `ADJ-${verif.id}`, quantity: variance, unitCost,
            source: "adjustment", sourceId: verif.id,
            ...(await productBatchIdentity(client, "item", itemId)),
          });
        }
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

router.get("/stock/verifications", async (req, res): Promise<void> => {
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

router.get("/stock/verifications/:id", async (req, res): Promise<void> => {
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

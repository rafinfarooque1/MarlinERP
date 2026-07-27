import { Router } from "express";
import { db, pool, productionsTable, itemsTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { eq } from "drizzle-orm";
import { CreateProductionBody } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { creditBatch, updateAvgCostOnInbound, inboundCostForItem } from "../lib/batches";

// ── Phase 5: batch costing & wastage ─────────────────────────────────────────
// Every new batch snapshots, at save time:
//   materialCost   = Σ usedQuantity × material's current cost (valuation basis)
//   overheadAmount = materialCost × overheadPercent / 100
//   totalCost      = materialCost + overheadAmount
//   costPerUnit    = totalCost / producedQuantity   (absorption: good units
//                    carry the full batch cost, including what was wasted)
//   wastageValue   = wastageQty × totalCost / (producedQuantity + wastageQty)
//                    (informational: cost sunk into scrapped units)
// producedQuantity remains the GOOD output that enters stock; wastage lines
// are scrapped units that never reach stock. Legacy rows keep NULL costs.

const defaultBatchNumber = (id: number) => `B-${String(id).padStart(4, "0")}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

type UsedLine = {
  materialType: string; materialId: number; usedQuantity: number;
  materialName?: string; unit?: string; unitCost?: number; lineCost?: number;
};
type WastageLine = { quantity: number; reason: string };
type MatInfo = { name: string; unit: string; cost: number };

async function materialMaps(): Promise<Record<string, Map<number, MatInfo>>> {
  // `cost` was added via raw migration and is absent from the drizzle schema,
  // so a raw query is required — db.select() would silently drop it.
  const [mats, raws] = await Promise.all([
    pool.query(`SELECT id, name, unit, cost FROM materials`),
    pool.query(`SELECT id, name, unit, cost FROM raw_materials`),
  ]);
  const toMap = (rows: any[]) =>
    new Map<number, MatInfo>(rows.map((x: any) => [x.id, { name: x.name, unit: x.unit ?? "", cost: Number(x.cost ?? 0) }]));
  return { material: toMap(mats.rows), raw_material: toMap(raws.rows) };
}

/** Fill display fields on consumed-material lines. Stored snapshots win;
 *  legacy lines (no snapshot) fall back to the current master data. */
function enrichUsedLines(lines: UsedLine[], maps: Record<string, Map<number, MatInfo>>): UsedLine[] {
  return (lines ?? []).map((l) => {
    const info = maps[l.materialType]?.get(l.materialId);
    return {
      ...l,
      materialName: l.materialName ?? info?.name ?? `#${l.materialId}`,
      unit: l.unit ?? info?.unit ?? "",
    };
  });
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Costing + wastage response fields from a raw productions row. */
function costFields(ex: any) {
  return {
    materialCost: num(ex?.material_cost),
    overheadPercent: num(ex?.overhead_percent),
    overheadAmount: num(ex?.overhead_amount),
    totalCost: num(ex?.total_cost),
    costPerUnit: num(ex?.cost_per_unit),
    wastage: (ex?.wastage ?? []) as WastageLine[],
    wastageQty: Number(ex?.wastage_qty ?? 0),
    wastageValue: Number(ex?.wastage_value ?? 0),
  };
}

const EXTRA_COLS = `id, batch_number, mfg_date, expiry_date, material_cost, overhead_percent,
  overhead_amount, total_cost, cost_per_unit, wastage, wastage_qty, wastage_value`;

const router = Router();

router.get("/productions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(productionsTable).orderBy(productionsTable.id);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  const maps = await materialMaps();
  // batch/costing columns are migration-added (not in the Drizzle schema) — fetch raw
  const extra = await pool.query(`SELECT ${EXTRA_COLS} FROM productions`);
  const eMap = new Map(extra.rows.map((e: any) => [e.id, e]));
  res.json(rows.map((r) => {
    const ex = eMap.get(r.id);
    return {
      ...r,
      itemName: iMap.get(r.itemId) ?? "",
      producedQuantity: Number(r.producedQuantity),
      materialUsed: enrichUsedLines((r.materialUsed ?? []) as UsedLine[], maps),
      batchNumber: ex?.batch_number ?? defaultBatchNumber(r.id),
      mfgDate: ex?.mfg_date ?? null,
      expiryDate: ex?.expiry_date ?? null,
      ...costFields(ex),
    };
  }));
});

// ── Production reports (must be registered before /productions/:id) ──────────
// GET /productions/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/productions/reports", requireModuleView("Production"), async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, item_id, produced_quantity, to_char(production_date, 'YYYY-MM-DD') AS production_date,
            material_used, batch_number, material_cost, overhead_percent, overhead_amount,
            total_cost, cost_per_unit, wastage, wastage_qty, wastage_value
     FROM productions
     WHERE ($1 = '' OR production_date >= $1::date)
       AND ($2 = '' OR production_date <= $2::date)
     ORDER BY production_date, id`,
    [from, to]
  );

  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i: any) => [i.id, { name: i.name, unit: i.unit ?? "" }]));
  const maps = await materialMaps();
  const { rows: bomRows } = await pool.query(`SELECT item_id, lines FROM bom_templates`);
  const bomMap = new Map(bomRows.map((b: any) => [b.item_id, (b.lines ?? []) as Array<{ materialType: string; materialId: number; quantity: number }>]));

  type OutputAgg = { itemId: number; itemName: string; unit: string; batchCount: number; producedQty: number; wastageQty: number; totalCost: number; costedQty: number };
  type ConsAgg = { materialType: string; materialId: number; materialName: string; unit: string; consumedQty: number; consumedCost: number; costKnown: boolean; expectedQty: number; hasBom: boolean };

  const outputByItem = new Map<number, OutputAgg>();
  const consumption = new Map<string, ConsAgg>();
  const wastageRows: any[] = [];
  const batchRows: any[] = [];
  const totals = { batchCount: 0, producedQty: 0, wastageQty: 0, wastageValue: 0, totalCost: 0 };

  for (const p of rows) {
    const produced = Number(p.produced_quantity);
    const wastageQty = Number(p.wastage_qty ?? 0);
    const gross = r3(produced + wastageQty);
    const totalCost = num(p.total_cost);
    const item = iMap.get(p.item_id);
    const bom = bomMap.get(p.item_id);

    totals.batchCount += 1;
    totals.producedQty = r3(totals.producedQty + produced);
    totals.wastageQty = r3(totals.wastageQty + wastageQty);
    totals.wastageValue = r2(totals.wastageValue + Number(p.wastage_value ?? 0));
    if (totalCost !== null) totals.totalCost = r2(totals.totalCost + totalCost);

    // Output summary by item
    let out = outputByItem.get(p.item_id);
    if (!out) {
      out = { itemId: p.item_id, itemName: item?.name ?? `Item #${p.item_id}`, unit: item?.unit ?? "", batchCount: 0, producedQty: 0, wastageQty: 0, totalCost: 0, costedQty: 0 };
      outputByItem.set(p.item_id, out);
    }
    out.batchCount += 1;
    out.producedQty = r3(out.producedQty + produced);
    out.wastageQty = r3(out.wastageQty + wastageQty);
    if (totalCost !== null) { out.totalCost = r2(out.totalCost + totalCost); out.costedQty = r3(out.costedQty + produced); }

    // Consumption vs BOM
    for (const l of (p.material_used ?? []) as UsedLine[]) {
      const key = `${l.materialType}:${l.materialId}`;
      let c = consumption.get(key);
      if (!c) {
        const info = maps[l.materialType]?.get(l.materialId);
        c = {
          materialType: l.materialType, materialId: l.materialId,
          materialName: l.materialName ?? info?.name ?? `#${l.materialId}`,
          unit: l.unit ?? info?.unit ?? "",
          consumedQty: 0, consumedCost: 0, costKnown: false, expectedQty: 0, hasBom: false,
        };
        consumption.set(key, c);
      }
      c.consumedQty = r3(c.consumedQty + Number(l.usedQuantity));
      if (l.lineCost !== undefined && l.lineCost !== null) { c.consumedCost = r2(c.consumedCost + Number(l.lineCost)); c.costKnown = true; }
      const bomLine = bom?.find((b) => b.materialType === l.materialType && b.materialId === l.materialId);
      if (bomLine) { c.hasBom = true; c.expectedQty = r3(c.expectedQty + Number(bomLine.quantity) * gross); }
    }

    // Wastage detail
    if (wastageQty > 0) {
      wastageRows.push({
        productionId: p.id,
        batchNumber: p.batch_number ?? defaultBatchNumber(p.id),
        productionDate: p.production_date,
        itemId: p.item_id,
        itemName: item?.name ?? `Item #${p.item_id}`,
        unit: item?.unit ?? "",
        producedQty: produced,
        wastageQty,
        wastageValue: Number(p.wastage_value ?? 0),
        lines: (p.wastage ?? []) as WastageLine[],
      });
    }

    // Batch cost history
    batchRows.push({
      id: p.id,
      batchNumber: p.batch_number ?? defaultBatchNumber(p.id),
      productionDate: p.production_date,
      itemId: p.item_id,
      itemName: item?.name ?? `Item #${p.item_id}`,
      unit: item?.unit ?? "",
      producedQty: produced,
      wastageQty,
      materialCost: num(p.material_cost),
      overheadPercent: num(p.overhead_percent),
      overheadAmount: num(p.overhead_amount),
      totalCost,
      costPerUnit: num(p.cost_per_unit),
    });
  }

  res.json({
    from: from || null,
    to: to || null,
    totals,
    output: [...outputByItem.values()].map((o) => ({
      itemId: o.itemId, itemName: o.itemName, unit: o.unit,
      batchCount: o.batchCount, producedQty: o.producedQty, wastageQty: o.wastageQty,
      totalCost: o.costedQty > 0 ? o.totalCost : null,
      avgCostPerUnit: o.costedQty > 0 ? r4(o.totalCost / o.costedQty) : null,
    })),
    consumption: [...consumption.values()].map((c) => ({
      materialType: c.materialType, materialId: c.materialId, materialName: c.materialName, unit: c.unit,
      consumedQty: c.consumedQty,
      consumedCost: c.costKnown ? c.consumedCost : null,
      expectedQty: c.hasBom ? c.expectedQty : null,
      varianceQty: c.hasBom ? r3(c.consumedQty - c.expectedQty) : null,
    })),
    wastage: wastageRows,
    batches: batchRows,
  });
});

router.post("/productions", requireModuleAction("Production", "add"), async (req, res): Promise<void> => {
  const parsed = CreateProductionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // ── Strict server-side validation (generated schema is loose here) ───────
  const produced = Number(parsed.data.producedQuantity);
  if (!Number.isFinite(produced) || produced <= 0) {
    res.status(400).json({ error: "producedQuantity must be greater than 0" });
    return;
  }
  const { rows: [itemRow] } = await pool.query(`SELECT id, name FROM items WHERE id = $1 LIMIT 1`, [parsed.data.itemId]);
  if (!itemRow) { res.status(400).json({ error: `Item #${parsed.data.itemId} does not exist` }); return; }

  const rawBody = req.body as {
    batchNumber?: string; mfgDate?: string; expiryDate?: string;
    overheadPercent?: unknown; wastage?: unknown;
  };

  // ── Validate passthrough fields (zod strips unknown keys) ────────────────
  let overheadPercent: number | null = null;
  if (rawBody.overheadPercent !== undefined && rawBody.overheadPercent !== null && rawBody.overheadPercent !== "") {
    const v = Number(rawBody.overheadPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      res.status(400).json({ error: "Overhead % must be between 0 and 100" });
      return;
    }
    overheadPercent = r2(v);
  }
  if (overheadPercent === null) {
    const { rows: [cs] } = await pool.query(`SELECT production_overhead_percent FROM company_settings LIMIT 1`);
    overheadPercent = r2(Number(cs?.production_overhead_percent ?? 0));
  }

  const wastageLines: WastageLine[] = [];
  if (rawBody.wastage !== undefined) {
    if (!Array.isArray(rawBody.wastage)) { res.status(400).json({ error: "wastage must be an array" }); return; }
    for (const w of rawBody.wastage as any[]) {
      const quantity = Number(w?.quantity);
      const reason = typeof w?.reason === "string" ? w.reason.trim() : "";
      if (!Number.isFinite(quantity) || quantity <= 0) { res.status(400).json({ error: "Each wastage line needs a quantity greater than 0" }); return; }
      if (!reason) { res.status(400).json({ error: "Each wastage line needs a reason" }); return; }
      wastageLines.push({ quantity: r3(quantity), reason });
    }
  }

  // ── Cost the consumed materials at their current valuation cost ──────────
  const maps = await materialMaps();
  // Line-level validation: the generated CreateProductionBody leaves these
  // fields optional, so enforce shape + referential integrity before writes.
  for (const mat of (parsed.data.materialUsed ?? []) as UsedLine[]) {
    if (mat.materialType !== "material" && mat.materialType !== "raw_material") {
      res.status(400).json({ error: "Each material line needs materialType 'material' or 'raw_material'" });
      return;
    }
    if (!Number.isInteger(mat.materialId) || mat.materialId <= 0) {
      res.status(400).json({ error: "Each material line needs a valid materialId" });
      return;
    }
    if (!Number.isFinite(Number(mat.usedQuantity)) || Number(mat.usedQuantity) <= 0) {
      res.status(400).json({ error: "Each material line needs usedQuantity greater than 0" });
      return;
    }
    if (!maps[mat.materialType]?.has(mat.materialId)) {
      res.status(400).json({ error: `${mat.materialType === "material" ? "Material" : "Raw material"} #${mat.materialId} does not exist` });
      return;
    }
  }
  const materialUsed: UsedLine[] = (parsed.data.materialUsed as UsedLine[]).map((mat) => {
    const info = maps[mat.materialType]?.get(mat.materialId);
    const unitCost = r4(Math.max(0, info?.cost ?? 0));
    return {
      materialType: mat.materialType,
      materialId: mat.materialId,
      usedQuantity: mat.usedQuantity,
      materialName: info?.name ?? `#${mat.materialId}`,
      unit: info?.unit ?? "",
      unitCost,
      lineCost: r2(mat.usedQuantity * unitCost),
    };
  });

  const materialCost = r2(materialUsed.reduce((s, l) => s + (l.lineCost ?? 0), 0));
  const overheadAmount = r2(materialCost * overheadPercent / 100);
  const totalCost = r2(materialCost + overheadAmount);
  const wastageQty = r3(wastageLines.reduce((s, w) => s + w.quantity, 0));
  const gross = r3(produced + wastageQty);
  const costPerUnit = produced > 0 && totalCost > 0 ? r4(totalCost / produced) : 0;
  const wastageValue = wastageQty > 0 && gross > 0 && totalCost > 0 ? r2(totalCost * wastageQty / gross) : 0;

  // ── All writes in one transaction, serialized per item ───────────────────
  // (advisory lock removes the first-production stock-entry race; any
  //  mid-flow failure rolls back every stock/cost side effect together)
  const client = await pool.connect();
  let rowId = 0;
  let createdAt: Date | null = null;
  let batchNumber = "";
  let mfgDate: string | null = null;
  let expiryDate: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('production-stock'), $1)`, [parsed.data.itemId]);

    const { rows: [inserted] } = await client.query(
      `INSERT INTO productions (item_id, produced_quantity, production_date, material_used, notes)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, created_at`,
      [parsed.data.itemId, produced, parsed.data.productionDate, JSON.stringify(materialUsed), parsed.data.notes ?? null]
    );
    rowId = inserted.id;
    createdAt = inserted.created_at;

    // Batch identity: user-provided or the existing display convention (B-0001)
    batchNumber = (rawBody.batchNumber ?? "").trim() || defaultBatchNumber(rowId);
    mfgDate = rawBody.mfgDate || parsed.data.productionDate || null;
    expiryDate = rawBody.expiryDate || null;
    await client.query(
      `UPDATE productions SET batch_number = $1, mfg_date = $2, expiry_date = $3,
         material_cost = $4, overhead_percent = $5, overhead_amount = $6,
         total_cost = $7, cost_per_unit = $8,
         wastage = $9::jsonb, wastage_qty = $10, wastage_value = $11
       WHERE id = $12`,
      [batchNumber, mfgDate, expiryDate,
       materialCost, overheadPercent, overheadAmount, totalCost, costPerUnit,
       JSON.stringify(wastageLines), wastageQty, wastageValue, rowId]
    );

    // Deduct materials used
    for (const mat of materialUsed) {
      const table = mat.materialType === "material" ? "materials" : "raw_materials";
      await client.query(
        `UPDATE ${table} SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`,
        [mat.usedQuantity, mat.materialId]
      );
    }

    // Add to item production stock (good units only — wastage never enters stock)
    await client.query(
      `UPDATE items SET production_stock = production_stock::numeric + $1, updated_at = now() WHERE id = $2`,
      [produced, parsed.data.itemId]
    );

    // Production stock entry (atomic upsert on uq_stock_entries_item_branch)
    await client.query(
      `INSERT INTO stock_entries (item_id, branch_type, branch_id, quantity, cost_price)
       VALUES ($1, 'headoffice', 1, $2, '0')
       ON CONFLICT (item_id, branch_type, branch_id)
       DO UPDATE SET quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric, updated_at = now()`,
      [parsed.data.itemId, produced]
    );

    // Track the produced batch and roll the item's weighted-average cost.
    // The batch's own cost-per-unit is the truth when available; zero-cost
    // batches (materials without costs) fall back to the item's current average
    // so the average is never dragged to zero.
    const unitCost = costPerUnit > 0 ? costPerUnit : await inboundCostForItem(client, parsed.data.itemId);
    await creditBatch(client, {
      itemId: parsed.data.itemId, branchType: "headoffice", branchId: 1,
      batchNumber, mfgDate, expiryDate,
      quantity: produced, unitCost,
      source: "production", sourceId: rowId,
    });
    await updateAvgCostOnInbound(client, parsed.data.itemId, produced, unitCost);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "CREATE", module: "production", entityType: "production", entityId: rowId,
    description: `Produced ${produced} × ${itemRow.name} on ${parsed.data.productionDate}` +
      (totalCost > 0 ? ` — cost ₹${totalCost.toFixed(2)} (₹${costPerUnit.toFixed(2)}/unit)` : "") +
      (wastageQty > 0 ? `, wastage ${wastageQty}` : ""),
    metadata: { after: { itemId: parsed.data.itemId, itemName: itemRow.name, producedQuantity: produced, materialCount: materialUsed.length, totalCost, costPerUnit, wastageQty } },
  }).catch(() => {});

  res.status(201).json({
    id: rowId, itemId: parsed.data.itemId, itemName: itemRow.name,
    producedQuantity: produced, productionDate: parsed.data.productionDate,
    materialUsed, notes: parsed.data.notes ?? null, createdAt,
    batchNumber, mfgDate, expiryDate,
    materialCost, overheadPercent, overheadAmount, totalCost, costPerUnit,
    wastage: wastageLines, wastageQty, wastageValue,
  });
});

router.get("/productions/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  const maps = await materialMaps();
  const { rows: [ex] } = await pool.query(`SELECT ${EXTRA_COLS} FROM productions WHERE id = $1`, [id]);
  res.json({
    ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity),
    materialUsed: enrichUsedLines((row.materialUsed ?? []) as UsedLine[], maps),
    batchNumber: ex?.batch_number ?? defaultBatchNumber(id), mfgDate: ex?.mfg_date ?? null, expiryDate: ex?.expiry_date ?? null,
    ...costFields(ex),
  });
});

// ── Update (metadata only — date and notes) ───────────────────────────────────
router.patch("/productions/:id", requireModuleAction("Production", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  const { productionDate, notes } = req.body as { productionDate?: string; notes?: string };
  const updateData: Record<string, unknown> = {};
  if (productionDate !== undefined) updateData.productionDate = productionDate;
  if (notes !== undefined) updateData.notes = notes;
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  const [row] = await db.update(productionsTable).set(updateData).where(eq(productionsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [] });
});

// ── Delete (with full stock reversal) ────────────────────────────────────────
router.delete("/productions/:id", requireModuleAction("Production", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  // ── Full reversal in one transaction ─────────────────────────────────────
  // Row-lock the production BEFORE reading its data: a concurrent DELETE of
  // the same batch blocks on FOR UPDATE, then sees zero rows → 404, so stock
  // can never be reversed twice from a stale snapshot. The per-item advisory
  // lock (shared with POST) then serializes the stock writes themselves.
  const client = await pool.connect();
  let itemId = 0;
  let qty = 0;
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(`SELECT * FROM productions WHERE id = $1 FOR UPDATE`, [id]);
    if (!row) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" });
      return;
    }

    const materialUsed = (row.material_used ?? []) as Array<{ materialType: string; materialId: number; usedQuantity: number }>;
    qty = Number(row.produced_quantity);
    itemId = Number(row.item_id);
    const delBatchNumber = row.batch_number || defaultBatchNumber(id);

    await client.query(`SELECT pg_advisory_xact_lock(hashtext('production-stock'), $1)`, [itemId]);

    // Reverse material deductions
    for (const mat of materialUsed) {
      const table = mat.materialType === "material" ? "materials"
        : mat.materialType === "raw_material" ? "raw_materials" : null;
      if (!table) continue;
      await client.query(
        `UPDATE ${table} SET current_stock = GREATEST(0, current_stock::numeric + $1), updated_at = now() WHERE id = $2`,
        [mat.usedQuantity, mat.materialId]
      );
    }

    // Reverse production stock
    await client.query(
      `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $1), updated_at = now() WHERE id = $2`,
      [qty, itemId]
    );
    await client.query(
      `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
       WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1`,
      [qty, itemId]
    );

    // Reverse this production's own batch (floored — it may be partly consumed)
    await client.query(
      `UPDATE stock_batches SET quantity = GREATEST(0, quantity - $1), updated_at = now()
       WHERE item_id = $2 AND branch_type = 'headoffice' AND branch_id = 1 AND batch_number = $3`,
      [qty, itemId, delBatchNumber]
    );

    await client.query(`DELETE FROM productions WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "DELETE", module: "production", entityType: "production", entityId: id,
    description: `Production batch B-${String(id).padStart(4, "0")} deleted (${qty} units reversed)`,
    metadata: { before: { itemId, producedQuantity: qty } },
  }).catch(() => {});

  res.status(204).send();
});

export default router;

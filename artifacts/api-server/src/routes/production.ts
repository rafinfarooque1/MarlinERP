import { Router } from "express";
import { db, pool, productionsTable, itemsTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { eq } from "drizzle-orm";
import { CreateProductionBody } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { creditBatch, consumeBatches, debitBatchByNumber, restoreBatches, updateAvgCostOnInbound, inboundCostForItem, inboundCostForMaterial, type BatchBreakdownEntry } from "../lib/batches";
import { writeStockLedger } from "../lib/stockLedger";
import { deductMaterialAt, creditMaterialAt, isMaterialKind } from "../lib/materialStock";
import { productBatchIdentity, blockedByInactiveProducts, INACTIVE_PRODUCT_CODE } from "../lib/productIdentity";
import {
  reallocateDayLabour, lockLabourDay, postProductionCostJv, postReallocationAdjustment,
  resolveActingLocation, locationLabel, type ProdLocation,
} from "../lib/productionCosting";
import { getUserDataScope, scopeLocationTypeWhere } from "../lib/dataScope";
import { parsePaging, setPagingHeaders, applyPaging } from "../lib/paging";
import { availabilityAt, insufficientStockMessage } from "../lib/reservations";

// ── Batch costing & wastage ──────────────────────────────────────────────────
// Every new batch snapshots, at save time:
//   rmCost         = Σ usedQuantity × cost   of RAW material lines
//   pmCost         = Σ usedQuantity × cost   of PACKING material lines
//   materialCost   = rmCost + pmCost                 (valuation basis)
//   overheadAmount = materialCost × overheadPercent / 100
//   labourCost     = share of the day's production payroll at this location
//   totalCost      = materialCost + overheadAmount + labourCost
//   costPerUnit    = totalCost / producedQuantity   (absorption: good units
//                    carry the full batch cost, including what was wasted)
//   wastageValue   = wastageQty × totalCost / (producedQuantity + wastageQty)
//                    (informational: cost sunk into scrapped units)
// producedQuantity remains the GOOD output that enters stock; wastage lines
// are scrapped units that never reach stock. Legacy rows keep NULL costs.
//
// LOCATION: a run belongs to the location that made it — Head Office or any
// warehouse. Materials are consumed and output deposited AT that location, so a
// warehouse's production never touches Head Office stock. Labour allocation and
// the capitalisation posting live in lib/productionCosting.ts, which owns the
// rule that labour is a daily pool shared across the day's batches.
//
// NAMING (fixed by the masters, do not "correct" it): materialType 'material'
// is the RAW material master, displayed as "Raw Material" → rm_cost.
// materialType 'raw_material' is the PACKING material master → pm_cost.

const defaultBatchNumber = (id: number) => `B-${String(id).padStart(4, "0")}`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

type UsedLine = {
  materialType: string; materialId: number; usedQuantity: number;
  materialName?: string; unit?: string; unitCost?: number; lineCost?: number;
  /** Lots this line drew from, recorded so a reversal restores the same lots. */
  batchBreakdown?: BatchBreakdownEntry[];
};
type WastageLine = { quantity: number; reason: string };
type MatInfo = { name: string; unit: string; cost: number };

async function materialMaps(): Promise<Record<string, Map<number, MatInfo>>> {
  // `cost` and `avg_cost` were added via raw migration and are absent from the
  // drizzle schema, so a raw query is required — db.select() would silently
  // drop them.
  //
  // COSTING BASIS: `avg_cost` is the weighted-average cost that purchases
  // maintain on every inbound — it is the real valuation cost. `cost` is a
  // manually-entered standard rate that nothing keeps current and which is 0
  // for materials that were only ever purchased. Reading `cost` first is why
  // produced batches used to come out costing nothing at all.
  const [mats, raws] = await Promise.all([
    pool.query(`SELECT id, name, unit, COALESCE(NULLIF(avg_cost, 0), cost, 0) AS cost FROM materials`),
    pool.query(`SELECT id, name, unit, COALESCE(NULLIF(avg_cost, 0), cost, 0) AS cost FROM raw_materials`),
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
    rmCost: num(ex?.rm_cost),
    pmCost: num(ex?.pm_cost),
    labourCost: num(ex?.labour_cost),
    labourMethod: (ex?.labour_method ?? null) as string | null,
    overheadPercent: num(ex?.overhead_percent),
    overheadAmount: num(ex?.overhead_amount),
    totalCost: num(ex?.total_cost),
    costPerUnit: num(ex?.cost_per_unit),
    wastage: (ex?.wastage ?? []) as WastageLine[],
    wastageQty: Number(ex?.wastage_qty ?? 0),
    wastageValue: Number(ex?.wastage_value ?? 0),
  };
}

const EXTRA_COLS = `id, batch_number, mfg_date, expiry_date, material_cost, rm_cost, pm_cost,
  labour_cost, labour_method, overhead_percent,
  overhead_amount, total_cost, cost_per_unit, wastage, wastage_qty, wastage_value,
  location_type, location_id`;

const router = Router();


/** Names for every location that can manufacture, for list/report labels. */
async function locationNameMap(): Promise<Map<string, string>> {
  const [whs, outs] = await Promise.all([
    pool.query(`SELECT id, name FROM warehouses`),
    pool.query(`SELECT id, name FROM outlets`),
  ]);
  const m = new Map<string, string>([["headoffice:1", "Head Office"]]);
  for (const w of whs.rows) m.set(`warehouse:${w.id}`, w.name);
  for (const o of outs.rows) m.set(`outlet:${o.id}`, o.name);
  return m;
}

const locKey = (ex: any) => `${ex?.location_type ?? "headoffice"}:${Number(ex?.location_id ?? 1)}`;

/** Stock-ledger branch id. Head Office has always ledgered materials at 0 and
 *  finished items at 1; keeping that split means a location's ledger stays one
 *  continuous series instead of splitting into two running balances. Every
 *  other location uses its own id for both. */
const ledgerBranchId = (loc: ProdLocation, materialType: string) =>
  loc.type === "headoffice" ? (materialType === "item" ? 1 : 0) : loc.id;

router.get("/productions", requireModuleView("page:/production/production"), async (req, res): Promise<void> => {
  // LBAC: a location sees its own runs; Head Office sees every location's.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const params: unknown[] = [];
  const where = scopeLocationTypeWhere(scope, params, "p");
  if (where === "FALSE") { res.json([]); return; }

  // batch/costing/location columns are migration-added (not in the Drizzle
  // schema), so the raw query drives the list and carries the scoping.
  const extra = await pool.query(
    `SELECT ${EXTRA_COLS} FROM productions p WHERE ${where} ORDER BY id`, params
  );
  if (extra.rows.length === 0) { res.json([]); return; }
  const ids = extra.rows.map((e: any) => Number(e.id));

  const rows = await db.select().from(productionsTable).orderBy(productionsTable.id);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  const maps = await materialMaps();
  const locNames = await locationNameMap();
  const eMap = new Map(extra.rows.map((e: any) => [e.id, e]));
  const idSet = new Set(ids);
  const list = rows.filter((r) => idSet.has(r.id)).map((r) => {
    const ex = eMap.get(r.id);
    return {
      ...r,
      itemName: iMap.get(r.itemId) ?? "",
      producedQuantity: Number(r.producedQuantity),
      materialUsed: enrichUsedLines((r.materialUsed ?? []) as UsedLine[], maps),
      batchNumber: ex?.batch_number ?? defaultBatchNumber(r.id),
      mfgDate: ex?.mfg_date ?? null,
      expiryDate: ex?.expiry_date ?? null,
      locationType: ex?.location_type ?? "headoffice",
      locationId: Number(ex?.location_id ?? 1),
      locationName: locNames.get(locKey(ex)) ?? "Head Office",
      ...costFields(ex),
    };
  });
  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, list.length, paging);
  res.json(applyPaging(list, paging));
});

// ── Production reports (must be registered before /productions/:id) ──────────
// GET /productions/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/productions/reports", requireModuleView("page:/production/reports"), async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD dates" });
    return;
  }

  // LBAC: a location reports on its own production; Head Office on all of it.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const params: unknown[] = [from, to];
  const where = scopeLocationTypeWhere(scope, params, "p");
  if (where === "FALSE") {
    res.json({ from: from || null, to: to || null, totals: { batchCount: 0, producedQty: 0, wastageQty: 0, wastageValue: 0, totalCost: 0, rmCost: 0, pmCost: 0, labourCost: 0, overheadAmount: 0 }, output: [], consumption: [], wastage: [], batches: [] });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, item_id, produced_quantity, to_char(production_date, 'YYYY-MM-DD') AS production_date,
            material_used, batch_number, material_cost, rm_cost, pm_cost, labour_cost, labour_method,
            overhead_percent, overhead_amount,
            total_cost, cost_per_unit, wastage, wastage_qty, wastage_value,
            location_type, location_id
     FROM productions p
     WHERE ($1 = '' OR production_date >= $1::date)
       AND ($2 = '' OR production_date <= $2::date)
       AND ${where}
     ORDER BY production_date, id`,
    params
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
  const locNames = await locationNameMap();
  // Cost components are reported separately so a rising batch cost can be
  // traced to the input that moved — material, packing, labour or overhead.
  const totals = {
    batchCount: 0, producedQty: 0, wastageQty: 0, wastageValue: 0, totalCost: 0,
    rmCost: 0, pmCost: 0, labourCost: 0, overheadAmount: 0,
  };

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
    totals.rmCost = r2(totals.rmCost + Number(p.rm_cost ?? 0));
    totals.pmCost = r2(totals.pmCost + Number(p.pm_cost ?? 0));
    totals.labourCost = r2(totals.labourCost + Number(p.labour_cost ?? 0));
    totals.overheadAmount = r2(totals.overheadAmount + Number(p.overhead_amount ?? 0));

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
      rmCost: num(p.rm_cost),
      pmCost: num(p.pm_cost),
      labourCost: num(p.labour_cost),
      labourMethod: p.labour_method ?? null,
      overheadPercent: num(p.overhead_percent),
      overheadAmount: num(p.overhead_amount),
      totalCost,
      costPerUnit: num(p.cost_per_unit),
      locationType: p.location_type ?? "headoffice",
      locationId: Number(p.location_id ?? 1),
      locationName: locNames.get(locKey(p)) ?? "Head Office",
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

router.post("/productions", requireModuleAction("page:/production/production", "add"), async (req, res): Promise<void> => {
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
    locationType?: unknown; locationId?: unknown; labourCost?: unknown;
  };

  // ── Which location is manufacturing ──────────────────────────────────────
  // Head Office may record for any location; a warehouse only for itself.
  const resolved = await resolveActingLocation(pool, {
    employee: (req as any).employee,
    requested: { type: rawBody.locationType, id: rawBody.locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const loc: ProdLocation = resolved.loc;

  // ── Manual labour fallback ───────────────────────────────────────────────
  // Labour normally comes from the day's production payroll. When attendance
  // cannot answer (contract gang, piece-rate crew), an explicit amount may be
  // given for this batch; it is then excluded from the payroll spread and the
  // batch records that it was entered by hand.
  let manualLabour: number | null = null;
  if (rawBody.labourCost !== undefined && rawBody.labourCost !== null && rawBody.labourCost !== "") {
    const v = Number(rawBody.labourCost);
    if (!Number.isFinite(v) || v < 0) {
      res.status(400).json({ error: "Labour cost must be zero or more" });
      return;
    }
    manualLabour = r2(v);
  }

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

  // A discontinued product can neither be produced nor consumed by a NEW batch.
  // Existing batches are untouched, so their materials stay visible and
  // reversible even after the product is retired.
  const inactiveMsg = await blockedByInactiveProducts(pool, [
    { kind: "item", id: Number(parsed.data.itemId) },
    ...((parsed.data.materialUsed ?? []) as UsedLine[]).map(mat => ({
      kind: mat.materialType as any, id: Number(mat.materialId),
    })),
  ]);
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }
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

  // Raw material and packing material are costed and reported separately so a
  // batch cost can be explained. 'material' is the raw-material master,
  // 'raw_material' is the packing-material master (see the header note).
  const sumLines = (kind: string) =>
    r2(materialUsed.filter((l) => l.materialType === kind).reduce((s, l) => s + (l.lineCost ?? 0), 0));
  const rmCost = sumLines("material");
  const pmCost = sumLines("raw_material");
  const materialCost = r2(rmCost + pmCost);
  const overheadAmount = r2(materialCost * overheadPercent / 100);
  const wastageQty = r3(wastageLines.reduce((s, w) => s + w.quantity, 0));

  const locName = await locationLabel(pool, loc);

  // ── All writes in one transaction, serialized per item ───────────────────
  // (advisory lock removes the first-production stock-entry race; any
  //  mid-flow failure rolls back every stock/cost side effect together —
  //  including the labour allocation and the accounting posting, so the books
  //  can never disagree with the stock move)
  const client = await pool.connect();
  let rowId = 0;
  let createdAt: Date | null = null;
  let batchNumber = "";
  let mfgDate: string | null = null;
  let expiryDate: string | null = null;
  let labourCost = 0;
  let labourMethod = "none";
  let totalCost = 0;
  let costPerUnit = 0;
  let wastageValue = 0;
  try {
    await client.query("BEGIN");
    // Lock order: labour day+location first, then the per-item lock (see
    // lockLabourDay). Taking them in the other order here would deadlock against
    // the edit/delete paths, which cannot know the item until they read the row.
    await lockLabourDay(client, parsed.data.productionDate, loc);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('production-stock'), $1)`, [parsed.data.itemId]);

    const { rows: [inserted] } = await client.query(
      `INSERT INTO productions (item_id, produced_quantity, production_date, material_used, notes, location_type, location_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, created_at`,
      [parsed.data.itemId, produced, parsed.data.productionDate, JSON.stringify(materialUsed), parsed.data.notes ?? null,
       loc.type, loc.id]
    );
    rowId = inserted.id;
    createdAt = inserted.created_at;

    // Batch identity: user-provided or the existing display convention (B-0001)
    batchNumber = (rawBody.batchNumber ?? "").trim() || defaultBatchNumber(rowId);
    mfgDate = rawBody.mfgDate || parsed.data.productionDate || null;
    expiryDate = rawBody.expiryDate || null;
    await client.query(
      `UPDATE productions SET batch_number = $1, mfg_date = $2, expiry_date = $3,
         material_cost = $4, rm_cost = $5, pm_cost = $6,
         overhead_percent = $7, overhead_amount = $8,
         labour_cost = $9, labour_method = $10,
         wastage = $11::jsonb, wastage_qty = $12
       WHERE id = $13`,
      [batchNumber, mfgDate, expiryDate,
       materialCost, rmCost, pmCost, overheadPercent, overheadAmount,
       manualLabour ?? 0, manualLabour === null ? "none" : "manual",
       JSON.stringify(wastageLines), wastageQty, rowId]
    );

    // ── Labour, then the derived totals ──────────────────────────────────────
    // Labour is the day's production wage cost at this location, shared across
    // every batch made that day — so recording this batch re-spreads labour
    // over its siblings. reallocateDayLabour() writes total_cost, cost_per_unit
    // and wastage_value for all of them and returns what each now carries.
    const alloc = await reallocateDayLabour(client, parsed.data.productionDate, loc);
    const mine = alloc.rows.find((r) => r.id === rowId);
    if (!mine) throw new Error("Labour allocation did not include the new batch");
    labourCost = mine.labourCost;
    labourMethod = mine.labourMethod;
    totalCost = mine.totalCost;
    costPerUnit = mine.costPerUnit;
    wastageValue = mine.wastageValue;

    // Deduct materials used. The mirror counter and the location row move
    // together: production consumes at the location that is manufacturing, so
    // a warehouse's run never draws down Head Office material.
    for (const mat of materialUsed) {
      const table = mat.materialType === "material" ? "materials" : "raw_materials";
      await client.query(
        `UPDATE ${table} SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`,
        [mat.usedQuantity, mat.materialId]
      );
      if (isMaterialKind(mat.materialType)) {
        // Material already committed to another document cannot also be consumed
        // here, so the check is against available (on hand − held) and the row is
        // locked before it is judged.
        const avail = await availabilityAt(client, {
          refId: mat.materialId, materialType: mat.materialType,
          branchType: loc.type, branchId: loc.id, lock: true,
        });
        if (avail.available + 0.001 < Number(mat.usedQuantity)) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: mat.materialName ?? `#${mat.materialId}`,
              locationName: locName, unit: mat.unit,
              quantity: avail.quantity, reserved: avail.reserved,
              requested: Number(mat.usedQuantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        // Forward consumption must NOT clamp: a shortfall here means the batch
        // is claiming more material than this location holds, and silently
        // flooring it at zero would manufacture stock out of nothing.
        const taken = await deductMaterialAt(
          client, mat.materialType, mat.materialId, loc.type, loc.id, Number(mat.usedQuantity)
        );
        if (!taken.ok) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: mat.materialName ?? `#${mat.materialId}`,
              locationName: locName, unit: mat.unit,
              quantity: taken.available, reserved: avail.reserved,
              requested: Number(mat.usedQuantity),
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        // Draw the material from its own lots, earliest expiry first, and keep
        // the breakdown on the line so a later reversal restores the exact lots
        // (and their mfg/expiry dates) rather than inventing a new one.
        mat.batchBreakdown = await consumeBatches(client, {
          itemId: mat.materialId, materialType: mat.materialType,
          branchType: loc.type, branchId: loc.id,
          quantity: Number(mat.usedQuantity),
        });
      }
    }
    // Persist the lot allocations recorded above onto the stored line items.
    await client.query(
      `UPDATE productions SET material_used = $1::jsonb WHERE id = $2`,
      [JSON.stringify(materialUsed), rowId]
    );

    // Add to item production stock (good units only — wastage never enters stock)
    await client.query(
      `UPDATE items SET production_stock = production_stock::numeric + $1, updated_at = now() WHERE id = $2`,
      [produced, parsed.data.itemId]
    );

    // Production stock entry, at the manufacturing location
    // (atomic upsert on uq_stock_entries_ref_branch)
    await client.query(
      `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
       VALUES ($1, 'item', $3, $4, $2, '0')
       ON CONFLICT (item_id, material_type, branch_type, branch_id)
       DO UPDATE SET quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric, updated_at = now()`,
      [parsed.data.itemId, produced, loc.type, loc.id]
    );

    // Track the produced batch and roll the item's weighted-average cost.
    // The batch's own cost-per-unit is the truth when available; zero-cost
    // batches (materials without costs) fall back to the item's current average
    // so the average is never dragged to zero.
    const unitCost = costPerUnit > 0 ? costPerUnit : await inboundCostForItem(client, parsed.data.itemId);
    await creditBatch(client, {
      itemId: parsed.data.itemId, branchType: loc.type, branchId: loc.id,
      batchNumber, mfgDate, expiryDate,
      quantity: produced, unitCost,
      source: "production", sourceId: rowId,
      // The produced lot inherits the SKU's barcode and MRP, so a scan on the
      // pack identifies both the product and the price it was made to sell at.
      ...(await productBatchIdentity(client, "item", parsed.data.itemId)),
    });
    await updateAvgCostOnInbound(client, parsed.data.itemId, produced, unitCost);

    // ── Stock ledger ──────────────────────────────────────────────────────────
    await writeStockLedger(client, [
      ...materialUsed.map(mat => ({
        txnType: 'production_consumption',
        materialType: mat.materialType,
        refId: mat.materialId,
        itemName: mat.materialName ?? '',
        unit: mat.unit ?? '',
        branchType: loc.type,
        branchId: ledgerBranchId(loc, mat.materialType),
        branchName: locName,
        qtyChange: -Number(mat.usedQuantity),
        unitCost: Number(mat.unitCost ?? 0),
        docType: 'production',
        docId: rowId,
      })),
      {
        txnType: 'production_output',
        materialType: 'item',
        refId: parsed.data.itemId,
        itemName: itemRow.name,
        unit: (itemRow as any).unit ?? '',
        branchType: loc.type,
        branchId: ledgerBranchId(loc, 'item'),
        branchName: locName,
        qtyChange: produced,
        unitCost,
        docType: 'production',
        docId: rowId,
      },
    ]);

    // ── Books: capitalise the batch cost into stock ──────────────────────────
    // Same transaction as the stock move, so stock and books commit together.
    //   Dr Finished Goods Inventory / Cr Production Cost Absorbed
    // The absorbed contra relieves the purchases and wages already expensed, so
    // manufacturing a batch does not move profit — only selling it does.
    await postProductionCostJv(client, {
      date: parsed.data.productionDate,
      narration: `Production ${batchNumber} — ${produced} × ${itemRow.name} at ${locName}`,
      amount: totalCost,
      direction: "capitalise",
      createdBy: (req as any).employee?.name ?? "system",
    });
    // Siblings whose labour share moved need their capitalised value moved too.
    await postReallocationAdjustment(client, {
      date: parsed.data.productionDate,
      rows: alloc.rows,
      excludeId: rowId,
      reason: `Production ${batchNumber} at ${locName}`,
      createdBy: (req as any).employee?.name ?? "system",
    });

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "CREATE", module: "production", entityType: "production", entityId: rowId,
    description: `Produced ${produced} × ${itemRow.name} at ${locName} on ${parsed.data.productionDate}` +
      (totalCost > 0 ? ` — cost ₹${totalCost.toFixed(2)} (₹${costPerUnit.toFixed(2)}/unit)` : "") +
      (labourCost > 0 ? `, labour ₹${labourCost.toFixed(2)} (${labourMethod})` : "") +
      (wastageQty > 0 ? `, wastage ${wastageQty}` : ""),
    metadata: { after: { itemId: parsed.data.itemId, itemName: itemRow.name, producedQuantity: produced, materialCount: materialUsed.length, locationType: loc.type, locationId: loc.id, rmCost, pmCost, labourCost, labourMethod, totalCost, costPerUnit, wastageQty } },
  }).catch(() => {});

  res.status(201).json({
    id: rowId, itemId: parsed.data.itemId, itemName: itemRow.name,
    producedQuantity: produced, productionDate: parsed.data.productionDate,
    materialUsed, notes: parsed.data.notes ?? null, createdAt,
    batchNumber, mfgDate, expiryDate,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    materialCost, rmCost, pmCost, labourCost, labourMethod,
    overheadPercent, overheadAmount, totalCost, costPerUnit,
    wastage: wastageLines, wastageQty, wastageValue,
  });
});

router.get("/productions/:id", requireModuleView("page:/production/production"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { rows: [ex] } = await pool.query(`SELECT ${EXTRA_COLS} FROM productions WHERE id = $1`, [id]);

  // LBAC: only the location that made the batch (and Head Office) may read it.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  if (!scope.isHeadOffice) {
    const t = ex?.location_type ?? "headoffice";
    const lid = Number(ex?.location_id ?? 1);
    const allowed = (t === "warehouse" && scope.warehouseIds.includes(lid))
      || (t === "outlet" && scope.outletIds.includes(lid));
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
  }

  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  const maps = await materialMaps();
  const locNames = await locationNameMap();
  res.json({
    ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity),
    materialUsed: enrichUsedLines((row.materialUsed ?? []) as UsedLine[], maps),
    batchNumber: ex?.batch_number ?? defaultBatchNumber(id), mfgDate: ex?.mfg_date ?? null, expiryDate: ex?.expiry_date ?? null,
    locationType: ex?.location_type ?? "headoffice",
    locationId: Number(ex?.location_id ?? 1),
    locationName: locNames.get(locKey(ex)) ?? "Head Office",
    ...costFields(ex),
  });
});

// ── Update (metadata only — date and notes) ───────────────────────────────────
router.patch("/productions/:id", requireModuleAction("page:/production/production", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  const { productionDate, notes } = req.body as { productionDate?: string; notes?: string };
  const updateData: Record<string, unknown> = {};
  if (productionDate !== undefined) updateData.productionDate = productionDate;
  if (notes !== undefined) updateData.notes = notes;
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  // Moving a batch to another date moves it into another day's labour pool, so
  // both days must be re-spread and the value difference posted. Done in one
  // transaction with the edit so costs and books never drift apart.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // An unlocked peek first, only to learn which day+location locks this edit
    // needs. Locks must be taken before the row lock (see lockLabourDay), and the
    // authoritative read below re-checks everything under the lock.
    const { rows: [peek] } = await client.query(
      `SELECT to_char(production_date, 'YYYY-MM-DD') AS day, location_type, location_id
       FROM productions WHERE id = $1`, [id]
    );
    if (!peek) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }
    const peekLoc: ProdLocation = {
      type: peek.location_type ?? "headoffice",
      id: Number(peek.location_id ?? 1),
    };
    // Sorted so two edits moving batches in opposite directions take the two day
    // locks in the same order and cannot deadlock against each other.
    const daysToLock = Array.from(new Set([peek.day, productionDate ?? peek.day])).sort();
    for (const day of daysToLock) await lockLabourDay(client, day, peekLoc);

    const { rows: [before] } = await client.query(
      `SELECT to_char(production_date, 'YYYY-MM-DD') AS day, location_type, location_id, batch_number
       FROM productions WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!before) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }
    // If the row moved day or location between the peek and the lock, the locks
    // held are the wrong ones. Bail out rather than reallocate the wrong pools.
    if (before.day !== peek.day
      || (before.location_type ?? "headoffice") !== peekLoc.type
      || Number(before.location_id ?? 1) !== peekLoc.id) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch was changed by someone else. Reload and try again." }); return;
    }
    // LBAC: a batch belonging to another location must not be editable by id.
    const editLoc: ProdLocation = {
      type: before.location_type ?? "headoffice",
      id: Number(before.location_id ?? 1),
    };
    const editScope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
    if (!editScope.isHeadOffice) {
      const allowed = (editLoc.type === "warehouse" && editScope.warehouseIds.includes(editLoc.id))
        || (editLoc.type === "outlet" && editScope.outletIds.includes(editLoc.id));
      if (!allowed) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" }); return;
      }
    }
    if (productionDate !== undefined) {
      await client.query(`UPDATE productions SET production_date = $1 WHERE id = $2`, [productionDate, id]);
    }
    if (notes !== undefined) {
      await client.query(`UPDATE productions SET notes = $1 WHERE id = $2`, [notes, id]);
    }

    const loc: ProdLocation = editLoc;
    const newDay = productionDate ?? before.day;
    if (newDay !== before.day) {
      const label = before.batch_number || defaultBatchNumber(id);
      for (const day of daysToLock) {
        const realloc = await reallocateDayLabour(client, day, loc);
        await postReallocationAdjustment(client, {
          date: day, rows: realloc.rows,
          reason: `Production ${label} moved to ${newDay}`,
          createdBy: (req as any).employee?.name ?? "system",
        });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const [row] = await db.select().from(productionsTable).where(eq(productionsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? "", producedQuantity: Number(row.producedQuantity), materialUsed: row.materialUsed ?? [] });
});

// ── Delete (with full stock reversal) ────────────────────────────────────────
router.delete("/productions/:id", requireModuleAction("page:/production/production", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid production id" }); return; }
  // ── Full reversal in one transaction ─────────────────────────────────────
  // Row-lock the production BEFORE reading its data: a concurrent DELETE of
  // the same batch blocks on FOR UPDATE, then sees zero rows → 404, so stock
  // can never be reversed twice from a stale snapshot. The day+location and
  // per-item advisory locks are taken first, in the order lockLabourDay
  // documents, so this path cannot deadlock against a concurrent create or edit.
  const client = await pool.connect();
  let itemId = 0;
  let qty = 0;
  let delLocName = "Head Office";
  try {
    await client.query("BEGIN");
    // Unlocked peek purely to learn which locks are needed; everything is
    // re-read and re-validated under the locks below.
    const { rows: [peek] } = await client.query(
      `SELECT item_id, location_type, location_id, to_char(production_date, 'YYYY-MM-DD') AS day
       FROM productions WHERE id = $1`, [id]
    );
    if (!peek) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" });
      return;
    }
    const peekLoc: ProdLocation = {
      type: peek.location_type ?? "headoffice",
      id: Number(peek.location_id ?? 1),
    };
    await lockLabourDay(client, peek.day, peekLoc);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('production-stock'), $1)`, [Number(peek.item_id)]);

    const { rows: [row] } = await client.query(
      `SELECT *, to_char(production_date, 'YYYY-MM-DD') AS production_date_str
       FROM productions WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!row) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Reverse at the location that produced it, never a hardcoded Head Office.
    const delLoc: ProdLocation = {
      type: row.location_type ?? "headoffice",
      id: Number(row.location_id ?? 1),
    };
    // Locks were chosen from the peek; if the row moved since, they are the
    // wrong ones and this reversal would touch pools it does not hold.
    if (row.production_date_str !== peek.day
      || delLoc.type !== peekLoc.type || delLoc.id !== peekLoc.id
      || Number(row.item_id) !== Number(peek.item_id)) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch was changed by someone else. Reload and try again." });
      return;
    }
    delLocName = await locationLabel(client, delLoc);

    // LBAC: a location may only delete its own runs.
    const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
    if (!scope.isHeadOffice) {
      const allowed = (delLoc.type === "warehouse" && scope.warehouseIds.includes(delLoc.id))
        || (delLoc.type === "outlet" && scope.outletIds.includes(delLoc.id));
      if (!allowed) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" });
        return;
      }
    }

    const materialUsed = (row.material_used ?? []) as Array<{ materialType: string; materialId: number; usedQuantity: number }>;
    qty = Number(row.produced_quantity);
    itemId = Number(row.item_id);
    const delBatchNumber = row.batch_number || defaultBatchNumber(id);
    const delDate = row.production_date_str as string;
    const delTotalCost = Number(row.total_cost ?? 0);
    const { rows: [delItemInfo] } = await client.query(`SELECT name, unit FROM items WHERE id = $1`, [itemId]);

    // (the per-item lock for this row was already taken above, before the row lock)

    // Reverse material deductions
    for (const mat of materialUsed) {
      const table = mat.materialType === "material" ? "materials"
        : mat.materialType === "raw_material" ? "raw_materials" : null;
      if (!table) continue;
      await client.query(
        `UPDATE ${table} SET current_stock = GREATEST(0, current_stock::numeric + $1), updated_at = now() WHERE id = $2`,
        [mat.usedQuantity, mat.materialId]
      );
      if (isMaterialKind(mat.materialType)) {
        await creditMaterialAt(
          client, mat.materialType, mat.materialId, delLoc.type, delLoc.id, Number(mat.usedQuantity)
        );
        // Return the exact lots this batch consumed. Batches recorded before
        // material lots existed carry no breakdown; credit a reversal lot so
        // the batch layer still reconciles with the located quantity.
        const alloc = (mat as any).batchBreakdown as BatchBreakdownEntry[] | undefined;
        const allocTotal = (alloc ?? []).reduce((s, b) => s + Number(b?.quantity ?? 0), 0);
        await restoreBatches(
          client, mat.materialId, delLoc.type, delLoc.id, alloc,
          "production_reversal", id, mat.materialType
        );
        const residual = Number(mat.usedQuantity) - allocTotal;
        if (residual > 0.001) {
          await creditBatch(client, {
            itemId: mat.materialId, materialType: mat.materialType,
            branchType: delLoc.type, branchId: delLoc.id,
            batchNumber: `REV-PROD-${id}`, quantity: residual,
            unitCost: await inboundCostForMaterial(client, mat.materialType, mat.materialId),
            source: "production_reversal", sourceId: id,
            ...(await productBatchIdentity(client, mat.materialType as any, mat.materialId)),
          });
        }
      }
    }

    // Reverse production stock
    await client.query(
      `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $1), updated_at = now() WHERE id = $2`,
      [qty, itemId]
    );
    await client.query(
      `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
       WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
      [qty, itemId, delLoc.type, delLoc.id]
    );

    // Reverse this production's own batch (floored — it may be partly consumed)
    await debitBatchByNumber(client, {
      itemId, materialType: "item", branchType: delLoc.type, branchId: delLoc.id,
      batchNumber: delBatchNumber, quantity: qty,
    });

    // ── Stock ledger (production delete reversals) ────────────────────────────
    await writeStockLedger(client, [
      ...(materialUsed as any[]).map(mat => ({
        txnType: 'production_consumption',
        materialType: mat.materialType,
        refId: mat.materialId,
        itemName: mat.materialName ?? '',
        unit: mat.unit ?? '',
        branchType: delLoc.type,
        branchId: ledgerBranchId(delLoc, mat.materialType),
        branchName: delLocName,
        qtyChange: Number(mat.usedQuantity),
        unitCost: Number(mat.unitCost ?? 0),
        docType: 'production',
        docId: id,
        notes: 'Production deleted — consumption reversed',
      })),
      {
        txnType: 'production_output',
        materialType: 'item',
        refId: itemId,
        itemName: delItemInfo?.name ?? '',
        unit: delItemInfo?.unit ?? '',
        branchType: delLoc.type,
        branchId: ledgerBranchId(delLoc, 'item'),
        branchName: delLocName,
        qtyChange: -qty,
        unitCost: 0,
        docType: 'production',
        docId: id,
        notes: 'Production deleted — output reversed',
      },
    ]);

    await client.query(`DELETE FROM productions WHERE id = $1`, [id]);

    // ── Books: relieve the capitalised cost ──────────────────────────────────
    // Mirror image of the create posting, so what stays capitalised always
    // equals the value of the batches still on the books.
    await postProductionCostJv(client, {
      date: delDate,
      narration: `Production ${delBatchNumber} deleted — ${qty} × ${delItemInfo?.name ?? `item #${itemId}`} at ${delLocName}`,
      amount: delTotalCost,
      direction: "relieve",
      createdBy: (req as any).employee?.name ?? "system",
    });

    // The day's labour pool now spreads over one batch fewer, so the siblings'
    // costs (and their capitalised value) move. Runs after the DELETE so the
    // removed batch is excluded from the re-spread.
    const realloc = await reallocateDayLabour(client, delDate, delLoc);
    await postReallocationAdjustment(client, {
      date: delDate,
      rows: realloc.rows,
      reason: `Production ${delBatchNumber} deleted at ${delLocName}`,
      createdBy: (req as any).employee?.name ?? "system",
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "DELETE", module: "production", entityType: "production", entityId: id,
    description: `Production batch B-${String(id).padStart(4, "0")} deleted at ${delLocName} (${qty} units reversed)`,
    metadata: { before: { itemId, producedQuantity: qty } },
  }).catch(() => {});

  res.status(204).send();
});

export default router;

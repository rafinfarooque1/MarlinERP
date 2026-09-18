/**
 * The single stock-valuation function.
 *
 * Every figure that expresses "what is our stock worth" must come from here:
 * the P&L closing stock, the Balance Sheet, the Stock Valuation report, the
 * Live Stock page and the dashboard. Before this existed the P&L valued stock
 * at MRP off an abandoned counter column while the Stock Valuation report
 * valued the same item at weighted-average cost, so the two never agreed.
 *
 * Rules:
 *  - Quantity comes from `stock_entries`, which is the quantity truth for all
 *    three product kinds. Never from `items.production_stock` or
 *    `materials.current_stock` (retired company-wide counters that cannot
 *    express a location) and never from `stock_batches` (a reconciling lot
 *    layer that may total less than the entry).
 *  - Cost is the latest dated per-product/per-location weighted-average cost
 *    checkpoint, falling back to the product's weighted-average cost and then
 *    manual cost when no checkpoint exists. MRP is a selling price and must
 *    never value stock — that would capitalise unrealised profit into inventory.
 *  - Raw materials and packing materials are stock too. Valuing finished goods
 *    only understated inventory by the whole material holding.
 *  - Dispatched-but-unreceived stock belongs to nobody's on-hand figure: it
 *    left the sender at dispatch and reaches the destination only on receipt.
 *    It is valued from the in-transit reservation ledger and attributed to the
 *    sender, so a transfer in flight never makes inventory disappear.
 */

import { activeInTransit, reservedSql, type ReservationProductKind } from "./reservations";
import { scopeBranchWhere, type DataScope } from "./dataScope";
import { isIsoDate } from "./dateInput";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

export type ProductKind = ReservationProductKind;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Weighted-average cost with a manual-cost fallback, for a stock_entries row
 *  joined to all three master tables as i / m / rm. Only one join can match a
 *  row (the id spaces overlap, so every join is guarded by material_type), so
 *  COALESCE picks that one master's figures. */
export const PRODUCT_UNIT_COST_SQL = `
  CASE WHEN scs.unit_cost IS NOT NULL THEN scs.unit_cost::numeric
       WHEN COALESCE(i.avg_cost, m.avg_cost, rm.avg_cost, 0)::numeric > 0
       THEN COALESCE(i.avg_cost, m.avg_cost, rm.avg_cost, 0)::numeric
       ELSE COALESCE(i.cost,     m.cost,     rm.cost,     0)::numeric END`;

/** Latest authoritative dated cost for the exact product/location key. */
export const LATEST_STOCK_COST_SNAPSHOT_JOIN = `
   LEFT JOIN LATERAL (
     SELECT CASE WHEN scs.quantity > 0 THEN scs.value::numeric / scs.quantity::numeric
                 ELSE scs.unit_cost::numeric END AS unit_cost
       FROM stock_cost_snapshots scs
      WHERE scs.material_type = se.material_type
        AND scs.ref_id = se.item_id
        AND scs.branch_type = se.branch_type
        AND scs.branch_id = se.branch_id
      ORDER BY scs.as_of_date DESC, scs.id DESC
      LIMIT 1
   ) scs ON TRUE`;

/** Items-only form, for queries that join `items` alone. Kept so the per-item
 *  reports and this module cannot value the same item differently. */
export const ITEM_UNIT_COST_SQL =
  `CASE WHEN COALESCE(i.avg_cost, 0) > 0 THEN i.avg_cost::numeric ELSE COALESCE(i.cost, 0)::numeric END`;

export const PRODUCT_MASTER_JOINS = `
  LEFT JOIN items         i  ON se.material_type = 'item'         AND i.id  = se.item_id
  LEFT JOIN materials     m  ON se.material_type = 'material'     AND m.id  = se.item_id
  LEFT JOIN raw_materials rm ON se.material_type = 'raw_material' AND rm.id = se.item_id`;

// The two material tables are named the opposite way round from how the business
// talks about them: `materials` is what staff call a raw material, and
// `raw_materials` is packing. The labels follow the business, not the table.
export const PRODUCT_KIND_LABELS: Record<ProductKind, string> = {
  item: "Finished Good",
  material: "Raw Material",
  raw_material: "Packing Material",
};

export interface ValuationRow {
  materialType: ProductKind;
  refId: number;
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  quantity: number;
  reserved: number;
  available: number;
  unitCost: number;
  value: number;
  /** true = dispatched and not yet received, still owned by this location. */
  inTransit: boolean;
}

export interface ValuationScope {
  branchType?: string;
  branchId?: number;
  /**
   * Every (branch_type, branch_id) identity of ONE physical place — a location
   * mirrored as both a warehouse and an outlet holds stock under either stamp.
   * When present, rows matching ANY pair are included and branchType/branchId
   * are ignored.
   */
  branchPairs?: Array<{ type: string; id: number }>;
  materialType?: ProductKind;
  /** Defaults to true: excluding in-flight stock understates inventory. */
  includeInTransit?: boolean;
  /**
   * Location scope of the requesting employee. Applied on top of any explicit
   * branch filter, so a warehouse user asking for another warehouse's stock gets
   * nothing rather than someone else's numbers.
   */
  dataScope?: DataScope;
  /** Historical position from the append-only stock cost checkpoints. */
  asOf?: string;
}

/** Whether one location is inside an employee's scope. */
function locationInScope(scope: DataScope | undefined, branchType: string, branchId: number): boolean {
  if (!scope || scope.isHeadOffice) return true;
  if (branchType === "warehouse") return scope.warehouseIds.includes(Number(branchId));
  if (branchType === "outlet") return scope.outletIds.includes(Number(branchId));
  return false;
}

export interface ValuationSummary {
  /** False means totals cover evidenced rows only, not a complete valuation. */
  reliable: boolean;
  note: string | null;
  issues: ValuationIssue[];
  rows: ValuationRow[];
  byLocation: Array<{
    branchType: string; branchId: number; lines: number;
    quantity: number; onHandValue: number; inTransitValue: number; value: number;
  }>;
  byType: Array<{ materialType: ProductKind; label: string; lines: number; quantity: number; value: number }>;
  byProduct: Array<{
    materialType: ProductKind; refId: number; itemName: string; unit: string;
    quantity: number; unitCost: number; value: number;
  }>;
  onHandValue: number;
  inTransitValue: number;
  reservedQuantity: number;
  grandTotal: number;
}

export interface ValuationIssue {
  code: string;
  materialType: string;
  refId: number;
  branchType: string;
  branchId: number;
  asOf?: string;
  quantity?: number;
  message: string;
}

/**
 * Per (product, location) closing stock valued at cost, across every location
 * and all three product kinds, plus in-transit rows when asked for.
 */
export async function stockValuationRows(q: Queryable, scope: ValuationScope = {}): Promise<ValuationRow[]> {
  const issues: ValuationIssue[] = [];
  const rows = await buildStockValuationRows(q, scope, issues);
  // Row-only consumers cannot display summary warnings. Refuse a partial
  // answer instead of silently turning absent evidence into zero inventory.
  if (issues.length) throw Object.assign(new Error(issues.map(i => i.message).join(" ")), {
    code: "INVENTORY_HISTORY_INCOMPLETE", issues,
  });
  return rows;
}

async function buildStockValuationRows(q: Queryable, scope: ValuationScope, issues: ValuationIssue[]): Promise<ValuationRow[]> {
  if (scope.asOf != null && !isIsoDate(scope.asOf)) throw new Error("Invalid stock valuation cutoff date");
  const conds = [scope.asOf
    ? "(se.quantity::numeric <> 0 OR se.evidence_issue IS NOT NULL)"
    : "se.quantity::numeric > 0"];
  const params: unknown[] = [];
  if (scope.asOf) params.push(scope.asOf);
  if (scope.branchPairs && scope.branchPairs.length > 0) {
    const parts = scope.branchPairs.map((p) => {
      params.push(p.type, p.id);
      return `(se.branch_type = $${params.length - 1} AND se.branch_id = $${params.length})`;
    });
    conds.push(`(${parts.join(" OR ")})`);
  } else {
    if (scope.branchType) { params.push(scope.branchType); conds.push(`se.branch_type = $${params.length}`); }
    if (scope.branchId != null) { params.push(scope.branchId); conds.push(`se.branch_id = $${params.length}`); }
  }
  if (scope.materialType) { params.push(scope.materialType); conds.push(`se.material_type = $${params.length}`); }
  if (scope.dataScope && !scope.dataScope.isHeadOffice) {
    conds.push(scopeBranchWhere(scope.dataScope, params, "se"));
  }

  const source = scope.asOf
    ? `(WITH inventory_keys AS (
          SELECT item_id AS ref_id, material_type, branch_type, branch_id FROM stock_entries
          UNION SELECT ref_id, material_type, branch_type, branch_id FROM stock_ledger
          UNION SELECT ref_id, material_type, branch_type, branch_id FROM stock_cost_snapshots
        )
        SELECT k.ref_id AS item_id, k.material_type, k.branch_type, k.branch_id,
               COALESCE(s.quantity, COALESCE(current_stock.quantity, 0) - movement.after_cutoff) AS quantity,
               CASE WHEN s.quantity > 0 THEN s.value::numeric / s.quantity::numeric
                    ELSE s.unit_cost::numeric END AS unit_cost,
               s.value AS checkpoint_value,
               CASE
                 WHEN s.id IS NULL AND ABS(COALESCE(current_stock.quantity, 0) - movement.after_cutoff) > 0.0001
                   THEN 'MISSING_COST_CHECKPOINT'
                 WHEN s.id IS NOT NULL AND ABS(s.quantity - (COALESCE(current_stock.quantity, 0) - movement.after_checkpoint)) > 0.0001
                   THEN 'CHECKPOINT_QUANTITY_MISMATCH'
                 ELSE NULL END AS evidence_issue
          FROM inventory_keys k
          LEFT JOIN stock_entries current_stock ON current_stock.item_id = k.ref_id
           AND current_stock.material_type = k.material_type AND current_stock.branch_type = k.branch_type
           AND current_stock.branch_id = k.branch_id
          LEFT JOIN LATERAL (
            SELECT * FROM stock_cost_snapshots scs
             WHERE scs.ref_id = k.ref_id AND scs.material_type = k.material_type
               AND scs.branch_type = k.branch_type AND scs.branch_id = k.branch_id
               AND scs.as_of_date <= $1::date
             ORDER BY scs.as_of_date DESC, scs.id DESC LIMIT 1
          ) s ON TRUE
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(sl.qty_change) FILTER (WHERE COALESCE(sl.txn_date, sl.created_at::date) > $1::date), 0) AS after_cutoff,
                   COALESCE(SUM(sl.qty_change) FILTER (WHERE COALESCE(sl.txn_date, sl.created_at::date) > s.as_of_date), 0) AS after_checkpoint
              FROM stock_ledger sl
             WHERE sl.ref_id = k.ref_id AND sl.material_type = k.material_type
               AND sl.branch_type = k.branch_type AND sl.branch_id = k.branch_id
          ) movement ON TRUE
        ) se`
    : `stock_entries se`;
  const costSql = scope.asOf
    ? `se.unit_cost::numeric`
    : PRODUCT_UNIT_COST_SQL;
  const reservedSqlForScope = scope.asOf ? "0::numeric" : reservedSql("se");
  const snapshotJoin = scope.asOf ? "" : LATEST_STOCK_COST_SNAPSHOT_JOIN;
  const { rows } = await q.query(
    `SELECT se.item_id                                 AS ref_id,
            se.material_type,
            COALESCE(i.name, m.name, rm.name, '')      AS item_name,
            COALESCE(i.unit, m.unit, rm.unit, '')      AS unit,
            se.branch_type, se.branch_id::int           AS branch_id,
            se.quantity::numeric                        AS quantity,
            ${reservedSqlForScope}                       AS reserved,
            ${costSql}                                  AS unit_cost,
            ${scope.asOf ? "se.checkpoint_value" : "NULL::numeric"} AS checkpoint_value,
            ${scope.asOf ? "se.evidence_issue" : "NULL::text"} AS evidence_issue
       FROM ${source}
       ${PRODUCT_MASTER_JOINS}
        ${snapshotJoin}
      WHERE ${conds.join(" AND ")}
      ORDER BY se.branch_type, se.branch_id, item_name`,
    params,
  );

  const onHand: ValuationRow[] = rows.flatMap((r: any) => {
    const quantity = r3(Number(r.quantity));
    if (r.evidence_issue || (scope.asOf && r.unit_cost == null) || quantity < 0) {
      issues.push({
        code: r.evidence_issue ?? (quantity < 0 ? "NEGATIVE_HISTORICAL_STOCK" : "MISSING_COST_CHECKPOINT"),
        materialType: r.material_type, refId: Number(r.ref_id), branchType: r.branch_type,
        branchId: Number(r.branch_id), asOf: scope.asOf, quantity,
        message: `Inventory evidence is incomplete for ${r.material_type}:${r.ref_id} at ${r.branch_type}:${r.branch_id}`
          + `${scope.asOf ? ` on ${scope.asOf}` : ""} (${r.evidence_issue ?? "missing cost or negative quantity"}). `
          + "This position is excluded from the partial total; no current master cost has been substituted.",
      });
      return [];
    }
    const reserved = r3(Number(r.reserved ?? 0));
    const rawUnitCost = Number(r.unit_cost ?? 0);
    const unitCost = r2(rawUnitCost);
    return [{
      materialType: (r.material_type ?? "item") as ProductKind,
      refId: Number(r.ref_id),
      itemName: r.item_name ?? "",
      unit: r.unit ?? "",
      branchType: r.branch_type,
      branchId: Number(r.branch_id),
      quantity,
      reserved,
      available: r3(Math.max(0, quantity - reserved)),
      unitCost,
      // Keep checkpoint precision through the value calculation. The display
      // unit cost may be rounded to paise, but rounding it before multiplying
      // can turn a conserved blended receipt into a one-paise inventory gain.
      value: scope.asOf && r.checkpoint_value != null ? r2(Number(r.checkpoint_value)) : r2(quantity * rawUnitCost),
      inTransit: false,
    }];
  });

  if (scope.includeInTransit === false) return onHand;

  // In-transit rows carry their dispatched cost, never mutable master cost.
  const transit = (await activeInTransit(q, {
    branchType: scope.branchPairs?.length ? undefined : scope.branchType,
    branchId: scope.branchPairs?.length ? undefined : scope.branchId,
    materialType: scope.materialType,
    asOf: scope.asOf,
  }))
    .filter((t) => locationInScope(scope.dataScope, t.branchType, t.branchId))
    .filter((t) => !scope.branchPairs?.length
      || scope.branchPairs.some((p) => p.type === t.branchType && Number(p.id) === Number(t.branchId)));
  if (transit.length === 0) return onHand;

  const names = await resolveProductNames(q, transit.map((t) => ({ materialType: t.materialType, refId: t.refId })));
  const grouped = new Map<string, ValuationRow>();
  for (const t of transit) {
    const key = `${t.materialType}:${t.refId}:${t.branchType}:${t.branchId}`;
    const meta = names.get(`${t.materialType}:${t.refId}`);
    if (!(t.unitCost > 0)) {
      issues.push({
        code: "MISSING_TRANSIT_COST", materialType: t.materialType, refId: t.refId,
        branchType: t.branchType, branchId: t.branchId, asOf: scope.asOf, quantity: t.quantity,
        message: `Transfer ${t.docId} has no positive evidenced dispatch cost for ${t.materialType}:${t.refId}. `
          + "Its value is unknown and excluded from this partial valuation.",
      });
      continue;
    }
    const unitCost = t.unitCost;
    const existing = grouped.get(key);
    if (existing) {
      const quantity = r3(existing.quantity + t.quantity);
      existing.quantity = quantity;
      existing.available = quantity;
      existing.value = r2(existing.value + t.quantity * unitCost);
      // Blended cost, so value / quantity always reconciles.
      existing.unitCost = quantity > 0 ? r2(existing.value / quantity) : unitCost;
    } else {
      grouped.set(key, {
        materialType: t.materialType,
        refId: t.refId,
        itemName: meta?.name ?? "",
        unit: meta?.unit ?? "",
        branchType: t.branchType,
        branchId: t.branchId,
        quantity: t.quantity,
        reserved: 0,
        available: t.quantity,
        unitCost,
        value: r2(t.quantity * unitCost),
        inTransit: true,
      });
    }
  }
  return [...onHand, ...grouped.values()];
}

/** Names, units and fallback costs for a mixed list of product references. */
export async function resolveProductNames(
  q: Queryable,
  refs: Array<{ materialType: ProductKind; refId: number }>,
): Promise<Map<string, { name: string; unit: string; unitCost: number }>> {
  const out = new Map<string, { name: string; unit: string; unitCost: number }>();
  if (refs.length === 0) return out;
  const byKind: Record<string, number[]> = { item: [], material: [], raw_material: [] };
  for (const r of refs) {
    const kind = r.materialType ?? "item";
    if (!byKind[kind]) continue;
    if (!byKind[kind].includes(r.refId)) byKind[kind].push(r.refId);
  }
  const TABLES: Record<string, string> = { item: "items", material: "materials", raw_material: "raw_materials" };
  for (const kind of Object.keys(byKind)) {
    const ids = byKind[kind];
    if (ids.length === 0) continue;
    const { rows } = await q.query(
      `SELECT id, name, unit,
              CASE WHEN COALESCE(avg_cost, 0)::numeric > 0 THEN avg_cost::numeric ELSE COALESCE(cost, 0)::numeric END AS unit_cost
         FROM ${TABLES[kind]} WHERE id = ANY($1::int[])`,
      [ids],
    );
    for (const r of rows) {
      out.set(`${kind}:${Number(r.id)}`, {
        name: r.name ?? "",
        unit: r.unit ?? "",
        unitCost: r2(Number(r.unit_cost ?? 0)),
      });
    }
  }
  return out;
}

/** Rows plus every roll-up a report, statement or dashboard needs. */
export async function stockValuation(q: Queryable, scope: ValuationScope = {}): Promise<ValuationSummary> {
  const issues: ValuationIssue[] = [];
  const rows = await buildStockValuationRows(q, scope, issues);

  const locMap = new Map<string, ValuationSummary["byLocation"][number]>();
  const typeMap = new Map<ProductKind, ValuationSummary["byType"][number]>();
  const prodMap = new Map<string, ValuationSummary["byProduct"][number]>();

  let onHandValue = 0;
  let inTransitValue = 0;
  let reservedQuantity = 0;

  for (const r of rows) {
    if (r.inTransit) inTransitValue = r2(inTransitValue + r.value);
    else onHandValue = r2(onHandValue + r.value);
    reservedQuantity = r3(reservedQuantity + r.reserved);

    const lk = `${r.branchType}:${r.branchId}`;
    const loc = locMap.get(lk) ?? {
      branchType: r.branchType, branchId: r.branchId, lines: 0,
      quantity: 0, onHandValue: 0, inTransitValue: 0, value: 0,
    };
    loc.lines += 1;
    loc.quantity = r3(loc.quantity + r.quantity);
    if (r.inTransit) loc.inTransitValue = r2(loc.inTransitValue + r.value);
    else loc.onHandValue = r2(loc.onHandValue + r.value);
    loc.value = r2(loc.onHandValue + loc.inTransitValue);
    locMap.set(lk, loc);

    const type = typeMap.get(r.materialType) ?? {
      materialType: r.materialType, label: PRODUCT_KIND_LABELS[r.materialType] ?? r.materialType,
      lines: 0, quantity: 0, value: 0,
    };
    type.lines += 1;
    type.quantity = r3(type.quantity + r.quantity);
    type.value = r2(type.value + r.value);
    typeMap.set(r.materialType, type);

    const pk = `${r.materialType}:${r.refId}`;
    const prod = prodMap.get(pk) ?? {
      materialType: r.materialType, refId: r.refId, itemName: r.itemName, unit: r.unit,
      quantity: 0, unitCost: r.unitCost, value: 0,
    };
    prod.quantity = r3(prod.quantity + r.quantity);
    prod.value = r2(prod.value + r.value);
    prod.unitCost = prod.quantity > 0 ? r2(prod.value / prod.quantity) : r.unitCost;
    prodMap.set(pk, prod);
  }

  return {
    reliable: issues.length === 0,
    note: issues.length ? issues.map(i => i.message).join(" ") : null,
    issues,
    rows,
    byLocation: [...locMap.values()].sort((a, b) => b.value - a.value),
    byType: [...typeMap.values()].sort((a, b) => b.value - a.value),
    byProduct: [...prodMap.values()].sort((a, b) => a.itemName.localeCompare(b.itemName)),
    onHandValue,
    inTransitValue,
    reservedQuantity,
    grandTotal: r2(onHandValue + inTransitValue),
  };
}

export type ValuedItem = {
  id: number;
  name: string;
  unit: string;
  stock: number;
  unitCost: number;
  total: number;
  materialType: ProductKind;
  typeLabel: string;
};

/**
 * Closing stock for the financial statements: every product kind, every
 * location, in-transit included, valued at cost. One number, one source.
 *
 * `scope` narrows to one branch for location-filtered statements. In-transit
 * stock stays sender-owned, so a branch slice includes what it has dispatched
 * but the destination has not yet received.
 */
export async function closingStockValuation(
  q: Queryable,
  scope: { branchType?: string; branchId?: number; branchPairs?: Array<{ type: string; id: number }> } = {},
): Promise<{ items: ValuedItem[]; total: number; inTransit: number }> {
  const summary = await stockValuation(q, { includeInTransit: true, ...scope });
  return {
    items: summary.byProduct
      .filter((p) => p.quantity > 0)
      .map((p) => ({
        id: p.refId,
        name: p.itemName,
        unit: p.unit,
        stock: p.quantity,
        unitCost: p.unitCost,
        total: p.value,
        materialType: p.materialType,
        typeLabel: PRODUCT_KIND_LABELS[p.materialType] ?? p.materialType,
      })),
    total: summary.grandTotal,
    inTransit: summary.inTransitValue,
  };
}

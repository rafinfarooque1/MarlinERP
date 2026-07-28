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
 *  - Cost is the product's weighted-average cost, falling back to its manual
 *    cost. MRP is a selling price and must never value stock — that would
 *    capitalise unrealised profit into inventory.
 *  - Raw materials and packing materials are stock too. Valuing finished goods
 *    only understated inventory by the whole material holding.
 *  - Dispatched-but-unreceived stock belongs to nobody's on-hand figure: it
 *    left the sender at dispatch and reaches the destination only on receipt.
 *    It is valued from the in-transit reservation ledger and attributed to the
 *    sender, so a transfer in flight never makes inventory disappear.
 */

import { activeInTransit, reservedSql, type ReservationProductKind } from "./reservations";
import { scopeBranchWhere, type DataScope } from "./dataScope";

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
  CASE WHEN COALESCE(i.avg_cost, m.avg_cost, rm.avg_cost, 0)::numeric > 0
       THEN COALESCE(i.avg_cost, m.avg_cost, rm.avg_cost, 0)::numeric
       ELSE COALESCE(i.cost,     m.cost,     rm.cost,     0)::numeric END`;

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
  materialType?: ProductKind;
  /** Defaults to true: excluding in-flight stock understates inventory. */
  includeInTransit?: boolean;
  /**
   * Location scope of the requesting employee. Applied on top of any explicit
   * branch filter, so a warehouse user asking for another warehouse's stock gets
   * nothing rather than someone else's numbers.
   */
  dataScope?: DataScope;
}

/** Whether one location is inside an employee's scope. */
function locationInScope(scope: DataScope | undefined, branchType: string, branchId: number): boolean {
  if (!scope || scope.isHeadOffice) return true;
  if (branchType === "warehouse") return scope.warehouseIds.includes(Number(branchId));
  if (branchType === "outlet") return scope.outletIds.includes(Number(branchId));
  return false;
}

export interface ValuationSummary {
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

/**
 * Per (product, location) closing stock valued at cost, across every location
 * and all three product kinds, plus in-transit rows when asked for.
 */
export async function stockValuationRows(q: Queryable, scope: ValuationScope = {}): Promise<ValuationRow[]> {
  const conds = ["se.quantity::numeric > 0"];
  const params: unknown[] = [];
  if (scope.branchType) { params.push(scope.branchType); conds.push(`se.branch_type = $${params.length}`); }
  if (scope.branchId != null) { params.push(scope.branchId); conds.push(`se.branch_id = $${params.length}`); }
  if (scope.materialType) { params.push(scope.materialType); conds.push(`se.material_type = $${params.length}`); }
  if (scope.dataScope && !scope.dataScope.isHeadOffice) {
    conds.push(scopeBranchWhere(scope.dataScope, params, "se"));
  }

  const { rows } = await q.query(
    `SELECT se.item_id                                 AS ref_id,
            se.material_type,
            COALESCE(i.name, m.name, rm.name, '')      AS item_name,
            COALESCE(i.unit, m.unit, rm.unit, '')      AS unit,
            se.branch_type, se.branch_id::int           AS branch_id,
            se.quantity::numeric                        AS quantity,
            ${reservedSql("se")}                        AS reserved,
            ${PRODUCT_UNIT_COST_SQL}                    AS unit_cost
       FROM stock_entries se
       ${PRODUCT_MASTER_JOINS}
      WHERE ${conds.join(" AND ")}
      ORDER BY se.branch_type, se.branch_id, item_name`,
    params,
  );

  const onHand: ValuationRow[] = rows.map((r: any) => {
    const quantity = r3(Number(r.quantity));
    const reserved = r3(Number(r.reserved ?? 0));
    const unitCost = r2(Number(r.unit_cost ?? 0));
    return {
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
      value: r2(quantity * unitCost),
      inTransit: false,
    };
  });

  if (scope.includeInTransit === false) return onHand;

  // In-transit rows carry the cost they were dispatched at. A dispatch that
  // predates cost stamping falls back to the product's current cost rather than
  // valuing the shipment at zero.
  const transit = (await activeInTransit(q, {
    branchType: scope.branchType,
    branchId: scope.branchId,
    materialType: scope.materialType,
  })).filter((t) => locationInScope(scope.dataScope, t.branchType, t.branchId));
  if (transit.length === 0) return onHand;

  const names = await resolveProductNames(q, transit.map((t) => ({ materialType: t.materialType, refId: t.refId })));
  const grouped = new Map<string, ValuationRow>();
  for (const t of transit) {
    const key = `${t.materialType}:${t.refId}:${t.branchType}:${t.branchId}`;
    const meta = names.get(`${t.materialType}:${t.refId}`);
    const unitCost = t.unitCost > 0 ? t.unitCost : Number(meta?.unitCost ?? 0);
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
  const rows = await stockValuationRows(q, scope);

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
 */
export async function closingStockValuation(q: Queryable): Promise<{ items: ValuedItem[]; total: number; inTransit: number }> {
  const summary = await stockValuation(q, { includeInTransit: true });
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

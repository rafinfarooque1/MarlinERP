/**
 * GSTIN → location scoping for the GST pages (Summary, Returns).
 *
 * Several warehouses can share one GST registration. The effective GSTIN of a
 * location falls back like this:
 *
 *   warehouse  → warehouses.gst_number, else the company GSTIN
 *   outlet     → outlets.gstin, else its parent warehouse's effective GSTIN,
 *                else the company GSTIN
 *   headoffice → company_settings.gst_number
 *
 * DELIBERATE divergence from resolveLocationGst (lib/gstTransfer.ts), which
 * reads only the location's own column with NO fallback. That resolver decides
 * whether a transfer can carry a tax invoice — a blank GSTIN there must mean
 * "unregistered → internal, no invoice", and adding fallbacks would change
 * which transfers get taxed. Here the question is the opposite one: under
 * which REGISTRATION does an existing document get reported? A location
 * without its own registration necessarily files under its parent's/company's
 * GSTIN, so the fallback matches filing reality. Do not "unify" the two.
 *
 * The scope produced here is a set of (location_type, location_id) pairs that
 * SQL conditions are built from. When no filter is requested the caller must
 * pass NO condition at all — the unfiltered figures have to stay byte-stable.
 *
 * Legacy rows predate the location columns:
 *   sales      → COALESCE(location_type,'outlet') / COALESCE(location_id, outlet_id)
 *   purchases  → COALESCE(location_type, branch_type, 'headoffice') /
 *                COALESCE(location_id, branch_id, 0)
 * Head-office membership matches on TYPE alone — the id placeholder differs
 * per table (see the global-filter conventions).
 */
import { pool } from "@workspace/db";

export interface GstinGroup {
  gstin: string;
  /** Warehouses whose effective GSTIN is this one — the dependent dropdown. */
  warehouses: Array<{ id: number; name: string }>;
  includesHeadOffice: boolean;
}

export interface GstScope {
  /** (type,id) pairs to match; empty ⇒ match nothing. */
  pairs: Array<{ type: "warehouse" | "outlet"; id: number }>;
  includeHeadOffice: boolean;
}

interface GstinIndex {
  companyGstin: string;
  warehouses: Array<{ id: number; name: string; gstin: string }>;
  outlets: Array<{ id: number; name: string; warehouseId: number | null; gstin: string }>;
}

const clean = (s: unknown): string => String(s ?? "").trim().toUpperCase();

async function loadGstinIndex(): Promise<GstinIndex> {
  const [{ rows: [cs] }, { rows: whs }, { rows: outs }] = await Promise.all([
    pool.query(`SELECT gst_number FROM company_settings LIMIT 1`),
    pool.query(`SELECT id, name, gst_number FROM warehouses ORDER BY name, id`),
    pool.query(`SELECT id, name, gstin, warehouse_id FROM outlets ORDER BY name, id`),
  ]);
  const companyGstin = clean(cs?.gst_number);
  const warehouses = whs.map((w: any) => ({
    id: Number(w.id),
    name: String(w.name ?? ""),
    gstin: clean(w.gst_number) || companyGstin,
  }));
  const whGstin = new Map(warehouses.map(w => [w.id, w.gstin]));
  const outlets = outs.map((o: any) => {
    const parentId = o.warehouse_id == null ? null : Number(o.warehouse_id);
    return {
      id: Number(o.id),
      name: String(o.name ?? ""),
      warehouseId: parentId,
      gstin: clean(o.gstin) || (parentId != null ? (whGstin.get(parentId) ?? "") : "") || companyGstin,
    };
  });
  return { companyGstin, warehouses, outlets };
}

/** Distinct GSTINs with the warehouses registered under each — the filter UI. */
export async function listGstinGroups(): Promise<GstinGroup[]> {
  const idx = await loadGstinIndex();
  const groups = new Map<string, GstinGroup>();
  const ensure = (g: string) => {
    let e = groups.get(g);
    if (!e) { e = { gstin: g, warehouses: [], includesHeadOffice: false }; groups.set(g, e); }
    return e;
  };
  for (const w of idx.warehouses) {
    if (w.gstin) ensure(w.gstin).warehouses.push({ id: w.id, name: w.name });
  }
  if (idx.companyGstin) ensure(idx.companyGstin).includesHeadOffice = true;
  return [...groups.values()].sort((a, b) => a.gstin.localeCompare(b.gstin));
}

/**
 * Resolve the requested filter to a location scope. Returns null when no
 * filter is active (⇒ caller adds NO condition — unfiltered output unchanged).
 *
 * A warehouse filter includes the warehouse's own outlets, but only those
 * whose effective GSTIN matches the warehouse's — an outlet registered under
 * its own different GSTIN files under that GSTIN, not its parent's.
 */
export async function resolveGstScope(
  q: { gstin?: string; warehouseId?: number },
): Promise<GstScope | null> {
  const gstin = clean(q.gstin);
  const warehouseId = Number.isInteger(q.warehouseId) && (q.warehouseId as number) > 0 ? q.warehouseId : undefined;
  if (!gstin && !warehouseId) return null;

  const idx = await loadGstinIndex();

  if (warehouseId) {
    const wh = idx.warehouses.find(w => w.id === warehouseId);
    // Unknown warehouse, or one that is not under the requested GSTIN ⇒ nothing.
    if (!wh || (gstin && wh.gstin !== gstin)) return { pairs: [], includeHeadOffice: false };
    const pairs: GstScope["pairs"] = [{ type: "warehouse", id: wh.id }];
    for (const o of idx.outlets) {
      if (o.warehouseId === wh.id && o.gstin === wh.gstin) pairs.push({ type: "outlet", id: o.id });
    }
    return { pairs, includeHeadOffice: false };
  }

  const pairs: GstScope["pairs"] = [];
  for (const w of idx.warehouses) if (w.gstin === gstin) pairs.push({ type: "warehouse", id: w.id });
  for (const o of idx.outlets) if (o.gstin === gstin) pairs.push({ type: "outlet", id: o.id });
  return { pairs, includeHeadOffice: idx.companyGstin === gstin };
}

/** ` AND (...)` condition over sales rows (alias must be the sales table's). */
export function salesScopeCond(alias: string, scope: GstScope, params: any[]): string {
  const parts: string[] = [];
  for (const p of scope.pairs) {
    params.push(p.type, p.id);
    parts.push(`(COALESCE(${alias}.location_type, 'outlet') = $${params.length - 1} AND COALESCE(${alias}.location_id, ${alias}.outlet_id, 0) = $${params.length})`);
  }
  if (scope.includeHeadOffice) parts.push(`(COALESCE(${alias}.location_type, 'outlet') = 'headoffice')`);
  return parts.length ? ` AND (${parts.join(" OR ")})` : ` AND FALSE`;
}

/** ` AND (...)` condition over purchase rows. */
export function purchaseScopeCond(alias: string, scope: GstScope, params: any[]): string {
  const parts: string[] = [];
  for (const p of scope.pairs) {
    params.push(p.type, p.id);
    parts.push(`(COALESCE(${alias}.location_type, ${alias}.branch_type, 'headoffice') = $${params.length - 1} AND COALESCE(${alias}.location_id, ${alias}.branch_id, 0) = $${params.length})`);
  }
  if (scope.includeHeadOffice) parts.push(`(COALESCE(${alias}.location_type, ${alias}.branch_type, 'headoffice') = 'headoffice')`);
  return parts.length ? ` AND (${parts.join(" OR ")})` : ` AND FALSE`;
}

/** Location display names for GST register rows. */
export async function locationNameIndex(): Promise<{
  name(type: string | null | undefined, id: number | null | undefined): string;
}> {
  const idx = await loadGstinIndex();
  const wh = new Map(idx.warehouses.map(w => [w.id, w.name]));
  const ou = new Map(idx.outlets.map(o => [o.id, o.name]));
  return {
    name(type, id) {
      const t = String(type ?? "").trim();
      if (t === "headoffice") return "Head Office";
      if (t === "warehouse") return wh.get(Number(id)) ?? `Warehouse #${id}`;
      if (t === "outlet") return ou.get(Number(id)) ?? `Outlet #${id}`;
      return "—";
    },
  };
}

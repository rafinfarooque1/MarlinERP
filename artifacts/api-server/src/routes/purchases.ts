import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { db, pool, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";
import { creditBatch, debitBatchByNumber, updateAvgCostOnInbound, updateAvgCostOnReversal, type BatchKind } from "../lib/batches";
import { productBatchIdentity, blockedByInactiveProducts, INACTIVE_PRODUCT_CODE, isProductKind } from "../lib/productIdentity";
import { writeStockLedger } from "../lib/stockLedger";
import { deductMaterialAt, creditMaterialAt, isMaterialKind } from "../lib/materialStock";
import { resolveActingLocation, locationLabel, type ProdLocation } from "../lib/productionCosting";
import { getUserDataScope, scopeLocationTypeWhere } from "../lib/dataScope";
import { parseDateRange, pushDateRange, pushLocationFilter } from "../lib/queryFilters";
import { getLocationFilter } from "../lib/requestLocation";
import { isIsoDate, dateOrNull } from "../lib/dateInput";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { advanceAvailable, takeAdvanceLock, attributeAdvanceConsumption, releaseAdvanceConsumption } from "../lib/advanceLedgers";
import { PURCHASE_BATCH_SEQUENCE } from "../migrations/purchaseBills";
import { validateOtherCharges, parseStoredOtherCharges, otherChargesTotal, type OtherCharge } from "../lib/otherCharges";
import {
  calcPurchaseBill, asPriceMode, asTaxType,
  type PriceMode, type TaxType,
} from "@workspace/purchase-pricing";
import { respondIfMonthLocked, isMonthLocked, ymOfDate, monthLockedBody } from "../lib/periodLock";

const router = Router();

/** Anything with a .query(text, params) — the pool or a transaction client. */
type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

/** Purchased goods land at the location that bought them: Head Office or any
 *  warehouse. The bill records that location, and every stock effect — location
 *  quantity, lot, ledger — uses it, so a warehouse's purchase never inflates
 *  Head Office stock. The mirror counter on the master row is company-wide and
 *  is maintained by the caller's own UPDATE (which also rolls avg_cost).
 *
 *  Stock-ledger branch id. Head Office has always ledgered materials at 0 and
 *  finished items at 1; every other location uses its own id for both. */
export const ledgerBranchId = (loc: ProdLocation, materialType: string) =>
  loc.type === "headoffice" ? (materialType === "item" ? 1 : 0) : loc.id;

/** Parent product identity (barcode + MRP) stamped onto the batch a line creates. */
const lineIdentity = (li: any) =>
  productBatchIdentity(pool, (li.materialType ?? "item") as any, Number(li.materialId));

const KIND_LABEL: Record<string, string> = {
  material: "Raw Material", raw_material: "Packing Material", item: "Item",
};

/** A batch number the server issued. Reserved: a hand-typed number in this
 *  shape could collide with a future allocation and silently merge two lots. */
const RESERVED_BATCH_RE = /^PUR-\d{8}-\d{5}$/;
/** HSN/SAC codes are 4, 6 or 8 digits. Held as TEXT end to end so a code such
 *  as 08119090 keeps its leading zero instead of becoming 8119090. */
const HSN_RE = /^\d{4,8}$/;

/**
 * Everything about a line that must be true before any stock moves.
 *
 * Batch NUMBER is no longer demanded from the user — a blank one is issued by
 * the server (see allocateBatchNumbers). Manufacturing and expiry dates still
 * are: frozen stock that cannot be traced to the bill it arrived on cannot be
 * expiry-warned or recalled. Both are calendar-checked because they land in
 * real DATE columns, where '2026-02-30' is an error and not a stored string.
 *
 * The message names the exact field and line so it can be fixed without guessing.
 */
/**
 * Whether the stock this edit needs to take back out is still on the shelf.
 *
 * Edits no longer round-trip the whole bill through a reversal: untouched
 * lines are left alone, so only the lines being rewritten ("rewrite" — full
 * old quantity comes out) or reduced ("reduce" — just the difference comes
 * out) are checked. Every reversal here floors at zero, so a debit larger
 * than what remains would silently discard the shortfall and the books would
 * hold stock that was already sold or consumed — hence each check demands the
 * exact quantity its write will subtract, per line, and names ONLY the line
 * that cannot comply.
 *
 * Rows are locked as they are checked, so nothing can consume the lot between
 * this check and the writes that follow it in the same transaction.
 */
interface StockCheck { line: any; need: number; mode: "rewrite" | "reduce" }

async function stockShortfall(
  c: Queryable, checks: StockCheck[], loc: { type: string; id: number },
  purchaseId: number, maps: NameMaps,
): Promise<string | null> {
  // Aggregate FIRST: two checks can hit the same lot (legacy bills with
  // duplicate lot keys, in the ambiguous fallback) or the same product's
  // location balance (two lines of one product). Judged one by one, each
  // would pass against the same unreserved stock and the floored debits that
  // follow would together invent stock — so the comparison is against the
  // SUM this edit will withdraw, not each line's own share.
  interface Agg { need: number; mode: "rewrite" | "reduce" }
  const lotAgg = new Map<string, Agg>();  // kind \0 id \0 batch → total leaving that lot
  const locAgg = new Map<string, Agg>();  // kind \0 id → total leaving this location
  for (const chk of checks) {
    const need = Number(chk.need);
    if (!(need > 0)) continue;
    const kind = String(chk.line?.materialType ?? "item");
    const mid = Number(chk.line?.materialId);
    const batch = String(chk.line?.batchNumber || `PUR-${purchaseId}`);
    for (const [map, key] of [[lotAgg, `${kind}\u0000${mid}\u0000${batch}`], [locAgg, `${kind}\u0000${mid}`]] as const) {
      const prev = map.get(key);
      if (prev) { prev.need += need; if (chk.mode === "reduce") prev.mode = "reduce"; }
      else map.set(key, { need, mode: chk.mode });
    }
  }

  // Deterministic order, so two concurrent edits touching the same products
  // queue up instead of deadlocking against each other.
  for (const pk of [...locAgg.keys()].sort()) {
    const [kind, midStr] = pk.split("\u0000");
    const mid = Number(midStr);
    const name = maps[kind as keyof NameMaps]?.get(mid)?.name
      ?? `${KIND_LABEL[kind] ?? "Item"} #${mid}`;

    for (const lk of [...lotAgg.keys()].filter(k => k.startsWith(`${pk}\u0000`)).sort()) {
      const { need, mode } = lotAgg.get(lk)!;
      const batchNumber = lk.slice(pk.length + 1);
      const { rows: [lot] } = await c.query(
        `SELECT quantity::numeric AS q FROM stock_batches
          WHERE item_id = $1 AND material_type = $2 AND branch_type = $3
            AND branch_id = $4 AND batch_number = $5
          FOR UPDATE`,
        [mid, kind, loc.type, loc.id, batchNumber],
      );
      // No lot at all means the stock was written before lots were tracked, so
      // there is nothing to compare against — fall through to the location check.
      if (lot && Number(lot.q) + 1e-6 < need) {
        return mode === "reduce"
          ? `${name}: requested reduction is ${fmtQty(need)}, but only ${fmtQty(Number(lot.q))} is available to reduce on batch ${batchNumber} — the remaining quantity has already been sold, transferred or consumed.`
          : `${name}: ${fmtQty(Number(lot.q))} of the ${fmtQty(need)} received on batch ${batchNumber} is left — the rest has already been used, sold or transferred. Reverse those movements first, or record a purchase return instead of editing this line.`;
      }
    }

    // Summed in JS rather than by SUM(): Postgres refuses FOR UPDATE on an
    // aggregate, and the lock is the point — it holds the balance still until
    // the writes below have run.
    const { need, mode } = locAgg.get(pk)!;
    const { rows: locRows } = await c.query(
      `SELECT quantity::numeric AS q FROM stock_entries
        WHERE item_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4
        FOR UPDATE`,
      [mid, kind, loc.type, loc.id],
    );
    const onLoc = locRows.reduce((sum: number, r: any) => sum + Number(r.q ?? 0), 0);
    if (onLoc + 1e-6 < need) {
      return mode === "reduce"
        ? `${name}: requested reduction is ${fmtQty(need)}, but this location is holding only ${fmtQty(onLoc)} — the remaining quantity has already been sold, transferred or consumed.`
        : `${name}: this location is holding ${fmtQty(onLoc)}, less than the ${fmtQty(need)} on the bill — the stock has already moved on. Reverse those movements first, or record a purchase return instead of editing this line.`;
    }
  }
  return null;
}

/** Trim trailing zeros so quantities read like quantities, not like decimals. */
function fmtQty(n: number): string {
  return String(Number(n.toFixed(3)));
}

function lineIdentityError(lines: any[], maps: NameMaps, allowedReserved: Set<string> = new Set()): string | null {
  const seenBatch = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i];
    const kind = String(li?.materialType ?? "material");
    const name = maps[kind as keyof NameMaps]?.get(Number(li?.materialId))?.name
      ?? `${KIND_LABEL[kind] ?? "Item"} #${li?.materialId}`;
    const at = `Line ${i + 1} (${name})`;

    const mfgDate = String(li?.mfgDate ?? "").trim();
    const expiryDate = String(li?.expiryDate ?? "").trim();
    if (!mfgDate) return `${at}: manufacturing date is required`;
    if (!expiryDate) return `${at}: expiry date is required`;
    // Calendar-checked: these land in stock_batches DATE columns.
    if (!isIsoDate(mfgDate)) return `${at}: manufacturing date must be a real calendar date (YYYY-MM-DD)`;
    if (!isIsoDate(expiryDate)) return `${at}: expiry date must be a real calendar date (YYYY-MM-DD)`;
    if (expiryDate < mfgDate) return `${at}: expiry date cannot be before the manufacturing date`;

    const hsn = String(li?.hsnCode ?? "").trim();
    if (hsn && !HSN_RE.test(hsn)) return `${at}: HSN "${hsn}" must be 4 to 8 digits`;

    const qty = Number(li?.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return `${at}: quantity must be greater than zero`;
    const rate = Number(li?.unitCost);
    if (!Number.isFinite(rate) || rate < 0) return `${at}: rate must be zero or more`;
    const disc = Number(li?.discount ?? 0);
    if (!Number.isFinite(disc) || disc < 0 || disc > 100) return `${at}: discount must be between 0 and 100 percent`;

    const batchNumber = String(li?.batchNumber ?? "").trim();
    if (batchNumber) {
      if (batchNumber.length > 60) return `${at}: batch number is too long (60 characters max)`;
      // A system-issued number is refused as *input* — it would collide with a
      // future allocation. Editing a bill is the exception: its lines come back
      // carrying the numbers this route issued them, and those are not typed in.
      if (RESERVED_BATCH_RE.test(batchNumber) && !allowedReserved.has(batchNumber)) {
        return `${at}: PUR-YYYYMMDD-NNNNN numbers are issued by the system and cannot be typed in — leave the batch field blank`;
      }
      const key = `${kind}:${Number(li?.materialId)}:${batchNumber.toLowerCase()}`;
      const prev = seenBatch.get(key);
      if (prev !== undefined) return `${at}: batch number "${batchNumber}" is already used on line ${prev + 1} of this bill`;
      seenBatch.set(key, i);
    }
  }
  return null;
}

/**
 * A hand-typed batch number must not land on a lot that already exists at this
 * location for this product — creditBatch upserts on that natural key, so a
 * collision would quietly pour new stock into someone else's lot and take its
 * expiry date with it.
 *
 * `excludeSourceId` is the bill being edited: its own existing lots are not
 * collisions with itself.
 */
/**
 * Serialise everyone writing hand-typed lot numbers for the same products at
 * the same location.
 *
 * The duplicate check reads stock_batches and the write upserts on that same
 * natural key, so two bills submitted at once can both find the number free and
 * then silently merge into one lot. A transaction-scoped advisory lock per
 * product+location makes the check-then-insert atomic; taken in sorted order so
 * two bills sharing products queue rather than deadlock. Auto-issued numbers
 * come from a sequence and need none of this.
 */
async function lockLotNamespace(c: Queryable, lines: any[], loc: ProdLocation): Promise<void> {
  const keys = [...new Set(
    lines
      .filter(li => String(li?.batchNumber ?? "").trim())
      .map(li => `purchase-lot:${li?.materialType ?? "material"}:${Number(li?.materialId)}:${loc.type}:${loc.id}`),
  )].sort();
  for (const key of keys) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
  }
}

async function manualBatchConflict(
  q: Queryable, lines: any[], loc: ProdLocation, excludeSourceId: number | null,
): Promise<string | null> {
  const manual = lines
    .map((li, i) => ({
      i, kind: String(li?.materialType ?? "material"),
      id: Number(li?.materialId), bn: String(li?.batchNumber ?? "").trim(),
    }))
    .filter(x => x.bn);
  if (manual.length === 0) return null;

  const { rows } = await q.query(
    `SELECT item_id, material_type, batch_number, source, source_id
       FROM stock_batches
      WHERE branch_type = $1 AND branch_id = $2 AND batch_number = ANY($3::text[])`,
    [loc.type, loc.id, manual.map(m => m.bn)],
  );
  for (const m of manual) {
    const hit = rows.find((r: any) =>
      String(r.batch_number) === m.bn
      && Number(r.item_id) === m.id
      && String(r.material_type) === m.kind);
    if (!hit) continue;
    if (excludeSourceId !== null && String(hit.source) === "purchase" && Number(hit.source_id) === excludeSourceId) continue;
    return `Line ${m.i + 1}: batch "${m.bn}" already exists at this location for this product`
      + `${hit.source ? ` (from ${hit.source} #${hit.source_id})` : ""}.`
      + ` Use a different number, or leave the field blank to have one issued automatically.`;
  }
  return null;
}

/**
 * Issue `count` unique batch numbers, PUR-YYYYMMDD-NNNNN, dated to the bill.
 *
 * The counter is a real Postgres SEQUENCE. `nextval` is non-transactional, so
 * two bills saved in the same instant draw different numbers and a rolled-back
 * bill burns its number rather than handing it on — neither of which is true
 * of `SELECT max(...)+1` or a COUNT-based scheme. Numbers are drawn per line,
 * so a five-line bill gets five distinct lots (the old `PUR-<id>` fallback gave
 * every line on a bill the SAME number and merged them into one lot).
 */
export async function allocateBatchNumbers(q: Queryable, purchaseDate: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const { rows } = await q.query(
    `SELECT 'PUR-' || to_char($1::date, 'YYYYMMDD') || '-'
            || lpad(nextval('${PURCHASE_BATCH_SEQUENCE}')::text, 5, '0') AS batch_number
       FROM generate_series(1, $2)`,
    [purchaseDate, count],
  );
  return rows.map((r: any) => String(r.batch_number));
}

const gstinStateCode = (gstin: unknown): string | null => {
  const s = String(gstin ?? "").trim();
  return /^\d{2}[A-Za-z0-9]{13}$/.test(s) ? s.slice(0, 2) : null;
};
const normState = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Whether this is an intra-state (CGST+SGST) or inter-state (IGST) supply.
 *
 * Derived from data the server already holds — the vendor's registration and
 * the receiving location's — rather than taken on trust from the browser, so a
 * tampered or simply mistaken request cannot decide which tax heads the input
 * credit lands in. GSTIN state codes are the statutory fact and win; recorded
 * state names are the fallback. `null` means the server genuinely cannot tell
 * (one side has neither), in which case the caller's value stands.
 */
export async function resolveSupplyTaxType(
  vendorId: number, loc: ProdLocation,
  // Callers inside a transaction (e.g. import approval) pass their client so
  // the resolution sees the same transactional view as the writes.
  q: { query: (sql: string, params?: unknown[]) => Promise<any> } = pool,
): Promise<{ taxType: TaxType | null; why: string }> {
  const { rows: [v] } = await q.query(`SELECT state, gst_number FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) return { taxType: null, why: "vendor not found" };

  let locState: string | null = null;
  let locGstin: string | null = null;
  if (loc.type === "warehouse") {
    const { rows: [w] } = await q.query(`SELECT state, gst_number FROM warehouses WHERE id = $1`, [loc.id]);
    locState = w?.state ?? null; locGstin = w?.gst_number ?? null;
  } else if (loc.type === "outlet") {
    const { rows: [o] } = await q.query(`SELECT state, gstin FROM outlets WHERE id = $1`, [loc.id]);
    locState = o?.state ?? null; locGstin = o?.gstin ?? null;
  }
  if (!normState(locState) && !gstinStateCode(locGstin)) {
    const { rows: [c] } = await q.query(`SELECT state, gst_number FROM company_settings LIMIT 1`);
    locState = locState || (c?.state ?? null);
    locGstin = locGstin || (c?.gst_number ?? null);
  }

  const vCode = gstinStateCode(v.gst_number), lCode = gstinStateCode(locGstin);
  if (vCode && lCode) {
    return { taxType: vCode === lCode ? "intra" : "inter", why: `vendor GSTIN state ${vCode} vs receiving GSTIN state ${lCode}` };
  }
  const vName = normState(v.state), lName = normState(locState);
  if (vName && lName) {
    return { taxType: vName === lName ? "intra" : "inter", why: `vendor state "${v.state}" vs receiving state "${locState}"` };
  }
  return { taxType: null, why: "vendor or receiving-location state is not recorded" };
}

/**
 * Price the whole bill.
 *
 * HSN and GST% default from the Item Master and are then SNAPSHOT onto the
 * line: the bill keeps what was actually charged, so a later change to the
 * master cannot restate a filed return. Nothing here writes back to the master.
 *
 * The arithmetic itself lives in @workspace/purchase-pricing, which the ERP web
 * app imports too — the preview in the browser and the figures written here are
 * produced by the same code, so they cannot drift apart.
 */
export function priceBill(
  rawLineItems: any[], billMode: PriceMode, maps: NameMaps, derivedTaxType: TaxType | null,
) {
  const prepared = rawLineItems.map((li: any) => {
    const kind = String(li?.materialType ?? "material") as keyof NameMaps;
    const master = maps[kind]?.get(Number(li?.materialId));

    const hsnTyped = li?.hsnCode == null ? "" : String(li.hsnCode).trim();
    const hsnCode = hsnTyped || (master?.hsnCode ?? "");

    const gstSupplied = li?.gstRate !== undefined && li?.gstRate !== null && String(li.gstRate).trim() !== "";
    const gstRate = gstSupplied ? Number(li.gstRate) : Number(master?.taxRate ?? 0);

    // The derived supply type wins, so the browser cannot pick the tax heads.
    // An explicit override is still honoured — master data is sometimes wrong,
    // and the ERP has always let the person recording the bill say so — but it
    // is recorded as an override rather than passed off as derived.
    const override = li?.taxTypeOverride === true || String(li?.taxTypeOverride) === "true";
    const requested = li?.taxType == null ? null : asTaxType(li.taxType);
    const taxType: TaxType = override ? (requested ?? "intra") : (derivedTaxType ?? requested ?? "intra");

    return {
      materialType: String(li?.materialType ?? "material"),
      materialId: Number(li?.materialId),
      quantity: li?.quantity,
      unitCost: li?.unitCost,
      discount: li?.discount ?? 0,
      hsnCode, gstRate, taxType,
      taxTypeSource: override ? "override" : derivedTaxType ? "derived" : "entered",
      ...(requested && requested !== taxType ? { taxTypeRequested: requested } : {}),
      // Batch capture. A blank number is filled in by the allocator before the
      // bill is written, so a stored line always carries its lot.
      batchNumber: li?.batchNumber == null ? null : (String(li.batchNumber).trim() || null),
      mfgDate: li?.mfgDate ?? null,
      expiryDate: li?.expiryDate ?? null,
    };
  });

  const bill = calcPurchaseBill(prepared, billMode);
  return {
    enriched: bill.lines,
    subtotal: bill.subtotal,
    discountTotal: bill.discountTotal,
    taxableTotal: bill.taxableTotal,
    taxTotal: bill.taxTotal,
    roundOff: bill.roundOff,
    totalAmount: bill.totalAmount,
  };
}

// ── Item Master snapshot (names, HSN, GST% and unit for every product kind) ──
export type ProductMaster = { name: string; hsnCode: string; taxRate: number; unit: string };
export type NameMaps = {
  material: Map<number, ProductMaster>;
  raw_material: Map<number, ProductMaster>;
  item: Map<number, ProductMaster>;
};

export async function buildNameMaps(
  // Callers inside a transaction (e.g. import approval) pass their client so
  // the maps see the same transactional view as the writes.
  q: { query: (sql: string, params?: unknown[]) => Promise<any> } = pool,
): Promise<NameMaps> {
  // Raw SQL rather than drizzle: hsn_code and tax_rate are startup-migration
  // columns on materials/raw_materials and so are invisible to the schema.
  const load = async (table: "materials" | "raw_materials" | "items") => {
    const { rows } = await q.query(
      `SELECT id, name, COALESCE(hsn_code, '') AS hsn_code,
              COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit
         FROM ${table}`,
    );
    return new Map<number, ProductMaster>(rows.map((r: any) => [Number(r.id), {
      name: String(r.name ?? ""),
      hsnCode: String(r.hsn_code ?? ""),
      taxRate: Number(r.tax_rate ?? 0),
      unit: String(r.unit ?? ""),
    }]));
  };
  const [material, raw_material, item] = await Promise.all([
    load("materials"), load("raw_materials"), load("items"),
  ]);
  return { material, raw_material, item };
}

/** Name and unit are resolved at READ time, never stored on the line: a stored
 *  copy would still show the old name after the product is renamed. */
function enrichLines(lineItems: unknown, maps: NameMaps): any[] {
  return (Array.isArray(lineItems) ? lineItems : []).map((li: any) => {
    const master = maps[(li.materialType as keyof NameMaps)]?.get(Number(li.materialId));
    return {
      ...li,
      materialName: master?.name
        || li.materialName
        || `${li.materialType === 'raw_material' ? 'Packing Material' : li.materialType === 'item' ? 'Item Name (SKU)' : 'Material'} #${li.materialId}`,
      unit: master?.unit ?? '',
    };
  });
}

/** Names for every location that can purchase, for list labels. */
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

/** Current ledger names for the charge rows a bill stores — resolved live, so
 *  a renamed ledger shows its current name everywhere. */
async function chargeLedgerNames(charges: OtherCharge[][]): Promise<Map<number, string>> {
  const ids = [...new Set(charges.flat().map((c) => c.ledgerId))];
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(`SELECT id, name FROM account_ledgers WHERE id = ANY($1::int[])`, [ids]);
  return new Map(rows.map((r: any) => [Number(r.id), String(r.name)]));
}

const enrichCharges = (charges: OtherCharge[], names: Map<number, string>) =>
  charges.map((c) => ({ ...c, ledgerName: names.get(c.ledgerId) ?? `Ledger #${c.ledgerId}` }));

// Serves Purchases and Returns pages.
router.get("/purchases", requireModuleView(["page:/production/purchase", "page:/returns"]), async (req, res): Promise<void> => {
  // LBAC: a location sees its own bills; Head Office sees every location's.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Inward branch-transfer invoices are not vendor bills — they carry no vendor
  // and must not appear in the purchase register or its spend totals.
  const conds: string[] = ['p.branch_transfer_id IS NULL'];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(p.invoice_number ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
  }
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }
  pushDateRange(conds, params, 'p.purchase_date', dr.from, dr.to);
  pushLocationFilter(
    conds, params, getLocationFilter(req),
    // Legacy bills predate the location columns and belong to Head Office.
    "COALESCE(p.location_type, 'headoffice')", "COALESCE(p.location_id, 1)",
  );
  const scopeWhere = scopeLocationTypeWhere(scope, params, 'p');
  if (scopeWhere === 'FALSE') {
    res.json(paginated ? { total: 0, page: 1, limit: 25, rows: [] } : []);
    return;
  }
  if (scopeWhere !== 'TRUE') conds.push(scopeWhere);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const baseFrom = `FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id`;

  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const limit = paginated ? Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200) : 0;
  const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS total ${baseFrom} ${where}`, params);
  const total = Number(t?.total ?? 0);

  const { rows } = await pool.query(`
    SELECT p.*, p.purchase_date::text AS purchase_date_str,
           p.vendor_invoice_date::text AS vendor_invoice_date_str, v.name AS vendor_name
    ${baseFrom} ${where}
    ORDER BY p.id DESC${limit ? ` LIMIT ${limit} OFFSET ${(page - 1) * limit}` : ''}
  `, params);
  const nameMaps = await buildNameMaps();
  const locNames = await locationNameMap();
  const chargeRows = rows.map((r: any) => parseStoredOtherCharges(r.other_charges));
  const chargeNames = await chargeLedgerNames(chargeRows);
  const mapped = rows.map((r: any, i: number) => ({
    id: r.id,
    vendorId: r.vendor_id,
    purchaseDate: r.purchase_date_str,
    invoiceNumber: r.invoice_number,
    // Absent on historical bills — null, never a fake backfill.
    vendorInvoiceDate: r.vendor_invoice_date_str ?? null,
    notes: r.notes,
    createdAt: r.created_at,
    vendorName: r.vendor_name ?? "",
    totalAmount: Number(r.total_amount),
    taxTotal: Number(r.tax_total ?? 0),
    discountTotal: Number(r.discount_total ?? 0),
    roundOff: Number(r.round_off ?? 0),
    priceMode: asPriceMode(r.price_mode),
    locationType: r.location_type ?? 'headoffice',
    locationId: Number(r.location_id ?? 1),
    locationName: locNames.get(`${r.location_type ?? 'headoffice'}:${Number(r.location_id ?? 1)}`) ?? 'Head Office',
    otherCharges: enrichCharges(chargeRows[i], chargeNames),
    otherChargesTotal: otherChargesTotal(chargeRows[i]),
    lineItems: enrichLines(r.line_items, nameMaps),
  }));

  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

router.post("/purchases", requireModuleAction("page:/production/purchase", "add"), async (req, res): Promise<void> => {
  // Vendor Invoice Date — the date printed on the VENDOR's invoice, distinct
  // from purchase_date (our booking date, which month locks and stock dating
  // follow). Mandatory on every new manual bill; also a real DATE column
  // (raw-migration — read/written via raw SQL throughout). Checked on the raw
  // body BEFORE the zod parse: the spec now marks the field required, so a
  // schema failure would otherwise bury this plain-language message inside a
  // generic zod error.
  const vendorInvoiceDateRaw = (req.body as any)?.vendorInvoiceDate;
  if (vendorInvoiceDateRaw === undefined || vendorInvoiceDateRaw === null || String(vendorInvoiceDateRaw).trim() === "") {
    res.status(400).json({ error: "Vendor Invoice Date is required — enter the date printed on the vendor's invoice" }); return;
  }
  const vendorInvoiceDate = String(vendorInvoiceDateRaw).trim();
  if (!isIsoDate(vendorInvoiceDate)) {
    res.status(400).json({ error: "Vendor Invoice Date must be a real calendar date (YYYY-MM-DD)" }); return;
  }

  const parsed = CreatePurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // purchase_date is a real DATE column: reject an impossible date here rather
  // than letting the driver raise 22007 halfway through the transaction.
  if (!isIsoDate(parsed.data.purchaseDate)) {
    res.status(400).json({ error: "Purchase date must be a real calendar date (YYYY-MM-DD)" }); return;
  }

  // Month lock: a new bill dated in a locked month cannot be backdated in.
  if (await respondIfMonthLocked(res, pool, [parsed.data.purchaseDate], "purchase create")) return;

  const rawLineItems = (parsed.data.lineItems || []) as any[];
  if (rawLineItems.length === 0) { res.status(400).json({ error: "Add at least one line item" }); return; }

  const maps = await buildNameMaps();

  // A discontinued product cannot be bought again. Checked on create only:
  // existing purchases stay editable so a historical bill can still be corrected.
  const inactiveMsg = await blockedByInactiveProducts(
    pool,
    rawLineItems
      .filter(li => isProductKind(li?.materialType ?? "material"))
      .map(li => ({ kind: (li?.materialType ?? "material") as any, id: Number(li?.materialId) })),
  );
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }

  // A NEW bill cannot name a product that does not exist: without this check
  // the stock-write trigger refuses mid-transaction and the user sees an
  // opaque server error. Create-only — historical bills whose product was
  // later deleted must stay readable and date-editable.
  for (let i = 0; i < rawLineItems.length; i++) {
    const li = rawLineItems[i];
    const kind = String(li?.materialType ?? "material");
    if (!maps[kind as keyof NameMaps]?.has(Number(li?.materialId))) {
      res.status(400).json({
        error: `Line ${i + 1}: ${KIND_LABEL[kind] ?? "Item"} #${li?.materialId} does not exist — it may have been deleted. Refresh the product list and pick it again.`,
      });
      return;
    }
  }

  // Dates, HSN shape, quantities and any hand-typed batch number.
  const identityMsg = lineIdentityError(rawLineItems, maps);
  if (identityMsg) { res.status(400).json({ error: identityMsg }); return; }

  // ── Which location is buying ─────────────────────────────────────────────
  // Head Office may record a bill for any location; a warehouse only for
  // itself. Stock, lots and the ledger all follow this location, and the vendor
  // payable and input GST post against this location's own purchase ledger.
  const resolved = await resolveActingLocation(pool, {
    employee: (req as any).employee,
    requested: { type: (req.body as any).locationType, id: (req.body as any).locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const loc = resolved.loc;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: loc.type, id: loc.id }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }
  const locName = await locationLabel(pool, loc);

  // Checked against the RESOLVED location, not the requested one.
  const batchClash = await manualBatchConflict(pool, rawLineItems, loc, null);
  if (batchClash) { res.status(400).json({ error: batchClash }); return; }

  // Rate mode is stored, never inferred: 105 at 5% is a valid inclusive line
  // (100 + 5) and an equally valid exclusive one (105 + 5.25).
  const priceMode = asPriceMode((req.body as any).priceMode);
  const supply = await resolveSupplyTaxType(parsed.data.vendorId, loc);

  const { enriched, subtotal, discountTotal, taxableTotal, taxTotal, roundOff, totalAmount } =
    priceBill(rawLineItems, priceMode, maps, supply.taxType);

  // GST slabs are validated on the EFFECTIVE rate — the one that will be
  // charged and posted — not on what the request happened to send. A line that
  // omits gstRate inherits the Item Master's, which must be a legal slab too.
  for (const li of enriched) {
    if (!isValidGstSlab(li.gstRate)) { res.status(400).json({ error: gstSlabErrorMessage(li.gstRate) }); return; }
  }

  // Other Purchase Charges (freight, hamali, courier…) — validated on the
  // effective ledgers server-side; the dropdown filter is not a guard. They
  // post to P&L and add to what the vendor is owed, never to stock cost.
  const ocParsed = await validateOtherCharges(pool, (parsed.data as any).otherCharges);
  if ("error" in ocParsed) { res.status(400).json({ error: ocParsed.error }); return; }
  const otherCharges = ocParsed.charges;
  const otherChargesTot = ocParsed.total;
  // What the vendor is actually owed for this bill: goods + charges.
  const grandPayable = Math.round((totalAmount + otherChargesTot) * 100) / 100;

  const warnings: string[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const li = enriched[i] as any;
    if (li.taxTypeRequested && li.taxTypeSource === "derived") {
      warnings.push(
        `Line ${i + 1}: GST type recorded as ${li.taxType === "inter" ? "inter-state (IGST)" : "intra-state (CGST+SGST)"} `
        + `from ${supply.why}, not the ${li.taxTypeRequested === "inter" ? "inter-state" : "intra-state"} value sent.`,
      );
    }
  }

  // Opt-in adjustment of the vendor's advance balance against this bill. Read
  // from the raw body — CreatePurchaseBody predates the flag and zod strips
  // unknown keys. Only possible once the vendor HAS an advance ledger (it is
  // provisioned by the first over-payment); no ledger = silent no-op.
  const useAdvanceRequested = (req.body as any).useAdvance === true && !!parsed.data.vendorId;
  const advanceCapIn = Number((req.body as any).advanceAmount);
  let vendAdvLedgerExists = false;
  if (useAdvanceRequested) {
    const { rows: [al] } = await pool.query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`VADV-${parsed.data.vendorId}`],
    );
    vendAdvLedgerExists = !!al;
  }

  // Everything below moves stock, lots, weighted-average costs and the stock
  // ledger. A bill that half-applied would leave the books unreconcilable, so
  // the whole thing runs in ONE transaction on ONE client — including the
  // ledger write, which must not be fire-and-forget.
  const client = await pool.connect();
  let newId = 0;
  let appliedAdvance = 0;
  try {
    await client.query("BEGIN");

    // Re-check hand-typed lot numbers under a lock. The pre-flight check above
    // gives the good error message early; this one is the guarantee, because
    // between that read and this write another bill could have taken the number.
    await lockLotNamespace(client, enriched, loc);
    const racedClash = await manualBatchConflict(client, enriched, loc, null);
    if (racedClash) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: racedClash }); return;
    }

    // Every line that did not arrive with a vendor lot number gets its own
    // server-issued one, before the bill row is written, so line_items always
    // carries the lot it created.
    const needsBatch = (enriched as any[]).filter(l => !l.batchNumber);
    if (needsBatch.length > 0) {
      const issued = await allocateBatchNumbers(client, parsed.data.purchaseDate, needsBatch.length);
      needsBatch.forEach((l, i) => { l.batchNumber = issued[i]; });
    }

    // location_*, tax_total, discount_total, round_off and price_mode are
    // raw-migration columns and invisible to drizzle, so the row is inserted
    // with explicit SQL.
    const { rows: [ins] } = await client.query(
      `INSERT INTO purchases (vendor_id, purchase_date, invoice_number, line_items, total_amount,
                              notes, tax_total, discount_total, round_off, location_type, location_id,
                              price_mode, other_charges, vendor_invoice_date)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::date)
       RETURNING id`,
      [parsed.data.vendorId, parsed.data.purchaseDate, parsed.data.invoiceNumber ?? null,
       JSON.stringify(enriched), String(totalAmount), parsed.data.notes ?? null,
       taxTotal, discountTotal, roundOff, loc.type, loc.id, priceMode,
       JSON.stringify(otherCharges), vendorInvoiceDate],
    );
    newId = Number(ins.id);

    // ── Vendor advance adjustment ───────────────────────────────────────────
    // Serialize on the advance lock, then read availability from the books
    // (ledger-authoritative). The application row drives the Dr VEND / Cr VADV
    // contra in the derived postings, dated with this bill.
    if (useAdvanceRequested && vendAdvLedgerExists) {
      await takeAdvanceLock(client, "vendor", parsed.data.vendorId);
      const advPos = await advanceAvailable("vendor", parsed.data.vendorId);
      // The advance may settle the whole of what the vendor is owed —
      // goods AND other charges, since both credit the vendor.
      appliedAdvance = Math.min(advPos.available, grandPayable);
      if (Number.isFinite(advanceCapIn) && advanceCapIn >= 0) {
        appliedAdvance = Math.min(appliedAdvance, advanceCapIn);
      }
      appliedAdvance = Math.round(appliedAdvance * 100) / 100;
      if (appliedAdvance > 0.004) {
        await client.query(
          `INSERT INTO purchase_advance_applications (purchase_id, vendor_id, amount, created_by)
           VALUES ($1, $2, $3, $4)`,
          [newId, parsed.data.vendorId, appliedAdvance, (req as any).employee?.username ?? null],
        );
        // Pin the consumption to the voucher(s) that parked the money — the
        // reference the payment delete guard checks. Same txn, under the lock.
        await attributeAdvanceConsumption(client, "vendor", parsed.data.vendorId,
          { purchaseId: newId }, appliedAdvance);
      } else {
        appliedAdvance = 0;
      }
    }

  // Update stock for each line item.
  //
  // Stock is valued at li.costPerUnit — net of discount and net of GST — NOT at
  // the rate keyed in. GST on a purchase is recoverable input tax that the books
  // debit to the input-GST ledgers, and the purchase ledger is debited with the
  // taxable value; valuing stock at a gross or pre-discount rate would put tax
  // and discount into inventory and leave the stock valuation permanently out
  // of step with the purchase ledger.
  for (const li of enriched) {
    if (li.materialType === "material") {
      // Atomically update current_stock AND roll weighted-average cost (avg_cost is a raw-migration column)
      await client.query(
        `UPDATE materials SET
           avg_cost = ROUND(
             (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
             / NULLIF(current_stock::numeric + $2::numeric, 0),
           4),
           current_stock = current_stock::numeric + $2::numeric
         WHERE id = $1`,
        [li.materialId, li.quantity, li.costPerUnit]
      );
      await creditMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.costPerUnit));
      await creditBatch(client, {
        itemId: li.materialId, materialType: "material",
        branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber!,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.costPerUnit,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    } else if (li.materialType === "raw_material") {
      await client.query(
        `UPDATE raw_materials SET
           avg_cost = ROUND(
             (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
             / NULLIF(current_stock::numeric + $2::numeric, 0),
           4),
           current_stock = current_stock::numeric + $2::numeric
         WHERE id = $1`,
        [li.materialId, li.quantity, li.costPerUnit]
      );
      await creditMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.costPerUnit));
      await creditBatch(client, {
        itemId: li.materialId, materialType: "raw_material",
        branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber!,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.costPerUnit,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    } else if (li.materialType === "item") {
      await client.query(
        `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      // Purchased finished goods arrive at the production unit: keep the
      // location-level stock ledger consistent (previously only the item
      // counter was bumped), roll the weighted-average cost, and track the
      // inbound batch.
      await client.query(
        `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
         VALUES ($1, 'item', $4, $5, $2, $3)
         ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
           quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
           cost_price = EXCLUDED.cost_price,
           updated_at = now()`,
        [li.materialId, li.quantity, li.costPerUnit, loc.type, loc.id]
      );
      await updateAvgCostOnInbound(client, li.materialId, li.quantity, li.costPerUnit);
      await creditBatch(client, {
        itemId: li.materialId, branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber!,
        mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
        quantity: li.quantity, unitCost: li.costPerUnit,
        source: "purchase", sourceId: newId,
        ...(await lineIdentity(li)),
      });
    }
  }

    // ── Stock ledger (purchase inbound) ───────────────────────────────────────
    // Awaited inside the transaction: an audit trail that can silently fail is
    // not an audit trail.
    await writeStockLedger(client, (enriched as any[]).map(li => {
      const master = maps[li.materialType as keyof NameMaps]?.get(Number(li.materialId));
      return {
        txnType: 'purchase', materialType: li.materialType ?? 'item',
        refId: li.materialId, itemName: master?.name ?? '', unit: master?.unit ?? '',
        branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
        qtyChange: Number(li.quantity), unitCost: Number(li.costPerUnit ?? 0),
        docType: 'purchase', docId: newId,
        txnDate: parsed.data.purchaseDate,
      };
    }));

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // The same vendor invoice recorded twice is what a double-clicked Save, a
    // retried request or a re-opened tab looks like. The unique index is what
    // makes the guard race-proof; this turns it into an answerable message.
    if ((e as any)?.code === "23505" && String((e as any)?.constraint ?? "").includes("purchases_vendor_invoice")) {
      res.status(409).json({
        error: `Invoice "${parsed.data.invoiceNumber}" is already recorded for this vendor. `
          + `Open the existing bill instead of entering it again.`,
        code: "DUPLICATE_PURCHASE_INVOICE",
      });
      return;
    }
    throw e;
  } finally {
    client.release();
  }

  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, newId)).limit(1);
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);

  logActivity({
    action: "CREATE", module: "purchases", entityType: "purchase", entityId: row.id,
    description: `New purchase from ${vendor?.name ?? "Vendor"} at ${locName} — ₹${totalAmount.toFixed(2)}${row.invoiceNumber ? ` (Ref: ${row.invoiceNumber})` : ""}`,
    metadata: { after: {
      vendorId: row.vendorId, vendorName: vendor?.name, totalAmount, lineCount: enriched.length,
      invoiceNumber: row.invoiceNumber, locationType: loc.type, locationId: loc.id,
      priceMode, taxableTotal, taxTotal, discountTotal,
      otherChargesTotal: otherChargesTot,
      batchNumbers: (enriched as any[]).map(l => l.batchNumber),
    } },
  }).catch(() => {});

  res.status(201).json({
    ...row, vendorName: vendor?.name ?? "", totalAmount,
    // vendor_invoice_date is a raw-migration column drizzle cannot see — the
    // re-read `row` above does not carry it, so the value just stored is
    // echoed explicitly.
    vendorInvoiceDate,
    subtotal, taxableTotal, taxTotal, discountTotal, roundOff, priceMode,
    otherCharges: enrichCharges(otherCharges, await chargeLedgerNames([otherCharges])),
    otherChargesTotal: otherChargesTot,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    advanceApplied: appliedAdvance,
    ...(warnings.length ? { warnings } : {}),
    lineItems: enrichLines(enriched, maps),
  });
});

router.get("/purchases/:id", requireModuleView("page:/production/purchase"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { rows: [locRow] } = await pool.query(
    `SELECT location_type, location_id, price_mode, other_charges,
            vendor_invoice_date::text AS vendor_invoice_date
       FROM purchases WHERE id = $1`, [id]);
  const loc: ProdLocation = { type: locRow?.location_type ?? 'headoffice', id: Number(locRow?.location_id ?? 1) };
  const gotCharges = parseStoredOtherCharges(locRow?.other_charges);

  // LBAC: a location may only open its own bills.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  if (!scope.isHeadOffice) {
    const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
      || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
  }

  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  res.json({
    ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount),
    // Raw-migration column: absent on historical bills — null, never backfilled.
    vendorInvoiceDate: locRow?.vendor_invoice_date ?? null,
    taxTotal: Number((row as any).taxTotal ?? 0),
    discountTotal: Number((row as any).discountTotal ?? 0),
    roundOff: Number((row as any).roundOff ?? 0),
    priceMode: asPriceMode(locRow?.price_mode),
    otherCharges: enrichCharges(gotCharges, await chargeLedgerNames([gotCharges])),
    otherChargesTotal: otherChargesTotal(gotCharges),
    locationType: loc.type, locationId: loc.id,
    locationName: await locationLabel(pool, loc),
    lineItems: enrichLines(row.lineItems, await buildNameMaps()),
  });
});

router.patch("/purchases/:id", requireModuleAction("page:/production/purchase", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [current] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const { purchaseDate, invoiceNumber, notes, vendorId, lineItems, otherCharges: otherChargesBody,
          vendorInvoiceDate: vendorInvoiceDateBody } = req.body as {
    purchaseDate?: string; invoiceNumber?: string; notes?: string;
    vendorId?: number; lineItems?: any[]; otherCharges?: any[];
    vendorInvoiceDate?: string | null;
  };

  // Vendor Invoice Date: omitted = keep as stored; explicit null clears (a
  // correction path — historical bills legitimately have none, absent ≠ zero);
  // a string must be a real calendar date. Raw-migration DATE column — written
  // via raw SQL on both edit paths below.
  if (vendorInvoiceDateBody !== undefined && vendorInvoiceDateBody !== null
      && !isIsoDate(String(vendorInvoiceDateBody).trim())) {
    res.status(400).json({ error: "Vendor Invoice Date must be a real calendar date (YYYY-MM-DD)" }); return;
  }
  const vendorInvoiceDateNew: string | null | undefined = vendorInvoiceDateBody === undefined
    ? undefined
    : (vendorInvoiceDateBody === null || String(vendorInvoiceDateBody).trim() === ""
        ? null : String(vendorInvoiceDateBody).trim());

  // Bill-wise settlement guards. Money already recorded against this bill no
  // longer freezes it: the payable is derived from the row, so an edited total
  // simply recalculates the outstanding (paid stays paid, outstanding = new
  // total − settled). Two things remain non-negotiable — the bill cannot be
  // handed to a DIFFERENT vendor from under that vendor's payments/advances,
  // and the total cannot shrink below what has already been settled, or the
  // books would show money applied to value that no longer exists.
  if (lineItems !== undefined || vendorId !== undefined || otherChargesBody !== undefined) {
    const { rows: [settled] } = await pool.query(
      `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0) AS alloc_total,
              COALESCE((SELECT COUNT(*) FROM payment_bill_allocations WHERE purchase_id = $1), 0)::int AS allocs,
              COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS adv_applied,
              COALESCE((SELECT COUNT(*) FROM purchase_advance_applications WHERE purchase_id = $1), 0)::int AS adv_rows`,
      [id],
    );
    if (vendorId !== undefined && Number(vendorId) !== Number(current.vendorId)
        && (Number(settled?.allocs ?? 0) > 0 || Number(settled?.adv_rows ?? 0) > 0)) {
      res.status(409).json({
        error: "Payments or advances are already recorded against this bill — it cannot be moved to a different vendor. Delete those vouchers first.",
        code: "BILL_HAS_SETTLEMENTS",
      });
      return;
    }
    (req as any)._advApplied = Number(settled?.adv_applied ?? 0);
    (req as any)._allocTotal = Number(settled?.alloc_total ?? 0);
  }

  // An edit always REVERSES the old lines at the location that recorded the
  // bill. Unless a new location is sent explicitly, the re-apply happens there
  // too — an edit can never quietly move stock between locations.
  const { rows: [curLocRow] } = await pool.query(
    `SELECT location_type, location_id FROM purchases WHERE id = $1`, [id]);
  const loc: ProdLocation = { type: curLocRow?.location_type ?? 'headoffice', id: Number(curLocRow?.location_id ?? 1) };
  const locName = await locationLabel(pool, loc);

  // LBAC: a location may only edit its own bills.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  if (!scope.isHeadOffice) {
    const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
      || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
    if (!allowed) { res.status(404).json({ error: "Not found" }); return; }
  }

  // ── Optional receiving-location change ────────────────────────────────────
  // A bill may be moved to another location on edit: old lines are reversed
  // where they were, new lines applied at the new location, and the GST supply
  // type re-derived against the NEW location's state. Resolved through the
  // same gate as create, so a warehouse user can only move a bill to a
  // location they are allowed to act for.
  let newLoc: ProdLocation = loc;
  if ((req.body as any).locationType !== undefined || (req.body as any).locationId !== undefined) {
    const resolvedMove = await resolveActingLocation(pool, {
      employee: (req as any).employee,
      requested: { type: (req.body as any).locationType, id: (req.body as any).locationId },
    });
    if ("error" in resolvedMove) { res.status(400).json({ error: resolvedMove.error }); return; }
    newLoc = resolvedMove.loc;
  }
  const isMove = newLoc.type !== loc.type || newLoc.id !== loc.id;
  if (isMove && lineItems === undefined) {
    res.status(400).json({
      error: "To move this bill to another location, send its line items too so stock can be reversed at the old location and re-applied at the new one.",
    }); return;
  }
  const newLocName = isMove ? await locationLabel(pool, newLoc) : locName;

  // purchase_date is a real DATE column — reject an impossible date up front.
  if (purchaseDate !== undefined && !isIsoDate(String(purchaseDate))) {
    res.status(400).json({ error: "Purchase date must be a real calendar date (YYYY-MM-DD)" }); return;
  }

  // Month lock: an edit may neither change a bill inside a locked month nor
  // move one into/out of one — guard the stored date AND the incoming date.
  // Fast pre-check for both edit paths; the line-items path re-checks under the
  // row lock below.
  if (await respondIfMonthLocked(res, pool, [current.purchaseDate, purchaseDate], "purchase edit")) return;

  if (lineItems !== undefined) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      res.status(400).json({ error: "Add at least one line item" }); return;
    }
    // Every check the create path runs, run here too: an edit rewrites the same
    // stock, lots and postings a create does. All of it happens before any write
    // so a rejected edit leaves the bill and its stock exactly as they were.
    const maps = await buildNameMaps();
    // The lot numbers this bill already owns. An edit posts the lines back as
    // it read them, system-issued numbers included, and those must survive.
    const ownReserved = new Set<string>(
      ((current.lineItems as any[]) ?? [])
        .map(li => String(li?.batchNumber ?? "").trim())
        .filter(Boolean),
    );
    const identityMsg = lineIdentityError(lineItems, maps, ownReserved);
    if (identityMsg) { res.status(400).json({ error: identityMsg }); return; }

    // Checked at the location the new lines will LAND at.
    const batchClash = await manualBatchConflict(pool, lineItems, newLoc, id);
    if (batchClash) { res.status(400).json({ error: batchClash }); return; }

    // Rate mode is part of the bill, so an edit that does not mention it keeps
    // whatever the bill was written with rather than silently reverting to
    // exclusive and restating the totals.
    const { rows: [modeRow] } = await pool.query(`SELECT price_mode, other_charges FROM purchases WHERE id = $1`, [id]);
    const modeSupplied = (req.body as any).priceMode;
    // Validated, not coerced. Silently reading an unrecognised mode as
    // "exclusive" would restate an inclusive bill's taxable value and tax on an
    // edit that never meant to touch the rate basis.
    if (modeSupplied !== undefined && modeSupplied !== "inclusive" && modeSupplied !== "exclusive") {
      res.status(400).json({ error: 'Rate basis must be "inclusive" or "exclusive"' }); return;
    }
    const priceMode = modeSupplied !== undefined
      ? asPriceMode(modeSupplied)
      : asPriceMode(modeRow?.price_mode);

    const effVendorId = Number(vendorId ?? current.vendorId);
    // GST intra/inter is judged against the location the goods are billed TO —
    // after a move, that is the new location.
    const supply = await resolveSupplyTaxType(effVendorId, newLoc);

    // 2. Calculate and enrich the new lines (before any write, so a bad line
    //    cannot leave the reversal applied)
    const { enriched, subtotal, discountTotal, taxableTotal, taxTotal, roundOff, totalAmount } =
      priceBill(lineItems, priceMode, maps, supply.taxType);

    for (const li of enriched) {
      if (!isValidGstSlab(li.gstRate)) { res.status(400).json({ error: gstSlabErrorMessage(li.gstRate) }); return; }
    }

    // Other Purchase Charges: replaced when sent, kept when omitted — an edit
    // that never mentions them must not silently clear them. Ledgers this bill
    // ALREADY charges are grandfathered under the old any-expense rule; only
    // genuinely new picks are held to Direct Expense.
    let newOtherCharges: OtherCharge[];
    if (otherChargesBody !== undefined) {
      const storedIds = new Set(parseStoredOtherCharges(modeRow?.other_charges).map(c => c.ledgerId));
      const ocEdit = await validateOtherCharges(pool, otherChargesBody, { grandfatheredLedgerIds: storedIds });
      if ("error" in ocEdit) { res.status(400).json({ error: ocEdit.error }); return; }
      newOtherCharges = ocEdit.charges;
    } else {
      newOtherCharges = parseStoredOtherCharges(modeRow?.other_charges);
    }
    const newOtherTot = otherChargesTotal(newOtherCharges);

    // Money already settled against this bill (payment allocations + adjusted
    // vendor advances) is spent — the bill cannot shrink below it, or the
    // books would show money applied to value that no longer exists. Judged on
    // what the vendor is owed: goods plus other charges, since both credit the
    // vendor. Any total ABOVE that floor is allowed; the outstanding simply
    // re-derives as new total − settled.
    const advApplied = Number((req as any)._advApplied ?? 0);
    const settledTotal = Math.round((advApplied + Number((req as any)._allocTotal ?? 0)) * 100) / 100;
    const grandPayable = Math.round((totalAmount + newOtherTot) * 100) / 100;
    if (settledTotal > 0.004 && grandPayable < settledTotal - 0.005) {
      res.status(409).json({
        error: `₹${settledTotal.toFixed(2)} has already been paid or adjusted against this bill — the new total (₹${grandPayable.toFixed(2)}) cannot go below that. Delete those payment vouchers first, or record a purchase return instead.`,
        code: "BILL_BELOW_SETTLED_AMOUNT",
      });
      return;
    }

    const warnings: string[] = [];
    for (let i = 0; i < enriched.length; i++) {
      const li = enriched[i] as any;
      if (li.taxTypeRequested && li.taxTypeSource === "derived") {
        warnings.push(
          `Line ${i + 1}: GST type recorded as ${li.taxType === "inter" ? "inter-state (IGST)" : "intra-state (CGST+SGST)"} `
          + `from ${supply.why}, not the ${li.taxTypeRequested === "inter" ? "inter-state" : "intra-state"} value sent.`,
        );
      }
    }

    // An edit is a reversal plus a re-apply: both halves, the lot layer, the
    // weighted-average costs, the bill row and the stock ledger commit together
    // or not at all.
    const client = await pool.connect();
    let beforeTotal = Number(current.totalAmount);
    try {
      await client.query("BEGIN");

      // Row-lock the bill and take the old lines FROM THE LOCKED ROW. Reading
      // them before BEGIN would let two concurrent edits (or an edit racing a
      // delete) each reverse the same lines from the same stale snapshot.
      const { rows: [locked] } = await client.query(
        `SELECT line_items, vendor_id, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date,
                to_char(vendor_invoice_date, 'YYYY-MM-DD') AS vendor_invoice_date,
                invoice_number, notes, total_amount, location_type, location_id
         FROM purchases WHERE id = $1 FOR UPDATE`, [id]);
      if (!locked) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" }); return;
      }
      // Location is immutable, so a mismatch means the row is not what the LBAC
      // check above cleared. Refuse rather than post to the wrong warehouse.
      if ((locked.location_type ?? 'headoffice') !== loc.type || Number(locked.location_id ?? 1) !== loc.id) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This bill was changed by someone else. Reload and try again." }); return;
      }
      beforeTotal = Number(locked.total_amount ?? 0);

      // Month lock: an edit may neither change a bill inside a locked month nor
      // move one into/out of one — guard the stored date AND the incoming date.
      for (const d of [locked.purchase_date, purchaseDate]) {
        const ym = ymOfDate(d);
        if (ym && await isMonthLocked(client, ym.year, ym.month)) {
          await client.query("ROLLBACK");
          res.status(423).json(monthLockedBody(ym.year, ym.month)); return;
        }
      }

      // Re-check the settlement floor UNDER the row lock. The pre-transaction
      // check is a fast fail for the common case, but a payment allocation can
      // commit between that read and this lock — the allocation path takes
      // FOR UPDATE on this same purchase row, so re-reading here is what
      // actually serialises money against the edit.
      {
        const { rows: [s2] } = await client.query(
          `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0) AS alloc_total,
                  COALESCE((SELECT COUNT(*) FROM payment_bill_allocations WHERE purchase_id = $1), 0)::int AS allocs,
                  COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS adv_applied,
                  COALESCE((SELECT COUNT(*) FROM purchase_advance_applications WHERE purchase_id = $1), 0)::int AS adv_rows`,
          [id],
        );
        if (vendorId !== undefined && Number(vendorId) !== Number(locked.vendor_id)
            && (Number(s2?.allocs ?? 0) > 0 || Number(s2?.adv_rows ?? 0) > 0)) {
          await client.query("ROLLBACK");
          res.status(409).json({
            error: "Payments or advances are already recorded against this bill — it cannot be moved to a different vendor. Delete those vouchers first.",
            code: "BILL_HAS_SETTLEMENTS",
          });
          return;
        }
        const settledNow = Math.round((Number(s2?.alloc_total ?? 0) + Number(s2?.adv_applied ?? 0)) * 100) / 100;
        const grandNow = Math.round((totalAmount + newOtherTot) * 100) / 100;
        if (settledNow > 0.004 && grandNow < settledNow - 0.005) {
          await client.query("ROLLBACK");
          res.status(409).json({
            error: `₹${settledNow.toFixed(2)} has already been paid or adjusted against this bill — the new total (₹${grandNow.toFixed(2)}) cannot go below that. Delete those payment vouchers first, or record a purchase return instead.`,
            code: "BILL_BELOW_SETTLED_AMOUNT",
          });
          return;
        }
      }

      // ── Line diff: only lines that actually change stock are rewritten ──
      const oldLines = (locked.line_items ?? []) as Array<{
        materialType: string; materialId: number; quantity: number;
        batchNumber?: string | null; costPerUnit?: number; unitCost?: number;
      }>;

      // Pair old and new lines by identity (product kind + product + lot).
      // An untouched line is left completely alone — it is no longer
      // round-tripped through the floored reversal, so one consumed line
      // cannot block edits to the REST of the bill any more.
      const keyOf = (t: any, mid: any, batch: any) =>
        `${String(t ?? "item")}:${Number(mid)}:${String(batch ?? "").trim().toLowerCase()}`;
      const oldByKey = new Map<string, any>();
      // A move re-homes every line, and duplicate lot keys (possible only on
      // bills that predate the identity checks) make pairing unsafe — both
      // fall back to the historical full reverse + re-apply.
      let ambiguous = isMove;
      for (const li of oldLines) {
        const k = keyOf(li?.materialType, li?.materialId, li?.batchNumber || `PUR-${id}`);
        if (oldByKey.has(k)) ambiguous = true;
        oldByKey.set(k, li);
      }
      const newByKey = new Map<string, any>();
      for (const li of enriched as any[]) {
        const bn = String(li?.batchNumber ?? "").trim();
        if (!bn) continue; // a brand-new line — it will draw a fresh lot number
        const k = keyOf(li?.materialType, li?.materialId, bn);
        if (newByKey.has(k)) ambiguous = true;
        newByKey.set(k, li);
      }

      const sameDate = (a: any, b: any) => String(a ?? "").slice(0, 10) === String(b ?? "").slice(0, 10);
      const toReverse: any[] = []; // old lines whose full quantity comes back out
      const toApply: any[] = [];   // new lines applied in full
      const deltas: Array<{ nu: any; delta: number }> = []; // quantity-only changes
      const dateFixes: any[] = []; // mfg/expiry corrections — lot metadata, no stock movement
      if (ambiguous) {
        toReverse.push(...oldLines);
        toApply.push(...(enriched as any[]));
      } else {
        for (const [k, ol] of oldByKey) {
          const nl = newByKey.get(k);
          if (!nl) { toReverse.push(ol); continue; } // line removed from the bill
          const oldQty = Number(ol?.quantity ?? 0);
          const newQty = Number(nl?.quantity ?? 0);
          const oldCost = Number(ol?.costPerUnit ?? ol?.unitCost ?? 0);
          const newCost = Number(nl?.costPerUnit ?? 0);
          // Stock cares about the per-unit taxable cost: a cost change means
          // the line's valuation must be rebuilt from scratch — which needs
          // its full old quantity still on hand. A quantity-only change
          // adjusts by the difference instead. MFG/expiry are lot METADATA:
          // correcting them must never demand the old quantity back (imported
          // bills' stock is often long consumed), so the lot row keeps its
          // quantity and only its dates are rewritten in place.
          const costSame = Math.abs(oldCost - newCost) <= 0.005;
          const datesSame = sameDate(ol?.mfgDate, nl?.mfgDate) && sameDate(ol?.expiryDate, nl?.expiryDate);
          if (costSame) {
            if (Math.abs(newQty - oldQty) > 0.0005) deltas.push({ nu: nl, delta: newQty - oldQty });
            if (!datesSame) dateFixes.push(nl);
            // identical line: no stock work at all
          } else {
            toReverse.push(ol);
            toApply.push(nl);
          }
        }
        for (const [k, nl] of newByKey) if (!oldByKey.has(k)) toApply.push(nl);
        for (const nl of enriched as any[]) {
          if (!String(nl?.batchNumber ?? "").trim()) toApply.push(nl);
        }
      }

      // Refuse before writing anything if the stock this edit must take back
      // out is no longer on hand. Rewritten/removed lines need their full old
      // quantity; reduced lines need only the reduction. Untouched lines are
      // not checked at all, and the error names only the line at fault.
      const checks: StockCheck[] = [
        ...toReverse.map(li => ({ line: li, need: Number(li?.quantity ?? 0), mode: "rewrite" as const })),
        ...deltas.filter(d => d.delta < 0).map(d => ({ line: d.nu, need: -d.delta, mode: "reduce" as const })),
      ];
      const stuck = await stockShortfall(client, checks, loc, id, maps);
      if (stuck) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: stuck, code: "PURCHASE_STOCK_CONSUMED" }); return;
      }

      // Same lock-then-recheck as the create path: the pre-flight check ran
      // outside this transaction, so a hand-typed number could have been taken
      // since. This bill's own lots are excluded — it is allowed to keep them.
      await lockLotNamespace(client, enriched, newLoc);
      const racedClash = await manualBatchConflict(client, enriched, newLoc, id);
      if (racedClash) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: racedClash }); return;
      }

    // 1. Reverse stock from the lines being rewritten or removed (mirror of
    //    the delete handler). The average cost is unwound with the quantity —
    //    leaving it behind would make this bill's own cost the baseline for
    //    its replacement and drift the valuation a little further on every save.
    for (const li of toReverse) {
      const oldCost = Number(li.costPerUnit ?? li.unitCost ?? 0);
      if (li.materialType === "material") {
        await client.query(
          `UPDATE materials SET
             avg_cost = CASE
               WHEN current_stock::numeric - $2::numeric > 0
                 THEN GREATEST(0, ROUND(
                   (current_stock::numeric * COALESCE(avg_cost, 0)::numeric - $2::numeric * $3::numeric)
                   / (current_stock::numeric - $2::numeric), 4))
               ELSE COALESCE(avg_cost, 0)
             END,
             current_stock = GREATEST(0, current_stock::numeric - $2::numeric)
           WHERE id = $1`,
          [li.materialId, li.quantity, oldCost],
        );
        await deductMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "material", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      } else if (li.materialType === "raw_material") {
        await client.query(
          `UPDATE raw_materials SET
             avg_cost = CASE
               WHEN current_stock::numeric - $2::numeric > 0
                 THEN GREATEST(0, ROUND(
                   (current_stock::numeric * COALESCE(avg_cost, 0)::numeric - $2::numeric * $3::numeric)
                   / (current_stock::numeric - $2::numeric), 4))
               ELSE COALESCE(avg_cost, 0)
             END,
             current_stock = GREATEST(0, current_stock::numeric - $2::numeric)
           WHERE id = $1`,
          [li.materialId, li.quantity, oldCost],
        );
        await deductMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "raw_material", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      } else if (li.materialType === "item") {
        // Before the quantity leaves stock_entries — the reversal reads the
        // total that still includes this line, mirroring the inbound.
        await updateAvgCostOnReversal(client, li.materialId, Number(li.quantity), oldCost);
        await client.query(
          `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await client.query(
          `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
           WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
          [li.quantity, li.materialId, loc.type, loc.id],
        );
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: "item", branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
        });
      }
    }

    // A fully-reversed line leaves its lot at zero. Delete those emptied lots
    // so (a) a removed line leaves no orphan zero-quantity batch behind, and
    // (b) a re-applied line re-INSERTS a fresh lot — creditBatch keeps an
    // existing lot's mfg/expiry via COALESCE, so without this a date
    // correction on an existing batch number would never take effect.
    // Scoped to the REVERSED lines' own lots only — full lot identity
    // (kind + product + batch), since a batch NUMBER alone is only unique per
    // product: an untouched product B lot sharing product A's batch string, or
    // any untouched line's fully-consumed lot, keeps its row and its dates.
    for (const li of toReverse) {
      await client.query(
        `DELETE FROM stock_batches
          WHERE source = 'purchase' AND source_id = $1
            AND branch_type = $2 AND branch_id = $3
            AND quantity::numeric <= 0.0005
            AND material_type = $4 AND item_id = $5 AND batch_number = $6`,
        [id, loc.type, loc.id, String(li?.materialType ?? 'item'), Number(li?.materialId),
         String(li?.batchNumber || `PUR-${id}`)],
      );
    }

    // ── Stock ledger (purchase edit reversal) ────────────────────────────────
    // Dated on the bill's OLD business date: the reversal takes the old lines
    // out of history exactly where they entered it, so date-based stock
    // reports stay continuous (closing of D = opening of D+1).
    await writeStockLedger(client, (toReverse as any[]).map(li => ({
      txnType: 'purchase_reversal', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: -Number(li.quantity), unitCost: 0,
      docType: 'purchase', docId: id,
      txnDate: String(locked.purchase_date ?? '') || null,
      notes: 'Purchase edit — old lines reversed',
    })));

    // ── Quantity-only changes: adjust by the difference ─────────────────────
    // An increase is a normal inbound of the extra units at the line's own
    // cost; a reduction was validated above against THIS line's remaining
    // stock, so the debit cannot underflow. The lot keeps its dates — only
    // its quantity moves.
    for (const d of deltas) {
      const li = d.nu;
      const qty = Math.abs(d.delta);
      const cost = Number(li.costPerUnit ?? 0);
      const kind = String(li.materialType ?? "item");
      if (d.delta > 0) {
        if (kind === "material" || kind === "raw_material") {
          await client.query(
            `UPDATE ${kind === "material" ? "materials" : "raw_materials"} SET
               avg_cost = ROUND(
                 (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
                 / NULLIF(current_stock::numeric + $2::numeric, 0),
               4),
               current_stock = current_stock::numeric + $2::numeric
             WHERE id = $1`,
            [li.materialId, qty, cost],
          );
          await creditMaterialAt(client, kind, li.materialId, loc.type, loc.id, qty, cost);
        } else {
          await client.query(
            `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
            [li.materialId, qty],
          );
          await client.query(
            `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
             VALUES ($1, 'item', $4, $5, $2, $3)
             ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
               quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
               cost_price = EXCLUDED.cost_price,
               updated_at = now()`,
            [li.materialId, qty, cost, loc.type, loc.id],
          );
          await updateAvgCostOnInbound(client, li.materialId, qty, cost);
        }
        await creditBatch(client, {
          itemId: li.materialId, materialType: kind as BatchKind,
          branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber!,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: qty, unitCost: cost,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      } else {
        if (kind === "material" || kind === "raw_material") {
          await client.query(
            `UPDATE ${kind === "material" ? "materials" : "raw_materials"} SET
               avg_cost = CASE
                 WHEN current_stock::numeric - $2::numeric > 0
                   THEN GREATEST(0, ROUND(
                     (current_stock::numeric * COALESCE(avg_cost, 0)::numeric - $2::numeric * $3::numeric)
                     / (current_stock::numeric - $2::numeric), 4))
                 ELSE COALESCE(avg_cost, 0)
               END,
               current_stock = GREATEST(0, current_stock::numeric - $2::numeric)
             WHERE id = $1`,
            [li.materialId, qty, cost],
          );
          await deductMaterialAt(client, kind, li.materialId, loc.type, loc.id, qty, { floor: true });
        } else {
          // Before the quantity leaves stock_entries — the unwind reads the
          // total that still includes this reduction, mirroring the inbound.
          await updateAvgCostOnReversal(client, li.materialId, qty, cost);
          await client.query(
            `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
            [li.materialId, qty],
          );
          await client.query(
            `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
             WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
            [qty, li.materialId, loc.type, loc.id],
          );
        }
        await debitBatchByNumber(client, {
          itemId: li.materialId, materialType: kind as BatchKind, branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber || `PUR-${id}`, quantity: qty,
        });
      }
    }

    // ── Stock ledger (quantity adjustments) ──────────────────────────────────
    await writeStockLedger(client, deltas.map(d => {
      const li = d.nu;
      const kind = String(li.materialType ?? "item");
      const master = maps[kind as keyof NameMaps]?.get(Number(li.materialId));
      return {
        txnType: d.delta > 0 ? 'purchase' : 'purchase_reversal',
        materialType: kind, refId: li.materialId,
        itemName: master?.name ?? '', unit: master?.unit ?? '',
        branchType: loc.type, branchId: ledgerBranchId(loc, kind), branchName: locName,
        qtyChange: d.delta, unitCost: Number(li.costPerUnit ?? 0),
        docType: 'purchase', docId: id,
        txnDate: String(purchaseDate ?? locked.purchase_date ?? '') || null,
        notes: d.delta > 0 ? 'Purchase edit — quantity increased' : 'Purchase edit — quantity reduced',
      };
    }));

    // ── Date-only corrections: rewrite the lot's dates in place ─────────────
    // No quantity moves, no ledger row, no valuation change — a direct UPDATE,
    // not creditBatch (whose COALESCE deliberately keeps existing dates).
    // Works even when the lot is fully consumed (quantity 0): that is exactly
    // the imported-bill case this exists for. A lot that predates batch
    // tracking simply has no row to update; the corrected dates still land in
    // line_items below either way. dateFixes is only populated on the
    // non-ambiguous path, where the bill is not moving — so `loc` is right.
    // Provenance-scoped: only the lot THIS bill created is rewritten. A
    // same-key lot owned by another document (legacy import, transfer-in)
    // keeps its own dates — the natural key alone is not ownership.
    for (const li of dateFixes) {
      await client.query(
        `UPDATE stock_batches SET mfg_date = $1, expiry_date = $2, updated_at = now()
          WHERE item_id = $3 AND material_type = $4 AND branch_type = $5 AND branch_id = $6
            AND batch_number = $7 AND source = 'purchase' AND source_id = $8`,
        [dateOrNull(li.mfgDate), dateOrNull(li.expiryDate), Number(li.materialId),
         String(li.materialType ?? "item"), loc.type, loc.id, String(li.batchNumber), id],
      );
    }

    // A line that already carries a lot number keeps it — an edit must not
    // silently re-issue lots and orphan the stock recorded against the old
    // ones. Only genuinely new lines draw a number.
    const needsBatch = (enriched as any[]).filter(l => !l.batchNumber);
    if (needsBatch.length > 0) {
      const issued = await allocateBatchNumbers(
        client, String(purchaseDate ?? locked.purchase_date), needsBatch.length);
      needsBatch.forEach((l, i) => { l.batchNumber = issued[i]; });
    }

    // When the bill is being MOVED, the destination may still hold a stale
    // zero-quantity lot this same bill created in an earlier life (a move
    // away before emptied lots were deleted). creditBatch would upsert into
    // it and COALESCE would resurrect its old mfg/expiry — clear the bill's
    // own emptied lots at the destination too, so re-apply always INSERTs
    // fresh rows. Other bills' lots are never touched: a live clash with a
    // foreign lot was already rejected by manualBatchConflict above.
    if (isMove) {
      await client.query(
        `DELETE FROM stock_batches
          WHERE source = 'purchase' AND source_id = $1
            AND branch_type = $2 AND branch_id = $3
            AND quantity::numeric <= 0.0005`,
        [id, newLoc.type, newLoc.id],
      );
    }

    // 3. Apply stock for the rewritten and added lines (mirror of the create
    //    handler), at the EFFECTIVE location — the new one when the bill moved.
    //    Valued at costPerUnit: net of discount, net of recoverable input GST.
    for (const li of toApply) {
      if (li.materialType === "material") {
        await client.query(
          `UPDATE materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.costPerUnit]
        );
        await creditMaterialAt(client, "material", li.materialId, newLoc.type, newLoc.id, Number(li.quantity), Number(li.costPerUnit));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "material",
          branchType: newLoc.type, branchId: newLoc.id,
          batchNumber: li.batchNumber!,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "raw_material") {
        await client.query(
          `UPDATE raw_materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.costPerUnit]
        );
        await creditMaterialAt(client, "raw_material", li.materialId, newLoc.type, newLoc.id, Number(li.quantity), Number(li.costPerUnit));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "raw_material",
          branchType: newLoc.type, branchId: newLoc.id,
          batchNumber: li.batchNumber!,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "item") {
        await client.query(
          `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await client.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $4, $5, $2, $3)
           ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
             quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
             cost_price = EXCLUDED.cost_price,
             updated_at = now()`,
          [li.materialId, li.quantity, li.costPerUnit, newLoc.type, newLoc.id],
        );
        await updateAvgCostOnInbound(client, li.materialId, li.quantity, li.costPerUnit);
        await creditBatch(client, {
          itemId: li.materialId, branchType: newLoc.type, branchId: newLoc.id,
          batchNumber: li.batchNumber!,
          mfgDate: li.mfgDate ?? null, expiryDate: li.expiryDate ?? null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: id,
          ...(await lineIdentity(li)),
        });
      }
    }

    // ── Stock ledger (purchase edit re-apply) ────────────────────────────────
    // Dated on the bill's NEW business date at the effective location, so a
    // backdated correction rewrites stock history from the date it claims.
    await writeStockLedger(client, (toApply as any[]).map(li => {
      const master = maps[li.materialType as keyof NameMaps]?.get(Number(li.materialId));
      return {
        txnType: 'purchase', materialType: li.materialType ?? 'item',
        refId: li.materialId, itemName: master?.name ?? '', unit: master?.unit ?? '',
        branchType: newLoc.type, branchId: ledgerBranchId(newLoc, li.materialType ?? 'item'), branchName: newLocName,
        qtyChange: Number(li.quantity), unitCost: Number(li.costPerUnit ?? 0),
        docType: 'purchase', docId: id,
        txnDate: String(purchaseDate ?? locked.purchase_date ?? '') || null,
        notes: 'Purchase edit — new lines applied',
      };
    }));

    // Untouched lines' ledger rows are no longer rewritten, so a changed
    // business date must move them explicitly — the same re-date a
    // metadata-only edit performs. Every row of the bill moves together;
    // reversal pairs cancel on any day.
    if (purchaseDate !== undefined && String(locked.purchase_date ?? '') !== String(purchaseDate)) {
      await client.query(
        `UPDATE stock_ledger SET txn_date = $2::date WHERE doc_type = 'purchase' AND doc_id = $1`,
        [id, purchaseDate],
      );
    }

    // 4. Persist the updated record (location included: after a move the
    //    vendor payable and input GST re-derive against the new location's
    //    purchase ledger from this row).
      await client.query(
        `UPDATE purchases SET vendor_id = $2, purchase_date = $3, invoice_number = $4, notes = $5,
                              line_items = $6::jsonb, total_amount = $7,
                              tax_total = $8, discount_total = $9, round_off = $10,
                              price_mode = $11, location_type = $12, location_id = $13,
                              other_charges = $14::jsonb, vendor_invoice_date = $15::date
         WHERE id = $1`,
        [id, vendorId ?? locked.vendor_id, purchaseDate ?? locked.purchase_date,
         invoiceNumber !== undefined ? invoiceNumber : locked.invoice_number,
         notes !== undefined ? notes : locked.notes,
         JSON.stringify(enriched), String(totalAmount), taxTotal, discountTotal, roundOff,
         priceMode, newLoc.type, newLoc.id, JSON.stringify(newOtherCharges),
         vendorInvoiceDateNew !== undefined ? vendorInvoiceDateNew : (locked.vendor_invoice_date ?? null)],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if ((e as any)?.code === "23505" && String((e as any)?.constraint ?? "").includes("purchases_vendor_invoice")) {
        res.status(409).json({
          error: `Invoice "${invoiceNumber}" is already recorded for this vendor.`,
          code: "DUPLICATE_PURCHASE_INVOICE",
        });
        return;
      }
      throw e;
    } finally {
      client.release();
    }

    const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);

    logActivity({
      action: "UPDATE", module: "purchases", entityType: "purchase", entityId: id,
      description: `Purchase Bill #${id} fully edited at ${newLocName}`
        + (isMove ? ` (moved from ${locName})` : '') + ` — ₹${totalAmount.toFixed(2)}`,
      metadata: { before: { totalAmount: beforeTotal, locationType: loc.type, locationId: loc.id }, after: { totalAmount, otherChargesTotal: newOtherTot, lineCount: enriched.length, locationType: newLoc.type, locationId: newLoc.id, priceMode, taxableTotal, taxTotal } },
    }).catch(() => {});

    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
    // Raw-migration column: re-read what the UPDATE just stored.
    const { rows: [vidRow] } = await pool.query(
      `SELECT vendor_invoice_date::text AS vendor_invoice_date FROM purchases WHERE id = $1`, [id]);
    res.json({
      ...row, vendorName: vendor?.name ?? "",
      vendorInvoiceDate: vidRow?.vendor_invoice_date ?? null,
      totalAmount, subtotal, taxableTotal, taxTotal, discountTotal, roundOff, priceMode,
      otherCharges: enrichCharges(newOtherCharges, await chargeLedgerNames([newOtherCharges])),
      otherChargesTotal: newOtherTot,
      locationType: newLoc.type, locationId: newLoc.id, locationName: newLocName,
      ...(warnings.length ? { warnings } : {}),
      lineItems: enrichLines(enriched, maps),
    });
    return;
  }

  // ── Metadata-only edit (date / invoice ref / notes / other charges, no line changes) ──
  const updateData: Record<string, unknown> = {};
  if (purchaseDate !== undefined) updateData.purchaseDate = purchaseDate;
  if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber;
  if (notes !== undefined) updateData.notes = notes;

  // Other charges may change without touching the lines. They change what the
  // vendor is owed, so the settled floor is re-judged on the resulting grand
  // total here — the bill may not shrink below what was already paid/adjusted.
  // Ledgers the bill ALREADY charges are grandfathered (old any-expense rule);
  // only genuinely new picks are held to Direct Expense.
  let chargesOnly: { charges: OtherCharge[]; total: number } | null = null;
  if (otherChargesBody !== undefined) {
    const { rows: [ocCur] } = await pool.query(`SELECT other_charges FROM purchases WHERE id = $1`, [id]);
    const storedIds = new Set(parseStoredOtherCharges(ocCur?.other_charges).map(c => c.ledgerId));
    const ocp = await validateOtherCharges(pool, otherChargesBody, { grandfatheredLedgerIds: storedIds });
    if ("error" in ocp) { res.status(400).json({ error: ocp.error }); return; }
    const advApplied = Number((req as any)._advApplied ?? 0);
    const settledTotal = Math.round((advApplied + Number((req as any)._allocTotal ?? 0)) * 100) / 100;
    const grand = Math.round((Number(current.totalAmount) + ocp.total) * 100) / 100;
    if (settledTotal > 0.004 && grand < settledTotal - 0.005) {
      res.status(409).json({
        error: `₹${settledTotal.toFixed(2)} has already been paid or adjusted against this bill — the new total (₹${grand.toFixed(2)}) cannot go below that. Delete those payment vouchers first, or record a purchase return instead.`,
        code: "BILL_BELOW_SETTLED_AMOUNT",
      });
      return;
    }
    chargesOnly = ocp;
  }

  if (Object.keys(updateData).length === 0 && !chargesOnly && vendorInvoiceDateNew === undefined) {
    res.status(400).json({ error: "No fields to update" }); return;
  }

  // vendor_invoice_date is a raw-migration column — a drizzle .set() cannot
  // carry it, so it is written with explicit SQL like other_charges below.
  if (vendorInvoiceDateNew !== undefined) {
    await pool.query(
      `UPDATE purchases SET vendor_invoice_date = $2::date WHERE id = $1`,
      [id, vendorInvoiceDateNew],
    );
  }
  if (chargesOnly) {
    // Raw column — a drizzle .set() cannot carry it (see raw-migration columns).
    // Written under the same row lock the payment-allocation path takes, and
    // the settled floor re-checked there: a payment recorded between the
    // fast-fail check above and this write must not be stranded above a
    // shrunken total.
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      const { rows: [lk] } = await c2.query(
        `SELECT total_amount FROM purchases WHERE id = $1 FOR UPDATE`, [id]);
      if (!lk) { await c2.query("ROLLBACK"); res.status(404).json({ error: "Not found" }); return; }
      const { rows: [s2] } = await c2.query(
        `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0) AS alloc_total,
                COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS adv_applied`,
        [id],
      );
      const settledNow = Math.round((Number(s2?.alloc_total ?? 0) + Number(s2?.adv_applied ?? 0)) * 100) / 100;
      const grandNow = Math.round((Number(lk.total_amount ?? 0) + chargesOnly.total) * 100) / 100;
      if (settledNow > 0.004 && grandNow < settledNow - 0.005) {
        await c2.query("ROLLBACK");
        res.status(409).json({
          error: `₹${settledNow.toFixed(2)} has already been paid or adjusted against this bill — the new total (₹${grandNow.toFixed(2)}) cannot go below that. Delete those payment vouchers first, or record a purchase return instead.`,
          code: "BILL_BELOW_SETTLED_AMOUNT",
        });
        return;
      }
      await c2.query(`UPDATE purchases SET other_charges = $2::jsonb WHERE id = $1`, [id, JSON.stringify(chargesOnly.charges)]);
      await c2.query("COMMIT");
    } catch (e) {
      await c2.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c2.release();
    }
  }
  // An empty drizzle SET throws — fall back to a plain read when every field
  // that changed was the raw jsonb column.
  const [row] = Object.keys(updateData).length > 0
    ? await db.update(purchasesTable).set(updateData).where(eq(purchasesTable.id, id)).returning()
    : await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // A date-only edit re-dates the bill — its stock movements must follow, or
  // date-based stock reports keep the goods on the old day. txn_date is the
  // movement's BUSINESS date, not audit information (created_at is untouched),
  // so restating it here is the correction, not a rewrite of the trail. Every
  // row of the bill moves together, so reversal pairs still cancel on any day.
  if (purchaseDate !== undefined) {
    await pool.query(
      `UPDATE stock_ledger SET txn_date = $2::date WHERE doc_type = 'purchase' AND doc_id = $1`,
      [id, purchaseDate],
    );
  }
  const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
  // other_charges / vendor_invoice_date are raw-migration columns drizzle
  // cannot see — read them back explicitly so the response carries what was
  // just stored.
  const { rows: [ocRow] } = await pool.query(
    `SELECT other_charges, vendor_invoice_date::text AS vendor_invoice_date
       FROM purchases WHERE id = $1`, [id]);
  const storedCharges = parseStoredOtherCharges(ocRow?.other_charges);
  res.json({
    ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount), lineItems: row.lineItems ?? [],
    vendorInvoiceDate: ocRow?.vendor_invoice_date ?? null,
    otherCharges: enrichCharges(storedCharges, await chargeLedgerNames([storedCharges])),
    otherChargesTotal: otherChargesTotal(storedCharges),
  });
});

router.delete("/purchases/:id", requireModuleAction("page:/production/purchase", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });

  // Deleting a bill un-does stock, lots and the audit trail. Half a reversal is
  // worse than none, so it all commits together — and the row is read under a
  // FOR UPDATE lock inside the transaction, so two concurrent deletes (or a
  // delete racing an edit) can never reverse the same lines twice.
  const client = await pool.connect();
  let loc: ProdLocation = { type: 'headoffice', id: 1 };
  let locName = "Head Office";
  let vendorIdBefore = 0;
  let totalBefore = 0;
  try {
    await client.query("BEGIN");
    const { rows: [locked] } = await client.query(
      `SELECT line_items, vendor_id, total_amount, location_type, location_id,
              to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date
       FROM purchases WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }

    // Month lock: deleting a bill reverses stock and books in its own month —
    // frozen once that month is locked.
    {
      const ym = ymOfDate(locked.purchase_date);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month)); return;
      }
    }

    // A bill that a payment voucher explicitly settled cannot quietly vanish —
    // the voucher's allocation would point at nothing and its money would fall
    // back into the FIFO pool as if it had never been aimed.
    const { rows: [allocRef] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_bill_allocations WHERE purchase_id = $1`, [id]);
    if (Number(allocRef?.n ?? 0) > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "A payment voucher has settled this bill. Delete that payment voucher first, then delete the bill.",
        code: "BILL_HAS_ALLOCATIONS",
      });
      return;
    }
    // Advance applications die with the bill — the derived contra joins
    // purchases, so removing the rows restores the vendor's advance in full,
    // and releasing the consumption unpins the funding voucher(s) so they
    // become deletable again in this same atomic step.
    await client.query(`DELETE FROM purchase_advance_applications WHERE purchase_id = $1`, [id]);
    await releaseAdvanceConsumption(client, { purchaseId: id });

    // Reverse at the location that bought the goods, never a hardcoded HO.
    loc = { type: locked.location_type ?? 'headoffice', id: Number(locked.location_id ?? 1) };
    locName = await locationLabel(client, loc);
    vendorIdBefore = Number(locked.vendor_id ?? 0);
    totalBefore = Number(locked.total_amount ?? 0);

    // LBAC: a location may only delete its own bills.
    if (!scope.isHeadOffice) {
      const allowed = (loc.type === 'warehouse' && scope.warehouseIds.includes(loc.id))
        || (loc.type === 'outlet' && scope.outletIds.includes(loc.id));
      if (!allowed) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Not found" }); return;
      }
    }

    const lineItems = (locked.line_items ?? []) as Array<{ materialType: string; materialId: number; quantity: number; batchNumber?: string | null }>;
  for (const li of lineItems) {
    if (li.materialType === "material") {
      await client.query(
        `UPDATE materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      await deductMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "material", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    } else if (li.materialType === "raw_material") {
      await client.query(
        `UPDATE raw_materials SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      await deductMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), { floor: true });
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "raw_material", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    } else if (li.materialType === "item") {
      await client.query(
        `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, li.quantity],
      );
      // Reverse the stock-entry credit and the inbound batch (floored)
      await client.query(
        `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
         WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
        [li.quantity, li.materialId, loc.type, loc.id]
      );
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "item", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${id}`, quantity: Number(li.quantity),
      });
    }
  }
    // Deleting a bill removes it from history: the reversal is dated on the
    // bill's own business date so date-based stock reports on any day read as
    // if the bill never existed. This bill's emptied lots go with it.
    await client.query(
      `DELETE FROM stock_batches
        WHERE source = 'purchase' AND source_id = $1
          AND branch_type = $2 AND branch_id = $3
          AND quantity::numeric <= 0.0005`,
      [id, loc.type, loc.id],
    );
    await writeStockLedger(client, lineItems.map(li => ({
      txnType: 'purchase_reversal', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: -Number(li.quantity), unitCost: 0,
      docType: 'purchase', docId: id,
      txnDate: String(locked.purchase_date ?? '') || null,
      notes: 'Purchase deleted — stock reversed',
    })));
    const del = await client.query(`DELETE FROM purchases WHERE id = $1 RETURNING id`, [id]);
    if (del.rowCount === 0) {
      // Belt and braces: the FOR UPDATE above should make this impossible, so if
      // it ever happens the reversal must not be committed against a bill that
      // someone else already removed.
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Not found" }); return;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "DELETE", module: "purchases", entityType: "purchase", entityId: id,
    description: `Purchase Bill #${id} deleted at ${locName} (stock reversed)`,
    metadata: { before: { vendorId: vendorIdBefore, totalAmount: totalBefore, locationType: loc.type, locationId: loc.id } },
  }).catch(() => {});
  res.status(204).send();
});

// Asset purchases moved to the standalone Assets module (routes/assets.ts):
// same posting semantics (Dr STD-FIXED-ASSET / Cr Cash-Bank-Vendor, source
// 'fixed_asset', zero stock movement), extended with the register fields.
export default router;

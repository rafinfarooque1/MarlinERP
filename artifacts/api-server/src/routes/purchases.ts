import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { db, pool, purchasesTable, vendorsTable, materialsTable, rawMaterialsTable, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreatePurchaseBody, GetPurchaseParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";
import { creditBatch, debitBatchByNumber, updateAvgCostOnInbound, updateAvgCostOnReversal } from "../lib/batches";
import { productBatchIdentity, blockedByInactiveProducts, INACTIVE_PRODUCT_CODE, isProductKind } from "../lib/productIdentity";
import { writeStockLedger } from "../lib/stockLedger";
import { deductMaterialAt, creditMaterialAt, isMaterialKind } from "../lib/materialStock";
import { resolveActingLocation, locationLabel, type ProdLocation } from "../lib/productionCosting";
import { getUserDataScope, scopeLocationTypeWhere } from "../lib/dataScope";
import { isIsoDate } from "../lib/dateInput";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { ensureFixedAssetLedger } from "../migrations/fixedAssets";
import { PURCHASE_BATCH_SEQUENCE } from "../migrations/purchaseBills";
import {
  calcPurchaseBill, asPriceMode, asTaxType,
  type PriceMode, type TaxType,
} from "@workspace/purchase-pricing";

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
const ledgerBranchId = (loc: ProdLocation, materialType: string) =>
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
 * Whether this bill's stock can still be taken back out truthfully.
 *
 * An edit reverses everything the bill added and re-applies the new lines. That
 * reversal only tells the truth while the goods are still on the shelf. Once
 * some have been issued to production, sold or transferred, subtracting the
 * original quantity would drive the balance below zero — and every reversal
 * here floors at zero, so the shortfall is silently discarded and the
 * re-applied line puts the full quantity back. Buy 10, issue 8, re-save the
 * bill unchanged, and the location is holding 10 again instead of 2.
 *
 * Rather than invent that stock, refuse the edit and say what to do instead.
 * Rows are locked as they are checked, so nothing can consume the lot between
 * this check and the reversal that follows it in the same transaction.
 */
async function reversalBlocked(
  c: Queryable, oldLines: any[], loc: { type: string; id: number },
  purchaseId: number, maps: NameMaps,
): Promise<string | null> {
  // Deterministic order, so two concurrent edits touching the same products
  // queue up instead of deadlocking against each other.
  const ordered = [...oldLines].sort((a, b) =>
    String(a?.materialType).localeCompare(String(b?.materialType))
    || Number(a?.materialId) - Number(b?.materialId));

  for (const li of ordered) {
    const kind = String(li?.materialType ?? "item");
    const qty = Number(li?.quantity ?? 0);
    if (!(qty > 0)) continue;
    const name = maps[kind as keyof NameMaps]?.get(Number(li?.materialId))?.name
      ?? `${KIND_LABEL[kind] ?? "Item"} #${li?.materialId}`;
    const batchNumber = String(li?.batchNumber || `PUR-${purchaseId}`);

    const { rows: [lot] } = await c.query(
      `SELECT quantity::numeric AS q FROM stock_batches
        WHERE item_id = $1 AND material_type = $2 AND branch_type = $3
          AND branch_id = $4 AND batch_number = $5
        FOR UPDATE`,
      [Number(li?.materialId), kind, loc.type, loc.id, batchNumber],
    );
    // No lot at all means the stock was written before lots were tracked, so
    // there is nothing to compare against — fall through to the location check.
    if (lot && Number(lot.q) + 1e-6 < qty) {
      return `${name}: ${fmtQty(Number(lot.q))} of the ${fmtQty(qty)} received on batch ${batchNumber} is left — the rest has already been used, sold or transferred. Reverse those movements first, or record a purchase return instead of editing this bill.`;
    }

    // Summed in JS rather than by SUM(): Postgres refuses FOR UPDATE on an
    // aggregate, and the lock is the point — it holds the balance still until
    // the reversal below has run.
    const { rows: locRows } = await c.query(
      `SELECT quantity::numeric AS q FROM stock_entries
        WHERE item_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4
        FOR UPDATE`,
      [Number(li?.materialId), kind, loc.type, loc.id],
    );
    const onLoc = locRows.reduce((sum: number, r: any) => sum + Number(r.q ?? 0), 0);
    if (onLoc + 1e-6 < qty) {
      return `${name}: this location is holding ${fmtQty(onLoc)}, less than the ${fmtQty(qty)} on the bill — the stock has already moved on. Reverse those movements first, or record a purchase return instead of editing this bill.`;
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
async function allocateBatchNumbers(q: Queryable, purchaseDate: string, count: number): Promise<string[]> {
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
async function resolveSupplyTaxType(
  vendorId: number, loc: ProdLocation,
): Promise<{ taxType: TaxType | null; why: string }> {
  const { rows: [v] } = await pool.query(`SELECT state, gst_number FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) return { taxType: null, why: "vendor not found" };

  let locState: string | null = null;
  let locGstin: string | null = null;
  if (loc.type === "warehouse") {
    const { rows: [w] } = await pool.query(`SELECT state, gst_number FROM warehouses WHERE id = $1`, [loc.id]);
    locState = w?.state ?? null; locGstin = w?.gst_number ?? null;
  } else if (loc.type === "outlet") {
    const { rows: [o] } = await pool.query(`SELECT state, gstin FROM outlets WHERE id = $1`, [loc.id]);
    locState = o?.state ?? null; locGstin = o?.gstin ?? null;
  }
  if (!normState(locState) && !gstinStateCode(locGstin)) {
    const { rows: [c] } = await pool.query(`SELECT state, gst_number FROM company_settings LIMIT 1`);
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
function priceBill(
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
type ProductMaster = { name: string; hsnCode: string; taxRate: number; unit: string };
type NameMaps = {
  material: Map<number, ProductMaster>;
  raw_material: Map<number, ProductMaster>;
  item: Map<number, ProductMaster>;
};

async function buildNameMaps(): Promise<NameMaps> {
  // Raw SQL rather than drizzle: hsn_code and tax_rate are startup-migration
  // columns on materials/raw_materials and so are invisible to the schema.
  const load = async (table: "materials" | "raw_materials" | "items") => {
    const { rows } = await pool.query(
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
    SELECT p.*, p.purchase_date::text AS purchase_date_str, v.name AS vendor_name
    ${baseFrom} ${where}
    ORDER BY p.id DESC${limit ? ` LIMIT ${limit} OFFSET ${(page - 1) * limit}` : ''}
  `, params);
  const nameMaps = await buildNameMaps();
  const locNames = await locationNameMap();
  const mapped = rows.map((r: any) => ({
    id: r.id,
    vendorId: r.vendor_id,
    purchaseDate: r.purchase_date_str,
    invoiceNumber: r.invoice_number,
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
    lineItems: enrichLines(r.line_items, nameMaps),
  }));

  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

router.post("/purchases", requireModuleAction("page:/production/purchase", "add"), async (req, res): Promise<void> => {
  const parsed = CreatePurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // purchase_date is a real DATE column: reject an impossible date here rather
  // than letting the driver raise 22007 halfway through the transaction.
  if (!isIsoDate(parsed.data.purchaseDate)) {
    res.status(400).json({ error: "Purchase date must be a real calendar date (YYYY-MM-DD)" }); return;
  }

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

  // Everything below moves stock, lots, weighted-average costs and the stock
  // ledger. A bill that half-applied would leave the books unreconcilable, so
  // the whole thing runs in ONE transaction on ONE client — including the
  // ledger write, which must not be fire-and-forget.
  const client = await pool.connect();
  let newId = 0;
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
                              price_mode)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [parsed.data.vendorId, parsed.data.purchaseDate, parsed.data.invoiceNumber ?? null,
       JSON.stringify(enriched), String(totalAmount), parsed.data.notes ?? null,
       taxTotal, discountTotal, roundOff, loc.type, loc.id, priceMode],
    );
    newId = Number(ins.id);

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
      batchNumbers: (enriched as any[]).map(l => l.batchNumber),
    } },
  }).catch(() => {});

  res.status(201).json({
    ...row, vendorName: vendor?.name ?? "", totalAmount,
    subtotal, taxableTotal, taxTotal, discountTotal, roundOff, priceMode,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    ...(warnings.length ? { warnings } : {}),
    lineItems: enrichLines(enriched, maps),
  });
});

router.get("/purchases/:id", requireModuleView("page:/production/purchase"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { rows: [locRow] } = await pool.query(
    `SELECT location_type, location_id, price_mode FROM purchases WHERE id = $1`, [id]);
  const loc: ProdLocation = { type: locRow?.location_type ?? 'headoffice', id: Number(locRow?.location_id ?? 1) };

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
    taxTotal: Number((row as any).taxTotal ?? 0),
    discountTotal: Number((row as any).discountTotal ?? 0),
    roundOff: Number((row as any).roundOff ?? 0),
    priceMode: asPriceMode(locRow?.price_mode),
    locationType: loc.type, locationId: loc.id,
    locationName: await locationLabel(pool, loc),
    lineItems: enrichLines(row.lineItems, await buildNameMaps()),
  });
});

router.patch("/purchases/:id", requireModuleAction("page:/production/purchase", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [current] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, id)).limit(1);
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const { purchaseDate, invoiceNumber, notes, vendorId, lineItems } = req.body as {
    purchaseDate?: string; invoiceNumber?: string; notes?: string;
    vendorId?: number; lineItems?: any[];
  };

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
    const { rows: [modeRow] } = await pool.query(`SELECT price_mode FROM purchases WHERE id = $1`, [id]);
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

      // ── Full edit: reverse old stock, then apply the new lines ──
      const oldLines = (locked.line_items ?? []) as Array<{
        materialType: string; materialId: number; quantity: number;
        batchNumber?: string | null; costPerUnit?: number; unitCost?: number;
      }>;

      // Refuse before writing anything if the goods are no longer on hand: the
      // reversal below floors at zero, so it cannot express "8 of these are
      // already gone" and would quietly re-create them.
      const stuck = await reversalBlocked(client, oldLines, loc, id, maps);
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

    // 1. Reverse stock from the old lines (mirror of the delete handler).
    //    The average cost is unwound with the quantity — leaving it behind
    //    would make this bill's own cost the baseline for its replacement and
    //    drift the valuation a little further on every save.
    for (const li of oldLines) {
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

    // A fully-reversed line leaves its lot at zero. Delete this bill's own
    // emptied lots so (a) a removed line leaves no orphan zero-quantity batch
    // behind, and (b) a re-applied line re-INSERTS a fresh lot — creditBatch
    // keeps an existing lot's mfg/expiry via COALESCE, so without this a
    // date correction on an existing batch number would never take effect.
    // Scoped to this bill's own purchase lots at the old location only.
    await client.query(
      `DELETE FROM stock_batches
        WHERE source = 'purchase' AND source_id = $1
          AND branch_type = $2 AND branch_id = $3
          AND quantity::numeric <= 0.0005`,
      [id, loc.type, loc.id],
    );

    // ── Stock ledger (purchase edit reversal) ────────────────────────────────
    // Dated on the bill's OLD business date: the reversal takes the old lines
    // out of history exactly where they entered it, so date-based stock
    // reports stay continuous (closing of D = opening of D+1).
    await writeStockLedger(client, (oldLines as any[]).map(li => ({
      txnType: 'purchase_reversal', materialType: li.materialType ?? 'item',
      refId: li.materialId, itemName: '', unit: '',
      branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? 'item'), branchName: locName,
      qtyChange: -Number(li.quantity), unitCost: 0,
      docType: 'purchase', docId: id,
      txnDate: String(locked.purchase_date ?? '') || null,
      notes: 'Purchase edit — old lines reversed',
    })));

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

    // 3. Apply stock for the new lines (mirror of the create handler), at the
    //    EFFECTIVE location — the new one when the bill was moved.
    //    Valued at costPerUnit: net of discount, net of recoverable input GST.
    for (const li of enriched) {
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
    await writeStockLedger(client, (enriched as any[]).map(li => {
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

    // 4. Persist the updated record (location included: after a move the
    //    vendor payable and input GST re-derive against the new location's
    //    purchase ledger from this row).
      await client.query(
        `UPDATE purchases SET vendor_id = $2, purchase_date = $3, invoice_number = $4, notes = $5,
                              line_items = $6::jsonb, total_amount = $7,
                              tax_total = $8, discount_total = $9, round_off = $10,
                              price_mode = $11, location_type = $12, location_id = $13
         WHERE id = $1`,
        [id, vendorId ?? locked.vendor_id, purchaseDate ?? locked.purchase_date,
         invoiceNumber !== undefined ? invoiceNumber : locked.invoice_number,
         notes !== undefined ? notes : locked.notes,
         JSON.stringify(enriched), String(totalAmount), taxTotal, discountTotal, roundOff,
         priceMode, newLoc.type, newLoc.id],
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
      metadata: { before: { totalAmount: beforeTotal, locationType: loc.type, locationId: loc.id }, after: { totalAmount, lineCount: enriched.length, locationType: newLoc.type, locationId: newLoc.id, priceMode, taxableTotal, taxTotal } },
    }).catch(() => {});

    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, row.vendorId)).limit(1);
    res.json({
      ...row, vendorName: vendor?.name ?? "",
      totalAmount, subtotal, taxableTotal, taxTotal, discountTotal, roundOff, priceMode,
      locationType: newLoc.type, locationId: newLoc.id, locationName: newLocName,
      ...(warnings.length ? { warnings } : {}),
      lineItems: enrichLines(enriched, maps),
    });
    return;
  }

  // ── Metadata-only edit (date / invoice ref / notes, no line changes) ──
  const updateData: Record<string, unknown> = {};
  if (purchaseDate !== undefined) updateData.purchaseDate = purchaseDate;
  if (invoiceNumber !== undefined) updateData.invoiceNumber = invoiceNumber;
  if (notes !== undefined) updateData.notes = notes;
  if (Object.keys(updateData).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const [row] = await db.update(purchasesTable).set(updateData).where(eq(purchasesTable.id, id)).returning();
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
  res.json({ ...row, vendorName: vendor?.name ?? "", totalAmount: Number(row.totalAmount), lineItems: row.lineItems ?? [] });
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

// ── Asset purchases (fixed-asset acquisition, spec §7) ──────────────────────
// An asset purchase is capital expenditure, NOT a P&L purchase and NOT saleable
// stock. It never touches materials/items/stock_entries; it records the asset,
// quantity, per-unit acquisition cost and location, and posts a journal voucher
// Dr Fixed Assets / Cr the vendor's payable ledger — the same double-entry
// stream the rest of the books derive from. No depreciation.
const round2asset = (n: number) => Math.round(n * 100) / 100;

router.get("/asset-purchases", requireModuleView("page:/production/purchase"), async (req, res): Promise<void> => {
  // LBAC: a location sees its own acquisitions; Head Office sees every location's.
  const scope = await getUserDataScope((req as any).employee ?? { branchType: 'headoffice', branchId: 0 });
  const params: unknown[] = [];
  const scopeWhere = scopeLocationTypeWhere(scope, params, 'ap');
  if (scopeWhere === 'FALSE') { res.json([]); return; }
  const where = scopeWhere === 'TRUE' ? '' : `WHERE ${scopeWhere}`;

  const { rows } = await pool.query(
    `SELECT ap.*, ap.purchase_date::text AS purchase_date_str,
            a.name AS asset_name, a.unit AS asset_unit, v.name AS vendor_name
       FROM asset_purchases ap
       JOIN assets a ON a.id = ap.asset_id
       LEFT JOIN vendors v ON v.id = ap.vendor_id
       ${where}
      ORDER BY ap.id DESC`, params,
  );
  const locNames = await locationNameMap();
  res.json(rows.map((r: any) => ({
    id: r.id,
    assetId: r.asset_id,
    assetName: r.asset_name,
    assetUnit: r.asset_unit,
    quantity: Number(r.quantity),
    acquisitionCost: Number(r.acquisition_cost),
    totalCost: round2asset(Number(r.quantity) * Number(r.acquisition_cost)),
    vendorId: r.vendor_id,
    vendorName: r.vendor_name ?? "",
    purchaseDate: r.purchase_date_str,
    notes: r.notes,
    locationType: r.location_type ?? 'headoffice',
    locationId: Number(r.location_id ?? 1),
    locationName: locNames.get(`${r.location_type ?? 'headoffice'}:${Number(r.location_id ?? 1)}`) ?? 'Head Office',
    journalVoucherId: r.journal_voucher_id,
    createdAt: r.created_at,
  })));
});

router.post("/asset-purchases", requireModuleAction("page:/production/purchase", "add"), async (req, res): Promise<void> => {
  const assetId = Number(req.body?.assetId);
  const quantity = Number(req.body?.quantity);
  const acquisitionCost = Number(req.body?.acquisitionCost);
  const vendorId = req.body?.vendorId != null && req.body?.vendorId !== "" ? Number(req.body.vendorId) : null;
  const purchaseDate = String(req.body?.purchaseDate ?? "").slice(0, 10);
  const notes = req.body?.notes ? String(req.body.notes).trim() || null : null;

  if (!Number.isFinite(assetId) || assetId <= 0) { res.status(400).json({ error: "assetId is required" }); return; }
  if (!Number.isFinite(quantity) || quantity <= 0) { res.status(400).json({ error: "quantity must be greater than zero" }); return; }
  if (!Number.isFinite(acquisitionCost) || acquisitionCost < 0) { res.status(400).json({ error: "acquisitionCost must be a non-negative number" }); return; }
  // purchase_date lands in a real DATE column — calendar-checked, not just shape.
  if (!isIsoDate(purchaseDate)) { res.status(400).json({ error: "purchaseDate must be a real calendar date (YYYY-MM-DD)" }); return; }

  const { rows: [asset] } = await pool.query(`SELECT id, name, status FROM assets WHERE id = $1 LIMIT 1`, [assetId]);
  if (!asset) { res.status(400).json({ error: "Selected asset does not exist" }); return; }
  if ((asset.status ?? 'active') !== 'active') { res.status(400).json({ error: "This asset is inactive and cannot be purchased" }); return; }

  let vendorName = "";
  if (vendorId != null) {
    const { rows: [vendor] } = await pool.query(`SELECT id, name FROM vendors WHERE id = $1 LIMIT 1`, [vendorId]);
    if (!vendor) { res.status(400).json({ error: "Selected vendor does not exist" }); return; }
    vendorName = vendor.name;
  }

  // Head Office may record for any location; every other caller only for itself.
  const resolved = await resolveActingLocation(pool, {
    employee: (req as any).employee,
    requested: { type: req.body?.locationType, id: req.body?.locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const loc = resolved.loc;
  const locName = await locationLabel(pool, loc);
  const totalCost = round2asset(quantity * acquisitionCost);
  const createdBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  let newId = 0;
  let voucherNumber: string | null = null;
  try {
    await client.query("BEGIN");

    // ── Book the acquisition to the ledgers ────────────────────────────────
    // Dr Fixed Assets (capital, on the Balance Sheet — never Purchases/P&L and
    // never saleable stock). Cr the vendor's payable ledger where there is a
    // vendor (consistent with how the purchase flow credits the vendor), else
    // Cr Cash. Only booked when the value is non-zero.
    if (totalCost > 0.004) {
      const { rows: [fa] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-FIXED-ASSET' LIMIT 1`);
      const fixedAssetLedgerId = fa?.id ?? await ensureFixedAssetLedger(pool);
      if (!fixedAssetLedgerId) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Fixed Asset ledger is not available yet. Try again after the chart of accounts is initialised." });
        return;
      }

      // Funding side: vendor payable ledger, else Cash.
      let creditLedgerId: number | null = null;
      if (vendorId != null) {
        // A named vendor must never fall through to Cash: that would book an
        // unpaid acquisition as cash-paid, understate the payable and put this
        // route's figures at odds with the vendor's ledger balance.
        const { rows: [vl] } = await client.query(
          `SELECT id, is_active, is_group FROM account_ledgers WHERE code = $1 LIMIT 1`,
          [`VEND-${vendorId}`]);
        if (!vl || vl.is_group === true || vl.is_active === false) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: `Ledger account VEND-${vendorId} is missing or inactive. Re-save the vendor to create its payable ledger, then record this purchase.`,
          });
          return;
        }
        creditLedgerId = Number(vl.id);
      }
      if (creditLedgerId == null) {
        const { rows: [cash] } = await client.query(
          `SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`);
        creditLedgerId = cash?.id ?? null;
      }
      if (!creditLedgerId) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "No funding ledger (vendor payable or Cash) is available to credit." });
        return;
      }

      voucherNumber = await nextVoucherNumber(client, "journal", purchaseDate);
      const narration = `Asset purchase — ${asset.name} × ${quantity} @ ₹${acquisitionCost.toFixed(2)} at ${locName}`
        + (vendorName ? ` (Vendor: ${vendorName})` : "");
      const { rows: [voucher] } = await client.query(
        `INSERT INTO journal_vouchers
           (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, total_amount, created_by,
            origin, source_module)
         VALUES ('journal', $1, $2, $3, $4, $5, $6, 'system', 'fixed_asset') RETURNING id`,
        [voucherNumber, purchaseDate, narration,
         vendorId != null ? creditLedgerId : null, totalCost, createdBy],
      );
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
        [voucher.id, fixedAssetLedgerId, totalCost, creditLedgerId],
      );

      const { rows: [ins] } = await client.query(
        `INSERT INTO asset_purchases
           (asset_id, quantity, acquisition_cost, location_type, location_id, vendor_id,
            purchase_date, notes, journal_voucher_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [assetId, quantity, acquisitionCost, loc.type, loc.id, vendorId,
         purchaseDate, notes, voucher.id, createdBy],
      );
      newId = Number(ins.id);
    } else {
      // Zero-value acquisition (e.g. donated asset): record it, no posting.
      const { rows: [ins] } = await client.query(
        `INSERT INTO asset_purchases
           (asset_id, quantity, acquisition_cost, location_type, location_id, vendor_id,
            purchase_date, notes, journal_voucher_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9) RETURNING id`,
        [assetId, quantity, acquisitionCost, loc.type, loc.id, vendorId,
         purchaseDate, notes, createdBy],
      );
      newId = Number(ins.id);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "CREATE", module: "purchases", entityType: "asset_purchase", entityId: newId,
    description: `Asset purchased — ${asset.name} × ${quantity} @ ₹${acquisitionCost.toFixed(2)} at ${locName} — ₹${totalCost.toFixed(2)}`
      + (vendorName ? ` (Vendor: ${vendorName})` : ""),
    metadata: { after: { assetId, assetName: asset.name, quantity, acquisitionCost, totalCost, vendorId, vendorName, locationType: loc.type, locationId: loc.id, voucherNumber } },
  }).catch(() => {});

  res.status(201).json({
    id: newId,
    assetId, assetName: asset.name,
    quantity, acquisitionCost, totalCost,
    vendorId, vendorName,
    purchaseDate, notes,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    voucherNumber,
  });
});

export default router;

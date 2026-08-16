import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router } from "express";
import { requireModuleAction, requireModuleView, hasModuleAction } from "../middleware/permissions";
import { db, salesTable, outletsTable, customersTable, stockEntriesTable, itemsTable, itemPricesTable, companySettingsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { CreateSaleBody, GetSaleParams, SetItemPriceBody, ListItemPricesQueryParams } from "@workspace/api-zod";
import { logActivity } from "../lib/audit";
import { createInvoiceShareToken } from "../lib/shareToken";
import { assembleInvoiceData, renderInvoicePdf } from "../services/invoicePdf";
import { pool } from "@workspace/db";
import { consumeBatches, restoreBatches } from "../lib/batches";
import { writeStockLedger, batchResolveMeta, toTxnDate } from "../lib/stockLedger";
import { buildBranchMaps } from "./stock";
import {
  outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE,
  getPosEntryFlags, DISCOUNTS_DISABLED_MESSAGE, DISCOUNTS_DISABLED_CODE,
  COUPONS_DISABLED_MESSAGE, COUPONS_DISABLED_CODE,
} from "../lib/featureFlags";
import { getUserDataScope, isLocationInScope, scopeSalesWhere } from "../lib/dataScope";
import { getLocationFilter } from "../lib/requestLocation";
import { blockedByInactiveProducts, INACTIVE_PRODUCT_CODE } from "../lib/productIdentity";
import { CREATE_SALE_PAYMENT_MODES, isAllowedNewSaleMode, isSettledAtSale, clearsThroughBank, resolveEditedSaleMode } from "../lib/paymentModes";
import { availabilityAt, insufficientStockMessage } from "../lib/reservations";
import { isIsoDate } from "../lib/dateInput";
import { respondIfMonthLocked, isMonthLocked, ymOfDate, monthLockedBody } from "../lib/periodLock";
import {
  loadPaymentPosition, loadPaymentPositions, computePaymentPosition,
  loadInvoicePaymentSettings, buildUpiRequest,
} from "../lib/salePaymentPosition";
import { advanceAvailable, takeAdvanceLock, attributeAdvanceConsumption, releaseAdvanceConsumption } from "../lib/advanceLedgers";
import { allocateSalesInvoiceNumber, salesCounterScope } from "../lib/voucherNumber";
import { resolveLocationGst, isInterStateSupply } from "../lib/gstTransfer";
import { validateOtherCharges, validateSaleOtherCharges, parseStoredOtherCharges, otherChargesTotal, type OtherCharge } from "../lib/otherCharges";
import { resolveReceiveIntoAccount, postSaleCollectionReceipt, type ReceiveIntoAccount } from "../lib/saleCollection";

const router = Router();

/**
 * `stock_entries` is polymorphic: it holds items, raw materials and packing
 * materials, and those three ID spaces overlap from 1. Every item-stock query
 * MUST carry this filter or a sale of item #1 can read — and deduct — the row
 * belonging to material #1 at the same location.
 *
 * `material_type` is added by a startup migration, so Drizzle's schema does not
 * know about it; it has to be expressed as raw SQL.
 */
const ITEM_ROWS_ONLY = sql`stock_entries.material_type = 'item'`;

/**
 * Who may sell past a customer's credit limit.
 *
 * These are the receivables pages — the people who chase the money are the
 * people who get to decide it is safe to extend more of it. Deliberately NOT
 * the Point of Sale page: edit rights there belong to every cashier, and
 * credit control that any cashier can wave through is not credit control.
 */
const CREDIT_OVERRIDE_PAGES = ["page:/outstanding", "page:/returns"];
const CREDIT_OVERRIDE_DENIED_MESSAGE =
  'You are not authorized to override the credit limit. Ask a manager with edit access to the Outstanding page.';

// ── Tax computation helpers ───────────────────────────────────────────────────

export function computeInvoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
}

// Per-line price interpretation, mirroring the purchases priceMode convention:
//   'inclusive' (default — the treatment of every historical line): the entered
//     price is the FINAL GST-inclusive price; tax is EXTRACTED from it,
//     taxable = gross / (1 + rate/100). Never gross − rate% — that is wrong.
//   'exclusive': the entered price is the TAXABLE BASE; tax is ADDED ON TOP.
function computeLineTax(
  grossAmount: number,   // qty × unitPrice − line discount
  taxRate: number,
  isInterState: boolean,
  priceMode: 'inclusive' | 'exclusive' = 'inclusive',
): { taxRate: number; taxType: string; cgst: number; sgst: number; igst: number; taxAmount: number; taxableAmount: number } {
  let taxableAmount: number;
  let taxAmount: number;
  if (priceMode === 'exclusive') {
    taxableAmount = Math.round(grossAmount * 100) / 100;
    taxAmount = Math.round(taxableAmount * taxRate / 100 * 100) / 100;
  } else {
    taxableAmount = taxRate > 0
      ? Math.round(grossAmount / (1 + taxRate / 100) * 100) / 100
      : grossAmount;
    taxAmount = Math.round((grossAmount - taxableAmount) * 100) / 100;
  }
  if (isInterState) {
    return { taxRate, taxType: 'igst', cgst: 0, sgst: 0, igst: taxAmount, taxAmount, taxableAmount };
  }
  // Odd-paise tax: rounding both halves independently would make
  // cgst + sgst ≠ taxAmount (e.g. 0.05 → 0.03 + 0.03), so accounting heads
  // and GST reports would disagree with the stored line tax. Round one half
  // and give the exact remainder to the other.
  const half = Math.round(taxAmount / 2 * 100) / 100;
  const rest = Math.round((taxAmount - half) * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', cgst: half, sgst: rest, igst: 0, taxAmount, taxableAmount };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Render a stored sale row into the same shape the create endpoint returns,
// flagged `idempotentReplay`. Used when a create is replayed with a
// clientRequestId that already produced a bill — the caller (a double-click or
// a retry) must see the ORIGINAL invoice, never a second one. The position is
// re-read so the paid/balance figures match the live sale.
async function buildSaleReplayResponse(
  pgPool: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  row: any,
): Promise<any> {
  const totalAmount = Number(row.total_amount);
  const { loadPaymentPosition, computePaymentPosition } = await import("../lib/salePaymentPosition");
  const position = await loadPaymentPosition(pgPool as any, Number(row.id))
    ?? computePaymentPosition({ totalAmount, amountReceived: Number(row.amount_paid ?? 0), cancelledAt: row.cancelled_at });
  const customerName = row.customer_id
    ? (await db.select().from(customersTable).where(eq(customersTable.id, Number(row.customer_id))).limit(1))[0]?.name ?? null
    : null;
  const charges = parseStoredOtherCharges(row.other_charges);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    outletId: row.outlet_id,
    locationType: row.location_type,
    locationId: row.location_id,
    customerName,
    saleDate: row.sale_date,
    lineItems: row.line_items ?? [],
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    discountTotal: Number(row.discount_total),
    billDiscount: Number(row.bill_discount ?? 0),
    totalAmount,
    paymentMode: row.payment_mode,
    couponCode: row.coupon_code,
    otherCharges: charges,
    otherChargesTotal: otherChargesTotal(charges),
    createdAt: row.created_at,
    quotationId: row.quotation_id ?? null,
    quotationNumber: row.quotation_number ?? null,
    paymentStatus: position.status,
    amountPaid: position.amountReceived,
    amountReceived: position.amountReceived,
    creditAdjustments: position.creditAdjustments,
    amountDue: position.amountDue,
    balanceDue: position.outstanding,
    isCancelled: position.isCancelled,
    idempotentReplay: true,
  };
}

// ── Discount model ────────────────────────────────────────────────────────────
// TWO independent discount concepts, never mixed:
//   1. ITEM discount — `unitDiscount` ₹ off EVERY UNIT's MRP
//      (effective price = unitPrice − unitDiscount, then × qty).
//      Historical lines instead carry a line-TOTAL `discount` typed by the
//      cashier; lines without `unitDiscount` keep that meaning forever.
//   2. BILL discount — one pre-tax amount for the whole invoice, allocated
//      paise-exactly across lines in proportion to each line's
//      post-item-discount value, so each line's taxable value and GST are
//      computed from its share. (Distinct from the post-tax coupon
//      `discountTotal`, which stays a flat deduction off the grand total.)
// Every stored line keeps `discount` = itemDiscount + billDiscountShare (the
// TOTAL pre-tax ₹ off that line), because accounting, GST reports and the PDF
// all recompute gross as qty × unitPrice − discount. The explicit
// `unitDiscount` / `billDiscountShare` fields preserve the decomposition.

// Largest-remainder allocation in integer paise: shares sum EXACTLY to the
// bill discount, and no line's share exceeds its basis.
function allocateBillDiscount(bases: number[], billDiscount: number): number[] {
  const totalPaise = Math.round(billDiscount * 100);
  const basePaise = bases.map(b => Math.max(0, Math.round(b * 100)));
  const weightSum = basePaise.reduce((s, b) => s + b, 0);
  if (totalPaise <= 0 || weightSum <= 0) return bases.map(() => 0);
  const raw = basePaise.map(b => (totalPaise * b) / weightSum);
  const floors = raw.map(Math.floor);
  let remainder = totalPaise - floors.reduce((s, f) => s + f, 0);
  // Hand the leftover paise to the largest fractional parts (ties → earlier
  // line), never pushing a share past its own basis.
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    if (floors[i] < basePaise[i]) { floors[i] += 1; remainder -= 1; }
  }
  return floors.map(f => f / 100);
}

export type BuiltLines =
  | { ok: true; lineItems: any[]; billDiscount: number }
  | { ok: false; error: string };

// Single canonical computation for BOTH create and edit — the invoice preview,
// the stored lines, the accounting receipt and the GST reports must never see
// different math for the same sale. Exported so the Quotations module quotes
// with EXACTLY this arithmetic — a quote and the invoice it becomes must agree
// paise-for-paise.
export function buildSaleLines(
  rawLineItems: Array<{ itemId: number; quantity: number; unitPrice: number; discount?: number; unitDiscount?: number | null; priceMode?: string }>,
  itemTaxMap: Map<number, { taxRate: number; name: string; hsnCode: string | null; unit: string | null }>,
  isInterState: boolean,
  rawBillDiscount: unknown,
): BuiltLines {
  // Pass 1 — item-level discount and each line's pre-bill-discount basis.
  const prepared: Array<{ li: any; priceMode: 'inclusive' | 'exclusive'; itemDiscount: number; unitDiscount: number | null; basis: number }> = [];
  for (const li of rawLineItems) {
    const priceMode: 'inclusive' | 'exclusive' = (li as any).priceMode === 'exclusive' ? 'exclusive' : 'inclusive';
    const unitPrice = Number(li.unitPrice ?? 0);
    let itemDiscount: number;
    let unitDiscount: number | null = null;
    if (li.unitDiscount !== undefined && li.unitDiscount !== null) {
      // Per-unit path: ₹ off EVERY unit, capped by the unit price itself.
      const ud = Number(li.unitDiscount);
      if (!Number.isFinite(ud) || ud < 0) {
        return { ok: false, error: `Discount per unit must be a non-negative amount (item ${li.itemId})` };
      }
      if (ud > unitPrice + 0.004) {
        return { ok: false, error: `Discount per unit ₹${ud.toFixed(2)} cannot exceed the unit price ₹${unitPrice.toFixed(2)} (item ${li.itemId})` };
      }
      unitDiscount = ud;
      itemDiscount = round2(ud * li.quantity);
    } else {
      // Legacy path (historical invoices, old clients): `discount` is a
      // line-TOTAL amount deducted once. Never reinterpret it per-unit.
      const d = Number(li.discount ?? 0);
      const lineAmount = li.quantity * unitPrice;
      if (!Number.isFinite(d) || d < 0) {
        return { ok: false, error: `Line discount must be a non-negative amount (item ${li.itemId})` };
      }
      if (d > lineAmount + 0.004) {
        return { ok: false, error: `Line discount ₹${d.toFixed(2)} cannot exceed the line amount ₹${lineAmount.toFixed(2)} (item ${li.itemId})` };
      }
      itemDiscount = d;
    }
    prepared.push({ li, priceMode, itemDiscount, unitDiscount, basis: Math.max(0, round2(li.quantity * unitPrice - itemDiscount)) });
  }

  // Pass 2 — bill discount, validated against what the goods are worth AFTER
  // item discounts, then allocated paise-exactly.
  const billDiscount = round2(Number(rawBillDiscount ?? 0));
  if (!Number.isFinite(billDiscount) || billDiscount < 0) {
    return { ok: false, error: 'Bill discount must be a non-negative amount' };
  }
  const basisSum = round2(prepared.reduce((s, p) => s + p.basis, 0));
  if (billDiscount > basisSum + 0.004) {
    return { ok: false, error: `Bill discount ₹${billDiscount.toFixed(2)} cannot exceed the item value after item discounts ₹${basisSum.toFixed(2)}` };
  }
  const shares = allocateBillDiscount(prepared.map(p => p.basis), billDiscount);

  // Pass 3 — tax from each line's post-discount consideration, per its own
  // rate and inclusive/exclusive treatment.
  const lineItems = prepared.map((p, i) => {
    const itemInfo = itemTaxMap.get(p.li.itemId);
    const taxRate = itemInfo?.taxRate ?? 0;
    const adjusted = round2(p.basis - shares[i]);
    const taxInfo = computeLineTax(adjusted, taxRate, isInterState, p.priceMode);
    return {
      itemId: p.li.itemId,
      itemName: itemInfo?.name ?? '',
      hsnCode: itemInfo?.hsnCode ?? '',
      unit: itemInfo?.unit ?? '',
      quantity: p.li.quantity,
      unitPrice: p.li.unitPrice,
      discount: round2(p.itemDiscount + shares[i]),
      ...(p.unitDiscount !== null ? { unitDiscount: p.unitDiscount } : {}),
      billDiscountShare: shares[i],
      priceMode: p.priceMode,
      lineSubtotal: taxInfo.taxableAmount,
      ...taxInfo,
    };
  });
  return { ok: true, lineItems, billDiscount };
}

// ── MRP floor ─────────────────────────────────────────────────────────────────
// A sale line may be priced AT or ABOVE the item's master MRP, never below —
// price reductions must go through the discount fields so MRP, selling price
// and discount stay separate figures in reports and margin analysis. Items
// without a master MRP (0/unset) have no floor.
//
// `savedFloors` (edit only) grandfathers lines saved before a later master-MRP
// increase: the effective floor is min(master MRP, the line's previously saved
// price), so an old invoice stays editable as long as the price is not reduced
// further. It must be built from the sale's STORED lines, never the request.
//
// items.mrp is a startup-migration column invisible to drizzle — a drizzle
// select would silently read it as undefined, so the master MRP is fetched via
// raw SQL here.
//
// The comparison is deliberately strict (no epsilon): both sides come from
// parsing decimal strings (JSON body / NUMERIC-as-text), so equal decimals are
// identical doubles and any value even a fraction of a paisa below the floor
// (e.g. 99.996 vs ₹100) is rejected. No arithmetic is performed on either side.
//
// DELIBERATE EXCEPTION: createTransferSaleInvoice (lib/gstTransfer.ts) writes
// system-generated sales rows for cross-GSTIN branch transfers priced at COST,
// which is normally below MRP. Those are internal GST documents, excluded from
// revenue via branch_transfer_id, and are NOT subject to this floor.
export async function checkMrpFloor(
  pgPool: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  rawLineItems: Array<{ itemId: number; unitPrice: number }>,
  savedFloors?: Map<number, number>,
  // Optional caller-specific wording (e.g. quotations). The RULE — strict
  // compare against min(master, saved floor), no epsilon — stays in this one
  // function; only the message may differ per document type.
  messageFor?: (itemName: string, floor: number) => string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const itemIds = [...new Set(rawLineItems.map(li => Number(li.itemId)))]
    .filter(n => Number.isFinite(n) && n > 0);
  if (itemIds.length === 0) return { ok: true };
  const { rows } = await pgPool.query(
    `SELECT id, name, mrp FROM items WHERE id = ANY($1::int[])`, [itemIds],
  );
  const byId = new Map<number, { name: string; mrp: number }>(
    rows.map((r: any) => [Number(r.id), { name: String(r.name ?? ''), mrp: Number(r.mrp ?? 0) }]),
  );
  for (const li of rawLineItems) {
    const item = byId.get(Number(li.itemId));
    if (!item || item.mrp <= 0) continue;
    const saved = savedFloors?.get(Number(li.itemId));
    const floor = saved !== undefined && saved > 0 ? Math.min(item.mrp, saved) : item.mrp;
    if (Number(li.unitPrice ?? 0) < floor) {
      return {
        ok: false,
        error: messageFor
          ? messageFor(item.name, floor)
          : `MRP cannot be lower than the Item Master MRP. Use Discount if you want to reduce the selling price. (${item.name}: minimum allowed ₹${floor.toFixed(2)})`,
      };
    }
  }
  return { ok: true };
}

// ── Item Prices ───────────────────────────────────────────────────────────────

// Serves Item Prices and HO Sales (POS) pages.
router.get("/item-prices", requireModuleView(["page:/headoffice/item-price", "page:/sales/pos"]), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const qp = ListItemPricesQueryParams.safeParse(req.query);

  // Use raw SQL — location_type column is invisible to Drizzle (startup migration)
  const { rows } = await pgPool.query(`
    SELECT
      ip.id, ip.item_id, ip.outlet_id, ip.price, ip.updated_at,
      ip.valid_from, ip.valid_to,
      COALESCE(ip.location_type, 'outlet') AS location_type,
      i.name  AS item_name,
      CASE
        WHEN COALESCE(ip.location_type, 'outlet') = 'warehouse'  THEN w.name
        WHEN COALESCE(ip.location_type, 'outlet') = 'headoffice' THEN 'Head Office'
        ELSE o.name
      END AS outlet_name
    FROM item_prices ip
    LEFT JOIN items     i ON i.id = ip.item_id
    LEFT JOIN outlets   o ON o.id = ip.outlet_id AND COALESCE(ip.location_type, 'outlet') = 'outlet'
    LEFT JOIN warehouses w ON w.id = ip.outlet_id AND ip.location_type = 'warehouse'
    ORDER BY ip.id DESC
  `);

  let result = rows.map((r: any) => ({
    id:           r.id,
    itemId:       r.item_id,
    outletId:     r.outlet_id,
    locationType: r.location_type,
    price:        Number(r.price),
    validFrom:    r.valid_from ?? null,
    validTo:      r.valid_to   ?? null,
    itemName:     r.item_name  ?? '',
    outletName:   r.outlet_name ?? '',
    updatedAt:    r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }));

  if (qp.success && qp.data.outletId) {
    result = result.filter((r: any) => r.outletId === Number(qp.data.outletId));
  }

  res.json(result);
});

router.post("/item-prices", requireModuleAction("page:/headoffice/item-price", "add"), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const parsed = SetItemPriceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const body = req.body as { validFrom?: string; validTo?: string; locationType?: string };
  const locationType = body.locationType ?? 'outlet';
  const locationId   = parsed.data.outletId; // reused field: holds warehouse/HO id too

  // No new or amended pricing for a retired outlet; existing outlet prices stay
  // readable so historical bills still explain themselves.
  if (locationType === 'outlet' && await outletWritesBlocked(pgPool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // For headoffice there's no sub-id — store 0
  const storedId = locationType === 'headoffice' ? 0 : locationId;

  const validFrom = body.validFrom || null;
  const validTo   = body.validTo   || null;

  // Upsert: match on item + location combo
  const { rows: existing } = await pgPool.query(
    `SELECT id FROM item_prices WHERE item_id = $1 AND outlet_id = $2 AND COALESCE(location_type,'outlet') = $3 LIMIT 1`,
    [parsed.data.itemId, storedId, locationType]
  );

  let row: any;
  if (existing.length > 0) {
    const { rows: updated } = await pgPool.query(
      `UPDATE item_prices SET price = $1, valid_from = $2, valid_to = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [String(parsed.data.price), validFrom, validTo, existing[0].id]
    );
    row = updated[0];
  } else {
    const { rows: inserted } = await pgPool.query(
      `INSERT INTO item_prices (item_id, outlet_id, location_type, price, valid_from, valid_to)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [parsed.data.itemId, storedId, locationType, String(parsed.data.price), validFrom, validTo]
    );
    row = inserted[0];
  }

  // Resolve display names
  const { rows: itemRows }   = await pgPool.query(`SELECT name FROM items WHERE id = $1 LIMIT 1`, [row.item_id]);
  let locationName = 'Head Office';
  if (locationType === 'warehouse') {
    const { rows: wRows } = await pgPool.query(`SELECT name FROM warehouses WHERE id = $1 LIMIT 1`, [storedId]);
    locationName = wRows[0]?.name ?? '';
  } else if (locationType === 'outlet') {
    const { rows: oRows } = await pgPool.query(`SELECT name FROM outlets WHERE id = $1 LIMIT 1`, [storedId]);
    locationName = oRows[0]?.name ?? '';
  }

  res.json({
    id:           row.id,
    itemId:       row.item_id,
    outletId:     row.outlet_id,
    locationType: row.location_type ?? 'outlet',
    price:        Number(row.price),
    validFrom:    row.valid_from  ?? null,
    validTo:      row.valid_to    ?? null,
    itemName:     itemRows[0]?.name ?? '',
    outletName:   locationName,
    updatedAt:    row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  });
});

// ── Sales ──────────────────────────────────────────────────────────────────

// GET /sales — optionally server-paginated (Phase 7).
// Without `page`/`limit` params the legacy full-array response is returned
// (backward compatible). With them: envelope { total, page, limit, rows }.
// Filters (usable in both modes): q (invoice/customer name/phone), from/to
// (YYYY-MM-DD), locationType+locationId, warehouseScope=<warehouseId>
// (warehouse itself + its child outlets — replaces client-side filtering),
// legacy outletId.
// Serves HO Sales/Payments (POS), Returns and the Sales Dashboard.
router.get("/sales", requireModuleView(["page:/sales/pos", "page:/returns", "page:/"]), async (req, res): Promise<void> => {
  const { pool: pgPool } = await import("@workspace/db");
  const paginated = 'page' in req.query || 'limit' in req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return;
  }

  // Branch-transfer tax invoices are not customer sales — they must never show
  // in the sales register (see gstTransfer.ts).
  const conds: string[] = ['s.branch_transfer_id IS NULL'];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    // legacy_invoice_number keeps the pre-SB2B/SB2C number a bill carried
    // before the series split, so old references typed from printed copies
    // still find the bill.
    conds.push(`(s.invoice_number ILIKE $${params.length} OR s.legacy_invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (from) { params.push(from); conds.push(`s.sale_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`s.sale_date <= $${params.length}::date`); }

  const viewLoc = getLocationFilter(req);
  if (viewLoc && (viewLoc.locationType === 'warehouse' || viewLoc.locationType === 'outlet')) {
    params.push(viewLoc.locationType); conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
    params.push(viewLoc.locationId);   conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
  } else if (viewLoc && viewLoc.locationType === 'headoffice') {
    params.push('headoffice'); conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
  } else if (req.query.outletId) {
    // Legacy exact filter (kept for existing callers)
    params.push(Number(req.query.outletId)); conds.push(`s.outlet_id = $${params.length}`);
  }
  const ws = Number(req.query.warehouseScope);
  if (Number.isFinite(ws) && ws > 0) {
    params.push(ws);
    const p = params.length;
    conds.push(`((COALESCE(s.location_type, 'outlet') = 'warehouse' AND COALESCE(s.location_id, s.outlet_id) = $${p})
      OR (COALESCE(s.location_type, 'outlet') = 'outlet' AND COALESCE(s.location_id, s.outlet_id) IN (SELECT id FROM outlets WHERE warehouse_id = $${p})))`);
  }
  // ── Server-side data scope: enforce branch visibility ─────────────────────
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeSalesWhere(scope, params));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const baseFrom = `FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;

  let total = 0;
  let page = 1;
  let limit = 0;
  let pageSql = '';
  if (paginated) {
    page = Math.max(parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 200);
    const { rows: [t] } = await pgPool.query(`SELECT COUNT(*)::int AS total ${baseFrom} ${where}`, params);
    total = Number(t?.total ?? 0);
    pageSql = ` LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
  }

  const { rows: rawRows } = await pgPool.query(`
    SELECT s.*, c.name AS _customer_name, c.phone AS _customer_phone
    ${baseFrom} ${where}
    ORDER BY s.id ${paginated ? 'DESC' : ''}${pageSql}
  `, params);

  const outlets = await db.select().from(outletsTable);
  const { rows: warehouses } = await pgPool.query<{ id: number; name: string; upi_id: string | null }>(
    `SELECT id, name, upi_id FROM warehouses ORDER BY id`
  );
  const oMap = new Map(outlets.map((o) => [o.id, { name: o.name, upiId: (o as any).upiId ?? "" }]));
  const wMap = new Map(warehouses.map((w) => [w.id, { name: w.name, upiId: w.upi_id ?? "" }]));

  // One batched read of the shared payment position for every row on this page,
  // plus the company's payment settings. The list, the invoice view and the QR
  // it shows then all quote the same number.
  const positions = await loadPaymentPositions(pgPool, rawRows.map((r: any) => Number(r.id)));
  const paySettings = await loadInvoicePaymentSettings(pgPool);

  const mapped = rawRows.map((r: any) => {
    const locationType: string = r.location_type ?? 'outlet';
    const locationId: number = r.location_id ?? r.outlet_id;
    const outlet = oMap.get(r.outlet_id);
    const warehouse = locationType === 'warehouse' ? wMap.get(locationId) : null;
    // A Head Office sale's outlet_id is only a legacy NOT NULL placeholder —
    // resolving a name through it would mislabel the sale with a real outlet.
    const locationName = locationType === 'headoffice' ? 'Head Office' : (warehouse?.name ?? outlet?.name ?? "");
    const locationUpiId = locationType === 'headoffice' ? "" : (warehouse?.upiId ?? outlet?.upiId ?? "");
    const totalAmount = Number(r.total_amount);
    const amountPaid  = Number(r.amount_paid ?? 0);
    const position = positions.get(Number(r.id)) ?? computePaymentPosition({
      totalAmount, amountReceived: amountPaid, cancelledAt: r.cancelled_at,
    });
    // The collect request is built server-side from the position, so the screen
    // cannot ask for an amount the invoice does not owe.
    const upiRequest = buildUpiRequest({
      position,
      upiId: locationUpiId || paySettings.upiId,
      payeeName: paySettings.upiPayeeName || locationName,
      reference: r.invoice_number ?? "",
      enabled: paySettings.upiEnabled && paySettings.showUpiQrOnInvoice,
    });
    return {
      id: r.id,
      invoiceNumber: r.invoice_number,
      outletId: r.outlet_id,
      locationType,
      locationId,
      customerId: r.customer_id,
      saleDate: r.sale_date,
      lineItems: r.line_items ?? [],
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      discountTotal: Number(r.discount_total),
      billDiscount: Number(r.bill_discount ?? 0),
      totalAmount,
      paymentMode: r.payment_mode,
      couponCode: r.coupon_code,
      otherCharges: parseStoredOtherCharges(r.other_charges),
      otherChargesTotal: otherChargesTotal(parseStoredOtherCharges(r.other_charges)),
      createdAt: r.created_at,
      paymentStatus: position.status,
      amountPaid,
      amountReceived: position.amountReceived,
      creditAdjustments: position.creditAdjustments,
      amountDue: position.amountDue,
      balanceDue: position.outstanding,
      cancelledAt: r.cancelled_at ?? null,
      isCancelled: position.isCancelled,
      upiQrUri: upiRequest?.uri ?? null,
      upiQrAmount: upiRequest?.amount ?? 0,
      outletName: locationName,
      outletUpiId: locationUpiId,
      customerName: r._customer_name ?? null,
      customerPhone: r._customer_phone ?? null,
      quotationId: r.quotation_id ?? null,
      quotationNumber: r.quotation_number ?? null,
    };
  });

  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

router.post("/sales", requireModuleAction("page:/sales/pos", "add"), async (req, res): Promise<void> => {
  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // saleDate is copied into sale_date and into receipts.receipt_date, both real
  // DATE columns, and zod only checks that it is a string.
  if (!isIsoDate(parsed.data.saleDate)) {
    res.status(400).json({ error: "saleDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }

  const { pool: pgPool } = await import("@workspace/db");

  // ── Idempotency (double-click / network retry) ────────────────────────────
  // The client may stamp a stable clientRequestId on the create. An exact
  // replay of the same key must return the ORIGINAL invoice (200,
  // idempotentReplay) instead of raising a second bill. CreateSaleBody strips
  // unknown keys, so read it from the raw body. The stored value is the unique
  // identity a partial unique index keys on, so two concurrent submits cannot
  // both insert.
  const clientRequestId = typeof (req.body as any)?.clientRequestId === 'string'
    ? String((req.body as any).clientRequestId).trim() || null
    : null;
  if (clientRequestId) {
    const { rows: [prior] } = await pgPool.query<any>(
      `SELECT * FROM sales WHERE client_request_id = $1 LIMIT 1`, [clientRequestId]
    );
    if (prior) {
      res.status(200).json(await buildSaleReplayResponse(pgPool, prior));
      return;
    }
  }

  // Month lock: no new sale (or its same-dated payment/receipt trail) may
  // land in a locked accounting month.
  if (await respondIfMonthLocked(res, pgPool, [parsed.data.saleDate], "sale create")) return;

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount?: number; unitDiscount?: number | null; taxAmount: number;
  }>;

  // ── Discontinued items can't be billed again ──────────────────────────────
  // Create-only: an existing invoice stays editable and refundable after the
  // item is retired, so history and returns are never stranded.
  const inactiveMsg = await blockedByInactiveProducts(
    pgPool, rawLineItems.map(li => ({ kind: "item" as const, id: Number(li.itemId) })),
  );
  if (inactiveMsg) { res.status(400).json({ error: inactiveMsg, code: INACTIVE_PRODUCT_CODE }); return; }

  // ── Determine location (Head Office, warehouse or outlet) ─────────────────
  const rawBody = req.body as any;
  const locationType: 'outlet' | 'warehouse' | 'headoffice' =
    rawBody.locationType === 'warehouse' ? 'warehouse'
    : rawBody.locationType === 'headoffice' ? 'headoffice'
    : 'outlet';
  // Head Office is singular and its id is never taken from the body. Item
  // stock at HO lives under branch ('headoffice', 1) — the same convention
  // purchases and production use — so the sale row and its stock deduction
  // share one id.
  const locationId: number = locationType === 'headoffice'
    ? 1
    : (rawBody.locationId ? Number(rawBody.locationId) : parsed.data.outletId);
  // A sale with no resolvable location vanishes from every located view (TB
  // slices, day book, LBAC scopes) while still posting company-wide — refuse
  // it outright rather than relying on the masters lookup below to catch it.
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "locationId (or outletId) must identify a real location" });
    return;
  }
  const createScope = await getUserDataScope((req as any).employee);
  // Location fields are a request, not authority. Check the effective values
  // before looking up stock, allocating an invoice number, or posting books.
  if (!isLocationInScope(createScope, locationType, locationId)) {
    res.status(403).json({ error: "You can only record sales for a location in your assigned scope." });
    return;
  }
  // Lifecycle gate on the EFFECTIVE location — a disabled warehouse takes no
  // new sales (its outlets included).
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locationType, id: locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  // Look up location name, UPI ID, and ledger IDs
  let cashLedgerId: number | null = null;
  let salesLedgerId: number | null = null;
  let locationName = '';
  let locationUpiId = '';

  if (locationType === 'headoffice') {
    // Head Office rings up on the company's own books: the derived postings
    // fall back to STD-CASH / STD-SALES when a sale has no branch ledger
    // mapping, so no per-location ledgers are needed (creating separate "HO
    // Cash/Bank" ledgers would fragment the existing Head Office postings).
    cashLedgerId = null;
    salesLedgerId = null;
    locationName = 'Head Office';
    locationUpiId = '';
  } else if (locationType === 'warehouse') {
    const { rows: [wh] } = await pgPool.query<{
      name: string; upi_id: string | null; cash_ledger_id: number | null; sales_ledger_id: number | null
    }>(`SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM warehouses WHERE id = $1`, [locationId]);
    if (!wh) { res.status(400).json({ error: 'Warehouse not found' }); return; }
    cashLedgerId = wh.cash_ledger_id;
    salesLedgerId = wh.sales_ledger_id;
    locationName = wh.name;
    locationUpiId = wh.upi_id ?? '';
  } else {
    // Retired outlets are readable but frozen — no new bills may be raised at
    // one, otherwise the "no new outlet activity" rule leaks through the till.
    if (await outletWritesBlocked(pgPool)) {
      res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
    }
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, locationId)).limit(1);
    if (!outlet) { res.status(400).json({ error: 'Outlet not found' }); return; }
    const { rows: [ol] } = await pgPool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null }>(
      `SELECT cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`, [locationId]
    );
    cashLedgerId = ol?.cash_ledger_id ?? null;
    salesLedgerId = ol?.sales_ledger_id ?? null;
    locationName = outlet.name;
    locationUpiId = (outlet as any).upiId ?? '';
  }

  // NOTE: stock availability is NOT checked here. It used to be — with a
  // non-locking read, several statements before the deduction, which let two
  // concurrent bills both pass the check and sell the same unit twice. The
  // check, the row lock and the deduction now happen together inside the sale
  // transaction below.

  // ── Fetch (or create) company settings for invoice numbering and GST state ─
  let company = (await db.select().from(companySettingsTable).limit(1))[0];
  if (!company) {
    [company] = await db.insert(companySettingsTable).values({}).returning();
  }
  const companyState = (company.state ?? '').trim().toLowerCase();

  // ── Determine inter-state vs intra-state ──────────────────────────────────
  // Place of supply = the SELLING LOCATION's state vs the customer's state,
  // never the head-office state: a Karnataka warehouse selling to a Karnataka
  // customer is intrastate (CGST+SGST) even though the company registration
  // is Kerala. Walk-in / stateless customers are supplied over the counter →
  // intrastate at the location's own state. A location with no state
  // configured falls back to the company state (the previous behaviour).
  let customerState = '';
  if (parsed.data.customerId) {
    const [cust] = await db.select().from(customersTable)
      .where(eq(customersTable.id, parsed.data.customerId))
      .limit(1);
    customerState = (cust?.state ?? '').trim().toLowerCase();
  }
  const sellerGst = await resolveLocationGst(pgPool, locationType, locationId);
  const isInterState = isInterStateSupply(
    { state: sellerGst.state || companyState, stateCode: sellerGst.stateCode },
    customerState,
  );

  // ── Fetch item tax rates ──────────────────────────────────────────────────
  const itemIds = [...new Set(rawLineItems.map(li => li.itemId))];
  const itemsData = itemIds.length > 0
    ? await db.select({ id: itemsTable.id, taxRate: itemsTable.taxRate, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
        .from(itemsTable)
        .where(inArray(itemsTable.id, itemIds))
    : [];
  const itemTaxMap = new Map(itemsData.map(i => [i.id, { taxRate: Number(i.taxRate), name: i.name, hsnCode: i.hsnCode, unit: i.unit }]));

  // ── MRP floor ─────────────────────────────────────────────────────────────
  // Line price must be AT or ABOVE the item's master MRP; reductions go
  // through the discount fields. Enforced here so a direct API call cannot
  // bypass the POS rule.
  const mrpCheck = await checkMrpFloor(pgPool, rawLineItems);
  if (!mrpCheck.ok) {
    res.status(400).json({ error: mrpCheck.error, code: 'MRP_BELOW_MASTER' });
    return;
  }

  // ── Build enriched line items with GST ────────────────────────────────────
  // Item discounts, then the pre-tax bill discount allocation, then tax — the
  // one canonical computation shared with PUT (see buildSaleLines).
  const built = buildSaleLines(rawLineItems, itemTaxMap, isInterState, (parsed.data as any).billDiscount ?? rawBody.billDiscount);
  if (!built.ok) { res.status(400).json({ error: built.error }); return; }
  const lineItems = built.lineItems;
  const billDiscount = built.billDiscount;

  const subtotal = lineItems.reduce((s, li) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s, li) => s + li.taxAmount, 0);
  // Coupon discount ONLY — post-tax, off the grand total. Item discounts and
  // the bill discount are already netted into lineSubtotal/taxAmount above —
  // deducting either here would double-count. CreateSaleBody strips unknown
  // keys, so read the raw body (same pattern as locationType/locationId).
  const rawDiscountTotal = Number(rawBody.discountTotal ?? 0);
  if (!Number.isFinite(rawDiscountTotal) || rawDiscountTotal < 0) {
    res.status(400).json({ error: 'discountTotal must be a non-negative amount' });
    return;
  }
  if (rawDiscountTotal > subtotal + taxTotal + 0.004) {
    res.status(400).json({ error: 'Coupon discount cannot exceed the invoice amount' });
    return;
  }
  const discountTotal = Math.round(rawDiscountTotal * 100) / 100;

  // ── Other Charges (Packing & Transport, Freight, Hamali, Courier…) ────────
  // Money the customer owes ON TOP of the goods: folded into total_amount (the
  // grand total that dues, receipts, credit checks and the customer Dr leg all
  // key off) but never into subtotal/tax_total — charges carry no GST, so the
  // GSTR-1 taxable value stays goods-only. Validated on the EFFECTIVE ledgers
  // server-side: a sale charge may credit an income OR expense ledger (a real
  // recovery), but never the Sales (SYS-SAL) or Purchase (SYS-PUR) subtree, nor
  // an internal system ledger. CreateSaleBody strips unknown keys, so read the
  // raw body — the same pattern as discountTotal above.
  const ocParsed = await validateSaleOtherCharges(pgPool, rawBody.otherCharges);
  if ('error' in ocParsed) { res.status(400).json({ error: ocParsed.error }); return; }
  const otherCharges = ocParsed.charges;
  const otherChargesTot = ocParsed.total;

  const totalAmount = Math.round((subtotal + taxTotal - discountTotal + otherChargesTot) * 100) / 100;

  // ── Quotation conversion (optional) ───────────────────────────────────────
  // A sale may complete a quotation. The link is validated and stamped INSIDE
  // the sale transaction below — the row lock there is what makes "exactly one
  // sale per quotation" hold under concurrent requests.
  const rawQuotationId = Number((parsed.data as any).quotationId ?? rawBody.quotationId ?? 0);
  const quotationId = Number.isInteger(rawQuotationId) && rawQuotationId > 0 ? rawQuotationId : null;
  let quotationNumberForSale: string | null = null;

  // ── POS entry flags: refuse NEW discounts/coupons while switched off ──────
  // Settings-driven and server-enforced: hiding the inputs in the POS UI means
  // nothing if a crafted request can still carry the fields. Creation is
  // strict — any discount or coupon at all is refused while the flag is off.
  {
    const posFlags = await getPosEntryFlags(pgPool);
    // Stored line `discount` = item discount + allocated bill-discount share,
    // so summing it covers both pre-tax mechanisms in one figure.
    const preTaxDiscount = lineItems.reduce((s, li) => s + Number(li.discount ?? 0), 0);
    if (!posFlags.discountsEnabled && (preTaxDiscount > 0.004 || billDiscount > 0.004)) {
      res.status(400).json({ error: DISCOUNTS_DISABLED_MESSAGE, code: DISCOUNTS_DISABLED_CODE });
      return;
    }
    if (!posFlags.couponsEnabled && (discountTotal > 0.004 || (parsed.data.couponCode ?? '').trim() !== '')) {
      res.status(400).json({ error: COUPONS_DISABLED_MESSAGE, code: COUPONS_DISABLED_CODE });
      return;
    }
  }

  // ── Credit control + atomic sale insert ───────────────────────────────────
  // The credit-limit check, invoice-sequence increment, and sale INSERT run in
  // ONE transaction. A per-customer advisory lock serializes concurrent credit
  // sales so two requests cannot both pass the limit check, and a rejected
  // sale never burns an invoice number.
  const paymentModeIn = parsed.data.paymentMode ?? 'cash';
  // The generated zod schema types paymentMode as a plain string, so the mode
  // list is enforced here. A NEW sale may only be cash or credit: if the
  // customer isn't paying cash now the invoice is raised on Credit and the
  // money is collected later through payment collection (which still takes
  // bank/upi). Bank/UPI/card/bank_transfer are rejected on creation — they stay
  // valid only for reading/editing existing historical sales and for
  // collections.
  if (!isAllowedNewSaleMode(paymentModeIn)) {
    res.status(400).json({
      error: `paymentMode must be one of: ${CREATE_SALE_PAYMENT_MODES.join(', ')}. For a non-cash sale, record it as credit and collect payment later.`,
    });
    return;
  }
  // ── Creation-time payment via an explicit "Receive Into" account ──────────
  // Modern POS path: the caller names the ACTUAL Cash & Bank account the money
  // went into (the same selector payment collection uses) and the server
  // derives the cash/bank/upi method from the account itself — ONE collection
  // engine (lib/saleCollection), shared with POST /sales/:id/payments.
  // CreateSaleBody strips unknown keys, so read the raw body like
  // clientRequestId/billDiscount above.
  const receivedInLedgerIdRaw = Number(rawBody.receivedInLedgerId);
  const receivedInLedgerId = Number.isInteger(receivedInLedgerIdRaw) && receivedInLedgerIdRaw > 0
    ? receivedInLedgerIdRaw : null;
  const allowOverpayment = rawBody.allowOverpayment === true;
  const payReferenceNumber = typeof rawBody.referenceNumber === 'string'
    ? String(rawBody.referenceNumber).trim() || null : null;
  let receiveAccount: ReceiveIntoAccount | null = null;
  // null = "the full remainder after any advance adjustment" (pay in full now).
  let amountReceivedIn: number | null = null;
  if (receivedInLedgerId) {
    if (paymentModeIn === 'credit') {
      res.status(400).json({ error: "Pick either Credit (pay later) or a Receive-Into account — not both." });
      return;
    }
    const resolvedAcc = await resolveReceiveIntoAccount(pgPool, locationType, locationId, receivedInLedgerId);
    if ('error' in resolvedAcc) { res.status(400).json({ error: resolvedAcc.error }); return; }
    receiveAccount = resolvedAcc;
    const rawAmt = rawBody.amountReceived;
    if (rawAmt !== undefined && rawAmt !== null && rawAmt !== '') {
      const amt = Number(rawAmt);
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: 'amountReceived must be a positive amount' }); return;
      }
      if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) {
        res.status(400).json({ error: 'amountReceived cannot go beyond paise (2 decimal places)' }); return;
      }
      amountReceivedIn = Math.round(amt * 100) / 100;
    }
  }

  // cash/bank/upi are settled at the counter — mark them paid immediately so
  // outstanding, collections, and the credit check only track true credit
  // exposure. Only 'credit' (pay later) sales are credit-controlled.
  const settledAtSale = isSettledAtSale(paymentModeIn);
  const overrideRequested = rawBody.creditOverride === true;
  // Opt-in adjustment of the customer's advance balance against this bill.
  // Read from the raw body (like creditOverride): zod strips unknown keys.
  const useAdvanceRequested = rawBody.useAdvance === true && !!parsed.data.customerId;
  const advanceCapIn = Number((rawBody as any).advanceAmount);

  // Credit (pay later) sales must have a customer — otherwise there is no
  // account to owe the balance and the credit check would be bypassed.
  if (paymentModeIn === 'credit' && !parsed.data.customerId) {
    res.status(400).json({
      error: 'Credit sales require a customer. Pick a customer or choose cash, bank or UPI.',
      code: 'CREDIT_REQUIRES_CUSTOMER',
    });
    return;
  }

  // Server-side authorization for the override flag. The dialog is offered to
  // everyone, so this check is the only thing standing between a cashier and
  // selling past a customer's credit limit. Resolved whenever the flag is sent
  // with a customer: a partial creation-time payment also lands on credit, and
  // whether it does is only known inside the transaction (after the advance).
  let overrideAllowed = false;
  if (!!parsed.data.customerId && overrideRequested) {
    overrideAllowed = await hasModuleAction(req.employee?.hierarchyId, CREDIT_OVERRIDE_PAGES, "edit");
  }

  // ── Everything the sale transaction will need, resolved before it opens ───
  // The movement trail, the customer total and the accounting receipt all have
  // to commit WITH the sale (see below). These lookups are read-only, so they
  // run first rather than holding row locks open while they wait on the
  // database.
  const [ledgerMeta, branchNameOf] = await Promise.all([
    batchResolveMeta(pool, lineItems.map(li => ({ materialType: 'item' as const, refId: li.itemId }))),
    buildBranchMaps(),
  ]);
  let elecClrLedgerId: number | null = null;
  if (clearsThroughBank(paymentModeIn)) {
    const { rows: [clr] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    elecClrLedgerId = clr?.id ?? null;
  }
  let custLedgerId: number | null = null;
  if (paymentModeIn === 'credit' && parsed.data.customerId) {
    const { rows: [cl] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${parsed.data.customerId}`]
    );
    custLedgerId = cl?.id ?? null;
  }
  // Advance = the credit (negative) balance on the customer's own Sundry
  // Debtor ledger — no separate advance ledger exists. Availability is read
  // under the advance lock inside the transaction below; a customer with no
  // credit balance makes the flag a silent no-op rather than an error.

  const txClient = await pgPool.connect();
  let row: any;
  let invoiceNumber = '';
  let lineItemsWithBatches: any[] = [];
  let appliedAdvance = 0;
  try {
    await txClient.query('BEGIN');

    // ── Quotation conversion: lock the quotation FIRST ───────────────────────
    // FOR UPDATE serialises concurrent conversions of the same quotation; the
    // second request waits here, then sees converted_sale_id set and is
    // refused before any stock is touched or an invoice number consumed.
    if (quotationId) {
      const { rows: [qRow] } = await txClient.query<{
        id: number; converted_sale_id: number | null; quotation_number: string;
        location_type: string; location_id: number;
      }>(
        `SELECT id, converted_sale_id, quotation_number, location_type, location_id
           FROM quotations WHERE id = $1 FOR UPDATE`,
        [quotationId]
      );
      // LBAC: the caller must be allowed to see the QUOTATION's location, not
      // just the sale's — otherwise a scoped user could guess an out-of-scope
      // quotation id and permanently convert (consume) it. Checked inside the
      // same transaction as the lock so the decision is made on the locked
      // row. Out-of-scope reads as "not found" (never 403 — no existence
      // oracle), matching the quotations router's own scoping. Cross-location
      // conversion WITHIN the caller's scope stays allowed by design: the
      // sale's location was already validated by the create-scope check above.
      if (!qRow || !isLocationInScope(createScope, qRow.location_type as any, qRow.location_id)) {
        await txClient.query('ROLLBACK');
        res.status(400).json({ error: 'Quotation not found', code: 'QUOTATION_NOT_FOUND' });
        return;
      }
      if (qRow.converted_sale_id) {
        await txClient.query('ROLLBACK');
        res.status(409).json({
          error: `Quotation ${qRow.quotation_number} has already been converted to an invoice. A quotation can only ever produce one sale.`,
          code: 'QUOTATION_ALREADY_CONVERTED',
        });
        return;
      }
      quotationNumberForSale = qRow.quotation_number;
    }

    // ── Customer advance adjustment ─────────────────────────────────────────
    // Serialize on the advance lock, then read availability from the books
    // (ledger-authoritative). Concurrent consumers hold this lock until their
    // COMMIT, so the committed state we read here is the settled truth.
    if (useAdvanceRequested && parsed.data.customerId) {
      await takeAdvanceLock(txClient, 'customer', parsed.data.customerId);
      const advPos = await advanceAvailable('customer', parsed.data.customerId);
      appliedAdvance = Math.min(advPos.available, totalAmount);
      if (Number.isFinite(advanceCapIn) && advanceCapIn >= 0) {
        appliedAdvance = Math.min(appliedAdvance, advanceCapIn);
      }
      appliedAdvance = Math.round(appliedAdvance * 100) / 100;
      if (appliedAdvance <= 0.004) appliedAdvance = 0;
    }

    // ── Creation-time collection: final figures and the sale's stored mode ──
    // Decided here — after the advance — because whether the bill ends up
    // paid, partially paid (remainder on credit) or overpaid depends on how
    // much of it the advance already covered.
    let counterPay: { amount: number } | null = null;
    let saleMode = paymentModeIn;
    if (receiveAccount) {
      const remainderDue = round2(totalAmount - appliedAdvance);
      const amt = amountReceivedIn ?? Math.max(0, remainderDue);
      if (amt <= 0.004) {
        await txClient.query('ROLLBACK');
        res.status(400).json({ error: 'Nothing left to receive — the advance already covers this bill. Record it on credit or without the advance adjustment.' });
        return;
      }
      const paidTotal = round2(appliedAdvance + amt);
      if (paidTotal > totalAmount + 0.001) {
        // ── Overpayment gate — same contract as payment collection ──────────
        // Refused by default with a machine-readable code so the client can
        // offer the "hold the excess as advance" confirmation. Consent is
        // honoured ONLY for a registered customer: the excess lands as a
        // credit on their CUST- ledger (the natural Cr remainder in the
        // derived books). A walk-in has no ledger to hold it — refused even
        // WITH consent.
        const excess = round2(paidTotal - totalAmount);
        const overpaymentAllowed = parsed.data.customerId != null;
        if (!allowOverpayment || !overpaymentAllowed) {
          await txClient.query('ROLLBACK');
          res.status(400).json({
            error: overpaymentAllowed
              ? `Amount received (₹${amt.toFixed(2)}) exceeds the bill's remainder (₹${remainderDue.toFixed(2)}) by ₹${excess.toFixed(2)}. Confirm to hold the excess as customer advance.`
              : `Amount received (₹${amt.toFixed(2)}) exceeds the bill's remainder (₹${remainderDue.toFixed(2)}). A walk-in sale cannot hold the excess as advance — collect only what is owed.`,
            code: 'EXCEEDS_OUTSTANDING',
            excess,
            balanceDue: remainderDue,
            overpaymentAllowed,
          });
          return;
        }
        saleMode = receiveAccount.method;
      } else if (paidTotal < totalAmount - 0.004) {
        // Partial payment: the remainder is a receivable, so the bill lives on
        // the customer's credit — a walk-in has no account to owe it.
        if (!parsed.data.customerId) {
          await txClient.query('ROLLBACK');
          res.status(400).json({
            error: `Amount received (₹${amt.toFixed(2)}) is less than the bill (₹${remainderDue.toFixed(2)}). A walk-in must pay in full — pick a customer to leave a balance due.`,
            code: 'PARTIAL_REQUIRES_CUSTOMER',
          });
          return;
        }
        saleMode = 'credit';
      } else {
        saleMode = receiveAccount.method;
      }
      counterPay = { amount: amt };
    }

    // Credit control judges the sale's EFFECTIVE mode: a straight credit sale,
    // or a partial creation-time payment whose remainder just landed on credit.
    const isCreditControlled = !!parsed.data.customerId && saleMode === 'credit';
    if (isCreditControlled) {
      // Serialize concurrent credit sales for this customer; the lock is
      // released automatically at COMMIT/ROLLBACK.
      await txClient.query(
        `SELECT pg_advisory_xact_lock(hashtext('customer-credit'), $1)`,
        [parsed.data.customerId]
      );
      const { rows: [cc] } = await txClient.query<{ credit_limit: string }>(
        `SELECT COALESCE(credit_limit, 0)::numeric AS credit_limit FROM customers WHERE id = $1`,
        [parsed.data.customerId]
      );
      const creditLimit = Number(cc?.credit_limit ?? 0);
      if (creditLimit > 0) {
        // Exposure is the customer's LEDGER balance — the same figure their
        // statement, the receivables report and the Balance Sheet all show.
        // The old document arithmetic (sum of invoice dues minus credit
        // notes) could not see opening balances, manual journals or
        // unallocated receipts, and even counted cancelled invoices.
        const { currentPartyStatement } = await import("../lib/ledgerBalances");
        const st = await currentPartyStatement("customer", parsed.data.customerId!, { q: txClient });
        const currentOutstanding = Math.max(0, Math.round(Number(st.closing ?? 0) * 100) / 100);
        // The advance being adjusted against this bill — and any money being
        // received right now at the counter — is already in hand: it never
        // becomes exposure, so the credit check sees only the slice the
        // customer will actually owe.
        const projectedOutstanding = Math.round((currentOutstanding + totalAmount - appliedAdvance - (counterPay?.amount ?? 0)) * 100) / 100;
        const exceeded = projectedOutstanding > creditLimit + 0.009;
        if (exceeded && !(overrideRequested && overrideAllowed)) {
          await txClient.query('ROLLBACK');
          const figures = {
            creditLimit,
            currentOutstanding,
            saleAmount: Math.round(totalAmount * 100) / 100,
            projectedOutstanding,
          };
          if (overrideRequested && !overrideAllowed) {
            res.status(403).json({
              error: CREDIT_OVERRIDE_DENIED_MESSAGE,
              code: 'CREDIT_OVERRIDE_FORBIDDEN',
              ...figures,
            });
          } else {
            res.status(409).json({
              error: `Credit limit exceeded: current outstanding ₹${currentOutstanding.toFixed(2)} plus this sale of ₹${totalAmount.toFixed(2)} exceeds the credit limit of ₹${creditLimit.toFixed(2)}.`,
              code: 'CREDIT_LIMIT_EXCEEDED',
              ...figures,
            });
          }
          return;
        }
      }
    }

    // ── Stock: check, lock and deduct in one transaction ────────────────────
    // This is the write that stops stock being promised twice. Each line's
    // stock_entries row is locked BEFORE its availability is judged, so a second
    // bill for the same item waits here and then sees the reduced quantity
    // instead of reading a figure that is about to change. Availability is
    // on-hand minus active holds — stock already committed to another document
    // cannot be sold from under it.
    //
    // Lines are locked in ascending item order so two concurrent bills covering
    // the same items acquire their locks in the same sequence and cannot
    // deadlock waiting on each other.
    //
    // It also runs before the invoice-sequence bump: a sale that cannot be
    // fulfilled must not hold a lock on company_settings (which would serialise
    // every till in the business) while it finds out.
    const stockOrder = lineItems.map((_, i) => i).sort((a, b) => lineItems[a].itemId - lineItems[b].itemId);
    const breakdowns: any[] = new Array(lineItems.length);
    for (const idx of stockOrder) {
      const li = lineItems[idx];
      const avail = await availabilityAt(txClient, {
        refId: li.itemId, materialType: 'item',
        branchType: locationType, branchId: locationId, lock: true,
      });
      if (avail.available + 0.001 < Number(li.quantity)) {
        await txClient.query('ROLLBACK');
        res.status(400).json({
          error: insufficientStockMessage({
            productName: li.itemName || `Item #${li.itemId}`,
            locationName, unit: li.unit,
            quantity: avail.quantity, reserved: avail.reserved,
            requested: Number(li.quantity),
          }),
          code: 'INSUFFICIENT_STOCK',
          itemId: li.itemId,
          available: avail.available,
          reserved: avail.reserved,
          onHand: avail.quantity,
          requested: Number(li.quantity),
        });
        return;
      }
      await txClient.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, avail.entryId]
      );
      // Draw the lots that serve this line, earliest expiry first, so the sale
      // carries its own batch trail and an edit can restore the exact lots.
      breakdowns[idx] = await consumeBatches(txClient, {
        itemId: li.itemId, branchType: locationType, branchId: locationId, quantity: li.quantity,
      });
    }
    lineItemsWithBatches = lineItems.map((li, i) => ({ ...li, batchBreakdown: breakdowns[i] ?? [] }));

    // ── Allocate the sales bill number (same transaction) ───────────────────
    // Two independent FY-scoped series: SB2B when the customer holds a GST
    // number at billing time, SB2C for walk-in / retail / unregistered
    // customers. The series is decided automatically — no manual selection —
    // and the number is immutable from here on: edits keep it even if the
    // customer's GST registration changes later.
    let saleIsB2B = false;
    if (parsed.data.customerId) {
      const { rows: [cgst] } = await txClient.query<{ gstin: string | null }>(
        `SELECT NULLIF(TRIM(COALESCE(gst_number, '')), '') AS gstin FROM customers WHERE id = $1`,
        [parsed.data.customerId]
      );
      saleIsB2B = cgst?.gstin != null;
    }
    const numberAlloc = await allocateSalesInvoiceNumber(
      txClient, saleIsB2B ? 'b2b' : 'b2c', parsed.data.saleDate,
      { type: locationType, id: locationId }
    );
    invoiceNumber = numberAlloc.invoiceNumber;

    // ── Insert sale with location columns via raw SQL (location_type/location_id not in Drizzle schema) ──
    // Counter-settled modes are recorded fully paid; credit sales start unpaid.
    // The number identity columns (number_scope/series/fy/serial) are the
    // row's INTERNAL identity — plain columns the unique indexes key on, so
    // the DB itself forbids a duplicate number within one location while the
    // same printed number may exist at two different locations.
    const outletIdForInsert = locationType === 'outlet' ? locationId : null;
    ({ rows: [row] } = await txClient.query<any>(
      `INSERT INTO sales (invoice_number, outlet_id, location_type, location_id, customer_id, sale_date, line_items, subtotal, tax_total, discount_total, bill_discount, total_amount, payment_mode, coupon_code, amount_paid, payment_status,
                          number_scope, invoice_series, invoice_fy, invoice_serial, other_charges, client_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22) RETURNING *`,
      [invoiceNumber, outletIdForInsert, locationType, locationId,
       parsed.data.customerId ?? null, parsed.data.saleDate,
       // Stored WITH the batch trail already resolved above, so the served lots
       // are committed with the bill rather than patched in afterwards.
       JSON.stringify(lineItemsWithBatches), subtotal, taxTotal, discountTotal, billDiscount, totalAmount,
       saleMode, parsed.data.couponCode ?? null,
       // Counter-settled modes are fully paid at once; a creation-time
       // collection carries advance + money received (which may exceed the
       // bill — consented overpayment); a plain credit sale starts with
       // whatever slice the customer's advance just covered.
       counterPay
         ? round2(appliedAdvance + counterPay.amount)
         : settledAtSale ? totalAmount : appliedAdvance,
       counterPay
         ? computePaymentPosition({ totalAmount, amountReceived: round2(appliedAdvance + counterPay.amount), cancelledAt: null }).status
         : settledAtSale
           ? 'paid'
           : computePaymentPosition({ totalAmount, amountReceived: appliedAdvance, cancelledAt: null }).status,
       numberAlloc.numberScope, numberAlloc.seriesPrefix, numberAlloc.fyLabel, numberAlloc.serial,
       JSON.stringify(otherCharges), clientRequestId]
    ));

    // ── Counter-settlement payment history (audit F-1) ───────────────────────
    // A cash/upi/bank sale is settled the moment it exists. Write EXACTLY ONE
    // sale_payments row for it — source 'counter', method = the sale's mode,
    // amount = the FULL bill total, dated the sale date — so the Payment
    // History tab and bank reconciliation can see the collection. This is a
    // HISTORY/display row only: the derived postings already treat the
    // amount_paid remainder as counter money (see journal.ts), and the leg
    // simply relocates that same slice out of the remainder into a visible row,
    // so the trial balance is unchanged by construction. No receipt, no
    // voucher, no ledger posting. Cash needs no reconciliation (NULL); the
    // electronic modes enter 'pending' so reconciliation can settle them.
    // The advance-covered slice is already recorded as its own 'advance' leg
    // above, so the counter row carries only the money that hit the till/bank.
    // When an explicit Receive-Into account was picked, the receipt-backed
    // collection row below IS the settlement history — no bare counter row.
    if (settledAtSale && !counterPay) {
      const counterAmount = round2(totalAmount - appliedAdvance);
      if (counterAmount > 0.004) {
        await txClient.query(
          `INSERT INTO sale_payments
             (sale_id, payment_date, method, amount, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by, source)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 'counter')`,
          [row.id, parsed.data.saleDate, paymentModeIn, counterAmount,
           `Settled at counter — ${invoiceNumber}`,
           paymentModeIn === 'cash' ? null : 'pending',
           outletIdForInsert, (req as any).employee?.username ?? null]
        );
      }
    }

    // ── Creation-time collection: receipt + payment row, ONE engine ─────────
    // The same posting routine the collect flow uses: cash into the picked
    // cash account/till, electronic money direct-posted or through Electronic
    // Clearing ('pending') by the account's reconciliation switch. Committing
    // with the sale means a replayed clientRequestId can never double-post.
    if (counterPay && receiveAccount) {
      const posted = await postSaleCollectionReceipt(txClient, {
        method: receiveAccount.method,
        account: receiveAccount,
        locType: locationType,
        locId: locationId,
        amount: counterPay.amount,
        pDate: parsed.data.saleDate,
        invoiceNumber,
        referenceNumber: payReferenceNumber,
      });
      if ('error' in posted) {
        await txClient.query('ROLLBACK');
        res.status(500).json({ error: posted.error });
        return;
      }
      await txClient.query(
        `INSERT INTO sale_payments
           (sale_id, payment_date, method, amount, reference_number, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [row.id, parsed.data.saleDate, receiveAccount.method, counterPay.amount, payReferenceNumber,
         `Received at billing — ${invoiceNumber}`, posted.reconciliationStatus, posted.clearingReceiptId,
         outletIdForInsert, (req as any).employee?.username ?? null]
      );
    }

    // The adjusted advance is a collection like any other: a sale_payments row
    // with method 'advance'. The derived postings debit CUST-<customer> for it
    // — the invoice debit consuming the customer's credit (negative) balance.
    if (appliedAdvance > 0) {
      await txClient.query(
        `INSERT INTO sale_payments (sale_id, payment_date, method, amount, notes, reconciliation_status, outlet_id, created_by)
         VALUES ($1, $2, 'advance', $3, $4, NULL, $5, $6)`,
        [row.id, parsed.data.saleDate, appliedAdvance, `Advance adjusted against ${invoiceNumber}`,
         outletIdForInsert, (req as any).employee?.username ?? null]
      );
      // Pin this consumption to the voucher(s) that parked the money (FIFO,
      // oldest first) — the reference the voucher delete guard checks. Same
      // txn, still under the advance lock taken above.
      await attributeAdvanceConsumption(txClient, 'customer', parsed.data.customerId!,
        { saleId: Number(row.id) }, appliedAdvance);
    }

    // ── Stamp the quotation ↔ sale link, both directions, same transaction ──
    // The quotation was locked FOR UPDATE at the top of this transaction, so
    // no concurrent request can be stamping it at the same time.
    if (quotationId && quotationNumberForSale) {
      await txClient.query(
        `UPDATE quotations
            SET status = 'converted', converted_sale_id = $1,
                converted_invoice_number = $2, updated_at = now()
          WHERE id = $3`,
        [row.id, invoiceNumber, quotationId]
      );
      await txClient.query(
        `UPDATE sales SET quotation_id = $1, quotation_number = $2 WHERE id = $3`,
        [quotationId, quotationNumberForSale, row.id]
      );
      row.quotation_id = quotationId;
      row.quotation_number = quotationNumberForSale;
    }

    // ── The rest of what a sale means, in the SAME transaction ──────────────
    // The movement trail, the customer's running total and the accounting
    // receipt used to run AFTER the commit — the ledger write fire-and-forget
    // with its errors swallowed by an empty catch. That is why the database
    // held 52 sales and not one sale movement row: every failure was discarded
    // in silence. All of it now commits with the sale or none of it does.
    await writeStockLedger(txClient, lineItems.map(li => {
      const m = ledgerMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: locationType, branchId: locationId,
        branchName: branchNameOf(locationType, locationId),
        qtyChange: -Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: row.id,
        txnDate: parsed.data.saleDate,
        // The table has no doc_number column, so the invoice number rides in
        // notes — without it the trail can't be tied back to a bill.
        notes: invoiceNumber,
      };
    }));

    if (parsed.data.customerId) {
      await txClient.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric + $1 WHERE id = $2`,
        [totalAmount, parsed.data.customerId]
      );
    }

    // Debit routing follows settlement semantics: cash → location cash ledger,
    // upi/card (settled, awaiting bank) → Electronic Payment Clearing, and only
    // true credit sales → the customer debtor ledger. When a Receive-Into
    // account was picked, the collection receipt above already IS the money
    // trail — a second legacy trail receipt would double-display it.
    if (salesLedgerId && !counterPay) {
      let debitLedgerId = cashLedgerId;
      if (clearsThroughBank(paymentModeIn) && elecClrLedgerId) debitLedgerId = elecClrLedgerId;
      else if (paymentModeIn === 'credit' && custLedgerId) debitLedgerId = custLedgerId;
      // For counter-settled modes the advance-covered slice never reached the
      // till — the legacy trail row records only the money that did. (These
      // rows are excluded from the derived postings either way; the books get
      // the advance leg from the sale_payments row above.)
      const trailAmount = settledAtSale
        ? Math.round((totalAmount - appliedAdvance) * 100) / 100
        : totalAmount;
      if (debitLedgerId && trailAmount > 0.004) {
        await txClient.query(
          `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, voucher_number, location_type, location_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale')`,
          [parsed.data.saleDate, salesLedgerId, debitLedgerId, trailAmount,
           `Sale: ${invoiceNumber}${locationName ? ` at ${locationName}` : ''}`, invoiceNumber,
           locationType, locationId]
        );
      }
    }

    await txClient.query('COMMIT');
  } catch (txErr) {
    try { await txClient.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    txClient.release();
  }

  const customerName = parsed.data.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1))[0]?.name ?? null
    : null;

  logActivity({
    action: "CREATE", module: "sales", entityType: "sale", entityId: row.id,
    description: `New sale ${invoiceNumber} — ${customerName ?? "Walk-in"} — ₹${totalAmount.toFixed(2)}`,
    metadata: { after: { invoiceNumber, locationType, locationId, customerId: parsed.data.customerId, totalAmount, lineCount: lineItems.length } },
  }).catch(() => {});

  res.status(201).json({
    id: row.id,
    invoiceNumber: row.invoice_number,
    outletId: row.outlet_id,
    locationType: row.location_type,
    locationId: row.location_id,
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
    saleDate: row.sale_date,
    lineItems: lineItemsWithBatches,
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    discountTotal: Number(row.discount_total),
    billDiscount: Number(row.bill_discount ?? 0),
    totalAmount: Number(row.total_amount),
    paymentMode: row.payment_mode,
    couponCode: row.coupon_code,
    otherCharges,
    otherChargesTotal: otherChargesTot,
    createdAt: row.created_at,
    quotationId: row.quotation_id ?? null,
    quotationNumber: row.quotation_number ?? null,
    advanceApplied: appliedAdvance,
    // A sale cannot have a credit note against it the moment it is created, so
    // the position is computed rather than read back — same definition though,
    // so the figure the POS shows matches the one the invoice will print.
    ...(() => {
      const position = computePaymentPosition({
        totalAmount, amountReceived: row.amount_paid, cancelledAt: null,
      });
      return {
        paymentStatus: position.status,
        amountPaid: position.amountReceived,
        amountReceived: position.amountReceived,
        creditAdjustments: position.creditAdjustments,
        amountDue: position.amountDue,
        balanceDue: position.outstanding,
        isCancelled: false,
      };
    })(),
  });
});

// ── Edit Sale ─────────────────────────────────────────────────────────────────
router.put("/sales/:id", requireModuleAction("page:/sales/pos", "edit"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const { pool: pgPool } = await import("@workspace/db");
  const { rows: [existingRaw] } = await pgPool.query<any>(`SELECT * FROM sales WHERE id = $1`, [id]);
  if (!existingRaw) { res.status(404).json({ error: "Sale not found" }); return; }
  const existingScope = await getUserDataScope((req as any).employee);
  if (!isLocationInScope(
    existingScope,
    existingRaw.location_type ?? "outlet",
    existingRaw.location_id ?? existingRaw.outlet_id,
  )) {
    // Deliberately indistinguishable from a missing invoice: do not let a
    // branch user enumerate another location's sales by id.
    res.status(404).json({ error: "Sale not found" }); return;
  }

  // Transfer-generated invoices are system documents: their lines, totals,
  // GST and location mirror the branch transfer that raised them. Editing one
  // by hand would desync it from the transfer's stock and ledger postings.
  if (existingRaw.branch_transfer_id != null) {
    res.status(409).json({ error: "This invoice was generated by a branch transfer and cannot be edited directly." });
    return;
  }

  const parsed = CreateSaleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (!isIsoDate(parsed.data.saleDate)) {
    res.status(400).json({ error: "saleDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }

  // Month lock: an invoice in a locked month cannot be edited, and an open
  // invoice cannot be moved INTO a locked month — both dates must be open.
  if (await respondIfMonthLocked(res, pgPool, [existingRaw.sale_date, parsed.data.saleDate], "sale edit")) return;

  // Editing must not be a loophole for setting bank/upi on a sale. A new sale
  // may only be cash or credit; an edit may only leave the mode among the
  // create-time modes OR keep the historical mode (bank/upi/card/bank_transfer)
  // it already carried. Any attempt to CHANGE a sale into a non-create mode is
  // rejected — those are collected later, never set at sale time.
  const editModeIn = parsed.data.paymentMode ?? 'cash';
  const existingMode = (existingRaw.payment_mode ?? 'cash') as string;
  const resolvedMode = resolveEditedSaleMode(editModeIn, existingMode);
  if (!resolvedMode.ok) {
    res.status(400).json({
      error: `paymentMode must be one of: ${CREATE_SALE_PAYMENT_MODES.join(', ')}. A non-cash payment on this invoice is recorded through payment collection, not by changing the sale's mode.`,
    });
    return;
  }
  // Guard the value that will actually be written, not the one that was sent:
  // a 'bank' submission against a stored 'card' sale keeps 'card'.
  const effectivePaymentMode = resolvedMode.mode;

  // Credit (pay later) sales must have a customer — same server-side rule as
  // creation, enforced before any stock reversal side effects run.
  if ((parsed.data.paymentMode ?? 'cash') === 'credit' && !parsed.data.customerId) {
    res.status(400).json({
      error: 'Credit sales require a customer. Pick a customer or choose cash, bank or UPI.',
      code: 'CREDIT_REQUIRES_CUSTOMER',
    });
    return;
  }

  const rawLineItems = parsed.data.lineItems as Array<{
    itemId: number; quantity: number; unitPrice: number; discount?: number; unitDiscount?: number | null; taxAmount: number;
  }>;

  // ── Determine new location ────────────────────────────────────────────────
  // Fields absent from the body PRESERVE the invoice's current location. The
  // old default ('outlet' + whatever id fell out of the body) silently
  // rewrote warehouse invoices into location-less rows that vanished from
  // every located view while still posting company-wide.
  const rawBody = req.body as any;
  const newLocationType: 'outlet' | 'warehouse' | 'headoffice' =
    rawBody.locationType === 'warehouse' ? 'warehouse'
    : rawBody.locationType === 'outlet' ? 'outlet'
    : rawBody.locationType === 'headoffice' ? 'headoffice'
    : (existingRaw.location_type === 'warehouse' ? 'warehouse'
       : existingRaw.location_type === 'headoffice' ? 'headoffice'
       : 'outlet');
  // Head Office is singular: id fixed at 1 (the branch HO item stock lives
  // under), never taken from the body.
  const rawNewLocationId = newLocationType === 'headoffice'
    ? 1
    : (rawBody.locationId ?? parsed.data.outletId
       ?? existingRaw.location_id ?? existingRaw.outlet_id);
  const newLocationId: number = Number(rawNewLocationId);
  if (rawNewLocationId == null || rawNewLocationId === '' || !Number.isFinite(newLocationId)) {
    res.status(400).json({ error: "The sale's location could not be determined. Send locationType and locationId." });
    return;
  }
  // Existing-record scope prevents edits to another branch's invoice. This
  // independent check prevents using an otherwise permitted invoice as a
  // vehicle to move stock and accounting effects into a foreign location.
  if (!isLocationInScope(existingScope, newLocationType, newLocationId)) {
    res.status(403).json({ error: "You can only move a sale to a location in your assigned scope." });
    return;
  }

  // Old location (for stock reversal)
  const oldLocationType: string = existingRaw.location_type ?? 'outlet';
  const oldLocationId: number = existingRaw.location_id ?? existingRaw.outlet_id;

  // Retired outlets are read-only: a bill may not be moved ONTO an outlet, and a
  // historical outlet bill may not be rewritten (editing it would re-post that
  // outlet's stock and ledgers). Both ends are checked because either one is an
  // outlet write.
  if ((newLocationType === 'outlet' || oldLocationType === 'outlet') && await outletWritesBlocked(pgPool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Determine inter-state — the EDITED sale's location vs the customer, same
  // rule as creation (see POST). Editing the customer or moving the bill to a
  // location in another state therefore recomputes CGST/SGST vs IGST.
  let company = (await db.select().from(companySettingsTable).limit(1))[0];
  if (!company) { [company] = await db.insert(companySettingsTable).values({}).returning(); }
  const companyState = (company.state ?? '').trim().toLowerCase();

  let customerState = '';
  if (parsed.data.customerId) {
    const [cust] = await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1);
    customerState = (cust?.state ?? '').trim().toLowerCase();
  }
  const sellerGst = await resolveLocationGst(pgPool, newLocationType, newLocationId);
  const isInterState = isInterStateSupply(
    { state: sellerGst.state || companyState, stateCode: sellerGst.stateCode },
    customerState,
  );

  // Fetch item tax rates
  const itemIds = [...new Set(rawLineItems.map(li => li.itemId))];
  const itemsData = itemIds.length > 0
    ? await db.select({ id: itemsTable.id, taxRate: itemsTable.taxRate, name: itemsTable.name, hsnCode: itemsTable.hsnCode, unit: itemsTable.unit })
        .from(itemsTable).where(inArray(itemsTable.id, itemIds))
    : [];
  const itemTaxMap = new Map(itemsData.map(i => [i.id, { taxRate: Number(i.taxRate), name: i.name, hsnCode: i.hsnCode, unit: i.unit }]));

  // ── MRP floor (edit) ──────────────────────────────────────────────────────
  // Same rule as creation, with grandfathering: a line saved before a later
  // master-MRP increase keeps its saved price as the floor (min(master,
  // saved)), so old invoices stay editable as long as no price is reduced
  // further. Floors come from the sale's STORED lines, never the request.
  const savedFloors = new Map<number, number>();
  {
    const storedLines: any[] = typeof existingRaw.line_items === 'string'
      ? (() => { try { return JSON.parse(existingRaw.line_items); } catch { return []; } })()
      : (existingRaw.line_items ?? []);
    for (const li of storedLines) {
      const iid = Number(li?.itemId); const p = Number(li?.unitPrice);
      if (!iid || !Number.isFinite(p) || p <= 0) continue;
      const prev = savedFloors.get(iid);
      savedFloors.set(iid, prev === undefined ? p : Math.min(prev, p));
    }
  }
  const mrpCheck = await checkMrpFloor(pgPool, rawLineItems, savedFloors);
  if (!mrpCheck.ok) {
    res.status(400).json({ error: mrpCheck.error, code: 'MRP_BELOW_MASTER' });
    return;
  }

  // Build enriched line items — the SAME canonical computation as creation
  // (per-unit item discounts, pre-tax bill discount allocation, then tax).
  const built = buildSaleLines(rawLineItems, itemTaxMap, isInterState, (parsed.data as any).billDiscount ?? rawBody.billDiscount);
  if (!built.ok) { res.status(400).json({ error: built.error }); return; }
  const lineItems = built.lineItems;
  const billDiscount = built.billDiscount;

  const subtotal = lineItems.reduce((s, li) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s, li) => s + li.taxAmount, 0);
  // Coupon discount ONLY — post-tax; see POST handler for the semantics.
  const rawDiscountTotal = Number(rawBody.discountTotal ?? 0);
  if (!Number.isFinite(rawDiscountTotal) || rawDiscountTotal < 0) {
    res.status(400).json({ error: 'discountTotal must be a non-negative amount' });
    return;
  }
  if (rawDiscountTotal > subtotal + taxTotal + 0.004) {
    res.status(400).json({ error: 'Coupon discount cannot exceed the invoice amount' });
    return;
  }
  const discountTotal = Math.round(rawDiscountTotal * 100) / 100;

  // ── Other Charges on edit ─────────────────────────────────────────────────
  // A supplied list REPLACES the stored one (full-body PUT semantics, same as
  // the line items); an ABSENT field preserves what the invoice already
  // carries, so a payment-mode or quantity fix never silently wipes charges.
  // Same SALE validation as creation (new picks must be Direct Income), with
  // the invoice's already-stored charge ledgers grandfathered so a historical
  // expense-ledger charge keeps its stored meaning through unrelated edits.
  let otherCharges: OtherCharge[];
  if (rawBody.otherCharges === undefined) {
    otherCharges = parseStoredOtherCharges(existingRaw.other_charges);
  } else {
    const storedChargeLedgerIds = new Set(
      parseStoredOtherCharges(existingRaw.other_charges).map((c) => c.ledgerId),
    );
    const ocParsed = await validateSaleOtherCharges(pgPool, rawBody.otherCharges, {
      grandfatheredLedgerIds: storedChargeLedgerIds,
    });
    if ('error' in ocParsed) { res.status(400).json({ error: ocParsed.error }); return; }
    otherCharges = ocParsed.charges;
  }
  const otherChargesTot = otherChargesTotal(otherCharges);

  const totalAmount = Math.round((subtotal + taxTotal - discountTotal + otherChargesTot) * 100) / 100;

  // ── POS entry flags: edits may keep, but not grow, existing amounts ───────
  // Guard the EFFECTIVE value against what the sale already stored: a historical
  // discounted/couponed invoice must stay editable (qty fixes, payment mode)
  // after the flag is switched off, but the edit must not introduce a new
  // discount/coupon or increase the recorded one. Strict zero here would strand
  // every old discounted invoice; no guard at all would let edits route around
  // the setting entirely.
  {
    const posFlags = await getPosEntryFlags(pgPool);
    if (!posFlags.discountsEnabled || !posFlags.couponsEnabled) {
      const existingLines: any[] = typeof existingRaw.line_items === 'string'
        ? (() => { try { return JSON.parse(existingRaw.line_items); } catch { return []; } })()
        : (existingRaw.line_items ?? []);
      const existingPreTax = existingLines.reduce((s, li) => s + Number(li?.discount ?? 0), 0);
      const newPreTax = lineItems.reduce((s, li) => s + Number(li.discount ?? 0), 0);
      if (!posFlags.discountsEnabled && newPreTax > existingPreTax + 0.01) {
        res.status(400).json({ error: DISCOUNTS_DISABLED_MESSAGE, code: DISCOUNTS_DISABLED_CODE });
        return;
      }
      const existingCouponValue = Number(existingRaw.discount_total ?? 0);
      const existingCouponCode = String(existingRaw.coupon_code ?? '').trim().toUpperCase();
      const newCouponCode = (parsed.data.couponCode ?? '').trim().toUpperCase();
      if (!posFlags.couponsEnabled && (
        discountTotal > existingCouponValue + 0.01 ||
        (newCouponCode !== '' && newCouponCode !== existingCouponCode)
      )) {
        res.status(400).json({ error: COUPONS_DISABLED_MESSAGE, code: COUPONS_DISABLED_CODE });
        return;
      }
    }
  }

  // ── Credit limit check on edit ────────────────────────────────────────────
  // The guard itself runs INSIDE the edit transaction (below), under the same
  // per-customer advisory lock the create path takes — checking here, outside
  // the transaction, would let two concurrent writes both read the old balance
  // and both pass.
  const newPaymentModeForCredit = effectivePaymentMode;
  const isEditCreditControlled = !!parsed.data.customerId && newPaymentModeForCredit === 'credit';

  // ── Stock and sale row: one transaction ───────────────────────────────────
  // An edit reverses the bill's old lines and applies the new ones. Both halves
  // and the sale row itself move together: a failure part-way used to leave
  // stock credited back with the bill unchanged, and the re-apply had no
  // availability check at all, so an edit could overdraw a location until the
  // negative-stock constraint threw a raw database error at the user.
  //
  // Every stock_entries row is locked before it is judged, in ascending item
  // order, so a concurrent bill for the same item waits rather than reading a
  // quantity that is about to change.
  const oldLineItems = (existingRaw.line_items ?? []) as Array<{ itemId: number; quantity: number; batchBreakdown?: any[] }>;
  const oldTotal = Number(existingRaw.total_amount);
  const oldCustomerId = existingRaw.customer_id as number | null;
  const newPaymentMode = effectivePaymentMode;
  let newAmountPaid = totalAmount;
  let newPaymentStatus = 'paid';
  if (!isSettledAtSale(newPaymentMode)) {
    // Credit sales re-derive amount_paid from recorded sale_payments so an edit
    // never wipes out collected payments.
    const { rows: [pp] } = await pgPool.query<{ paid: string }>(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`, [id]
    );
    newAmountPaid = Number(pp?.paid ?? 0);
    newPaymentStatus = newAmountPaid >= totalAmount - 0.004 ? 'paid' : newAmountPaid > 0.004 ? 'partially_paid' : 'unpaid';
  }
  // The edit may lower the bill below what has already been collected —
  // payments are never wiped, so the excess becomes a credit held for the
  // customer. Under the single-ledger model that credit simply lands on the
  // customer's own CUST- ledger (which exists with the customer); nothing
  // needs provisioning here.
  const newOutletId = newLocationType === 'outlet' ? newLocationId : null;

  // ── Everything the edit transaction will need, resolved before it opens ───
  // An edit has to restate the accounting receipt as well as the stock, so the
  // ledgers for the (possibly new) location are looked up here rather than
  // inside the transaction.
  const { rows: [editLoc] } = newLocationType === 'headoffice'
    ? { rows: [undefined as any] }
    : await pgPool.query<{
        name: string; upi_id: string | null; cash_ledger_id: number | null; sales_ledger_id: number | null;
      }>(
        newLocationType === 'warehouse'
          ? `SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM warehouses WHERE id = $1`
          : `SELECT name, upi_id, cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`,
        [newLocationId]
      );
  // Head Office has no per-location ledgers — the derived postings fall back
  // to STD-CASH / STD-SALES, matching how HO sales are created.
  const locationName = newLocationType === 'headoffice' ? 'Head Office' : (editLoc?.name ?? '');
  const locationUpiId = newLocationType === 'headoffice' ? '' : (editLoc?.upi_id ?? '');
  const editSalesLedgerId = editLoc?.sales_ledger_id ?? null;
  const editCashLedgerId = editLoc?.cash_ledger_id ?? null;

  let editElecClrId: number | null = null;
  if (clearsThroughBank(newPaymentMode)) {
    const { rows: [clr] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
    );
    editElecClrId = clr?.id ?? null;
  }
  let editCustLedgerId: number | null = null;
  if (newPaymentMode === 'credit' && parsed.data.customerId) {
    const { rows: [cl] } = await pgPool.query<{ id: number }>(
      `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${parsed.data.customerId}`]
    );
    editCustLedgerId = cl?.id ?? null;
  }
  const [editMeta, editBranchNameOf] = await Promise.all([
    batchResolveMeta(pool, [...oldLineItems, ...lineItems].map(li => ({ materialType: 'item' as const, refId: li.itemId }))),
    buildBranchMaps(),
  ]);

  const editTx = await pgPool.connect();
  let updated: any;
  const newLineItemsWithBatches: any[] = [];
  try {
    await editTx.query('BEGIN');

    // ── Serialize on the sale row, then re-derive the paid figure ──────────
    // Collection-receipt deletes (allocation and the admin system delete)
    // remove sale_payments rows and rewrite amount_paid under this same row
    // lock. The SUM read before this transaction opened could therefore be
    // stale by the time we write; the figure that goes into the UPDATE must
    // come from the state visible AFTER the lock is held, or a concurrent
    // unwind is silently overwritten.
    await editTx.query(`SELECT id FROM sales WHERE id = $1 FOR UPDATE`, [id]);
    // ── Counter-settlement history follows the edit ──────────────────────────
    // The counter row is a restatement of the sale's own settlement, so an edit
    // must never leave a stale one behind. Clear any existing counter leg under
    // the row lock FIRST — before the credit re-derivation below sums the legs,
    // so converting a cash bill to credit does not count the old counter row as
    // a collection. A fresh counter leg for the edited total is written after
    // the UPDATE (below) when the new mode is still settled at the counter.
    await editTx.query(`DELETE FROM sale_payments WHERE sale_id = $1 AND source = 'counter'`, [id]);
    if (!isSettledAtSale(newPaymentMode)) {
      const { rows: [lockedPaid] } = await editTx.query<{ paid: string }>(
        `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`, [id]
      );
      newAmountPaid = Number(lockedPaid?.paid ?? 0);
      newPaymentStatus = newAmountPaid >= totalAmount - 0.004 ? 'paid' : newAmountPaid > 0.004 ? 'partially_paid' : 'unpaid';
    }

    // ── Credit limit check on edit ───────────────────────────────────────────
    // Mirror of the POST credit-limit guard so edits can't silently bypass it.
    // Serialized on the same per-customer advisory lock the create path takes,
    // and taken BEFORE any stock row locks — the same relative order as
    // creation — so the two paths queue rather than deadlock.
    if (isEditCreditControlled) {
      const editCustomerId = parsed.data.customerId!;
      await editTx.query(
        `SELECT pg_advisory_xact_lock(hashtext('customer-credit'), $1)`,
        [editCustomerId]
      );
      const { rows: [editCC] } = await editTx.query<{ credit_limit: string }>(
        `SELECT COALESCE(credit_limit, 0)::numeric AS credit_limit FROM customers WHERE id = $1`,
        [editCustomerId]
      );
      const editCreditLimit = Number(editCC?.credit_limit ?? 0);
      if (editCreditLimit > 0) {
        // Exposure is the customer's LEDGER balance, minus what THIS sale
        // currently contributes to it (the edit replaces that contribution).
        // The old document arithmetic missed opening balances, manual journals
        // and credit notes, and silently ignored non-credit invoices' dues.
        const { currentPartyStatement } = await import("../lib/ledgerBalances");
        const st = await currentPartyStatement("customer", editCustomerId, { q: editTx });
        // Only subtract the old contribution when the sale already sits on THIS
        // customer's ledger — reassigning a sale to a new customer brings its
        // whole unpaid remainder along as fresh exposure.
        const oldContribution = Number(existingRaw.customer_id) === editCustomerId
          ? Number(existingRaw.total_amount ?? 0) - Number(existingRaw.amount_paid ?? 0)
          : 0;
        const currentOutstanding = Math.max(0, Math.round((Number(st.closing ?? 0) - oldContribution) * 100) / 100);
        // What will actually stand collected on this sale AFTER the edit, with
        // the SAME semantics the save path uses for credit sales: amount_paid
        // is re-derived from recorded sale_payments. The stored amount_paid
        // must NOT be used here — a settled cash sale being converted to
        // credit has amount_paid = total, which would project zero new
        // exposure while the saved edit creates the full receivable.
        const { rows: [paidRow] } = await editTx.query<{ paid: string }>(
          `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`,
          [id]
        );
        const paidOnThisSale = Number(paidRow?.paid ?? 0);
        const projectedOutstanding = Math.round((currentOutstanding + Math.max(0, totalAmount - paidOnThisSale)) * 100) / 100;

        if (projectedOutstanding > editCreditLimit + 0.009) {
          const editOverrideRequested = (req.body as any).creditOverride === true;
          const overrideAllowed = editOverrideRequested
            && await hasModuleAction(req.employee?.hierarchyId, CREDIT_OVERRIDE_PAGES, "edit");
          if (!overrideAllowed) {
            await editTx.query('ROLLBACK');
            if (editOverrideRequested) {
              res.status(403).json({
                error: CREDIT_OVERRIDE_DENIED_MESSAGE,
                code: 'CREDIT_LIMIT_OVERRIDE_DENIED',
              });
            } else {
              res.status(422).json({
                error: `Credit limit exceeded: current outstanding ₹${currentOutstanding.toFixed(2)} plus this sale of ₹${totalAmount.toFixed(2)} exceeds the credit limit of ₹${editCreditLimit.toFixed(2)}.`,
                code: 'CREDIT_LIMIT_EXCEEDED',
                creditLimit: editCreditLimit,
                currentOutstanding,
                projectedOutstanding,
              });
            }
            return;
          }
        }
      }
    }

    // 0. Take every stock lock this edit will need, up front, in one globally
    //    deterministic order.
    //
    //    Reversing the old lines and applying the new ones are two separate
    //    passes, each sorted only within itself. That is not enough: an edit
    //    moving item 1 -> item 2 locks 1 then 2, while a concurrent edit moving
    //    2 -> 1 locks 2 then 1, and the two deadlock. Ordering the union of both
    //    passes by (item, location) gives every concurrent edit the same
    //    acquisition order, so they queue instead of deadlocking.
    //
    //    Rows that do not exist yet cannot be locked here; the reversal pass
    //    inserts them, which is safe because a row nobody has can't be
    //    contended for its quantity.
    const lockKeys = Array.from(new Set([
      ...oldLineItems.map(li => `${Number(li.itemId)}|${oldLocationType}|${Number(oldLocationId)}`),
      ...lineItems.map(li => `${Number(li.itemId)}|${newLocationType}|${Number(newLocationId)}`),
    ]));
    if (lockKeys.length > 0) {
      await editTx.query(
        `SELECT id FROM stock_entries
          WHERE material_type = 'item'
            AND (item_id::text || '|' || branch_type || '|' || branch_id::text) = ANY($1::text[])
          ORDER BY item_id, branch_type, branch_id
          FOR UPDATE`,
        [lockKeys]
      );
    }

    // 1. Reverse the old lines: credit the quantity back and restore the exact
    //    lots the bill consumed. Legacy lines without a stored breakdown leave
    //    batches untouched (the residual shows as untracked).
    for (const li of [...oldLineItems].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
      const { rows: [se] } = await editTx.query<{ id: number }>(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
          LIMIT 1 FOR UPDATE`,
        [li.itemId, oldLocationType, oldLocationId]
      );
      if (se) {
        await editTx.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [li.quantity, se.id]
        );
      } else {
        await editTx.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, '0')`,
          [li.itemId, oldLocationType, oldLocationId, li.quantity]
        );
      }
      await restoreBatches(editTx, li.itemId, oldLocationType, oldLocationId, li.batchBreakdown, "sale", id);
    }

    // 2. Apply the new lines against available stock (on hand − held). The old
    //    lines are already back in stock above, so an edit that keeps the same
    //    quantity always passes.
    const editOrder = lineItems.map((_, i) => i).sort((a, b) => lineItems[a].itemId - lineItems[b].itemId);
    const editBreakdowns: any[] = new Array(lineItems.length);
    for (const idx of editOrder) {
      const li = lineItems[idx];
      const avail = await availabilityAt(editTx, {
        refId: li.itemId, materialType: 'item',
        branchType: newLocationType, branchId: newLocationId, lock: true,
      });
      if (avail.available + 0.001 < Number(li.quantity)) {
        await editTx.query('ROLLBACK');
        // Named only when refusing, so the happy path costs no extra query.
        const { rows: [locRow] } = newLocationType === 'headoffice'
          ? { rows: [{ name: 'Head Office' }] }
          : await pgPool.query<{ name: string }>(
              newLocationType === 'warehouse'
                ? `SELECT name FROM warehouses WHERE id = $1`
                : `SELECT name FROM outlets WHERE id = $1`,
              [newLocationId]
            );
        res.status(400).json({
          error: insufficientStockMessage({
            productName: li.itemName || `Item #${li.itemId}`,
            locationName: locRow?.name ?? null, unit: li.unit,
            quantity: avail.quantity, reserved: avail.reserved,
            requested: Number(li.quantity),
          }),
          code: 'INSUFFICIENT_STOCK',
          itemId: li.itemId,
          available: avail.available,
          reserved: avail.reserved,
          onHand: avail.quantity,
          requested: Number(li.quantity),
        });
        return;
      }
      await editTx.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, avail.entryId]
      );
      editBreakdowns[idx] = await consumeBatches(editTx, {
        itemId: li.itemId, branchType: newLocationType, branchId: newLocationId, quantity: li.quantity,
      });
    }
    for (let i = 0; i < lineItems.length; i++) {
      newLineItemsWithBatches.push({ ...lineItems[i], batchBreakdown: editBreakdowns[i] ?? [] });
    }

    // 3. The sale row, carrying the lots that now serve it. An edit may move
    //    the sale to another location, so the folded number scope is
    //    recomputed with it — if the kept invoice number already exists at
    //    the destination, the unique index refuses the move loudly instead of
    //    leaving a stale identity behind.
    const editedNumberScope = await salesCounterScope(editTx, { type: newLocationType, id: newLocationId });
    ({ rows: [updated] } = await editTx.query<any>(
      `UPDATE sales SET outlet_id=$1, location_type=$2, location_id=$3, customer_id=$4, sale_date=$5,
       line_items=$6::jsonb, subtotal=$7, tax_total=$8, discount_total=$9, bill_discount=$10, total_amount=$11,
       payment_mode=$12, coupon_code=$13, amount_paid=$14, payment_status=$15, number_scope=$17, other_charges=$18::jsonb
       WHERE id=$16 RETURNING *`,
      [newOutletId, newLocationType, newLocationId, parsed.data.customerId ?? null,
       parsed.data.saleDate, JSON.stringify(newLineItemsWithBatches), subtotal, taxTotal, discountTotal, billDiscount, totalAmount,
       newPaymentMode, parsed.data.couponCode ?? null, newAmountPaid, newPaymentStatus, id, editedNumberScope,
       JSON.stringify(otherCharges)]
    ));

    // 3b. Restate the counter-settlement history to the edited bill. The old
    //     counter leg was cleared under the row lock above; when the edited
    //     mode is still settled at the counter, write exactly ONE fresh leg for
    //     the remainder that hit the till/bank (total minus any other recorded
    //     legs — advance adjustments, collections). Cash needs no
    //     reconciliation; electronic modes enter 'pending'. Converting to
    //     credit leaves NO counter leg — a credit bill is never settled at the
    //     counter, so no history is invented. History-only, no postings: the
    //     books derive the same slice either way (see journal.ts).
    if (isSettledAtSale(newPaymentMode)) {
      const { rows: [nonCounter] } = await editTx.query<{ paid: string }>(
        `SELECT COALESCE(SUM(amount::numeric), 0) AS paid FROM sale_payments WHERE sale_id = $1`, [id]
      );
      const counterAmount = round2(totalAmount - Number(nonCounter?.paid ?? 0));
      if (counterAmount > 0.004) {
        await editTx.query(
          `INSERT INTO sale_payments
             (sale_id, payment_date, method, amount, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by, source)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 'counter')`,
          [id, parsed.data.saleDate, newPaymentMode, counterAmount,
           `Settled at counter — ${existingRaw.invoice_number}`,
           newPaymentMode === 'cash' ? null : 'pending',
           newOutletId, (req as any).employee?.username ?? null]
        );
      }
    }

    // 4. Ledger the reversal before the re-apply so the trail reads
    //    out → back-in → out again, and the running balance stays truthful.
    //    Inside the transaction: an edit that moved stock but lost its movement
    //    rows leaves a ledger that can never be reconciled to the quantity.
    await writeStockLedger(editTx, oldLineItems.map(li => {
      const m = editMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale_reversal', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: oldLocationType, branchId: oldLocationId,
        branchName: editBranchNameOf(oldLocationType, oldLocationId),
        qtyChange: Number(li.quantity),
        unitCost: Number((li as any).unitPrice ?? 0),
        docType: 'sale', docId: id,
        txnDate: toTxnDate(existingRaw.sale_date),
        notes: `${existingRaw.invoice_number} — reversed for edit`,
      };
    }));
    await writeStockLedger(editTx, lineItems.map(li => {
      const m = editMeta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: newLocationType, branchId: newLocationId,
        branchName: editBranchNameOf(newLocationType, newLocationId),
        qtyChange: -Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: id,
        txnDate: parsed.data.saleDate,
        notes: `${existingRaw.invoice_number} — re-applied after edit`,
      };
    }));

    // 5. Customer running totals: take the old bill off, put the new one on.
    if (oldCustomerId) {
      await editTx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric - $1 WHERE id = $2`,
        [oldTotal, oldCustomerId]
      );
    }
    if (parsed.data.customerId) {
      await editTx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric + $1 WHERE id = $2`,
        [totalAmount, parsed.data.customerId]
      );
    }

    // 6. Restate the accounting receipt. An edit used to change the amount, the
    //    payment mode or the location and leave the original receipt standing,
    //    so the cash and bank books drifted away from the sales register with
    //    nothing to show why. The old receipt for this invoice is withdrawn and
    //    the current one written in its place, in the same transaction.
    //    Numbers are only unique PER LOCATION, so the delete may not key on the
    //    text alone — the same number at another location would lose its
    //    receipt too. When the number is shared, require the receipt to carry
    //    this sale's stored location; when it is unique (all legacy rows,
    //    whose receipts may predate location stamping), the number suffices.
    await editTx.query(
      `DELETE FROM receipts r
        WHERE r.voucher_number = $1
          AND (NOT EXISTS (SELECT 1 FROM sales s2 WHERE s2.invoice_number = $1 AND s2.id <> $2)
               OR (r.location_type = $3 AND COALESCE(r.location_id, 0) = $4))`,
      [existingRaw.invoice_number, id,
       existingRaw.location_type ?? 'outlet',
       Number(existingRaw.location_id ?? existingRaw.outlet_id ?? 0)]
    );
    if (editSalesLedgerId) {
      let debitLedgerId = editCashLedgerId;
      if (clearsThroughBank(newPaymentMode) && editElecClrId) debitLedgerId = editElecClrId;
      else if (newPaymentMode === 'credit' && editCustLedgerId) debitLedgerId = editCustLedgerId;
      if (debitLedgerId) {
        await editTx.query(
          `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, voucher_number, location_type, location_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale')`,
          [parsed.data.saleDate, editSalesLedgerId, debitLedgerId, totalAmount,
           `Sale: ${existingRaw.invoice_number}${locationName ? ` at ${locationName}` : ''}`,
           existingRaw.invoice_number, newLocationType, newLocationId]
        );
      }
    }

    await editTx.query('COMMIT');
  } catch (txErr) {
    try { await editTx.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    editTx.release();
  }

  const customerName = parsed.data.customerId
    ? (await db.select().from(customersTable).where(eq(customersTable.id, parsed.data.customerId)).limit(1))[0]?.name ?? null
    : null;

  logActivity({
    action: "UPDATE", module: "sales", entityType: "sale", entityId: id,
    description: `Sale ${existingRaw.invoice_number} updated — ₹${totalAmount.toFixed(2)}`,
    metadata: { before: { totalAmount: oldTotal }, after: { totalAmount } },
  }).catch(() => {});

  // Re-read the shared position after the edit: the new total may have changed
  // what is owed, and credit notes raised against this invoice still count.
  const editedPosition = await loadPaymentPosition(pgPool, Number(updated.id));

  res.json({
    id: updated.id,
    invoiceNumber: updated.invoice_number,
    outletId: updated.outlet_id,
    locationType: updated.location_type,
    locationId: updated.location_id,
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
    saleDate: updated.sale_date,
    lineItems: updated.line_items ?? [],
    subtotal: Number(updated.subtotal),
    taxTotal: Number(updated.tax_total),
    discountTotal: Number(updated.discount_total),
    totalAmount: Number(updated.total_amount),
    paymentMode: updated.payment_mode,
    couponCode: updated.coupon_code,
    otherCharges,
    otherChargesTotal: otherChargesTot,
    createdAt: updated.created_at,
    paymentStatus: editedPosition?.status ?? updated.payment_status ?? 'paid',
    amountPaid: Number(updated.amount_paid ?? 0),
    amountReceived: editedPosition?.amountReceived ?? Number(updated.amount_paid ?? 0),
    creditAdjustments: editedPosition?.creditAdjustments ?? 0,
    amountDue: editedPosition?.amountDue ?? totalAmount,
    balanceDue: editedPosition?.outstanding ?? Math.max(0, totalAmount - Number(updated.amount_paid ?? 0)),
    isCancelled: editedPosition?.isCancelled ?? false,
  });
});

// ── Cancel Sale ───────────────────────────────────────────────────────────────
//
// Cancelling used to be something only the branch-transfer code could do, by
// stamping `cancelled_at` and nothing else: stock stayed sold, the receipt
// stayed in the cash book, the customer stayed charged and the movement trail
// showed goods leaving that were still on the shelf. The GST and sales reports
// dropped the bill while the books kept it, so the two never agreed again.
//
// A cancellation now reverses every consequence of the sale in one transaction,
// and `buildDerivedPostings` skips cancelled customer invoices, so revenue,
// output GST and the debtor balance all fall away with it.
router.post("/sales/:id/cancel", requireModuleAction("page:/sales/pos", "delete"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
  const reason = typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).trim() : '';

  const { pool: pgPool } = await import("@workspace/db");
  const branchNameOf = await buildBranchMaps();

  const tx = await pgPool.connect();
  try {
    await tx.query('BEGIN');

    const { rows: [sale] } = await tx.query<any>(
      `SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!sale) {
      await tx.query('ROLLBACK');
      res.status(404).json({ error: "Sale not found" }); return;
    }
    const cancelScope = await getUserDataScope((req as any).employee);
    if (!isLocationInScope(
      cancelScope,
      sale.location_type ?? "outlet",
      sale.location_id ?? sale.outlet_id,
    )) {
      await tx.query('ROLLBACK');
      res.status(404).json({ error: "Sale not found" }); return;
    }
    if (sale.cancelled_at) {
      await tx.query('ROLLBACK');
      res.status(409).json({ error: `Invoice ${sale.invoice_number} is already cancelled.`, code: 'ALREADY_CANCELLED' }); return;
    }
    // A branch-transfer invoice is owned by the transfer that raised it. Reject
    // the transfer instead — that path raises the credit note which reverses
    // both legs and the tax with them.
    if (sale.branch_transfer_id != null) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: 'This invoice belongs to a branch transfer. Reject the transfer to reverse it.',
        code: 'BRANCH_TRANSFER_INVOICE',
      }); return;
    }
    // Month lock: a cancelled sale reverses stock and books in its own month —
    // frozen once the month is locked.
    {
      const ym = ymOfDate(sale.sale_date);
      if (ym && await isMonthLocked(tx, ym.year, ym.month)) {
        await tx.query('ROLLBACK');
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }
    // Money already banked, or goods already taken back, mean the bill has a
    // life of its own. Reversing it silently would strand those records.
    // An adjusted ADVANCE is the one exception: no cash changed hands at this
    // bill — the money is still the customer's, merely parked against it — so
    // cancellation returns the slice to their advance instead of blocking.
    // A counter-settlement leg (source='counter') is till money, NOT a banked
    // collection — it is the sale's own settlement history, so it must never
    // block cancellation. It leaves with the bill below, exactly as the
    // remainder it displays would. Advance legs are handled separately (the
    // parked money returns to the customer's advance). Only a REAL collection
    // (a receipt-backed payment) blocks a cancel.
    const { rows: [pay] } = await tx.query<{ n: string; amt: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount::numeric), 0)::text AS amt
         FROM sale_payments
        WHERE sale_id = $1 AND method <> 'advance'
          AND COALESCE(source, '') <> 'counter'`, [id]
    );
    if (Number(pay?.n ?? 0) > 0) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: `₹${Number(pay.amt).toFixed(2)} has already been collected against ${sale.invoice_number}. Refund or raise a credit note instead of cancelling.`,
        code: 'PAYMENTS_RECORDED',
      }); return;
    }
    // Remove the counter-settlement history with the bill — no orphan row may
    // remain (audit F-1). No receipt/voucher to reverse; the derived books drop
    // the sale's postings on their own once cancelled_at is set.
    await tx.query(`DELETE FROM sale_payments WHERE sale_id = $1 AND source = 'counter'`, [id]);
    const { rows: [advPay] } = await tx.query<{ n: string; amt: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount::numeric), 0)::text AS amt
         FROM sale_payments WHERE sale_id = $1 AND method = 'advance'`, [id]
    );
    const advToRestore = Number(advPay?.amt ?? 0);
    if (advToRestore > 0 && sale.customer_id) {
      // Same lock order as sale creation (advance lock before stock rows).
      // Deleting the consumption rows frees the parked money and unpins the
      // slice from the voucher(s) that funded it, in this same transaction —
      // the derived postings drop the Dr-advance leg with the row itself.
      await takeAdvanceLock(tx, 'customer', Number(sale.customer_id));
      await tx.query(`DELETE FROM sale_payments WHERE sale_id = $1 AND method = 'advance'`, [id]);
      await releaseAdvanceConsumption(tx, { saleId: id });
      await tx.query(
        `UPDATE sales SET amount_paid = GREATEST(0, amount_paid::numeric - $2) WHERE id = $1`,
        [id, advToRestore],
      );
    }
    const { rows: [ret] } = await tx.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales_returns WHERE sale_id = $1`, [id]
    );
    if (Number(ret?.n ?? 0) > 0) {
      await tx.query('ROLLBACK');
      res.status(409).json({
        error: `${sale.invoice_number} already has a sales return against it. Cancel the return first.`,
        code: 'RETURN_EXISTS',
      }); return;
    }

    const locType: string = sale.location_type ?? 'outlet';
    const locId: number = sale.location_id ?? sale.outlet_id;
    if (locType === 'outlet' && await outletWritesBlocked(pgPool)) {
      await tx.query('ROLLBACK');
      res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
    }

    const lines = (sale.line_items ?? []) as Array<{ itemId: number; quantity: number; unitPrice?: number; batchBreakdown?: any[] }>;

    // Put the goods back, in ascending item order so a concurrent bill for the
    // same item queues behind this instead of deadlocking against it.
    for (const li of [...lines].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
      const { rows: [se] } = await tx.query<{ id: number }>(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
          LIMIT 1 FOR UPDATE`,
        [li.itemId, locType, locId]
      );
      if (se) {
        await tx.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [li.quantity, se.id]
        );
      } else {
        await tx.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, '0')`,
          [li.itemId, locType, locId, li.quantity]
        );
      }
      await restoreBatches(tx, li.itemId, locType, locId, li.batchBreakdown, "sale", id);
    }

    const meta = await batchResolveMeta(tx, lines.map(li => ({ materialType: 'item' as const, refId: li.itemId })));
    await writeStockLedger(tx, lines.map(li => {
      const m = meta.get(`item:${li.itemId}`);
      return {
        txnType: 'sale_cancellation', materialType: 'item' as const, refId: li.itemId,
        itemName: m?.name ?? '', unit: m?.unit ?? '',
        branchType: locType, branchId: locId,
        branchName: branchNameOf(locType, locId),
        qtyChange: Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: 'sale', docId: id,
        notes: `${sale.invoice_number} — cancelled${reason ? `: ${reason}` : ''}`,
      };
    }));

    if (sale.customer_id) {
      await tx.query(
        `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric - $1 WHERE id = $2`,
        [Number(sale.total_amount), sale.customer_id]
      );
    }

    // Withdraw the cash-book side. The derived postings drop the revenue, the
    // output GST and the debtor leg on their own once `cancelled_at` is set.
    // Numbers are unique per location only — when another location shares this
    // number, the delete must also match this sale's location or it would
    // withdraw the twin's receipt. Unique numbers (all legacy rows) keep the
    // plain text match, since their receipts may predate location stamping.
    await tx.query(
      `DELETE FROM receipts r
        WHERE r.voucher_number = $1
          AND (NOT EXISTS (SELECT 1 FROM sales s2 WHERE s2.invoice_number = $1 AND s2.id <> $2)
               OR (r.location_type = $3 AND COALESCE(r.location_id, 0) = $4))`,
      [sale.invoice_number, id, locType, Number(locId ?? 0)]
    );

    await tx.query(`UPDATE sales SET cancelled_at = now() WHERE id = $1`, [id]);

    await tx.query('COMMIT');

    logActivity({
      action: "DELETE", module: "sales", entityType: "sale", entityId: id,
      description: `Sale ${sale.invoice_number} cancelled — ₹${Number(sale.total_amount).toFixed(2)}${reason ? ` (${reason})` : ''}`,
      metadata: { before: { totalAmount: Number(sale.total_amount), lineCount: lines.length }, reason },
    }).catch(() => {});

    res.json({
      id,
      invoiceNumber: sale.invoice_number,
      cancelled: true,
      reversedLines: lines.length,
      totalAmount: Number(sale.total_amount),
    });
  } catch (txErr) {
    try { await tx.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw txErr;
  } finally {
    tx.release();
  }
});

// Summary totals + per-location breakdown. Raw SQL because location_type /
// location_id are startup-migration columns invisible to drizzle — the old
// drizzle version grouped warehouse sales under their fallback outlet_id,
// losing them from the breakdown (bug #37).
// No mapped consumer; serves the POS and Dashboard sales figures.
// ── Customer price history ────────────────────────────────────────────────────
// Read-only helper for the POS item picker: the last few prices THIS customer
// actually paid for THIS item, so the operator can quote consistently. Derived
// from source documents (sales.line_items), never stock_ledger; cancelled
// invoices and branch-transfer documents are excluded. Informational only —
// nothing here ever auto-applies a price. Registered BEFORE /sales/:id so the
// literal path wins the route match.
router.get("/sales/price-history", requireModuleView("page:/sales/pos"), async (req, res): Promise<void> => {
  const customerId = Number(req.query.customerId);
  const itemId = Number(req.query.itemId);
  if (!Number.isInteger(customerId) || customerId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
    res.status(400).json({ error: "customerId and itemId are required" });
    return;
  }
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10) : 5;

  // LBAC: only sales the caller may see feed the history — a branch user never
  // learns what another location charged.
  const phScope = await getUserDataScope((req as any).employee);
  const phParams: any[] = [customerId, itemId];
  const phScopeCond = scopeSalesWhere(phScope, phParams);
  phParams.push(limit);

  const { pool: pgPool } = await import("@workspace/db");
  const { rows } = await pgPool.query(
    `SELECT s.id, s.invoice_number, s.sale_date,
            (li->>'quantity')::numeric   AS quantity,
            (li->>'unitPrice')::numeric  AS unit_price,
            (li->>'unitDiscount')::numeric AS unit_discount,
            (li->>'discount')::numeric   AS line_discount
       FROM sales s
       CROSS JOIN LATERAL jsonb_array_elements(s.line_items) li
      WHERE s.customer_id = $1
        AND (li->>'itemId')::numeric = $2
        AND s.cancelled_at IS NULL
        AND s.branch_transfer_id IS NULL
        AND ${phScopeCond}
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT $${phParams.length}`,
    phParams,
  );
  res.json(rows.map((r: any) => ({
    saleId: Number(r.id),
    invoiceNumber: r.invoice_number,
    saleDate: r.sale_date instanceof Date ? r.sale_date.toISOString().slice(0, 10) : String(r.sale_date).slice(0, 10),
    quantity: Number(r.quantity ?? 0),
    unitPrice: Number(r.unit_price ?? 0),
    // Per-unit item discount when the sale stored one; older rows only carry
    // the line-total discount figure, surfaced as-is (absent ≠ zero).
    unitDiscount: r.unit_discount != null ? Number(r.unit_discount) : null,
    lineDiscount: r.line_discount != null ? Number(r.line_discount) : null,
  })));
});

router.get("/sales/summary", requireModuleView(["page:/sales/pos", "page:/"]), async (req, res): Promise<void> => {
  // LBAC: scope summary to the employee's assigned location
  const { getUserDataScope, scopeSalesWhere } = await import("../lib/dataScope");
  const summEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const summScope = summEmp ? await getUserDataScope(summEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  const summParams: any[] = [];
  const summScopeCond = scopeSalesWhere(summScope, summParams);

  const { pool: pgPool } = await import("@workspace/db");
  const { rows } = await pgPool.query(`
    SELECT COALESCE(s.location_type, 'outlet')   AS location_type,
           COALESCE(s.location_id, s.outlet_id)  AS location_id,
           COUNT(*)::int                          AS invoice_count,
           COALESCE(SUM(s.total_amount::numeric), 0)::float AS sales_amount,
           COALESCE(SUM(s.tax_total::numeric), 0)::float    AS tax_amount
    FROM sales s
    WHERE s.branch_transfer_id IS NULL
      AND s.cancelled_at IS NULL
      AND ${summScopeCond}
    GROUP BY 1, 2
  `, summParams);
  const outlets = await db.select().from(outletsTable);
  const oMap = new Map(outlets.map((o) => [o.id, o.name]));
  const { rows: warehouses } = await pgPool.query<{ id: number; name: string }>(`SELECT id, name FROM warehouses`);
  const wMap = new Map(warehouses.map((w) => [w.id, w.name]));

  let totalSales = 0, totalTax = 0, totalInvoices = 0;
  const byLocation: Array<{ locationType: string; locationId: number; locationName: string; salesAmount: number; invoiceCount: number }> = [];
  for (const r of rows) {
    totalSales += Number(r.sales_amount);
    totalTax += Number(r.tax_amount);
    totalInvoices += Number(r.invoice_count);
    const locationType = r.location_type as string;
    const locationId = Number(r.location_id);
    byLocation.push({
      locationType,
      locationId,
      locationName: locationType === 'headoffice'
        ? 'Head Office'
        : (locationType === 'warehouse' ? wMap.get(locationId) : oMap.get(locationId)) ?? "",
      salesAmount: Number(r.sales_amount),
      invoiceCount: Number(r.invoice_count),
    });
  }
  byLocation.sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({
    totalSales,
    totalTax,
    totalInvoices,
    // Legacy shape: outlet rows only (warehouse sales now correctly excluded
    // instead of being misattributed to an outlet id)
    byOutlet: byLocation
      .filter((l) => l.locationType === 'outlet')
      .map((l) => ({ outletId: l.locationId, outletName: l.locationName, salesAmount: l.salesAmount, invoiceCount: l.invoiceCount })),
    byLocation,
  });
});

// Create a short-lived signed token so THIS user's browser can fetch the invoice
// PDF it is already looking at. It exists because `window.open` and a download
// navigation cannot carry an Authorization header — not as a way to publish an
// invoice. The backend verifies the sale exists (and thereby the customer
// linkage) before issuing one, so the frontend never passes phone numbers or ids
// into the PDF pipeline.
//
// The token IS the document: whoever holds it can fetch the PDF without signing
// in. So the right to mint one is a document right, and the caller says which one
// it is exercising. It used to require `add` on the sales pages — recording a sale
// and releasing a copy of it are different things, and the roles that print
// invoices are frequently not the ones that write them.
//
// Sending an invoice to a customer is NOT one of these intents. That goes through
// the share-link flow (also gated on `download` under the five-action model),
// which produces a link the office can revoke, replace and see the usage of.
//
// Download is the single right for every output channel — saving, printing and
// on-screen preview alike — so the old per-intent action table is gone.

// Minutes, not days. A month-long token was in practice an unrevocable public
// share link that anyone who could download an invoice could forward, which is
// precisely the thing the revocable share-link flow exists to control. Long
// enough here to survive a slow print dialog or a re-authenticating proxy.
// Tokens already issued carry their own signed expiry, so links customers were
// sent under the old scheme keep working until they lapse on their own.
const IN_SESSION_TOKEN_TTL_DAYS = 30 / (24 * 60);
const SHARE_PAGES = ["page:/sales/pos", "page:/outstanding"];

router.post("/sales/:id/share-token", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  // Clients may still send an `intent` field naming the button that was
  // pressed; every intent now requires the same single `download` right.
  const mayShare = await hasModuleAction(req.employee?.hierarchyId, SHARE_PAGES, "download");
  if (!mayShare) {
    res.status(403).json({
      error: "You don't have permission to download or print invoices",
    });
    return;
  }
  // LBAC: the token opens one invoice without a session, so only someone who can
  // see the sale may mint one. Scoped through the same rule the sales list uses,
  // otherwise a branch user could read any invoice by id.
  const shareScope = await getUserDataScope((req as any).employee);
  const shareParams: unknown[] = [id];
  const { rows: [row] } = await pool.query(
    `SELECT s.id FROM sales s WHERE s.id = $1 AND ${scopeSalesWhere(shareScope, shareParams)}`,
    shareParams,
  );
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { token, expiresAt } = createInvoiceShareToken(id, IN_SESSION_TOKEN_TTL_DAYS);
  res.json({ token, expiresAt });
});

// Authenticated inline invoice PDF. The View sheet embeds the invoice document
// directly; a passive sheet open must NOT be a token-issuance event (each
// share-token is a public bearer URL), so this route serves the PDF under the
// caller's own session instead. Same rights as the `preview` intent and the
// same LBAC scope rule the sales list uses.
router.get("/sales/:id/invoice.pdf", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
  const mayView = await hasModuleAction(req.employee?.hierarchyId, SHARE_PAGES, "download");
  if (!mayView) { res.status(403).json({ error: "You don't have permission to view invoices" }); return; }
  const pdfScope = await getUserDataScope((req as any).employee);
  const pdfParams: unknown[] = [id];
  const { rows: [pdfRow] } = await pool.query(
    `SELECT s.id FROM sales s WHERE s.id = $1 AND ${scopeSalesWhere(pdfScope, pdfParams)}`,
    pdfParams,
  );
  if (!pdfRow) { res.status(404).json({ error: "Not found" }); return; }
  const data = await assembleInvoiceData(id);
  if (!data) { res.status(404).json({ error: "Not found" }); return; }
  const { buffer, fileName } = await renderInvoicePdf(data);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
});

// Dispatch staff may open the bill they are packing (view-only surface —
// PDF/share stay gated on the sales page's own download right client-side,
// and every write on this sale still requires the sales page rights).
router.get("/sales/:id", requireModuleView(["page:/sales/pos", "page:/operations/dispatch"]), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { pool: pgPool } = await import("@workspace/db");
  const detailScope = await getUserDataScope((req as any).employee);
  const detailParams: unknown[] = [id];
  const { rows: [row] } = await pgPool.query(
    `SELECT * FROM sales s WHERE s.id = $1 AND ${scopeSalesWhere(detailScope, detailParams)}`,
    detailParams,
  );
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const locationType: string = row.location_type ?? 'outlet';
  const locationId: number = row.location_id ?? row.outlet_id;
  let locationName = '';
  let locationUpiId = '';
  if (locationType === 'headoffice') {
    locationName = 'Head Office';
  } else if (locationType === 'warehouse') {
    const { rows: [wh] } = await pgPool.query<{ name: string; upi_id: string | null }>(
      `SELECT name, upi_id FROM warehouses WHERE id = $1`, [locationId]
    );
    locationName = wh?.name ?? '';
    locationUpiId = wh?.upi_id ?? '';
  } else {
    const [outlet] = await db.select().from(outletsTable).where(eq(outletsTable.id, row.outlet_id)).limit(1);
    locationName = outlet?.name ?? '';
    locationUpiId = (outlet as any)?.upiId ?? '';
  }
  const customerName = row.customer_id
    ? (await db.select().from(customersTable).where(eq(customersTable.id, row.customer_id)).limit(1))[0]?.name ?? null
    : null;
  const totalAmount = Number(row.total_amount);
  const amountPaid  = Number(row.amount_paid ?? 0);
  // One shared position drives the status, what is still owed and the QR, and it
  // is re-derived on every fetch — never read from a stored figure.
  const position = (await loadPaymentPosition(pgPool, Number(row.id))) ?? computePaymentPosition({
    totalAmount, amountReceived: amountPaid, cancelledAt: row.cancelled_at,
  });
  const paySettings = await loadInvoicePaymentSettings(pgPool);
  const upiRequest = buildUpiRequest({
    position,
    upiId: locationUpiId || paySettings.upiId,
    payeeName: paySettings.upiPayeeName || locationName,
    reference: row.invoice_number ?? "",
    enabled: paySettings.upiEnabled && paySettings.showUpiQrOnInvoice,
  });
  res.json({
    id: row.id,
    invoiceNumber: row.invoice_number,
    outletId: row.outlet_id,
    locationType,
    locationId,
    customerId: row.customer_id,
    saleDate: row.sale_date,
    lineItems: row.line_items ?? [],
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    discountTotal: Number(row.discount_total),
    billDiscount: Number(row.bill_discount ?? 0),
    totalAmount,
    paymentMode: row.payment_mode,
    couponCode: row.coupon_code,
    otherCharges: parseStoredOtherCharges(row.other_charges),
    otherChargesTotal: otherChargesTotal(parseStoredOtherCharges(row.other_charges)),
    createdAt: row.created_at,
    paymentStatus: position.status,
    amountPaid,
    amountReceived: position.amountReceived,
    creditAdjustments: position.creditAdjustments,
    amountDue: position.amountDue,
    balanceDue: position.outstanding,
    cancelledAt: row.cancelled_at ?? null,
    isCancelled: position.isCancelled,
    upiQrUri: upiRequest?.uri ?? null,
    upiQrAmount: upiRequest?.amount ?? 0,
    outletName: locationName,
    outletUpiId: locationUpiId,
    customerName,
    quotationId: row.quotation_id ?? null,
    quotationNumber: row.quotation_number ?? null,
  });
});

export default router;

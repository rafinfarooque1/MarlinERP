import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
/**
 * Quotations — offers to customers that touch NOTHING else.
 *
 * A quotation mirrors the Sales Entry experience — same customer/location/
 * discount/tax arithmetic (literally the same helper, buildSaleLines) — but it
 * records only an offer. Nothing in this router writes to stock_entries, the
 * stock ledger, reservations, receipts, ledger_postings, GST or anything the
 * dashboard reads. The ONLY bridge to the real world is conversion, and that
 * lives inside POST /sales (see routes/sales.ts): the sale-creation
 * transaction locks the quotation row, refuses a second conversion, and stamps
 * the two documents with each other's numbers.
 *
 * Numbering: QTN/<FY>/NNNN from company_settings.quotation_sequence, its own
 * counter, bumped atomically inside the create transaction — completely
 * separate from invoice numbering.
 *
 * The quotations table comes from a boot migration (see
 * migrations/quotations.ts), so EVERY read and write here is raw SQL —
 * drizzle's select() cannot see raw-migration columns.
 */
import { Router } from "express";
import {
  db, pool, customersTable, companySettingsTable, itemsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  CreateQuotationBody, UpdateQuotationBody, SetQuotationStatusBody,
} from "@workspace/api-zod";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { getUserDataScope, isLocationInScope, type DataScope } from "../lib/dataScope";
import { availabilityAt } from "../lib/reservations";
import { logActivity } from "../lib/audit";
import { createQuotationShareToken } from "../lib/shareToken";
import { buildSaleLines, checkMrpFloor, computeInvoiceNumber } from "./sales";
import { resolveLocationGst, isInterStateSupply } from "../lib/gstTransfer";
import { blockedByInactiveProducts } from "../lib/productIdentity";

const router = Router();

/** The one permission key for the whole module — behaves exactly like Sales. */
const QUOTE_PAGES = ["page:/sales/quotations"];

const QUOTATION_PREFIX = "QTN";

/** Same in-session TTL as the invoice share-token (about 30 minutes). */
const IN_SESSION_TOKEN_TTL_DAYS = 30 / (24 * 60);

const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const parseId = (raw: unknown): number => {
  const v = parseInt(String(Array.isArray(raw) ? raw[0] : raw), 10);
  return Number.isFinite(v) ? v : NaN;
};

/** Statuses a user may set by hand. 'converted' is reserved for POST /sales. */
const SETTABLE_STATUSES = ["draft", "sent", "accepted", "rejected", "expired"] as const;

// ── LBAC ──────────────────────────────────────────────────────────────────────

/**
 * Location scope for quotations. Same rule as sales, but the columns are
 * NOT NULL here so there is no legacy outlet_id fallback to coalesce over.
 */
function scopeQuotationsWhere(scope: DataScope, params: unknown[]): string {
  if (scope.isHeadOffice) return "TRUE";
  const conds: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(`(q.location_type = 'warehouse' AND q.location_id = ANY($${params.length}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(`(q.location_type = 'outlet' AND q.location_id = ANY($${params.length}::int[]))`);
  }
  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

/** A quotation, but only if this user's location scope may see it. */
async function quotationInScope(req: any, id: number): Promise<any | null> {
  const scope = await getUserDataScope(req.employee);
  const params: unknown[] = [id];
  const { rows: [row] } = await pool.query(
    `SELECT q.*,
            to_char(q.quote_date, 'YYYY-MM-DD') AS quote_date_s,
            to_char(q.valid_till, 'YYYY-MM-DD') AS valid_till_s,
            c.name AS _customer_name, c.phone AS _customer_phone, c.gst_number AS _customer_gstin
       FROM quotations q
       LEFT JOIN customers c ON c.id = q.customer_id
      WHERE q.id = $1 AND ${scopeQuotationsWhere(scope, params)}`,
    params,
  );
  return row ?? null;
}

// ── Expiry sweep ──────────────────────────────────────────────────────────────

/**
 * Reflect expiry automatically: an open offer (draft/sent) past its valid-till
 * date IS expired, and the stored status is brought in line whenever the
 * module is read. Accepted/rejected/converted rows are never touched — those
 * are outcomes, not open offers.
 */
async function sweepExpired(): Promise<void> {
  await pool.query(
    `UPDATE quotations
        SET status = 'expired', updated_at = now()
      WHERE status IN ('draft', 'sent')
        AND valid_till IS NOT NULL AND valid_till < CURRENT_DATE`,
  );
}

// ── Presentation ─────────────────────────────────────────────────────────────

async function locationNameMaps(): Promise<{ w: Map<number, string>; o: Map<number, string> }> {
  const [{ rows: ws }, { rows: os }] = await Promise.all([
    pool.query<{ id: number; name: string }>(`SELECT id, name FROM warehouses`),
    pool.query<{ id: number; name: string }>(`SELECT id, name FROM outlets`),
  ]);
  return {
    w: new Map(ws.map((r) => [r.id, r.name])),
    o: new Map(os.map((r) => [r.id, r.name])),
  };
}

function mapQuotation(r: any, names?: { w: Map<number, string>; o: Map<number, string> }) {
  const locationName = names
    ? (r.location_type === "warehouse" ? names.w.get(r.location_id) : names.o.get(r.location_id)) ?? ""
    : (r._location_name ?? "");
  return {
    id: r.id,
    quotationNumber: r.quotation_number,
    locationType: r.location_type,
    locationId: r.location_id,
    locationName,
    customerId: r.customer_id,
    customerName: r._customer_name ?? null,
    customerPhone: r._customer_phone ?? null,
    customerGstin: r._customer_gstin ?? null,
    quoteDate: r.quote_date_s ?? r.quote_date,
    validTill: r.valid_till_s ?? r.valid_till ?? null,
    status: r.status,
    lineItems: r.line_items ?? [],
    subtotal: Number(r.subtotal),
    taxTotal: Number(r.tax_total),
    discountTotal: Number(r.discount_total),
    billDiscount: Number(r.bill_discount ?? 0),
    totalAmount: Number(r.total_amount),
    couponCode: r.coupon_code,
    billingAddress: r.billing_address,
    shippingAddress: r.shipping_address,
    paymentTerms: r.payment_terms,
    placeOfSupply: r.place_of_supply,
    salesperson: r.salesperson,
    salespersonEmployeeId: r.salesperson_employee_id != null ? Number(r.salesperson_employee_id) : null,
    notes: r.notes,
    termsConditions: r.terms_conditions,
    convertedSaleId: r.converted_sale_id,
    convertedInvoiceNumber: r.converted_invoice_number,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

// ── Shared build step for create and update ──────────────────────────────────

type BuiltQuotation =
  | {
      ok: true;
      lineItems: any[]; billDiscount: number;
      subtotal: number; taxTotal: number; discountTotal: number; totalAmount: number;
    }
  | { ok: false; error: string; code?: string };

/**
 * Validate the payload and compute the money EXACTLY as a sale would:
 * buildSaleLines is the same function POST /sales runs, so a quotation and the
 * invoice it later becomes agree paise-for-paise.
 */
async function buildQuotationFigures(data: {
  customerId?: number | null;
  locationType?: string;
  locationId?: number;
  lineItems: any[];
  billDiscount?: number | null;
  discountTotal?: number | null;
  // Edit only: itemId → lowest previously SAVED line price for that item in
  // THIS quotation. Grandfathers old quotes across a later master-MRP rise —
  // same rule as sale edits (floor = min(master, saved), never the request).
  savedFloors?: Map<number, number>;
}): Promise<BuiltQuotation> {
  const rawLineItems = data.lineItems ?? [];
  if (rawLineItems.length === 0) return { ok: false, error: "At least one line item is required" };

  // Inactive products cannot be offered — same rule as sale creation.
  const itemIds = [...new Set(rawLineItems.map((li: any) => li.itemId))];
  const itemsData = itemIds.length > 0
    ? await db.select({
        id: itemsTable.id, taxRate: itemsTable.taxRate, name: itemsTable.name,
        hsnCode: itemsTable.hsnCode, unit: itemsTable.unit,
      }).from(itemsTable).where(inArray(itemsTable.id, itemIds))
    : [];
  if (itemsData.length !== itemIds.length) {
    return { ok: false, error: "One or more items do not exist" };
  }
  // Same create-only rule as sales: existing quotations stay editable, but a
  // discontinued item cannot appear on a NEW offer. blockedByInactiveProducts
  // owns what "inactive" means (items.status) — never re-derive it here.
  const inactiveMsg = await blockedByInactiveProducts(
    pool, itemIds.map((id) => ({ kind: "item" as const, id: Number(id) })),
  );
  if (inactiveMsg) return { ok: false, error: inactiveMsg };
  const itemTaxMap = new Map(itemsData.map((i) => [
    i.id, { taxRate: Number(i.taxRate), name: i.name, hsnCode: i.hsnCode, unit: i.unit },
  ]));

  // Inter-state exactly as sales decides it: the SELLING LOCATION's state vs
  // the customer's state (company state only as the fallback for a location
  // with no state configured). A quotation and the invoice it later becomes
  // must agree — both route through isInterStateSupply.
  let company = (await db.select().from(companySettingsTable).limit(1))[0];
  if (!company) {
    [company] = await db.insert(companySettingsTable).values({}).returning();
  }
  const companyState = (company.state ?? "").trim().toLowerCase();
  let customerState = "";
  if (data.customerId) {
    const [cust] = await db.select().from(customersTable)
      .where(eq(customersTable.id, data.customerId)).limit(1);
    if (!cust) return { ok: false, error: "Customer not found" };
    customerState = (cust.state ?? "").trim().toLowerCase();
  }
  const sellerGst = data.locationType && data.locationId
    ? await resolveLocationGst(pool, data.locationType, Number(data.locationId))
    : null;
  const isInterState = isInterStateSupply(
    { state: sellerGst?.state || companyState, stateCode: sellerGst?.stateCode ?? '' },
    customerState,
  );

  // ── Quotation MRP floor ─────────────────────────────────────────────────
  // The quotation MRP is editable, but only UPWARD: it may equal or exceed
  // the Item Master MRP, never undercut it. Same rule engine as sales
  // (strict compare, no epsilon; items with master MRP 0/unset have no
  // floor), with quotation-specific wording. The Item Master row is never
  // written from here — the raised figure lives on this document alone.
  const mrpCheck = await checkMrpFloor(pool, rawLineItems, data.savedFloors,
    (itemName, floor) =>
      `Quotation MRP cannot be lower than the Item Master MRP (₹${floor.toFixed(2)}). ` +
      `Increase the MRP or use a discount if you want to quote a lower selling price. (${itemName})`);
  if (!mrpCheck.ok) return { ok: false, error: mrpCheck.error, code: "MRP_BELOW_MASTER" };

  const built = buildSaleLines(rawLineItems, itemTaxMap, isInterState, data.billDiscount);
  if (!built.ok) return { ok: false, error: built.error };

  // Stamp the master MRP AS OF SAVE TIME on every stored line — the audit
  // record of what the Item Master said when this quote was priced. A line
  // whose unitPrice exceeds its masterMrp is a deliberate quote-level raise.
  // items.mrp is a raw-migration column, invisible to drizzle — raw SQL only.
  const { rows: mrpRows } = await pool.query(
    `SELECT id, mrp FROM items WHERE id = ANY($1::int[])`, [itemIds],
  );
  const mrpById = new Map<number, number>(mrpRows.map((r: any) => [Number(r.id), Number(r.mrp ?? 0)]));
  built.lineItems = built.lineItems.map((li: any) => ({
    ...li, masterMrp: mrpById.get(Number(li.itemId)) ?? 0,
  }));

  const subtotal = built.lineItems.reduce((s: number, li: any) => s + li.lineSubtotal, 0);
  const taxTotal = built.lineItems.reduce((s: number, li: any) => s + li.taxAmount, 0);
  const rawDiscountTotal = Number(data.discountTotal ?? 0);
  if (!Number.isFinite(rawDiscountTotal) || rawDiscountTotal < 0) {
    return { ok: false, error: "discountTotal must be a non-negative amount" };
  }
  if (rawDiscountTotal > subtotal + taxTotal + 0.004) {
    return { ok: false, error: "Coupon discount cannot exceed the quotation amount" };
  }
  const discountTotal = Math.round(rawDiscountTotal * 100) / 100;
  const totalAmount = subtotal + taxTotal - discountTotal;

  return {
    ok: true,
    lineItems: built.lineItems, billDiscount: built.billDiscount,
    subtotal, taxTotal, discountTotal, totalAmount,
  };
}

const s = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
};

// ── Salesperson master ────────────────────────────────────────────────────────

type ResolvedSalesperson =
  | { ok: true; employeeId: number | null; name: string | null }
  | { ok: false; error: string };

/**
 * Resolve the salesperson pair (employee reference + display name) for a
 * create or edit.
 *
 * - salespersonEmployeeId set → must be an ACTIVE employee at the quotation's
 *   location or Head Office; the stored `salesperson` text becomes the
 *   employee's name snapshotted NOW (documents keep the historical name if
 *   the employee is later renamed — same convention as every other document).
 * - Unchanged on edit (same id as stored) → keep the stored snapshot and skip
 *   re-validation: an employee who has since resigned or moved branch must not
 *   lock an old quotation out of harmless edits (grandfather, like MRP floors).
 * - No id → legacy free-text passthrough: quotations saved before the master
 *   keep their typed value forever, and edits that leave it alone preserve it.
 */
async function resolveSalesperson(
  body: { salespersonEmployeeId?: number | null; salesperson?: string | null;
          locationType?: string; locationId?: number },
  existing?: { salesperson_employee_id?: number | null; salesperson?: string | null },
): Promise<ResolvedSalesperson> {
  const rawId = body.salespersonEmployeeId;
  if (rawId == null) {
    // Explicit null or absent: no employee reference — keep/store the text.
    return { ok: true, employeeId: null, name: s(body.salesperson) };
  }
  const empId = Number(rawId);
  if (!Number.isInteger(empId) || empId <= 0) {
    return { ok: false, error: "salespersonEmployeeId must be a positive employee id" };
  }
  if (existing && Number(existing.salesperson_employee_id) === empId) {
    // Unchanged reference on an edit — keep the saved snapshot untouched.
    return { ok: true, employeeId: empId, name: s(existing.salesperson) };
  }
  const { rows: [emp] } = await pool.query<{
    id: number; name: string; branch_type: string | null; branch_id: number | null; is_active: boolean;
  }>(
    `SELECT id, name, branch_type, branch_id, is_active FROM employees WHERE id = $1`,
    [empId],
  );
  if (!emp) return { ok: false, error: "Salesperson not found — pick an employee from the list" };
  if (!emp.is_active) {
    return { ok: false, error: `${emp.name} is no longer an active employee and cannot be set as salesperson` };
  }
  const branchType = emp.branch_type ?? "headoffice";
  const atLocation = branchType === "headoffice" ||
    (branchType === body.locationType && Number(emp.branch_id) === Number(body.locationId));
  if (!atLocation) {
    return { ok: false, error: `${emp.name} does not work at this quotation's location` };
  }
  return { ok: true, employeeId: empId, name: emp.name };
}

/**
 * Audit rows for quotation-level MRP raises: lines priced ABOVE the master
 * MRP that was in force when the quote was saved. Recorded in the activity
 * log (with user + timestamp) alongside the masterMrp stamped on the line.
 */
function quoteMrpOverrides(lineItems: any[]): Array<{
  itemId: number; itemName: string | null; masterMrp: number; quotationMrp: number;
}> {
  return (lineItems ?? [])
    .filter((li: any) => Number(li?.masterMrp ?? 0) > 0 && Number(li?.unitPrice ?? 0) > Number(li.masterMrp))
    .map((li: any) => ({
      itemId: Number(li.itemId),
      itemName: li.itemName ?? null,
      masterMrp: Number(li.masterMrp),
      quotationMrp: Number(li.unitPrice),
    }));
}

/** itemId → lowest saved line price (the edit-time grandfather floor). */
function storedLineFloors(rawLineItems: unknown): Map<number, number> {
  const lines: any[] = typeof rawLineItems === "string"
    ? (() => { try { return JSON.parse(rawLineItems); } catch { return []; } })()
    : (Array.isArray(rawLineItems) ? rawLineItems : []);
  const floors = new Map<number, number>();
  for (const li of lines) {
    const iid = Number(li?.itemId); const p = Number(li?.unitPrice);
    if (!iid || !Number.isFinite(p) || p <= 0) continue;
    const prev = floors.get(iid);
    floors.set(iid, prev === undefined ? p : Math.min(prev, p));
  }
  return floors;
}

// ── Expiring/expired feed for the notification bell ──────────────────────────
// Registered BEFORE /quotations/:id so the literal path is not swallowed by
// the id parameter (same ordering trap as assets vs inventory).

router.get(
  "/quotations/notifications/expired",
  requireModuleView(QUOTE_PAGES),
  async (req, res): Promise<void> => {
    await sweepExpired();
    const scope = await getUserDataScope((req as any).employee);
    const params: unknown[] = [];
    const scopeSql = scopeQuotationsWhere(scope, params);
    const { rows } = await pool.query(
      `SELECT q.id, q.quotation_number, q.total_amount, q.status,
              to_char(q.valid_till, 'YYYY-MM-DD') AS valid_till_s,
              c.name AS _customer_name
         FROM quotations q
         LEFT JOIN customers c ON c.id = q.customer_id
        WHERE q.status = 'expired'
          AND q.valid_till >= CURRENT_DATE - INTERVAL '14 days'
          AND ${scopeSql}
        ORDER BY q.valid_till DESC, q.id DESC
        LIMIT 15`,
      params,
    );
    res.json(rows.map((r: any) => ({
      id: r.id,
      quotationNumber: r.quotation_number,
      customerName: r._customer_name ?? null,
      totalAmount: Number(r.total_amount),
      validTill: r.valid_till_s,
    })));
  },
);

// ── Salesperson directory ─────────────────────────────────────────────────────
// Minimal active-employee list for the Salesperson dropdown: id, name and
// branch only — no salary, no contact details (the HR page permission guards
// those). Master list stays unscoped, the same convention voucher-employees
// follows: the quotation's location choice does the narrowing client-side,
// and resolveSalesperson re-checks it server-side on save.
// Registered BEFORE /quotations/:id so the literal path is not swallowed.

router.get(
  "/quotations/salespeople",
  requireModuleView(QUOTE_PAGES),
  async (_req, res): Promise<void> => {
    const { rows } = await pool.query(
      `SELECT id, name, branch_type AS "branchType", branch_id AS "branchId"
         FROM employees
        WHERE is_active = true
        ORDER BY name`,
    );
    res.json(rows.map((r: any) => ({
      id: Number(r.id),
      name: r.name,
      branchType: r.branchType ?? "headoffice",
      branchId: r.branchId != null ? Number(r.branchId) : null,
    })));
  },
);

// ── Payment terms master ──────────────────────────────────────────────────────
// A small managed list feeding the quotation form's Payment Terms select.
// Reads are open to anyone who can see quotations OR the Settings page (the
// two surfaces that render it); writes are Settings-only. Quotations store the
// LABEL TEXT, so renaming or deleting a term never rewrites existing documents.

const TERMS_READ_PAGES = [...QUOTE_PAGES, "page:/company/settings"];
const MAX_TERM_LABEL = 120;

router.get(
  "/quotation-payment-terms",
  requireModuleView(TERMS_READ_PAGES),
  async (_req, res): Promise<void> => {
    const { rows } = await pool.query(
      `SELECT id, label, sort_order AS "sortOrder"
         FROM quotation_payment_terms
        ORDER BY sort_order, LOWER(label)`,
    );
    res.json(rows.map((r: any) => ({
      id: Number(r.id), label: r.label, sortOrder: Number(r.sortOrder),
    })));
  },
);

router.post(
  "/quotation-payment-terms",
  requireModuleAction("page:/company/settings", "edit"),
  async (req, res): Promise<void> => {
    const label = s((req.body ?? {}).label);
    if (!label) { res.status(400).json({ error: "label is required" }); return; }
    if (label.length > MAX_TERM_LABEL) {
      res.status(400).json({ error: `label must be at most ${MAX_TERM_LABEL} characters` }); return;
    }
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO quotation_payment_terms (label, sort_order)
         VALUES ($1, COALESCE((SELECT MAX(sort_order) FROM quotation_payment_terms), 0) + 10)
         RETURNING id, label, sort_order AS "sortOrder"`,
        [label],
      );
      res.status(201).json({ id: Number(row.id), label: row.label, sortOrder: Number(row.sortOrder) });
    } catch (e: any) {
      if (e?.code === "23505") {
        res.status(409).json({ error: `"${label}" is already in the payment terms list` }); return;
      }
      throw e;
    }
  },
);

router.patch(
  "/quotation-payment-terms/:id",
  requireModuleAction("page:/company/settings", "edit"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const label = s((req.body ?? {}).label);
    if (!label) { res.status(400).json({ error: "label is required" }); return; }
    if (label.length > MAX_TERM_LABEL) {
      res.status(400).json({ error: `label must be at most ${MAX_TERM_LABEL} characters` }); return;
    }
    try {
      const { rows: [row] } = await pool.query(
        `UPDATE quotation_payment_terms SET label = $1
          WHERE id = $2
          RETURNING id, label, sort_order AS "sortOrder"`,
        [label, id],
      );
      if (!row) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ id: Number(row.id), label: row.label, sortOrder: Number(row.sortOrder) });
    } catch (e: any) {
      if (e?.code === "23505") {
        res.status(409).json({ error: `"${label}" is already in the payment terms list` }); return;
      }
      throw e;
    }
  },
);

router.delete(
  "/quotation-payment-terms/:id",
  requireModuleAction("page:/company/settings", "edit"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { rows: [gone] } = await pool.query(
      `DELETE FROM quotation_payment_terms WHERE id = $1 RETURNING id`, [id],
    );
    if (!gone) { res.status(404).json({ error: "Not found" }); return; }
    // Quotations that already carry this wording keep it — payment_terms
    // stores the text, not the id, by design.
    res.json({ success: true });
  },
);

// ── List ──────────────────────────────────────────────────────────────────────

router.get("/quotations", requireModuleView(QUOTE_PAGES), async (req, res): Promise<void> => {
  await sweepExpired();

  const paginated = "page" in req.query || "limit" in req.query;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" }); return;
  }

  const conds: string[] = ["TRUE"];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(q.quotation_number ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (from) { params.push(from); conds.push(`q.quote_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`q.quote_date <= $${params.length}::date`); }

  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  if (status) { params.push(status); conds.push(`q.status = $${params.length}`); }

  const lt = req.query.locationType;
  const lid = Number(req.query.locationId);
  if ((lt === "warehouse" || lt === "outlet") && Number.isFinite(lid) && lid > 0) {
    params.push(lt);  conds.push(`q.location_type = $${params.length}`);
    params.push(lid); conds.push(`q.location_id = $${params.length}`);
  }
  const customerId = Number(req.query.customerId);
  if (Number.isFinite(customerId) && customerId > 0) {
    params.push(customerId); conds.push(`q.customer_id = $${params.length}`);
  }
  const salesperson = typeof req.query.salesperson === "string" ? req.query.salesperson.trim() : "";
  if (salesperson) {
    params.push(`%${salesperson}%`); conds.push(`q.salesperson ILIKE $${params.length}`);
  }

  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeEmp && scopeEmp.branchType !== "headoffice") {
    const scope = await getUserDataScope(scopeEmp);
    conds.push(scopeQuotationsWhere(scope, params));
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  const baseFrom = `FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id`;

  let total = 0;
  let page = 1;
  let limit = 0;
  let pageSql = "";
  if (paginated) {
    page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
    limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 200);
    const { rows: [t] } = await pool.query(`SELECT COUNT(*)::int AS total ${baseFrom} ${where}`, params);
    total = Number(t?.total ?? 0);
    pageSql = ` LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
  }

  const { rows } = await pool.query(
    `SELECT q.*,
            to_char(q.quote_date, 'YYYY-MM-DD') AS quote_date_s,
            to_char(q.valid_till, 'YYYY-MM-DD') AS valid_till_s,
            c.name AS _customer_name, c.phone AS _customer_phone, c.gst_number AS _customer_gstin
     ${baseFrom} ${where}
     ORDER BY q.id DESC${pageSql}`,
    params,
  );

  const names = await locationNameMaps();
  const mapped = rows.map((r: any) => mapQuotation(r, names));
  if (paginated) {
    res.json({ total, page, limit, rows: mapped });
  } else {
    res.json(mapped);
  }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/quotations", requireModuleAction(QUOTE_PAGES, "add"), async (req, res): Promise<void> => {
  const parsed = CreateQuotationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid quotation payload" });
    return;
  }
  const body = parsed.data;

  if (!isIsoDate(body.quoteDate)) { res.status(400).json({ error: "quoteDate must be YYYY-MM-DD" }); return; }
  if (body.validTill != null && body.validTill !== "" && !isIsoDate(body.validTill)) {
    res.status(400).json({ error: "validTill must be YYYY-MM-DD" }); return;
  }
  const initialStatus = body.status ?? "draft";
  if (initialStatus !== "draft" && initialStatus !== "sent") {
    res.status(400).json({ error: "A new quotation starts as draft or sent" }); return;
  }

  // LBAC — page right ran in middleware (403); the location must also be
  // inside the caller's scope.
  const scope = await getUserDataScope((req as any).employee);
  if (!isLocationInScope(scope, body.locationType, body.locationId)) {
    res.status(403).json({ error: "You do not have access to this location" }); return;
  }
  const locTable = body.locationType === "warehouse" ? "warehouses" : "outlets";
  const { rows: [loc] } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM ${locTable} WHERE id = $1`, [body.locationId],
  );
  if (!loc) { res.status(400).json({ error: `${body.locationType} not found` }); return; }
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: body.locationType, id: body.locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  const figures = await buildQuotationFigures(body);
  if (!figures.ok) {
    res.status(400).json({ error: figures.error, ...(figures.code ? { code: figures.code } : {}) });
    return;
  }

  const sp = await resolveSalesperson(body);
  if (!sp.ok) { res.status(400).json({ error: sp.error }); return; }

  const employee = (req as any).employee;
  const client = await pool.connect();
  let row: any;
  try {
    await client.query("BEGIN");

    // Numbering: the quotation's OWN sequence, bumped atomically — the row
    // lock the UPDATE takes is what serialises concurrent creates.
    let company = (await db.select().from(companySettingsTable).limit(1))[0];
    if (!company) {
      [company] = await db.insert(companySettingsTable).values({}).returning();
    }
    const { rows: [seqRow] } = await client.query<{ quotation_sequence: number; financial_year: string | null }>(
      `UPDATE company_settings SET quotation_sequence = quotation_sequence + 1
        WHERE id = $1
        RETURNING quotation_sequence, financial_year`,
      [company.id],
    );
    const fy = seqRow?.financial_year || "2025-26";
    const quotationNumber = computeInvoiceNumber(QUOTATION_PREFIX, fy, Number(seqRow?.quotation_sequence ?? 1));

    ({ rows: [row] } = await client.query(
      `INSERT INTO quotations
         (quotation_number, location_type, location_id, customer_id, quote_date, valid_till,
          status, line_items, subtotal, tax_total, discount_total, bill_discount, total_amount,
          coupon_code, billing_address, shipping_address, payment_terms, place_of_supply,
          salesperson, salesperson_employee_id, notes, terms_conditions, created_by)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        quotationNumber, body.locationType, body.locationId, body.customerId ?? null,
        body.quoteDate, s(body.validTill), initialStatus, JSON.stringify(figures.lineItems),
        figures.subtotal, figures.taxTotal, figures.discountTotal, figures.billDiscount,
        figures.totalAmount, s(body.couponCode), s(body.billingAddress), s(body.shippingAddress),
        s(body.paymentTerms), s(body.placeOfSupply), sp.name, sp.employeeId, s(body.notes),
        s(body.termsConditions), employee?.id ?? null,
      ],
    ));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  const full = await quotationInScope(req, Number(row.id));
  const names = await locationNameMaps();
  const mapped = mapQuotation(full, names);

  const mrpOverrides = quoteMrpOverrides(figures.lineItems);
  logActivity({
    action: "CREATE", module: "quotations", entityType: "quotation", entityId: mapped.id,
    user: employee?.username ?? "system",
    description: `New quotation ${mapped.quotationNumber} — ${mapped.customerName ?? "Walk-in"} — ₹${mapped.totalAmount.toFixed(2)}`
      + (mrpOverrides.length ? ` — MRP raised on ${mrpOverrides.length} line${mrpOverrides.length > 1 ? "s" : ""}` : ""),
    metadata: {
      after: { quotationNumber: mapped.quotationNumber, locationType: mapped.locationType, locationId: mapped.locationId, customerId: mapped.customerId, totalAmount: mapped.totalAmount, lineCount: mapped.lineItems.length },
      ...(mrpOverrides.length ? { mrpOverrides } : {}),
    },
  }).catch(() => {});

  res.status(201).json(mapped);
});

// ── Read one ──────────────────────────────────────────────────────────────────

router.get("/quotations/:id", requireModuleView(QUOTE_PAGES), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
  await sweepExpired();
  const row = await quotationInScope(req, id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const names = await locationNameMaps();
  res.json(mapQuotation(row, names));
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put("/quotations/:id", requireModuleAction(QUOTE_PAGES, "edit"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }

  const existing = await quotationInScope(req, id);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.converted_sale_id) {
    res.status(409).json({
      error: `Quotation ${existing.quotation_number} was converted to ${existing.converted_invoice_number} and can no longer be edited.`,
      code: "QUOTATION_ALREADY_CONVERTED",
    });
    return;
  }

  const parsed = UpdateQuotationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid quotation payload" });
    return;
  }
  const body = parsed.data;

  if (!isIsoDate(body.quoteDate)) { res.status(400).json({ error: "quoteDate must be YYYY-MM-DD" }); return; }
  if (body.validTill != null && body.validTill !== "" && !isIsoDate(body.validTill)) {
    res.status(400).json({ error: "validTill must be YYYY-MM-DD" }); return;
  }
  let nextStatus = existing.status;
  if (body.status != null) {
    if (!(SETTABLE_STATUSES as readonly string[]).includes(body.status)) {
      res.status(400).json({ error: `status must be one of ${SETTABLE_STATUSES.join(", ")}` }); return;
    }
    nextStatus = body.status;
  }

  const scope = await getUserDataScope((req as any).employee);
  if (!isLocationInScope(scope, body.locationType, body.locationId)) {
    res.status(403).json({ error: "You do not have access to this location" }); return;
  }
  const locTable = body.locationType === "warehouse" ? "warehouses" : "outlets";
  const { rows: [loc] } = await pool.query(`SELECT id FROM ${locTable} WHERE id = $1`, [body.locationId]);
  if (!loc) { res.status(400).json({ error: `${body.locationType} not found` }); return; }
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: body.locationType, id: body.locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  // Grandfather floor from the STORED lines (never the request): a quote
  // saved before a later master-MRP rise stays editable, but no line may be
  // priced below what it already carried.
  const figures = await buildQuotationFigures({ ...body, savedFloors: storedLineFloors(existing.line_items) });
  if (!figures.ok) {
    res.status(400).json({ error: figures.error, ...(figures.code ? { code: figures.code } : {}) });
    return;
  }

  const sp = await resolveSalesperson(body, existing);
  if (!sp.ok) { res.status(400).json({ error: sp.error }); return; }

  // The row was free of a conversion when checked above; the WHERE clause
  // re-checks under the UPDATE's own row lock so a conversion that lands in
  // between cannot be overwritten.
  const { rows: [updated] } = await pool.query(
    `UPDATE quotations SET
        location_type = $1, location_id = $2, customer_id = $3,
        quote_date = $4::date, valid_till = $5::date, status = $6,
        line_items = $7::jsonb, subtotal = $8, tax_total = $9, discount_total = $10,
        bill_discount = $11, total_amount = $12, coupon_code = $13,
        billing_address = $14, shipping_address = $15, payment_terms = $16,
        place_of_supply = $17, salesperson = $18, salesperson_employee_id = $19,
        notes = $20, terms_conditions = $21,
        updated_at = now()
      WHERE id = $22 AND converted_sale_id IS NULL
      RETURNING id`,
    [
      body.locationType, body.locationId, body.customerId ?? null,
      body.quoteDate, s(body.validTill), nextStatus,
      JSON.stringify(figures.lineItems), figures.subtotal, figures.taxTotal, figures.discountTotal,
      figures.billDiscount, figures.totalAmount, s(body.couponCode),
      s(body.billingAddress), s(body.shippingAddress), s(body.paymentTerms),
      s(body.placeOfSupply), sp.name, sp.employeeId, s(body.notes), s(body.termsConditions),
      id,
    ],
  );
  if (!updated) {
    res.status(409).json({ error: "This quotation was just converted and can no longer be edited.", code: "QUOTATION_ALREADY_CONVERTED" });
    return;
  }

  const full = await quotationInScope(req, id);
  const names = await locationNameMaps();
  const mapped = mapQuotation(full, names);

  const employee = (req as any).employee;
  const mrpOverrides = quoteMrpOverrides(figures.lineItems);
  logActivity({
    action: "UPDATE", module: "quotations", entityType: "quotation", entityId: id,
    user: employee?.username ?? "system",
    description: `Quotation ${mapped.quotationNumber} updated — ${mapped.customerName ?? "Walk-in"} — ₹${mapped.totalAmount.toFixed(2)}`
      + (mrpOverrides.length ? ` — MRP raised on ${mrpOverrides.length} line${mrpOverrides.length > 1 ? "s" : ""}` : ""),
    ...(mrpOverrides.length ? { metadata: { mrpOverrides } } : {}),
  }).catch(() => {});

  res.json(mapped);
});

// ── Status transitions ────────────────────────────────────────────────────────

router.post("/quotations/:id/status", requireModuleAction(QUOTE_PAGES, "edit"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }

  const parsed = SetQuotationStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `status must be one of ${SETTABLE_STATUSES.join(", ")}` });
    return;
  }

  const existing = await quotationInScope(req, id);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.converted_sale_id || existing.status === "converted") {
    res.status(409).json({
      error: `Quotation ${existing.quotation_number} is converted — its status is final.`,
      code: "QUOTATION_ALREADY_CONVERTED",
    });
    return;
  }

  await pool.query(
    `UPDATE quotations SET status = $1, updated_at = now()
      WHERE id = $2 AND converted_sale_id IS NULL`,
    [parsed.data.status, id],
  );

  const full = await quotationInScope(req, id);
  const names = await locationNameMaps();
  res.json(mapQuotation(full, names));
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/quotations/:id", requireModuleAction(QUOTE_PAGES, "delete"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }

  const existing = await quotationInScope(req, id);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  if (existing.converted_sale_id) {
    // The audit trail of a real invoice must keep naming the quotation it came
    // from, so a converted quotation is permanent.
    res.status(409).json({
      error: `Quotation ${existing.quotation_number} was converted to ${existing.converted_invoice_number} and cannot be deleted.`,
      code: "QUOTATION_ALREADY_CONVERTED",
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM quotation_share_links WHERE quotation_id = $1`, [id]);
    // Same re-check under the row lock as the edit path.
    const { rows: [gone] } = await client.query(
      `DELETE FROM quotations WHERE id = $1 AND converted_sale_id IS NULL RETURNING id`,
      [id],
    );
    if (!gone) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This quotation was just converted and cannot be deleted.", code: "QUOTATION_ALREADY_CONVERTED" });
      return;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const employee = (req as any).employee;
  logActivity({
    action: "DELETE", module: "quotations", entityType: "quotation", entityId: id,
    user: employee?.username ?? "system",
    description: `Quotation ${existing.quotation_number} deleted`,
  }).catch(() => {});

  res.json({ success: true });
});

// ── Soft stock check for Convert to Sale ──────────────────────────────────────
// A quotation is not a reservation: this WARNS about shortfalls before opening
// the prefilled Sales Entry, it never blocks. The authoritative check happens
// inside the sale transaction, with row locks, exactly as for any other sale.

router.get("/quotations/:id/stock-check", requireModuleView(QUOTE_PAGES), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
  const row = await quotationInScope(req, id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const lines: any[] = Array.isArray(row.line_items) ? row.line_items : [];
  const shortfalls: Array<{ itemId: number; itemName: string; requested: number; available: number }> = [];
  for (const li of lines) {
    const requested = Number(li.quantity ?? 0);
    if (!(requested > 0)) continue;
    const avail = await availabilityAt(pool, {
      refId: Number(li.itemId),
      branchType: row.location_type,
      branchId: Number(row.location_id),
    });
    if (avail.available + 1e-9 < requested) {
      shortfalls.push({
        itemId: Number(li.itemId),
        itemName: String(li.itemName ?? `Item #${li.itemId}`),
        requested,
        available: avail.available,
      });
    }
  }
  res.json({ ok: shortfalls.length === 0, shortfalls });
});

// ── Share token (in-session PDF preview/print/download) ──────────────────────

router.post("/quotations/:id/share-token", requireModuleAction(QUOTE_PAGES, "download"), async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
  // LBAC: the token opens the document without a session, so only someone who
  // can see the quotation may mint one.
  const row = await quotationInScope(req, id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const { token, expiresAt } = createQuotationShareToken(id, IN_SESSION_TOKEN_TTL_DAYS);
  res.json({ token, expiresAt });
});

export default router;

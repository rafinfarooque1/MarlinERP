/**
 * Asset Management module — purchases, register, categories, transfers,
 * disposals, reports/summary.
 *
 * An asset purchase is pure capital expenditure: it posts a journal voucher
 * Dr STD-FIXED-ASSET / Cr Cash, Bank or the vendor's payable ledger according
 * to payment mode (source_module 'fixed_asset', same stream fixedAssets.ts
 * established) and NEVER touches materials/items/stock_entries or stock
 * valuation. GST on the purchase is recorded and capitalised into the total —
 * no input-tax-credit posting (explicitly out of scope).
 *
 * Register model: one asset_purchases row IS one register entry. It carries its
 * own current location and lifecycle status; transfers and disposals act on the
 * row and append history rows (no accounting entries for either — the disposal
 * schema leaves headroom for future proceeds accounting).
 *
 * Most of the columns this module reads/writes were added by a startup
 * migration (assetModule.ts) and are invisible to drizzle — every query here is
 * raw SQL on purpose.
 *
 * LBAC: registers are location-stamped records. A branch sees the assets that
 * currently sit at a location in its scope; Head Office sees everything.
 * Body-supplied locations are requests, never authority (resolveActingLocation
 * / isLocationInScope decide).
 */
import { Router, type IRouter } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { resolveActingLocation, locationLabel } from "../lib/productionCosting";
import {
  getUserDataScope, isLocationInScope, scopeTransferWhere, type DataScope,
} from "../lib/dataScope";
import { parseDateRange, pushDateRange, parseLocationFilter, pushLocationFilter } from "../lib/queryFilters";
import { isIsoDate } from "../lib/dateInput";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { ensureFixedAssetLedger } from "../migrations/fixedAssets";
import {
  ASSET_DISPOSAL_TYPES, ASSET_PAYMENT_MODES, ASSET_PAYMENT_STATUSES,
} from "../migrations/assetModule";

const router: IRouter = Router();

// ── Permission keys ───────────────────────────────────────────────────────────
const PG_PURCHASES  = "page:/assets/purchases";
const PG_REGISTER   = "page:/assets/register";
const PG_CATEGORIES = "page:/assets/categories";
const PG_TRANSFERS  = "page:/assets/transfers";
const PG_DISPOSAL   = "page:/assets/disposal";
const PG_REPORTS    = "page:/assets/reports";
/** Read access to shared asset data (pickers, lists, summary cards). */
const ANY_ASSET_VIEW = [PG_PURCHASES, PG_REGISTER, PG_CATEGORIES, PG_TRANSFERS, PG_DISPOSAL, PG_REPORTS];

// ── Small helpers ─────────────────────────────────────────────────────────────
const round2 = (n: number) => Math.round(n * 100) / 100;
/** True when v is a finite number with at most `dp` decimal places. */
const hasMaxDp = (v: number, dp: number) => {
  if (!Number.isFinite(v)) return false;
  const scaled = v * 10 ** dp;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};
const trimOrNull = (v: unknown) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Names for every location an asset can sit at, for list labels. */
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

/**
 * Scope fragment over arbitrary type/id SQL expressions. The shared
 * scopeLocationTypeWhere only takes a table alias, and the register scopes on
 * COALESCE(current_location_*, location_*) — legacy rows predate the current-
 * location columns and live where they were purchased.
 */
function scopeExprWhere(scope: DataScope, params: unknown[], typeExpr: string, idExpr: string): string {
  if (scope.isHeadOffice) return "TRUE";
  const conds: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(`(${typeExpr} = 'warehouse' AND ${idExpr} = ANY($${params.length}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(`(${typeExpr} = 'outlet' AND ${idExpr} = ANY($${params.length}::int[]))`);
  }
  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

const CURRENT_TYPE_EXPR = `COALESCE(ap.current_location_type, ap.location_type, 'headoffice')`;
const CURRENT_ID_EXPR   = `COALESCE(ap.current_location_id, ap.location_id, 1)`;
const PURCHASE_TYPE_EXPR = `COALESCE(ap.location_type, 'headoffice')`;
const PURCHASE_ID_EXPR   = `COALESCE(ap.location_id, 1)`;

/** Uploaded invoice paths: caller must be the uploader (id is in the path). */
function attachmentPathError(raw: unknown, employee: any): { path: string | null; error?: string } {
  const path = trimOrNull(raw);
  if (path == null) return { path: null };
  const m = path.match(/^\/objects\/uploads\/(\d+)\/[A-Za-z0-9._-]+$/);
  if (!m) return { path: null, error: "attachmentPath must be an uploaded /objects/... path" };
  if (Number(m[1]) !== Number(employee?.id)) {
    return { path: null, error: "attachmentPath was not uploaded by this user" };
  }
  return { path };
}

/** Shared row → JSON mapping for register/purchase lists. */
function mapAssetRow(r: any, locNames: Map<string, string>) {
  const curType = r.current_location_type ?? r.location_type ?? "headoffice";
  const curId = Number(r.current_location_id ?? r.location_id ?? 1);
  const purType = r.location_type ?? "headoffice";
  const purId = Number(r.location_id ?? 1);
  return {
    id: r.id,
    assetCode: r.asset_code ?? `AST-${String(r.id).padStart(4, "0")}`,
    assetId: r.asset_id,
    assetName: r.asset_name,
    assetUnit: r.asset_unit,
    categoryId: r.category_id,
    categoryName: r.category_name ?? "",
    quantity: Number(r.quantity),
    acquisitionCost: Number(r.acquisition_cost),
    gstRate: Number(r.gst_rate ?? 0),
    gstAmount: Number(r.gst_amount ?? 0),
    totalCost: Number(r.total_cost ?? round2(Number(r.quantity) * Number(r.acquisition_cost))),
    vendorId: r.vendor_id,
    vendorName: r.vendor_name ?? "",
    purchaseDate: r.purchase_date_str,
    invoiceNumber: r.invoice_number,
    paymentMode: r.payment_mode ?? (r.vendor_id != null ? "credit" : "cash"),
    paymentStatus: r.payment_status ?? (r.vendor_id != null ? "unpaid" : "paid"),
    warrantyStart: r.warranty_start_str,
    warrantyEnd: r.warranty_end_str,
    serialNumber: r.serial_number,
    assetTag: r.asset_tag,
    usefulLifeMonths: r.useful_life_months != null ? Number(r.useful_life_months) : null,
    notes: r.notes,
    attachmentPath: r.attachment_path,
    status: r.status ?? "active",
    locationType: purType,
    locationId: purId,
    locationName: locNames.get(`${purType}:${purId}`) ?? "Head Office",
    currentLocationType: curType,
    currentLocationId: curId,
    currentLocationName: locNames.get(`${curType}:${curId}`) ?? "Head Office",
    journalVoucherId: r.journal_voucher_id,
    voucherNumber: r.voucher_number ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const ASSET_SELECT = `
  SELECT ap.*,
         ap.purchase_date::text  AS purchase_date_str,
         ap.warranty_start::text AS warranty_start_str,
         ap.warranty_end::text   AS warranty_end_str,
         a.name AS asset_name, a.unit AS asset_unit,
         c.name AS category_name,
         v.name AS vendor_name,
         jv.voucher_number AS voucher_number
    FROM asset_purchases ap
    JOIN assets a ON a.id = ap.asset_id
    LEFT JOIN asset_categories c ON c.id = ap.category_id
    LEFT JOIN vendors v ON v.id = ap.vendor_id
    LEFT JOIN journal_vouchers jv ON jv.id = ap.journal_voucher_id`;

// ═══════════════════════════════════════════════════════════════════════════
// Categories
// ═══════════════════════════════════════════════════════════════════════════

router.get("/assets/categories", requireModuleView(ANY_ASSET_VIEW), async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.status, c.created_at,
           (SELECT COUNT(*)::int FROM asset_purchases ap WHERE ap.category_id = c.id) AS asset_count
      FROM asset_categories c
     ORDER BY c.name
  `);
  res.json(rows.map((r: any) => ({
    id: r.id, name: r.name, status: r.status,
    assetCount: Number(r.asset_count), createdAt: r.created_at,
  })));
});

router.post("/assets/categories", requireModuleAction(PG_CATEGORIES, "add"), async (req, res): Promise<void> => {
  const name = trimOrNull(req.body?.name);
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  if (name.length > 60) { res.status(400).json({ error: "name must be 60 characters or fewer" }); return; }
  const { rows: [dup] } = await pool.query(
    `SELECT id FROM asset_categories WHERE lower(name) = lower($1) LIMIT 1`, [name]);
  if (dup) { res.status(409).json({ error: `Category "${name}" already exists` }); return; }

  const { rows: [row] } = await pool.query(
    `INSERT INTO asset_categories (name) VALUES ($1) RETURNING id, name, status, created_at`, [name]);
  logActivity({
    action: "CREATE", module: "assets", entityType: "asset_category", entityId: row.id,
    description: `Asset category "${name}" created`,
    user: (req as any).employee?.username,
    metadata: { after: { name, status: row.status } },
  }).catch(() => {});
  res.status(201).json({ id: row.id, name: row.name, status: row.status, assetCount: 0, createdAt: row.created_at });
});

router.patch("/assets/categories/:id", requireModuleAction(PG_CATEGORIES, "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const name = trimOrNull(req.body?.name);
  const status = trimOrNull(req.body?.status);
  if (name == null && status == null) { res.status(400).json({ error: "Nothing to update" }); return; }
  if (name != null && name.length > 60) { res.status(400).json({ error: "name must be 60 characters or fewer" }); return; }
  if (status != null && !["active", "inactive"].includes(status)) {
    res.status(400).json({ error: "status must be active or inactive" }); return;
  }
  const { rows: [before] } = await pool.query(`SELECT id, name, status FROM asset_categories WHERE id = $1`, [id]);
  if (!before) { res.status(404).json({ error: "Not found" }); return; }
  if (name != null) {
    const { rows: [dup] } = await pool.query(
      `SELECT id FROM asset_categories WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1`, [name, id]);
    if (dup) { res.status(409).json({ error: `Category "${name}" already exists` }); return; }
  }
  const { rows: [row] } = await pool.query(
    `UPDATE asset_categories SET
       name = COALESCE($1, name), status = COALESCE($2, status), updated_at = now()
     WHERE id = $3 RETURNING id, name, status, created_at`,
    [name, status, id]);
  logActivity({
    action: "UPDATE", module: "assets", entityType: "asset_category", entityId: id,
    description: `Asset category #${id} updated (${before.name} → ${row.name}, ${before.status} → ${row.status})`,
    user: (req as any).employee?.username,
    metadata: { before: { name: before.name, status: before.status }, after: { name: row.name, status: row.status } },
  }).catch(() => {});
  res.json({ id: row.id, name: row.name, status: row.status, createdAt: row.created_at });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchases + register (one row = one register entry)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /assets/purchases — the single list every Assets page reads.
 *
 * Filters: q, fromDate/toDate (purchase_date), locationType+locationId,
 * categoryId, vendorId, status. `locationBasis=purchase|current` picks which
 * location column the filter (and LBAC scope) applies to: the purchase report
 * cares where an asset was bought, the register cares where it sits now.
 */
router.get("/assets/purchases", requireModuleView(ANY_ASSET_VIEW), async (req, res): Promise<void> => {
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const basis = req.query.locationBasis === "purchase" ? "purchase" : "current";
  const typeExpr = basis === "purchase" ? PURCHASE_TYPE_EXPR : CURRENT_TYPE_EXPR;
  const idExpr = basis === "purchase" ? PURCHASE_ID_EXPR : CURRENT_ID_EXPR;

  const conds: string[] = [];
  const params: unknown[] = [];

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(a.name ILIKE $${params.length} OR ap.asset_code ILIKE $${params.length}
                 OR ap.serial_number ILIKE $${params.length} OR ap.asset_tag ILIKE $${params.length}
                 OR ap.invoice_number ILIKE $${params.length} OR v.name ILIKE $${params.length})`);
  }
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }
  pushDateRange(conds, params, "ap.purchase_date", dr.from, dr.to);
  pushLocationFilter(conds, params, parseLocationFilter(req.query as Record<string, unknown>), typeExpr, idExpr);

  const categoryId = Number(req.query.categoryId);
  if (Number.isInteger(categoryId) && categoryId > 0) { params.push(categoryId); conds.push(`ap.category_id = $${params.length}`); }
  const vendorId = Number(req.query.vendorId);
  if (Number.isInteger(vendorId) && vendorId > 0) { params.push(vendorId); conds.push(`ap.vendor_id = $${params.length}`); }
  const status = trimOrNull(req.query.status);
  if (status) { params.push(status); conds.push(`COALESCE(ap.status, 'active') = $${params.length}`); }

  const scopeWhere = scopeExprWhere(scope, params, typeExpr, idExpr);
  if (scopeWhere === "FALSE") { res.json([]); return; }
  if (scopeWhere !== "TRUE") conds.push(scopeWhere);

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await pool.query(`${ASSET_SELECT} ${where} ORDER BY ap.id DESC`, params);
  const locNames = await locationNameMap();
  res.json(rows.map((r: any) => mapAssetRow(r, locNames)));
});

router.post("/assets/purchases", requireModuleAction(PG_PURCHASES, "add"), async (req, res): Promise<void> => {
  const employee = (req as any).employee;
  const body = req.body ?? {};

  // ── Asset master: pick an existing asset or create one by name ────────────
  let assetId = body.assetId != null && body.assetId !== "" ? Number(body.assetId) : null;
  const assetName = trimOrNull(body.assetName);
  if (assetId == null && !assetName) { res.status(400).json({ error: "assetId or assetName is required" }); return; }

  const quantity = Number(body.quantity);
  const acquisitionCost = Number(body.acquisitionCost ?? body.unitCost);
  if (!Number.isFinite(quantity) || quantity <= 0 || !hasMaxDp(quantity, 3)) {
    res.status(400).json({ error: "quantity must be a positive number (max 3 decimals)" }); return;
  }
  if (!Number.isFinite(acquisitionCost) || acquisitionCost < 0 || !hasMaxDp(acquisitionCost, 2)) {
    res.status(400).json({ error: "unit cost must be a non-negative amount (max 2 decimals)" }); return;
  }

  const purchaseDate = String(body.purchaseDate ?? "").slice(0, 10);
  if (!isIsoDate(purchaseDate)) { res.status(400).json({ error: "purchaseDate must be a real calendar date (YYYY-MM-DD)" }); return; }

  const gstRate = Number(body.gstRate ?? 0);
  if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100 || !hasMaxDp(gstRate, 2)) {
    res.status(400).json({ error: "gstRate must be between 0 and 100 (max 2 decimals)" }); return;
  }
  const taxable = round2(quantity * acquisitionCost);
  // The vendor's printed invoice may round GST a paisa differently — accept a
  // supplied amount within a rupee of the computed figure, else compute it.
  const computedGst = round2(taxable * gstRate / 100);
  let gstAmount = computedGst;
  if (body.gstAmount != null && body.gstAmount !== "") {
    const supplied = Number(body.gstAmount);
    if (!Number.isFinite(supplied) || supplied < 0 || !hasMaxDp(supplied, 2)) {
      res.status(400).json({ error: "gstAmount must be a non-negative amount (max 2 decimals)" }); return;
    }
    if (Math.abs(supplied - computedGst) > 1) {
      res.status(400).json({ error: `gstAmount ₹${supplied.toFixed(2)} does not match ${gstRate}% of ₹${taxable.toFixed(2)} (expected ≈ ₹${computedGst.toFixed(2)})` });
      return;
    }
    gstAmount = round2(supplied);
  }
  const totalCost = round2(taxable + gstAmount);

  const paymentMode = String(body.paymentMode ?? "credit");
  if (!(ASSET_PAYMENT_MODES as readonly string[]).includes(paymentMode)) {
    res.status(400).json({ error: `paymentMode must be one of: ${ASSET_PAYMENT_MODES.join(", ")}` }); return;
  }
  let paymentStatus = trimOrNull(body.paymentStatus) ?? (paymentMode === "credit" ? "unpaid" : "paid");
  if (!(ASSET_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
    res.status(400).json({ error: `paymentStatus must be one of: ${ASSET_PAYMENT_STATUSES.join(", ")}` }); return;
  }

  const vendorId = body.vendorId != null && body.vendorId !== "" ? Number(body.vendorId) : null;
  if (paymentMode === "credit" && vendorId == null) {
    res.status(400).json({ error: "A vendor is required for credit purchases — the payable must land on a vendor ledger" });
    return;
  }
  let vendorName = "";
  if (vendorId != null) {
    if (!Number.isInteger(vendorId) || vendorId <= 0) { res.status(400).json({ error: "Invalid vendorId" }); return; }
    const { rows: [vendor] } = await pool.query(`SELECT id, name FROM vendors WHERE id = $1 LIMIT 1`, [vendorId]);
    if (!vendor) { res.status(400).json({ error: "Selected vendor does not exist" }); return; }
    vendorName = vendor.name;
  }

  const categoryId = body.categoryId != null && body.categoryId !== "" ? Number(body.categoryId) : null;
  if (categoryId == null) { res.status(400).json({ error: "categoryId is required" }); return; }
  const { rows: [cat] } = await pool.query(`SELECT id, name, status FROM asset_categories WHERE id = $1 LIMIT 1`, [categoryId]);
  if (!cat) { res.status(400).json({ error: "Selected category does not exist" }); return; }
  if (cat.status !== "active") { res.status(400).json({ error: `Category "${cat.name}" is inactive` }); return; }

  const warrantyStart = trimOrNull(body.warrantyStart);
  const warrantyEnd = trimOrNull(body.warrantyEnd);
  if (warrantyStart != null && !isIsoDate(warrantyStart)) { res.status(400).json({ error: "warrantyStart must be a real calendar date (YYYY-MM-DD)" }); return; }
  if (warrantyEnd != null && !isIsoDate(warrantyEnd)) { res.status(400).json({ error: "warrantyEnd must be a real calendar date (YYYY-MM-DD)" }); return; }
  if (warrantyStart != null && warrantyEnd != null && warrantyEnd < warrantyStart) {
    res.status(400).json({ error: "warrantyEnd cannot be before warrantyStart" }); return;
  }

  const usefulLifeMonths = body.usefulLifeMonths != null && body.usefulLifeMonths !== "" ? Number(body.usefulLifeMonths) : null;
  if (usefulLifeMonths != null && (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 0 || usefulLifeMonths > 1200)) {
    res.status(400).json({ error: "usefulLifeMonths must be a whole number of months" }); return;
  }

  const att = attachmentPathError(body.attachmentPath, employee);
  if (att.error) { res.status(400).json({ error: att.error }); return; }

  const invoiceNumber = trimOrNull(body.invoiceNumber);
  const serialNumber = trimOrNull(body.serialNumber);
  const assetTag = trimOrNull(body.assetTag);
  const notes = trimOrNull(body.notes);

  // Head Office may record for any location; every other caller only for itself.
  const resolved = await resolveActingLocation(pool, {
    employee,
    requested: { type: body.locationType, id: body.locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const loc = resolved.loc;
  const locName = await locationLabel(pool, loc);
  const createdBy = employee?.username ?? "system";

  const client = await pool.connect();
  let newId = 0;
  let assetLabel = assetName ?? "";
  let voucherNumber: string | null = null;
  try {
    await client.query("BEGIN");

    // Find-or-create the asset master inside the transaction.
    if (assetId == null) {
      const { rows: [existing] } = await client.query(
        `SELECT id, name, status FROM assets WHERE lower(name) = lower($1) LIMIT 1`, [assetName]);
      if (existing) {
        if ((existing.status ?? "active") !== "active") {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Asset "${existing.name}" is inactive and cannot be purchased` });
          return;
        }
        assetId = Number(existing.id);
        assetLabel = existing.name;
      } else {
        const unit = trimOrNull(body.assetUnit) ?? "pcs";
        const { rows: [created] } = await client.query(
          `INSERT INTO assets (name, unit) VALUES ($1, $2) RETURNING id, name`, [assetName, unit]);
        assetId = Number(created.id);
        assetLabel = created.name;
      }
    } else {
      const { rows: [asset] } = await client.query(`SELECT id, name, status FROM assets WHERE id = $1 LIMIT 1`, [assetId]);
      if (!asset) { await client.query("ROLLBACK"); res.status(400).json({ error: "Selected asset does not exist" }); return; }
      if ((asset.status ?? "active") !== "active") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "This asset is inactive and cannot be purchased" });
        return;
      }
      assetLabel = asset.name;
    }

    // ── Book the acquisition (Dr Fixed Assets / Cr by payment mode) ─────────
    let voucherId: number | null = null;
    if (totalCost > 0.004) {
      const { rows: [fa] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-FIXED-ASSET' LIMIT 1`);
      const fixedAssetLedgerId = fa?.id ?? await ensureFixedAssetLedger(pool);
      if (!fixedAssetLedgerId) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Fixed Asset ledger is not available yet. Try again after the chart of accounts is initialised." });
        return;
      }

      // Funding side by payment mode. A credit purchase must land on the
      // vendor's payable ledger — never fall through to Cash, which would book
      // an unpaid acquisition as cash-paid.
      let creditLedgerId: number | null = null;
      if (paymentMode === "credit") {
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
      } else {
        const code = paymentMode === "cash" ? "STD-CASH" : "STD-BANK";
        const { rows: [fl] } = await client.query(
          `SELECT id, is_group, is_active FROM account_ledgers WHERE code = $1 LIMIT 1`, [code]);
        if (!fl || fl.is_active === false) {
          await client.query("ROLLBACK");
          res.status(500).json({ error: `Funding ledger ${code} is not available.` });
          return;
        }
        creditLedgerId = Number(fl.id);
      }

      voucherNumber = await nextVoucherNumber(client, "journal", purchaseDate);
      const modeLabel = paymentMode === "credit" ? `on credit` : `paid by ${paymentMode.toUpperCase()}`;
      const narration = `Asset purchase — ${assetLabel} × ${quantity} @ ₹${acquisitionCost.toFixed(2)}`
        + (gstAmount > 0 ? ` + GST ₹${gstAmount.toFixed(2)}` : "")
        + ` at ${locName}, ${modeLabel}`
        + (vendorName ? ` (Vendor: ${vendorName})` : "");
      const { rows: [voucher] } = await client.query(
        `INSERT INTO journal_vouchers
           (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, total_amount, created_by,
            origin, source_module)
         VALUES ('journal', $1, $2, $3, $4, $5, $6, 'system', 'fixed_asset') RETURNING id`,
        [voucherNumber, purchaseDate, narration,
         paymentMode === "credit" ? creditLedgerId : null, totalCost, createdBy],
      );
      voucherId = Number(voucher.id);
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
        [voucherId, fixedAssetLedgerId, totalCost, creditLedgerId],
      );
    }

    const { rows: [ins] } = await client.query(
      `INSERT INTO asset_purchases
         (asset_id, quantity, acquisition_cost, location_type, location_id, vendor_id,
          purchase_date, notes, journal_voucher_id, created_by,
          category_id, invoice_number, gst_rate, gst_amount, total_cost,
          payment_mode, payment_status, warranty_start, warranty_end,
          serial_number, asset_tag, useful_life_months, attachment_path,
          status, current_location_type, current_location_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               'active',$4,$5, now())
       RETURNING id`,
      [assetId, quantity, acquisitionCost, loc.type, loc.id, vendorId,
       purchaseDate, notes, voucherId, createdBy,
       categoryId, invoiceNumber, gstRate, gstAmount, totalCost,
       paymentMode, paymentStatus, warrantyStart, warrantyEnd,
       serialNumber, assetTag, usefulLifeMonths, att.path],
    );
    newId = Number(ins.id);
    await client.query(
      `UPDATE asset_purchases SET asset_code = 'AST-' || lpad(id::text, 4, '0') WHERE id = $1 AND asset_code IS NULL`,
      [newId],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "CREATE", module: "assets", entityType: "asset_purchase", entityId: newId,
    description: `Asset purchased — ${assetLabel} × ${quantity} @ ₹${acquisitionCost.toFixed(2)} at ${locName} — ₹${totalCost.toFixed(2)} (${paymentMode})`
      + (vendorName ? ` (Vendor: ${vendorName})` : ""),
    user: employee?.username,
    metadata: {
      after: {
        assetId, assetName: assetLabel, categoryId, categoryName: cat.name,
        quantity, acquisitionCost, gstRate, gstAmount, totalCost,
        vendorId, vendorName, invoiceNumber, paymentMode, paymentStatus,
        warrantyStart, warrantyEnd, serialNumber, assetTag, usefulLifeMonths,
        locationType: loc.type, locationId: loc.id, voucherNumber,
      },
    },
  }).catch(() => {});

  res.status(201).json({
    id: newId,
    assetCode: `AST-${String(newId).padStart(4, "0")}`,
    assetId, assetName: assetLabel,
    categoryId, categoryName: cat.name,
    quantity, acquisitionCost, gstRate, gstAmount, totalCost,
    vendorId, vendorName, invoiceNumber,
    paymentMode, paymentStatus,
    warrantyStart, warrantyEnd, serialNumber, assetTag, usefulLifeMonths,
    purchaseDate, notes, attachmentPath: att.path,
    locationType: loc.type, locationId: loc.id, locationName: locName,
    currentLocationType: loc.type, currentLocationId: loc.id,
    status: "active",
    voucherNumber,
  });
});

/** Editable register fields — never the financials, which a posted voucher
 *  already recorded. Changing cost/qty/vendor/date/mode would silently detach
 *  the row from its journal voucher. */
router.patch("/assets/purchases/:id", requireModuleAction(PG_REGISTER, "edit"), async (req, res): Promise<void> => {
  const employee = (req as any).employee;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }

  const scope = await getUserDataScope(employee ?? { branchType: "headoffice", branchId: 0 });
  const { rows: [before] } = await pool.query(`
    SELECT ap.*, a.name AS asset_name,
           ap.warranty_start::text AS warranty_start_str, ap.warranty_end::text AS warranty_end_str
      FROM asset_purchases ap JOIN assets a ON a.id = ap.asset_id
     WHERE ap.id = $1`, [id]);
  if (!before) { res.status(404).json({ error: "Not found" }); return; }
  const curType = before.current_location_type ?? before.location_type ?? "headoffice";
  const curId = Number(before.current_location_id ?? before.location_id ?? 1);
  if (!isLocationInScope(scope, curType, curId)) { res.status(404).json({ error: "Not found" }); return; }

  const body = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: { before: Record<string, unknown>; after: Record<string, unknown> } = { before: {}, after: {} };
  const set = (col: string, val: unknown, field: string, prev: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changes.before[field] = prev;
    changes.after[field] = val;
  };

  if ("categoryId" in body) {
    const categoryId = body.categoryId != null && body.categoryId !== "" ? Number(body.categoryId) : null;
    if (categoryId == null) { res.status(400).json({ error: "categoryId cannot be empty" }); return; }
    const { rows: [cat] } = await pool.query(`SELECT id, status FROM asset_categories WHERE id = $1`, [categoryId]);
    if (!cat) { res.status(400).json({ error: "Selected category does not exist" }); return; }
    set("category_id", categoryId, "categoryId", before.category_id);
  }
  if ("invoiceNumber" in body) set("invoice_number", trimOrNull(body.invoiceNumber), "invoiceNumber", before.invoice_number);
  if ("serialNumber" in body) set("serial_number", trimOrNull(body.serialNumber), "serialNumber", before.serial_number);
  if ("assetTag" in body) set("asset_tag", trimOrNull(body.assetTag), "assetTag", before.asset_tag);
  if ("notes" in body) set("notes", trimOrNull(body.notes), "notes", before.notes);
  if ("warrantyStart" in body) {
    const v = trimOrNull(body.warrantyStart);
    if (v != null && !isIsoDate(v)) { res.status(400).json({ error: "warrantyStart must be a real calendar date (YYYY-MM-DD)" }); return; }
    set("warranty_start", v, "warrantyStart", before.warranty_start_str);
  }
  if ("warrantyEnd" in body) {
    const v = trimOrNull(body.warrantyEnd);
    if (v != null && !isIsoDate(v)) { res.status(400).json({ error: "warrantyEnd must be a real calendar date (YYYY-MM-DD)" }); return; }
    set("warranty_end", v, "warrantyEnd", before.warranty_end_str);
  }
  if ("usefulLifeMonths" in body) {
    const v = body.usefulLifeMonths != null && body.usefulLifeMonths !== "" ? Number(body.usefulLifeMonths) : null;
    if (v != null && (!Number.isInteger(v) || v < 0 || v > 1200)) {
      res.status(400).json({ error: "usefulLifeMonths must be a whole number of months" }); return;
    }
    set("useful_life_months", v, "usefulLifeMonths", before.useful_life_months);
  }
  if ("paymentStatus" in body) {
    const v = trimOrNull(body.paymentStatus);
    if (v == null || !(ASSET_PAYMENT_STATUSES as readonly string[]).includes(v)) {
      res.status(400).json({ error: `paymentStatus must be one of: ${ASSET_PAYMENT_STATUSES.join(", ")}` }); return;
    }
    set("payment_status", v, "paymentStatus", before.payment_status);
  }
  if ("attachmentPath" in body) {
    const v = trimOrNull(body.attachmentPath);
    if (v !== null && v !== before.attachment_path) {
      const att = attachmentPathError(v, employee);
      if (att.error) { res.status(400).json({ error: att.error }); return; }
    }
    set("attachment_path", v, "attachmentPath", before.attachment_path);
  }

  // The guarded value is the EFFECTIVE warranty window after this patch.
  const effStart = "warrantyStart" in body ? changes.after.warrantyStart : before.warranty_start_str;
  const effEnd = "warrantyEnd" in body ? changes.after.warrantyEnd : before.warranty_end_str;
  if (effStart != null && effEnd != null && String(effEnd) < String(effStart)) {
    res.status(400).json({ error: "warrantyEnd cannot be before warrantyStart" }); return;
  }

  if (sets.length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }
  params.push(id);
  await pool.query(
    `UPDATE asset_purchases SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params,
  );

  logActivity({
    action: "UPDATE", module: "assets", entityType: "asset_purchase", entityId: id,
    description: `Asset ${before.asset_code ?? `#${id}`} (${before.asset_name}) details updated`,
    user: employee?.username,
    metadata: changes,
  }).catch(() => {});

  const locNames = await locationNameMap();
  const { rows: [after] } = await pool.query(`${ASSET_SELECT} WHERE ap.id = $1`, [id]);
  res.json(mapAssetRow(after, locNames));
});

/**
 * DELETE — removes the register entry AND the journal voucher that booked it,
 * in one transaction, so the books never keep value for an asset that no
 * longer exists in the register. Disposed assets are history and refuse
 * deletion; delete their disposal record first if it truly was an error.
 */
router.delete("/assets/purchases/:id", requireModuleAction(PG_REGISTER, "delete"), async (req, res): Promise<void> => {
  const employee = (req as any).employee;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const scope = await getUserDataScope(employee ?? { branchType: "headoffice", branchId: 0 });

  const client = await pool.connect();
  let beforeMeta: Record<string, unknown> = {};
  let label = `#${id}`;
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(`
      SELECT ap.*, a.name AS asset_name FROM asset_purchases ap
        JOIN assets a ON a.id = ap.asset_id
       WHERE ap.id = $1 FOR UPDATE OF ap`, [id]);
    if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Not found" }); return; }
    const curType = row.current_location_type ?? row.location_type ?? "headoffice";
    const curId = Number(row.current_location_id ?? row.location_id ?? 1);
    if (!isLocationInScope(scope, curType, curId)) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Not found" }); return;
    }
    if ((row.status ?? "active") !== "active") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This asset has been disposed and is part of history — it cannot be deleted." });
      return;
    }
    label = `${row.asset_code ?? `#${id}`} (${row.asset_name})`;
    beforeMeta = {
      assetId: row.asset_id, assetName: row.asset_name, assetCode: row.asset_code,
      quantity: Number(row.quantity), acquisitionCost: Number(row.acquisition_cost),
      totalCost: Number(row.total_cost ?? 0), vendorId: row.vendor_id,
      paymentMode: row.payment_mode, journalVoucherId: row.journal_voucher_id,
      locationType: curType, locationId: curId,
    };

    // History rows cascade with the register entry.
    await client.query(`DELETE FROM asset_purchases WHERE id = $1`, [id]);
    if (row.journal_voucher_id != null) {
      await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [row.journal_voucher_id]);
      await client.query(`DELETE FROM journal_vouchers WHERE id = $1`, [row.journal_voucher_id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logActivity({
    action: "DELETE", module: "assets", entityType: "asset_purchase", entityId: id,
    description: `Asset purchase ${label} deleted (journal voucher removed)`,
    user: employee?.username,
    metadata: { before: beforeMeta },
  }).catch(() => {});
  res.status(204).send();
});

// ═══════════════════════════════════════════════════════════════════════════
// Transfers (no accounting entries — location bookkeeping only)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/assets/transfers", requireModuleView([PG_TRANSFERS, PG_REGISTER, PG_REPORTS]), async (req, res): Promise<void> => {
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const conds: string[] = [];
  const params: unknown[] = [];
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }
  pushDateRange(conds, params, "t.transfer_date", dr.from, dr.to);
  const purchaseId = Number(req.query.assetPurchaseId);
  if (Number.isInteger(purchaseId) && purchaseId > 0) { params.push(purchaseId); conds.push(`t.asset_purchase_id = $${params.length}`); }

  const scopeWhere = scopeTransferWhere(scope, params, "t");
  if (scopeWhere === "FALSE") { res.json([]); return; }
  if (scopeWhere !== "TRUE") conds.push(scopeWhere);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(`
    SELECT t.*, t.transfer_date::text AS transfer_date_str,
           ap.asset_code, a.name AS asset_name
      FROM asset_transfers t
      JOIN asset_purchases ap ON ap.id = t.asset_purchase_id
      JOIN assets a ON a.id = ap.asset_id
      ${where}
     ORDER BY t.id DESC`, params);
  const locNames = await locationNameMap();
  res.json(rows.map((r: any) => ({
    id: r.id,
    assetPurchaseId: r.asset_purchase_id,
    assetCode: r.asset_code,
    assetName: r.asset_name,
    fromType: r.from_type, fromId: Number(r.from_id),
    fromName: locNames.get(`${r.from_type}:${Number(r.from_id)}`) ?? "Head Office",
    toType: r.to_type, toId: Number(r.to_id),
    toName: locNames.get(`${r.to_type}:${Number(r.to_id)}`) ?? "Head Office",
    transferDate: r.transfer_date_str,
    approvedBy: r.approved_by,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
  })));
});

router.post("/assets/transfers", requireModuleAction(PG_TRANSFERS, "add"), async (req, res): Promise<void> => {
  const employee = (req as any).employee;
  const body = req.body ?? {};
  const purchaseId = Number(body.assetPurchaseId);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) { res.status(400).json({ error: "assetPurchaseId is required" }); return; }

  const toType = String(body.toType ?? "");
  const toId = Number(body.toId);
  if (!["warehouse", "outlet", "headoffice"].includes(toType) || !Number.isInteger(toId) || toId <= 0) {
    res.status(400).json({ error: "toType/toId must identify a warehouse, outlet or Head Office" }); return;
  }
  if (toType === "headoffice" && toId !== 1) { res.status(400).json({ error: "Head Office is location 1" }); return; }
  if (toType !== "headoffice") {
    const table = toType === "warehouse" ? "warehouses" : "outlets";
    const { rows: [dest] } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [toId]);
    if (!dest) { res.status(400).json({ error: "Destination location does not exist" }); return; }
  }

  const transferDate = String(body.transferDate ?? "").slice(0, 10);
  if (!isIsoDate(transferDate)) { res.status(400).json({ error: "transferDate must be a real calendar date (YYYY-MM-DD)" }); return; }
  const approvedBy = trimOrNull(body.approvedBy);
  const reason = trimOrNull(body.reason);

  const scope = await getUserDataScope(employee ?? { branchType: "headoffice", branchId: 0 });
  const client = await pool.connect();
  let out: Record<string, unknown> | null = null;
  let audit: (() => void) | null = null;
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(`
      SELECT ap.*, a.name AS asset_name FROM asset_purchases ap
        JOIN assets a ON a.id = ap.asset_id
       WHERE ap.id = $1 FOR UPDATE OF ap`, [purchaseId]);
    if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Asset not found" }); return; }
    const fromType = row.current_location_type ?? row.location_type ?? "headoffice";
    const fromId = Number(row.current_location_id ?? row.location_id ?? 1);
    // A branch may only move assets that currently sit inside its own scope.
    if (!isLocationInScope(scope, fromType, fromId)) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Asset not found" }); return;
    }
    if ((row.status ?? "active") !== "active") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This asset has been disposed and can no longer be transferred." });
      return;
    }
    if (fromType === toType && fromId === toId) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "The asset is already at that location." });
      return;
    }

    const { rows: [tr] } = await client.query(
      `INSERT INTO asset_transfers
         (asset_purchase_id, from_type, from_id, to_type, to_id, transfer_date, approved_by, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [purchaseId, fromType, fromId, toType, toId, transferDate, approvedBy, reason, employee?.username ?? "system"],
    );
    await client.query(
      `UPDATE asset_purchases SET current_location_type = $1, current_location_id = $2, updated_at = now() WHERE id = $3`,
      [toType, toId, purchaseId],
    );
    await client.query("COMMIT");

    const locNames = await locationNameMap();
    const fromName = locNames.get(`${fromType}:${fromId}`) ?? "Head Office";
    const toName = locNames.get(`${toType}:${toId}`) ?? "Head Office";
    out = {
      id: tr.id, assetPurchaseId: purchaseId,
      assetCode: row.asset_code, assetName: row.asset_name,
      fromType, fromId, fromName, toType, toId, toName,
      transferDate, approvedBy, reason,
      createdBy: employee?.username ?? "system", createdAt: tr.created_at,
    };
    audit = () => logActivity({
      action: "UPDATE", module: "assets", entityType: "asset_transfer", entityId: Number(tr.id),
      description: `Asset ${row.asset_code ?? `#${purchaseId}`} (${row.asset_name}) transferred ${fromName} → ${toName}`,
      user: employee?.username,
      metadata: {
        before: { currentLocationType: fromType, currentLocationId: fromId },
        after: { currentLocationType: toType, currentLocationId: toId, transferDate, approvedBy, reason },
      },
    }).catch(() => {});
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  audit?.();
  res.status(201).json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// Disposals (no accounting yet — schema leaves headroom for it)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/assets/disposals", requireModuleView([PG_DISPOSAL, PG_REGISTER, PG_REPORTS]), async (req, res): Promise<void> => {
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const conds: string[] = [];
  const params: unknown[] = [];
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }
  pushDateRange(conds, params, "d.disposal_date", dr.from, dr.to);
  const purchaseId = Number(req.query.assetPurchaseId);
  if (Number.isInteger(purchaseId) && purchaseId > 0) { params.push(purchaseId); conds.push(`d.asset_purchase_id = $${params.length}`); }

  // A disposed asset stays visible to the branch that held it when it left.
  const scopeWhere = scopeExprWhere(scope, params, CURRENT_TYPE_EXPR, CURRENT_ID_EXPR);
  if (scopeWhere === "FALSE") { res.json([]); return; }
  if (scopeWhere !== "TRUE") conds.push(scopeWhere);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(`
    SELECT d.*, d.disposal_date::text AS disposal_date_str,
           ap.asset_code, ap.current_location_type, ap.current_location_id,
           ap.location_type, ap.location_id, ap.total_cost,
           a.name AS asset_name
      FROM asset_disposals d
      JOIN asset_purchases ap ON ap.id = d.asset_purchase_id
      JOIN assets a ON a.id = ap.asset_id
      ${where}
     ORDER BY d.id DESC`, params);
  const locNames = await locationNameMap();
  res.json(rows.map((r: any) => {
    const locType = r.current_location_type ?? r.location_type ?? "headoffice";
    const locId = Number(r.current_location_id ?? r.location_id ?? 1);
    return {
      id: r.id,
      assetPurchaseId: r.asset_purchase_id,
      assetCode: r.asset_code,
      assetName: r.asset_name,
      disposalType: r.disposal_type,
      disposalDate: r.disposal_date_str,
      reason: r.reason,
      amount: r.amount != null ? Number(r.amount) : null,
      totalCost: Number(r.total_cost ?? 0),
      locationType: locType, locationId: locId,
      locationName: locNames.get(`${locType}:${locId}`) ?? "Head Office",
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }));
});

router.post("/assets/disposals", requireModuleAction(PG_DISPOSAL, "add"), async (req, res): Promise<void> => {
  const employee = (req as any).employee;
  const body = req.body ?? {};
  const purchaseId = Number(body.assetPurchaseId);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) { res.status(400).json({ error: "assetPurchaseId is required" }); return; }
  const disposalType = String(body.disposalType ?? "");
  if (!(ASSET_DISPOSAL_TYPES as readonly string[]).includes(disposalType)) {
    res.status(400).json({ error: `disposalType must be one of: ${ASSET_DISPOSAL_TYPES.join(", ")}` }); return;
  }
  const disposalDate = String(body.disposalDate ?? "").slice(0, 10);
  if (!isIsoDate(disposalDate)) { res.status(400).json({ error: "disposalDate must be a real calendar date (YYYY-MM-DD)" }); return; }
  const reason = trimOrNull(body.reason);

  const scope = await getUserDataScope(employee ?? { branchType: "headoffice", branchId: 0 });
  const client = await pool.connect();
  let out: Record<string, unknown> | null = null;
  let audit: (() => void) | null = null;
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(`
      SELECT ap.*, a.name AS asset_name FROM asset_purchases ap
        JOIN assets a ON a.id = ap.asset_id
       WHERE ap.id = $1 FOR UPDATE OF ap`, [purchaseId]);
    if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Asset not found" }); return; }
    const locType = row.current_location_type ?? row.location_type ?? "headoffice";
    const locId = Number(row.current_location_id ?? row.location_id ?? 1);
    if (!isLocationInScope(scope, locType, locId)) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Asset not found" }); return;
    }
    if ((row.status ?? "active") !== "active") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This asset has already been disposed." });
      return;
    }

    const { rows: [d] } = await client.query(
      `INSERT INTO asset_disposals
         (asset_purchase_id, disposal_type, disposal_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [purchaseId, disposalType, disposalDate, reason, employee?.username ?? "system"],
    );
    await client.query(
      `UPDATE asset_purchases SET status = $1, updated_at = now() WHERE id = $2`,
      [disposalType, purchaseId],
    );
    await client.query("COMMIT");

    out = {
      id: d.id, assetPurchaseId: purchaseId,
      assetCode: row.asset_code, assetName: row.asset_name,
      disposalType, disposalDate, reason,
      createdBy: employee?.username ?? "system", createdAt: d.created_at,
    };
    audit = () => logActivity({
      action: "UPDATE", module: "assets", entityType: "asset_disposal", entityId: Number(d.id),
      description: `Asset ${row.asset_code ?? `#${purchaseId}`} (${row.asset_name}) disposed — ${disposalType.replace(/_/g, " ")}`,
      user: employee?.username,
      metadata: {
        before: { status: row.status ?? "active" },
        after: { status: disposalType, disposalDate, reason },
      },
    }).catch(() => {});
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  audit?.();
  res.status(201).json(out);
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary (dashboard cards)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/assets/summary", requireModuleView(ANY_ASSET_VIEW), async (req, res): Promise<void> => {
  const scope = await getUserDataScope((req as any).employee ?? { branchType: "headoffice", branchId: 0 });
  const params: unknown[] = [];
  const scopeWhere = scopeExprWhere(scope, params, CURRENT_TYPE_EXPR, CURRENT_ID_EXPR);
  if (scopeWhere === "FALSE") {
    res.json({
      totalAssets: 0, activeAssets: 0, disposedAssets: 0, assetValue: 0,
      purchasedThisMonth: { count: 0, value: 0 },
      byLocation: [], warrantyExpiringSoon: { withinDays: 60, count: 0, items: [] },
    });
    return;
  }
  const where = scopeWhere === "TRUE" ? "" : `WHERE ${scopeWhere}`;

  const [totals, byLoc, warranty] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE COALESCE(ap.status,'active') = 'active')::int AS active,
             COALESCE(SUM(COALESCE(ap.total_cost, round(ap.quantity * ap.acquisition_cost, 2)))
               FILTER (WHERE COALESCE(ap.status,'active') = 'active'), 0)::float AS value,
             COUNT(*) FILTER (WHERE date_trunc('month', ap.purchase_date) = date_trunc('month', CURRENT_DATE))::int AS month_count,
             COALESCE(SUM(COALESCE(ap.total_cost, round(ap.quantity * ap.acquisition_cost, 2)))
               FILTER (WHERE date_trunc('month', ap.purchase_date) = date_trunc('month', CURRENT_DATE)), 0)::float AS month_value
        FROM asset_purchases ap ${where}`, params),
    pool.query(`
      SELECT ${CURRENT_TYPE_EXPR} AS loc_type, ${CURRENT_ID_EXPR} AS loc_id,
             COUNT(*)::int AS count,
             COALESCE(SUM(COALESCE(ap.total_cost, round(ap.quantity * ap.acquisition_cost, 2))), 0)::float AS value
        FROM asset_purchases ap
        ${where ? `${where} AND` : "WHERE"} COALESCE(ap.status,'active') = 'active'
       GROUP BY 1, 2 ORDER BY value DESC`, params),
    pool.query(`
      SELECT ap.id, ap.asset_code, a.name AS asset_name, ap.warranty_end::text AS warranty_end_str
        FROM asset_purchases ap JOIN assets a ON a.id = ap.asset_id
        ${where ? `${where} AND` : "WHERE"} COALESCE(ap.status,'active') = 'active'
         AND ap.warranty_end IS NOT NULL
         AND ap.warranty_end >= CURRENT_DATE
         AND ap.warranty_end <= CURRENT_DATE + 60
       ORDER BY ap.warranty_end ASC`, params),
  ]);

  const t = totals.rows[0] ?? {};
  const locNames = await locationNameMap();
  res.json({
    totalAssets: Number(t.total ?? 0),
    activeAssets: Number(t.active ?? 0),
    disposedAssets: Number(t.total ?? 0) - Number(t.active ?? 0),
    assetValue: Number(t.value ?? 0),
    purchasedThisMonth: { count: Number(t.month_count ?? 0), value: Number(t.month_value ?? 0) },
    byLocation: byLoc.rows.map((r: any) => ({
      locationType: r.loc_type, locationId: Number(r.loc_id),
      name: locNames.get(`${r.loc_type}:${Number(r.loc_id)}`) ?? "Head Office",
      count: Number(r.count), value: Number(r.value),
    })),
    warrantyExpiringSoon: {
      withinDays: 60,
      count: warranty.rows.length,
      items: warranty.rows.slice(0, 8).map((r: any) => ({
        id: r.id, assetCode: r.asset_code, assetName: r.asset_name, warrantyEnd: r.warranty_end_str,
      })),
    },
  });
});

export default router;

import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS, financialYearLabel } from "../lib/voucherNumber";
import { createJournalVoucherCore } from "../lib/journalCreate";
import { logActivity } from "../lib/audit";
import { lineTaxHeads } from "../lib/gst";
import { clearsThroughBank } from "../lib/paymentModes";
import { isIsoDate } from "../lib/dateInput";
import { callerLocation, ownLocationScope, foreignPartyLedgerIds, locationOwnedLedgerMap } from "../lib/moneyScope";
import { outletWritesBlocked } from "../lib/featureFlags";
import { respondIfMonthLocked, isMonthLocked, ymOfDate, monthLockedBody } from "../lib/periodLock";

const router = Router();

/** A queryable database handle (pg pool or PoolClient), per lib/importVouchers.ts. */
type Q = { query: Function };

const JV_TYPES = new Set(["journal", "contra", "credit_note", "debit_note"]);
const round2 = (n: number) => Math.round(n * 100) / 100;
// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDate = (s: unknown): s is string => isIsoDate(s);
/**
 * A pg `date` column parses to a Date at LOCAL midnight. `toISOString()` on that
 * would shift the day backwards in any timezone west of UTC, so read the local
 * calendar fields instead — a voucher dated the 1st must not report as the 31st.
 */
const toLocalISODate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── Helpers ────────────────────────────────────────────────────────────────

/** All ledger ids at-or-under the given root codes (walks the CoA tree). */
async function ledgerIdsUnderCodes(rootCodes: string[]): Promise<Set<number>> {
  const { rows } = await pool.query(`SELECT id, parent_id, code FROM account_ledgers`);
  const ids = new Set<number>();
  for (const r of rows) if (r.code && rootCodes.includes(r.code)) ids.add(r.id);
  for (let i = 0; i < 8; i++) {
    for (const r of rows) if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
  }
  return ids;
}

/** The given ledger id plus all of its descendants. */
async function ledgerSubtreeIds(rootId: number, q: Q = pool): Promise<Set<number>> {
  const { rows } = await q.query(`SELECT id, parent_id FROM account_ledgers`);
  const ids = new Set<number>([rootId]);
  for (let i = 0; i < 8; i++) {
    for (const r of rows) if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
  }
  return ids;
}

async function fetchVoucher(id: number): Promise<any | null> {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, pl.name AS party_name, pl.code AS party_code
     FROM journal_vouchers v
     LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
     WHERE v.id = $1`, [id]
  );
  if (!v) return null;
  const { rows: lines } = await pool.query(
    `SELECT l.id, l.ledger_id, l.debit, l.credit, al.name AS ledger_name, al.code AS ledger_code
     FROM journal_voucher_lines l
     LEFT JOIN account_ledgers al ON al.id = l.ledger_id
     WHERE l.voucher_id = $1 ORDER BY l.id`, [id]
  );
  return serializeVoucher(v, lines);
}

/** Party ledgers are coded CUST-<id> / VEND-<id>; recover the id so an edit
 *  form can pre-select the customer or vendor it was raised against. */
function partyIdFromCode(code: unknown): number | null {
  const m = /^(?:CUST|VEND)-(\d+)$/.exec(String(code ?? ""));
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Whether this voucher may be edited by hand. A voucher is editable only when
 * it was PROVEN to be manually entered (origin='manual', stamped at insert or
 * backfilled from the manual route's own audit trail) AND it is one of the
 * types the Vouchers screen can actually produce. Anything system-generated or
 * of unknown provenance is read-only — it belongs to a source document.
 */
function isEditableVoucher(v: any): boolean {
  return v?.origin === "manual" && JV_TYPES.has(v?.voucher_type);
}

/** Human wording for the module that owns a system-generated voucher. */
const SOURCE_MODULE_LABELS: Record<string, string> = {
  production: "production costing",
  payroll: "payroll",
  rent: "warehouse rent",
  fixed_asset: "a fixed-asset purchase",
  returns: "a sales or purchase return",
  branch_transfer: "an inter-branch transfer",
  accounts: "the Vouchers screen",
};

/** Why a voucher cannot be edited — said plainly enough to act on. */
function lockedReason(v: any, action: "edit" | "delete" = "edit"): string {
  const label = v?.voucher_number ?? "This voucher";
  const past = action === "delete" ? "deleted" : "edited";
  const gerund = action === "delete" ? "deleting" : "editing";
  if (!JV_TYPES.has(v?.voucher_type)) {
    return `${label} is a ${VOUCHER_TYPE_LABELS[v?.voucher_type] ?? v?.voucher_type} voucher and cannot be ${past} from the Vouchers screen.`;
  }
  if (v?.origin === "system") {
    const src = v?.source_module ? ` by ${SOURCE_MODULE_LABELS[v.source_module] ?? v.source_module}` : "";
    return `${label} was generated automatically${src}, so it belongs to that record. Change the source record instead — ${gerund} the voucher here would put the books out of step with it.`;
  }
  return `${label} predates provenance tracking, so there is no reliable record of whether a person entered it or another module generated it. It stays locked rather than risk ${gerund} an automatic entry.`;
}

/** The financial year a voucher number was allocated under: JV/2026-27/0007 → "2026-27". */
function fyFromVoucherNumber(n: unknown): string | null {
  const parts = String(n ?? "").split("/");
  const label = parts.length === 3 ? parts[1] : "";
  return label && /^\d{4}(-\d{2})?$/.test(label) ? label : null;
}

async function companyFyStartMonth(): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT fy_start_month FROM company_settings LIMIT 1`);
    return Number(rows[0]?.fy_start_month ?? 4) || 4;
  } catch {
    return 4;
  }
}

function serializeVoucher(v: any, lines: any[]) {
  return {
    id: v.id,
    voucherType: v.voucher_type,
    voucherNumber: v.voucher_number,
    /** Old-ERP voucher number for migrated vouchers (searchable). */
    legacyVoucherNumber: v.legacy_voucher_number ?? null,
    // A pg `date` reads back as a Date at LOCAL midnight; hand out the plain
    // calendar day so an edit form round-trips the date it was shown.
    voucherDate: v.voucher_date instanceof Date ? toLocalISODate(v.voucher_date) : v.voucher_date,
    narration: v.narration,
    reason: v.reason,
    partyLedgerId: v.party_ledger_id,
    partyName: v.party_name ?? null,
    partyId: partyIdFromCode(v.party_code),
    totalAmount: Number(v.total_amount),
    createdBy: v.created_by,
    createdAt: v.created_at,
    /** Where the voucher belongs; every derived posting inherits this stamp. */
    locationType: v.location_type ?? null,
    locationId: v.location_id != null ? Number(v.location_id) : null,
    // Provenance. `editable` is computed here so the UI never has to re-derive
    // the rule (and can never disagree with what the API will actually allow).
    origin: v.origin ?? null,
    sourceModule: v.source_module ?? null,
    editable: isEditableVoucher(v),
    /** Why not, in the same words the API would reject the edit with. */
    lockedReason: isEditableVoucher(v) ? null : lockedReason(v),
    updatedAt: v.updated_at ?? null,
    updatedBy: v.updated_by ?? null,
    /** Concurrency token — echo back on edit so a stale form is rejected. */
    rev: v.updated_at ?? v.created_at ?? null,
    lines: lines.map((l: any) => ({
      id: l.id,
      ledgerId: l.ledger_id,
      ledgerName: l.ledger_name ?? "",
      ledgerCode: l.ledger_code ?? null,
      debit: Number(l.debit),
      credit: Number(l.credit),
    })),
  };
}

type LineDraft = { ledgerId: number; debit: number; credit: number };
type BuildResult =
  | { ok: true; lines: LineDraft[]; partyLedgerId: number | null; totalAmount: number }
  | { ok: false; error: string };

/**
 * Turn a request body into balanced double-entry lines for the given voucher
 * type. Shared by create and edit so both enforce exactly the same accounting
 * rules — a voucher that could not have been created is not one an edit may
 * produce either.
 */
async function buildVoucherLines(
  voucherType: string,
  body: Record<string, any>,
  /**
   * Values to fall back on when the body omits them. Edits pass the voucher's
   * CURRENT values here so that a field left out of the request keeps what the
   * voucher already had, instead of silently resetting to a module default.
   */
  defaults: { counterLedgerId?: number } = {},
): Promise<BuildResult> {
  let lines: LineDraft[] = [];
  let partyLedgerId: number | null = null;

  if (voucherType === "journal") {
    const raw = Array.isArray(body.lines) ? body.lines : [];
    lines = raw.map((l: any) => ({
      ledgerId: Number(l?.ledgerId),
      debit: round2(Number(l?.debit ?? 0)),
      credit: round2(Number(l?.credit ?? 0)),
    }));
    if (lines.length < 2) return { ok: false, error: "A journal voucher needs at least two lines" };
    for (const l of lines) {
      if (!Number.isFinite(l.ledgerId) || l.ledgerId <= 0) return { ok: false, error: "Every line must have a ledger selected" };
      if (!Number.isFinite(l.debit) || !Number.isFinite(l.credit) || l.debit < 0 || l.credit < 0) {
        return { ok: false, error: "Amounts must be valid non-negative numbers" };
      }
      if ((l.debit > 0) === (l.credit > 0)) {
        return { ok: false, error: "Each line must have either a debit or a credit amount (not both, not neither)" };
      }
    }
    const totalDr = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCr = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (totalDr <= 0) return { ok: false, error: "Voucher amount must be greater than zero" };
    if (Math.abs(totalDr - totalCr) > 0.005) {
      return { ok: false, error: `Voucher does not balance: debits ₹${totalDr.toFixed(2)} vs credits ₹${totalCr.toFixed(2)}` };
    }
  } else if (voucherType === "contra") {
    const fromLedgerId = Number(body.fromLedgerId);
    const toLedgerId = Number(body.toLedgerId);
    const amount = round2(Number(body.amount));
    if (!fromLedgerId || !toLedgerId) return { ok: false, error: "fromLedgerId and toLedgerId are required" };
    if (fromLedgerId === toLedgerId) return { ok: false, error: "From and To ledgers must be different" };
    if (!(amount > 0)) return { ok: false, error: "amount must be greater than zero" };
    const cashBank = await ledgerIdsUnderCodes(["STD-CASH", "STD-BANK"]);
    if (!cashBank.has(fromLedgerId) || !cashBank.has(toLedgerId)) {
      return { ok: false, error: "Contra entries move money between Cash and Bank ledgers only" };
    }
    lines = [
      { ledgerId: toLedgerId, debit: amount, credit: 0 },
      { ledgerId: fromLedgerId, debit: 0, credit: amount },
    ];
  } else {
    // credit_note (customer) / debit_note (vendor)
    const isCN = voucherType === "credit_note";
    const partyType = isCN ? "customer" : "vendor";
    const partyId = Number(body.partyId);
    if (!partyId) return { ok: false, error: `partyId (${partyType} id) is required` };
    const amount = round2(Number(body.amount));
    if (!(amount > 0)) return { ok: false, error: "amount must be greater than zero" };

    const partyCode = isCN ? `CUST-${partyId}` : `VEND-${partyId}`;
    const { rows: [pl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [partyCode]);
    if (!pl) {
      return { ok: false, error: `No ledger found for this ${partyType}. Re-save the ${partyType} to create its ledger.` };
    }
    partyLedgerId = pl.id;

    // Body first, then the voucher's existing leg (edits), then the module
    // default. Without the middle step an edit that only changed the amount
    // would quietly move the entry from Purchases to Sales, or vice versa.
    let counterLedgerId = Number(body.counterLedgerId) || Number(defaults.counterLedgerId) || 0;
    if (!counterLedgerId) {
      const defCode = isCN ? "STD-SALES" : "STD-PUR";
      const { rows: [def] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [defCode]);
      if (!def) return { ok: false, error: "counterLedgerId is required" };
      counterLedgerId = def.id;
    }
    if (counterLedgerId === partyLedgerId) {
      return { ok: false, error: "Counter ledger cannot be the party's own ledger" };
    }

    lines = isCN
      ? [ // sales return / rate difference: Dr Sales (reversal), Cr Customer
          { ledgerId: counterLedgerId, debit: amount, credit: 0 },
          { ledgerId: partyLedgerId!, debit: 0, credit: amount },
        ]
      : [ // purchase return: Dr Vendor, Cr Purchases (reversal)
          { ledgerId: partyLedgerId!, debit: amount, credit: 0 },
          { ledgerId: counterLedgerId, debit: 0, credit: amount },
        ];
  }

  // All referenced ledgers must exist and be postable (not groups)
  const ledgerIds = [...new Set(lines.map(l => l.ledgerId))];
  const { rows: ledgerRows } = await pool.query(
    `SELECT id, name, is_group, is_system_group FROM account_ledgers WHERE id = ANY($1)`, [ledgerIds]
  );
  if (ledgerRows.length !== ledgerIds.length) {
    return { ok: false, error: "One or more selected ledgers do not exist" };
  }
  const grp = ledgerRows.find((l: any) => l.is_group || l.is_system_group);
  if (grp) return { ok: false, error: `"${grp.name}" is a group — post to a specific ledger under it instead` };

  return { ok: true, lines, partyLedgerId, totalAmount: round2(lines.reduce((s, l) => s + l.debit, 0)) };
}

// ── Voucher location ────────────────────────────────────────────────────────

type VoucherLoc = { locationType: "headoffice" | "warehouse" | "outlet"; locationId: number };

/**
 * Parse and AUTHORIZE the location a manual voucher is stamped with.
 *
 * The body's location fields are a request, not authority: Head Office staff
 * may record a voucher under any location, branch staff only under their own.
 * When the body omits the fields the fallback wins — the caller's own location
 * on create (backward compatible with older clients), the voucher's CURRENT
 * stamp on edit, so an edit that doesn't mention location never silently moves
 * the entry between location books.
 */
async function resolveVoucherLocation(
  employee: { branchType?: string; branchId?: number } | undefined,
  body: Record<string, any>,
  fallback: VoucherLoc | null,
): Promise<{ ok: true; loc: VoucherLoc } | { ok: false; status: number; error: string }> {
  const rawType = body.locationType != null && body.locationType !== "" ? String(body.locationType) : "";
  let loc: VoucherLoc;
  if (!rawType) {
    if (fallback) {
      loc = fallback;
    } else {
      const cl = callerLocation(employee);
      loc = { locationType: cl.locationType as VoucherLoc["locationType"], locationId: Number(cl.locationId) };
    }
  } else if (rawType === "headoffice") {
    // Head Office is singular — its id is a fixed placeholder (money vouchers
    // store 0 throughout), never taken from the body.
    loc = { locationType: "headoffice", locationId: 0 };
  } else if (rawType === "warehouse" || rawType === "outlet") {
    const id = Number(body.locationId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, status: 400, error: "Please select a location." };
    }
    const table = rawType === "warehouse" ? "warehouses" : "outlets";
    const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
    if (!rows[0]) {
      return { ok: false, status: 400, error: `${rawType === "warehouse" ? "Warehouse" : "Outlet"} not found` };
    }
    loc = { locationType: rawType, locationId: id };
  } else {
    return { ok: false, status: 400, error: "locationType must be headoffice, warehouse or outlet" };
  }

  const branchType = employee?.branchType;
  if (branchType && branchType !== "headoffice") {
    const own = callerLocation(employee);
    if (own.locationType !== loc.locationType || Number(own.locationId) !== loc.locationId) {
      return { ok: false, status: 403, error: "You can only record vouchers for your own location." };
    }
  }
  return { ok: true, loc };
}

// locationOwnedLedgerMap lives in lib/moneyScope.ts — shared with the money
// voucher routes so payments/receipts stamp locations by the exact same rule.

/**
 * A manual voucher's lines must be consistent with the location that stamps
 * the whole entry (both legs of every derived posting carry ONE stamp): a
 * branch-owned cash/sales/purchase ledger may only appear on a voucher stamped
 * to its owner, and Head Office's own cash/bank accounts only on a Head Office
 * voucher. Otherwise a located cash book would show money moving through a
 * till that its own location slice cannot see.
 */
async function checkLinesLocation(
  lines: LineDraft[],
  loc: VoucherLoc,
  employee: { branchType?: string; branchId?: number } | undefined,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const owned = await locationOwnedLedgerMap();
  // HO's own cash/bank = the STD-CASH/STD-BANK subtrees minus every branch till.
  const hoCashBank = await ledgerIdsUnderCodes(["STD-CASH", "STD-BANK"]);
  for (const id of owned.keys()) hoCashBank.delete(id);

  const ids = [...new Set(lines.map((l) => l.ledgerId))];
  const { rows: named } = await pool.query(
    `SELECT id, name FROM account_ledgers WHERE id = ANY($1)`, [ids]
  );
  const nameOf = (id: number) => named.find((r: any) => Number(r.id) === id)?.name ?? `ledger #${id}`;

  for (const l of lines) {
    const owners = owned.get(l.ledgerId);
    if (owners) {
      const match = owners.some((o) => o.locationType === loc.locationType && o.locationId === loc.locationId);
      if (!match) {
        return {
          ok: false, status: 400,
          error: `"${nameOf(l.ledgerId)}" belongs to ${owners[0].name}. Record this voucher under that location, or pick an account of the selected location.`,
        };
      }
    } else if (hoCashBank.has(l.ledgerId) && loc.locationType !== "headoffice") {
      return {
        ok: false, status: 400,
        error: `"${nameOf(l.ledgerId)}" is a Head Office cash/bank account — it can only be used on a voucher recorded under Head Office.`,
      };
    }
  }

  // Branch creators additionally may not post against parties outside their
  // own location's scope — the same rule payments and receipts enforce.
  const branchType = employee?.branchType;
  if (branchType && branchType !== "headoffice") {
    const foreignParties = new Set(await foreignPartyLedgerIds(ownLocationScope(employee)));
    const hit = lines.find((l) => foreignParties.has(l.ledgerId));
    if (hit) {
      return { ok: false, status: 403, error: `"${nameOf(hit.ledgerId)}" belongs to another location's customer or vendor.` };
    }
  }
  return { ok: true };
}

// ── Journal / Contra / Credit Note / Debit Note vouchers ──────────────────

// Serves Journal, Contra, Notes and Vouchers pages (all under Vouchers).
router.get("/accounts/journal-vouchers", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
  const { type, fromDate, toDate } = req.query as { type?: string; fromDate?: string; toDate?: string };
  const conds: string[] = [];
  const params: any[] = [];

  // LBAC: Head Office sees everything; a branch user sees only vouchers
  // stamped with their own location (the stamp every posting leg inherits).
  const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  if (employee?.branchType && employee.branchType !== "headoffice") {
    const own = callerLocation(employee);
    params.push(own.locationType); conds.push(`v.location_type = $${params.length}`);
    params.push(own.locationId);   conds.push(`v.location_id = $${params.length}`);
  }
  // View narrowing: the global location selector (or explicit query params)
  // narrows on the voucher's location stamp, ANDed onto the LBAC above so it
  // can only narrow. Unstamped legacy vouchers belong to Head Office; HO
  // matches on type alone (voucher HO rows carry id 0).
  const jvViewLoc = getLocationFilter(req);
  if (jvViewLoc) {
    params.push(jvViewLoc.locationType);
    conds.push(`COALESCE(v.location_type,'headoffice') = $${params.length}`);
    if (jvViewLoc.locationType !== "headoffice") {
      params.push(jvViewLoc.locationId);
      conds.push(`v.location_id = $${params.length}`);
    }
  }
  if (type && JV_TYPES.has(type)) { params.push(type); conds.push(`v.voucher_type = $${params.length}`); }
  if (isDate(fromDate)) { params.push(fromDate); conds.push(`v.voucher_date >= $${params.length}`); }
  if (isDate(toDate))   { params.push(toDate);   conds.push(`v.voucher_date <= $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows: vouchers } = await pool.query(
    `SELECT v.*, pl.name AS party_name, pl.code AS party_code
     FROM journal_vouchers v
     LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
     ${where}
     ORDER BY v.voucher_date DESC, v.id DESC`, params
  );

  const linesByVoucher = new Map<number, any[]>();
  if (vouchers.length > 0) {
    const { rows: lines } = await pool.query(
      `SELECT l.id, l.voucher_id, l.ledger_id, l.debit, l.credit,
              al.name AS ledger_name, al.code AS ledger_code
       FROM journal_voucher_lines l
       LEFT JOIN account_ledgers al ON al.id = l.ledger_id
       WHERE l.voucher_id = ANY($1) ORDER BY l.id`,
      [vouchers.map((v: any) => v.id)]
    );
    for (const l of lines) {
      const arr = linesByVoucher.get(l.voucher_id) ?? [];
      arr.push(l);
      linesByVoucher.set(l.voucher_id, arr);
    }
  }

  res.json(vouchers.map((v: any) => serializeVoucher(v, linesByVoucher.get(v.id) ?? [])));
});

/**
 * The locations the caller may record a manual voucher under, each with the
 * cash/bank ledger ids the voucher dialog should offer for it. Head Office's
 * set is the STD-CASH/STD-BANK subtrees minus every branch-owned till; a
 * branch's set is its own cash ledger(s). `ownedLedgers` maps every
 * branch-owned ledger to its owner so the dialog can hide accounts belonging
 * to a location other than the one selected — the same rule the server
 * enforces on save.
 */
router.get("/accounts/voucher-locations", requireModuleView(["page:/accounts/vouchers", "page:/operations/receipt-voucher", "page:/operations/payment-voucher", "page:/sales/pos", "page:/outstanding", "page:/customers"]), async (req, res): Promise<void> => {
  const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  const { rows: whs } = await pool.query(
    `SELECT id, name, cash_ledger_id FROM warehouses ORDER BY name`
  );
  // Retired outlets are a total hide — they take no new activity, vouchers included.
  const outs = (await outletWritesBlocked(pool))
    ? []
    : (await pool.query(`SELECT id, name, cash_ledger_id FROM outlets ORDER BY name`)).rows;

  const ownedMap = await locationOwnedLedgerMap();
  const hoCashBank = await ledgerIdsUnderCodes(["STD-CASH", "STD-BANK"]);
  for (const id of ownedMap.keys()) hoCashBank.delete(id);

  // Branch-assigned Cash & Bank accounts join the branch's till in its picker.
  const { rows: cbaRows } = await pool.query(
    `SELECT ledger_id, location_type, location_id FROM cash_bank_accounts
     WHERE ledger_id IS NOT NULL AND location_id IS NOT NULL AND location_type IN ('warehouse','outlet')`,
  );
  const branchCba = (lt: string, id: number) => cbaRows
    .filter((r: any) => r.location_type === lt && Number(r.location_id) === id)
    .map((r: any) => Number(r.ledger_id));

  const all = [
    { locationType: "headoffice", locationId: 0, name: "Head Office", cashBankLedgerIds: [...hoCashBank] },
    ...whs.map((w: any) => ({
      locationType: "warehouse", locationId: Number(w.id), name: w.name,
      cashBankLedgerIds: [...new Set([
        ...(w.cash_ledger_id ? [Number(w.cash_ledger_id)] : []),
        ...branchCba("warehouse", Number(w.id)),
      ])],
    })),
    ...outs.map((o: any) => ({
      locationType: "outlet", locationId: Number(o.id), name: o.name,
      cashBankLedgerIds: [...new Set([
        ...(o.cash_ledger_id ? [Number(o.cash_ledger_id)] : []),
        ...branchCba("outlet", Number(o.id)),
      ])],
    })),
  ];

  const isHO = !employee?.branchType || employee.branchType === "headoffice";
  const own = callerLocation(employee);
  const locations = isHO
    ? all
    : all.filter((l) => l.locationType === own.locationType && l.locationId === Number(own.locationId));

  const ownedLedgers = [...ownedMap.entries()].flatMap(([ledgerId, owners]) =>
    owners.map((o) => ({ ledgerId, locationType: o.locationType, locationId: o.locationId }))
  );

  res.json({ locations, ownedLedgers, headOfficeCashBankLedgerIds: [...hoCashBank] });
});

router.post("/accounts/journal-vouchers", requireModuleAction("page:/accounts/vouchers", "add"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, any>;
  const voucherType = String(body.voucherType ?? "journal");
  if (!JV_TYPES.has(voucherType)) {
    res.status(400).json({ error: "voucherType must be journal, contra, credit_note or debit_note" }); return;
  }
  const voucherDate = String(body.voucherDate ?? "").slice(0, 10);
  if (!isDate(voucherDate)) { res.status(400).json({ error: "voucherDate (YYYY-MM-DD) is required" }); return; }
  // Month lock: a journal voucher is a new record dated voucherDate — it may
  // not be created in a locked month.
  if (await respondIfMonthLocked(res, pool, [voucherDate], "journal voucher create")) return;
  const narration = body.narration ? String(body.narration).trim() || null : null;
  const reason = body.reason ? String(body.reason).trim() || null : null;
  const createdBy = (req as any).employee?.username ?? "system";

  const built = await buildVoucherLines(voucherType, body);
  if (!built.ok) { res.status(400).json({ error: built.error }); return; }
  const { lines, partyLedgerId, totalAmount } = built;

  // The voucher's location: chosen in the dialog (Head Office / a warehouse /
  // an outlet), authorized against the caller, defaulting to the caller's own
  // location when an older client omits it. The stamp is what keeps the entry
  // visible in that location's books instead of falling into the
  // unattributable company bucket.
  const locRes = await resolveVoucherLocation((req as any).employee, body, null);
  if (!locRes.ok) { res.status(locRes.status).json({ error: locRes.error }); return; }
  const { locationType, locationId } = locRes.loc;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locationType, id: locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }
  const lineCheck = await checkLinesLocation(lines, locRes.loc, (req as any).employee);
  if (!lineCheck.ok) { res.status(lineCheck.status).json({ error: lineCheck.error }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id: voucherId, voucherNumber } = await createJournalVoucherCore(client, {
      voucherType, voucherDate, narration, partyLedgerId, reason, totalAmount, createdBy, locationType, locationId, lines,
    });
    const v = { id: voucherId };
    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "accounts", entityType: "journal_voucher", entityId: v.id,
      description: `${VOUCHER_TYPE_LABELS[voucherType]} ${voucherNumber} — ₹${totalAmount.toFixed(2)}`,
      metadata: { after: { voucherType, voucherNumber, voucherDate, totalAmount } },
    }).catch(() => {});

    res.status(201).json(await fetchVoucher(v.id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

router.get("/accounts/journal-vouchers/:id", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const voucher = await fetchVoucher(id);
  if (!voucher) { res.status(404).json({ error: "Voucher not found" }); return; }
  // LBAC: a branch user may only read vouchers stamped with their own
  // location. 404 (not 403) — they must not learn which voucher ids exist.
  const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  if (employee?.branchType && employee.branchType !== "headoffice") {
    const own = callerLocation(employee);
    if (voucher.locationType !== own.locationType || Number(voucher.locationId) !== Number(own.locationId)) {
      res.status(404).json({ error: "Voucher not found" });
      return;
    }
  }
  res.json(voucher);
});

/**
 * Edit a MANUALLY created voucher.
 *
 * Only vouchers a person entered on this screen may be changed. Everything else
 * — payroll, production costing, rent, fixed assets, returns, inter-branch
 * transfers — is owned by a source document, and anything of unknown
 * provenance is treated the same way. See migrations/voucherProvenance.ts for
 * why the row's own `origin` column is the only trustworthy signal.
 *
 * The voucher id AND its number are preserved, and the lines are replaced in
 * place inside one transaction, so the edit never leaves a second copy behind.
 * Reports need no separate update: the Trial Balance, Day Book, Cash/Bank Book,
 * P&L, Balance Sheet and every ledger read journal_voucher_lines through
 * buildDerivedPostings() at query time.
 */
router.patch("/accounts/journal-vouchers/:id", requireModuleAction("page:/accounts/vouchers", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid voucher id" }); return; }

  const body = (req.body ?? {}) as Record<string, any>;

  // Concurrency. The caller must echo the `rev` it read. Its absence means the
  // form was not loaded from the row being written — precisely the case that
  // silently discards someone else's edit.
  const expectedRev = body.expectedRev ?? body.rev;
  if (!expectedRev) {
    res.status(400).json({ error: "expectedRev is required — reopen the voucher and try again" }); return;
  }
  const expectedMs = new Date(String(expectedRev)).getTime();
  if (!Number.isFinite(expectedMs)) { res.status(400).json({ error: "expectedRev is not a valid timestamp" }); return; }

  // Unlocked pre-read so the common rejections come back with a clear message
  // without holding a row lock through validation.
  const { rows: [pre] } = await pool.query(
    `SELECT id, voucher_type, voucher_number, origin, source_module, party_ledger_id,
            location_type, location_id
       FROM journal_vouchers WHERE id = $1`, [id]
  );
  if (!pre) { res.status(404).json({ error: "Voucher not found" }); return; }
  // LBAC: a branch user may only edit vouchers stamped with their own
  // location. 404, matching the read path — foreign ids must stay invisible.
  const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  if (employee?.branchType && employee.branchType !== "headoffice") {
    const own = callerLocation(employee);
    if ((pre.location_type ?? null) !== own.locationType || Number(pre.location_id ?? -1) !== Number(own.locationId)) {
      res.status(404).json({ error: "Voucher not found" });
      return;
    }
  }
  if (!isEditableVoucher(pre)) { res.status(409).json({ error: lockedReason(pre) }); return; }

  // The type is fixed. Changing it would contradict the voucher number's own
  // prefix, and the number is preserved by design.
  const voucherType = String(pre.voucher_type);
  if (body.voucherType != null && String(body.voucherType) !== voucherType) {
    res.status(400).json({
      error: `${pre.voucher_number} is a ${VOUCHER_TYPE_LABELS[voucherType] ?? voucherType} voucher. Its type cannot be changed — delete it and raise the correct kind instead.`,
    }); return;
  }

  const voucherDate = String(body.voucherDate ?? "").slice(0, 10);
  if (!isDate(voucherDate)) { res.status(400).json({ error: "voucherDate (YYYY-MM-DD) is required" }); return; }
  const narration = body.narration ? String(body.narration).trim() || null : null;
  const reason = body.reason ? String(body.reason).trim() || null : null;

  // The preserved number carries the financial year it was allocated under.
  // A date crossing into another FY would leave e.g. JV/2026-27/0007 dated in
  // 2027-28 — a number contradicting its own sequence. Renumbering instead is
  // worse: it strands the allocator counter and breaks existing references.
  const numberFy = fyFromVoucherNumber(pre.voucher_number);
  if (numberFy) {
    const dateFy = financialYearLabel(voucherDate, await companyFyStartMonth());
    if (dateFy !== numberFy) {
      res.status(400).json({
        error: `${pre.voucher_number} belongs to financial year ${numberFy}, and its number is kept on edit. A date in ${dateFy} would contradict it — delete this voucher and raise a new one in ${dateFy} instead.`,
      }); return;
    }
  }

  // A note's counter leg is not something the edit form must re-state. Recover
  // the one the voucher already carries so an omitted counterLedgerId preserves
  // it. Reading it unlocked is safe: if anything about the row changes before
  // we commit, the rev check inside the transaction rejects the whole write.
  let existingCounterLedgerId = 0;
  if (voucherType === "credit_note" || voucherType === "debit_note") {
    const { rows: existing } = await pool.query(
      `SELECT ledger_id FROM journal_voucher_lines
        WHERE voucher_id = $1 AND ledger_id IS DISTINCT FROM $2 ORDER BY id LIMIT 1`,
      [id, pre.party_ledger_id],
    );
    existingCounterLedgerId = Number(existing[0]?.ledger_id) || 0;
  }

  const built = await buildVoucherLines(voucherType, body, { counterLedgerId: existingCounterLedgerId });
  if (!built.ok) { res.status(400).json({ error: built.error }); return; }
  const { lines, partyLedgerId, totalAmount } = built;

  // Location: omitted → the voucher keeps its current stamp (an edit that
  // doesn't mention location never moves the entry between books); provided →
  // re-authorized and re-validated exactly like a create.
  const currentLoc: VoucherLoc | null = pre.location_type
    ? { locationType: pre.location_type, locationId: Number(pre.location_id ?? 0) }
    : null;
  const locRes = await resolveVoucherLocation(employee, body, currentLoc);
  if (!locRes.ok) { res.status(locRes.status).json({ error: locRes.error }); return; }
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locRes.loc.locationType, id: locRes.loc.locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }
  const lineCheck = await checkLinesLocation(lines, locRes.loc, employee);
  if (!lineCheck.ok) { res.status(lineCheck.status).json({ error: lineCheck.error }); return; }

  const updatedBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Re-read under a row lock. Provenance and the concurrency token must be
    // checked against the row actually being written, not the one sampled above.
    const { rows: [cur] } = await client.query(
      `SELECT * FROM journal_vouchers WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!cur) { await client.query("ROLLBACK"); res.status(404).json({ error: "Voucher not found" }); return; }
    if (!isEditableVoucher(cur)) { await client.query("ROLLBACK"); res.status(409).json({ error: lockedReason(cur) }); return; }

    // Month lock: an edit may neither touch a voucher inside a locked month nor
    // move it into/out of one — check BOTH the stored date and the new one.
    for (const d of [cur.voucher_date, voucherDate]) {
      const ym = ymOfDate(d);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }

    const currentRev = cur.updated_at ?? cur.created_at;
    const currentMs = currentRev ? new Date(currentRev).getTime() : NaN;
    if (!Number.isFinite(currentMs) || currentMs !== expectedMs) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "Someone else changed this voucher while you were editing it. Reload the page and reapply your changes.",
      });
      return;
    }

    const { rows: beforeLines } = await client.query(
      `SELECT ledger_id, debit, credit FROM journal_voucher_lines WHERE voucher_id = $1 ORDER BY id`, [id]
    );

    await client.query(
      `UPDATE journal_vouchers
          SET voucher_date = $2, narration = $3, reason = $4, party_ledger_id = $5,
              total_amount = $6, updated_at = now(), updated_by = $7,
              location_type = $8, location_id = $9
        WHERE id = $1`,
      [id, voucherDate, narration, reason, partyLedgerId, totalAmount, updatedBy,
       locRes.loc.locationType, locRes.loc.locationId]
    );

    // Replace the lines in place. Same voucher id, same number — so every
    // reference and every derived report follows the edit instead of seeing a
    // second entry alongside the original.
    await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, $4)`,
        [id, l.ledgerId, l.debit, l.credit]
      );
    }

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "accounts", entityType: "journal_voucher", entityId: id,
      user: updatedBy,
      description: `Edited ${VOUCHER_TYPE_LABELS[voucherType] ?? voucherType} ${cur.voucher_number} — ₹${Number(cur.total_amount).toFixed(2)} → ₹${totalAmount.toFixed(2)}`,
      metadata: {
        before: {
          voucherDate: cur.voucher_date instanceof Date ? toLocalISODate(cur.voucher_date) : cur.voucher_date,
          narration: cur.narration,
          reason: cur.reason,
          partyLedgerId: cur.party_ledger_id,
          totalAmount: Number(cur.total_amount),
          lines: beforeLines.map((l: any) => ({ ledgerId: l.ledger_id, debit: Number(l.debit), credit: Number(l.credit) })),
        },
        after: {
          voucherDate, narration, reason, partyLedgerId, totalAmount,
          lines: lines.map(l => ({ ledgerId: l.ledgerId, debit: l.debit, credit: l.credit })),
        },
      },
    }).catch(() => {});

    res.json(await fetchVoucher(id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

router.delete("/accounts/journal-vouchers/:id", requireModuleAction("page:/accounts/vouchers", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid voucher id" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock first, then decide. A voucher this screen refuses to EDIT because
    // another module owns it must not be deletable here either — deleting it
    // strands its source document (the payroll run, the production batch, the
    // transfer) with no matching entry in the books.
    //
    // Deliberately narrow: only provenance we have PROVEN to be system-owned is
    // blocked. Rows predating provenance tracking (origin IS NULL) stay
    // deletable, because deletion is a capability this screen has always had and
    // silently withdrawing it for every historical voucher is its own hazard.
    const { rows: [v] } = await client.query(
      `SELECT id, voucher_number, voucher_type, voucher_date, total_amount, origin, source_module,
              location_type, location_id
         FROM journal_vouchers WHERE id = $1 FOR UPDATE`, [id]
    );
    if (!v) { await client.query("ROLLBACK"); res.status(404).json({ error: "Voucher not found" }); return; }
    // LBAC: a branch user may only delete vouchers stamped with their own
    // location. 404, matching the read path.
    const employee = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    if (employee?.branchType && employee.branchType !== "headoffice") {
      const own = callerLocation(employee);
      if ((v.location_type ?? null) !== own.locationType || Number(v.location_id ?? -1) !== Number(own.locationId)) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Voucher not found" });
        return;
      }
    }
    if (v.origin === "system") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: lockedReason(v, "delete") });
      return;
    }
    // Month lock: cannot delete a voucher dated in a locked month.
    {
      const ym = ymOfDate(v.voucher_date);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }

    await client.query(`DELETE FROM journal_vouchers WHERE id = $1`, [id]);
    await client.query("COMMIT");

    logActivity({
      action: "DELETE", module: "accounts", entityType: "journal_voucher", entityId: id,
      user: (req as any).employee?.username,
      description: `Deleted ${VOUCHER_TYPE_LABELS[v.voucher_type] ?? v.voucher_type} ${v.voucher_number} — ₹${Number(v.total_amount).toFixed(2)}`,
    }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ── Derived double-entry postings ──────────────────────────────────────────
// One shared builder so the Trial Balance, Cash Book and Bank Book always
// agree with each other. Sales/purchases have no stored ledger postings, so
// they are derived here the same way the financial statements imply them.

export interface Posting {
  date: string;
  /** Stable identity of the source document, so consumers can regroup the
   *  legs of one entry without guessing from voucher number + description. */
  entryId: string;
  ledgerId: number;
  debit: number;
  credit: number;
  source: string;
  voucherNumber: string | null;
  description: string;
  /**
   * Where the source document belongs: 'warehouse' | 'outlet' | 'headoffice',
   * or null for company-level entries that no location can honestly claim
   * (journal-family vouchers, and legacy rows with no stored location).
   * Both legs of an entry carry the SAME location — an entry is stamped as a
   * whole, never split — so any location slice of the stream stays balanced
   * and the slices plus the company-level bucket always sum to the whole.
   */
  locationType: string | null;
  locationId: number | null;
}

// Location filtering over the posting stream lives in lib/postingLocation.ts
// (shared with lib/books.ts). Re-exported here for the report routes.
import {
  parsePostingLocationFilter, postingMatchesLocation,
  filterPostingsByLocation, companyLevelSummary,
  type PostingLocationFilter,
} from "../lib/postingLocation";
export {
  parsePostingLocationFilter, postingMatchesLocation,
  filterPostingsByLocation, companyLevelSummary,
  type PostingLocationFilter,
};
import { getLocationFilter, getPostingLocationFilter } from "../lib/requestLocation";

export async function buildDerivedPostings(opts: { toDate?: string; q?: Q } = {}): Promise<Posting[]> {
  const { toDate } = opts;
  const q = opts.q ?? pool;
  const postings: Posting[] = [];
  /**
   * `date` is declared as a YYYY-MM-DD string, but pg hands back a JS Date for
   * every `date`/`timestamptz` column, so half the sources below would push a
   * Date object into a field typed `string`. Consumers then either crash
   * (`p.date.localeCompare is not a function`) or silently mis-sort, because
   * a Date stringifies to "Fri Jul 28 2026 …" which does not compare against
   * "2026-07-28". Normalising once here makes the declared type true for every
   * consumer instead of asking each one to remember `String(p.date)`.
   */
  const push = (p: Omit<Posting, "locationType" | "locationId"> & { locationType?: string | null; locationId?: number | null }) => {
    if (!p.ledgerId || (p.debit <= 0.004 && p.credit <= 0.004)) return;
    const d = p.date as unknown;
    const full: Posting = {
      ...p,
      // Undefined means the source did not stamp a location — company-level.
      locationType: p.locationType ?? null,
      locationId: p.locationType != null ? Number(p.locationId ?? 0) : null,
      date: typeof d === "string"
        ? (d.length === 10 ? d : d.slice(0, 10))
        : d instanceof Date ? toLocalISODate(d) : String(d ?? "").slice(0, 10),
    };
    postings.push(full);
  };
  /** Normalise a stored location pair into a posting stamp. */
  const locOf = (type: unknown, id: unknown): { locationType: string | null; locationId: number | null } => {
    const t = typeof type === "string" && type.length > 0 ? type : null;
    if (!t) return { locationType: null, locationId: null };
    const n = Number(id);
    return { locationType: t, locationId: Number.isFinite(n) ? n : 0 };
  };
  const upTo = (col: string, params: any[]) => {
    if (!isDate(toDate)) return "";
    params.push(toDate);
    return ` AND ${col} <= $${params.length}`;
  };

  const { rows: ledgerRows } = await q.query(`SELECT id, code, name FROM account_ledgers`);
  const byCode = new Map<string, any>(ledgerRows.filter((r: any) => r.code).map((r: any) => [r.code, r]));
  const idOf = (code: string): number => byCode.get(code)?.id ?? 0;
  const stdCash = idOf("STD-CASH"), stdBank = idOf("STD-BANK"), stdSales = idOf("STD-SALES"),
        stdDtx = idOf("STD-DTX"), stdPur = idOf("STD-PUR"), elecClr = idOf("STD-ELEC-CLR"),
        debtors = idOf("SYS-DEBTORS"), creditors = idOf("SYS-CREDITORS");
  // Inter-branch transfer ledgers. A cross-GSTIN transfer raises a real tax
  // invoice, but it is a movement of own stock, not turnover — so its value
  // parks in the balance-sheet clearing ledger instead of Sales/Purchases,
  // which is what keeps transfers out of the P&L entirely.
  const branchTrf = idOf("STD-BRANCH-TRF"),
        branchDebtor = idOf("STD-BRANCH-DEBTOR"),
        branchCreditor = idOf("STD-BRANCH-CREDITOR");

  // Location → cash / sales / purchase ledger mapping. A location's purchases
  // debit its own purchase ledger, so each warehouse's buying shows separately
  // in the books instead of being lumped into one company-wide Purchases total.
  // Outlets have no purchase ledger of their own (they are sales points, stocked
  // by transfer), so theirs is NULL and falls back to the company Purchases ledger.
  const { rows: locRows } = await q.query(`
    SELECT 'warehouse' AS lt, id, cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses
    UNION ALL
    SELECT 'outlet' AS lt, id, cash_ledger_id, sales_ledger_id, NULL::integer AS purchase_ledger_id FROM outlets
  `);
  const locMap = new Map<string, any>(locRows.map((r: any) => [`${r.lt}:${r.id}`, r]));

  // 1. Payments: Dr paid_to / Cr paid_from
  // Sales-return cash refunds are payments rows; older ones were inserted
  // without a location stamp, so the return document's location backfills it —
  // otherwise every historical refund would misfile under Head Office.
  const pp: any[] = [];
  const { rows: pays } = await q.query(
    `SELECT p.id, p.payment_date AS date, p.paid_from_ledger_id AS f, p.paid_to_ledger_id AS t,
            p.amount, p.voucher_number, p.narration,
            p.advance_amount, p.advance_ledger_id,
            COALESCE(p.location_type, sr.location_type) AS location_type,
            COALESCE(p.location_id, sr.location_id) AS location_id
     FROM payments p
     LEFT JOIN sales_returns sr ON sr.refund_payment_id = p.id
     WHERE 1=1${upTo("p.payment_date", pp)}`, pp
  );
  for (const r of pays) {
    const amt = Number(r.amount);
    const desc = r.narration || "Payment";
    const eid = `payment:${r.id}`;
    // Money vouchers default to Head Office — the long-standing convention for
    // rows recorded before location stamping existed (id placeholder 0).
    const loc = locOf(r.location_type ?? "headoffice", r.location_id ?? 0);
    // Excess over the vendor's bills is an advance TO the vendor: it debits
    // the vendor-advance asset ledger, not the payable — otherwise the payable
    // would swing into an unexplained debit balance.
    const adv = Math.min(Math.max(Number(r.advance_amount ?? 0), 0), amt);
    const advLedger = Number(r.advance_ledger_id ?? 0);
    if (adv > 0.004 && advLedger) {
      const toBills = round2(amt - adv);
      if (toBills > 0.004) push({ entryId: eid, date: r.date, ledgerId: r.t, debit: toBills, credit: 0, source: "payment", voucherNumber: r.voucher_number, description: desc, ...loc });
      push({ entryId: eid, date: r.date, ledgerId: advLedger, debit: adv, credit: 0, source: "payment", voucherNumber: r.voucher_number, description: `Advance paid — ${desc}`, ...loc });
    } else {
      push({ entryId: eid, date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "payment", voucherNumber: r.voucher_number, description: desc, ...loc });
    }
    push({ entryId: eid, date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "payment", voucherNumber: r.voucher_number, description: desc, ...loc });
  }

  // 2. Receipts: Dr received_in / Cr received_from
  // Sale-linked receipts are EXCLUDED: the sales flow persists receipt rows at
  // sale creation (voucher_number = invoice_number) and at payment collection
  // (linked via sale_payments.clearing_receipt_id), but those rows don't split
  // GST and credit Sales on collection. Section 5 derives the correct postings
  // from sales + sale_payments instead — including both would double-count.
  const rp: any[] = [];
  const { rows: recs } = await q.query(
    `SELECT id, receipt_date AS date, received_from_ledger_id AS f, received_in_ledger_id AS t,
            amount, voucher_number, narration, location_type, location_id,
            advance_amount, advance_ledger_id
     FROM receipts
     WHERE id NOT IN (SELECT clearing_receipt_id FROM sale_payments WHERE clearing_receipt_id IS NOT NULL)
       AND (voucher_number IS NULL OR voucher_number NOT IN (SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL))
       ${upTo("receipt_date", rp)}`, rp
  );
  for (const r of recs) {
    const amt = Number(r.amount);
    const desc = r.narration || "Receipt";
    const eid = `receipt:${r.id}`;
    const loc = locOf(r.location_type ?? "headoffice", r.location_id ?? 0);
    push({ entryId: eid, date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "receipt", voucherNumber: r.voucher_number, description: desc, ...loc });
    // The whole amount credits the payer's ledger. Money received beyond a
    // customer's bills simply leaves their single Sundry Debtor ledger with a
    // CREDIT (negative) balance — that credit balance IS the advance; there is
    // no separate customer-advance ledger (business decision, Aug 2026).
    push({ entryId: eid, date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "receipt", voucherNumber: r.voucher_number, description: desc, ...loc });
  }

  // 2b. Advance slice of ALLOCATION receipts. A receipt that settles bills is
  // excluded above (its bill money reaches the books through sale_payments in
  // section 5), but its EXCESS never touches a sale — so that slice posts here:
  // Dr received_in / Cr customer advance. Without this the money would land in
  // the till through section 5's legs while the advance liability never arose.
  const radvParams: any[] = [];
  const { rows: allocAdvRecs } = await q.query(
    `SELECT id, receipt_date AS date, received_in_ledger_id AS t,
            received_from_ledger_id AS f,
            advance_amount, voucher_number, narration,
            location_type, location_id
     FROM receipts
     WHERE advance_amount > 0.004
       AND id IN (SELECT clearing_receipt_id FROM sale_payments WHERE clearing_receipt_id IS NOT NULL)
       ${upTo("receipt_date", radvParams)}`, radvParams
  );
  for (const r of allocAdvRecs) {
    const adv = Number(r.advance_amount);
    const eid = `receiptadv:${r.id}`;
    const desc = r.narration || "Advance received";
    const loc = locOf(r.location_type ?? "headoffice", r.location_id ?? 0);
    push({ entryId: eid, date: r.date, ledgerId: r.t, debit: adv, credit: 0, source: "receipt", voucherNumber: r.voucher_number, description: `Advance received — ${desc}`, ...loc });
    // The excess credits the customer's OWN ledger — their advance is simply
    // that ledger's credit (negative) balance; no separate advance ledger.
    push({ entryId: eid, date: r.date, ledgerId: Number(r.f), debit: 0, credit: adv, source: "receipt", voucherNumber: r.voucher_number, description: `Advance received — ${desc}`, ...loc });
  }

  // 3. Journal voucher lines (journal, contra, credit/debit notes) — as stored.
  //
  // Most JVs are company-level — the honest answer for manual journals,
  // payroll allocations and two-location transfer vouchers. Two exceptions
  // carry a location: RETURN vouchers inherit it from their source document
  // (a sales-return credit note / purchase-return debit note must not vanish
  // from the slice its sale or purchase posted into), and system vouchers
  // whose money leg is a branch till carry their own stored stamp
  // (v.location_type — salary/advance payments made from a warehouse or
  // outlet cash box).
  // (credit_note_id / debit_note_id are one-to-one, so the joins cannot fan out.)
  const jp: any[] = [];
  const { rows: jls } = await q.query(
    `SELECT v.id AS voucher_id, v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.ledger_id, l.debit, l.credit,
            COALESCE(sr.location_type, pu.location_type, v.location_type) AS location_type,
            COALESCE(sr.location_id, pu.location_id, v.location_id) AS location_id
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     LEFT JOIN sales_returns sr ON sr.credit_note_id = v.id
     LEFT JOIN purchase_returns pr ON pr.debit_note_id = v.id
     LEFT JOIN purchases pu ON pu.id = pr.purchase_id
     WHERE 1=1${upTo("v.voucher_date", jp)}`, jp
  );
  for (const r of jls) {
    push({
      entryId: `jv:${r.voucher_id}`,
      date: r.date, ledgerId: r.ledger_id, debit: Number(r.debit), credit: Number(r.credit),
      source: r.voucher_type, voucherNumber: r.voucher_number,
      description: r.narration || VOUCHER_TYPE_LABELS[r.voucher_type] || "Journal",
      ...locOf(r.location_type, r.location_id),
    });
  }

  // 4. Direct expenses: Dr expense ledger / Cr the paying account's own ledger.
  //    Since the Cash & Bank ↔ chart link, each payment account is backed by a
  //    CBA ledger under the Cash / Bank Accounts heads, and the credit leg goes
  //    there — which is what makes the account's ledger balance equal
  //    opening − its expenses (the migration seeded opening = stored + spent).
  //    Rows whose account predates the link (or was hand-deleted) fall back to
  //    the head itself, exactly as before.
  const ep: any[] = [];
  const { rows: exps } = await q.query(
    `SELECT e.id, e.expense_number, e.expense_date AS date, e.ledger_account_id AS lid, e.amount, e.description,
            e.location_type, e.location_id,
            cb.account_type AS cb_type, cb.ledger_id AS cb_ledger
     FROM expenses e
     LEFT JOIN cash_bank_accounts cb ON cb.id = e.payment_account_id
     WHERE 1=1${upTo("e.expense_date", ep)}`, ep
  );
  for (const r of exps) {
    const amt = Number(r.amount);
    const linked = Number(r.cb_ledger);
    const creditLedger = Number.isFinite(linked) && linked > 0
      ? linked
      : (String(r.cb_type ?? "").toLowerCase().includes("bank") ? stdBank : stdCash);
    const desc = r.description || "Expense";
    const eid = `expense:${r.id}`;
    const loc = locOf(r.location_type ?? "headoffice", r.location_id ?? 0);
    push({ entryId: eid, date: r.date, ledgerId: r.lid, debit: amt, credit: 0, source: "expense", voucherNumber: r.expense_number ?? null, description: desc, ...loc });
    push({ entryId: eid, date: r.date, ledgerId: creditLedger, debit: 0, credit: amt, source: "expense", voucherNumber: r.expense_number ?? null, description: desc, ...loc });
  }

  // 5. Sales: Cr sales ledger (net) + Cr Output GST (split CGST/SGST/IGST when
  //    line detail exists, else Duty & Tax lump); Dr cash/clearing via
  //    sale_payments; Dr customer ledger for any unpaid remainder.
  const outCgst = byCode.get("STD-OUT-CGST")?.id, outSgst = byCode.get("STD-OUT-SGST")?.id, outIgst = byCode.get("STD-OUT-IGST")?.id;
  const inpCgst = byCode.get("STD-INP-CGST")?.id, inpSgst = byCode.get("STD-INP-SGST")?.id, inpIgst = byCode.get("STD-INP-IGST")?.id;
  const sp: any[] = [];
  const { rows: sales } = await q.query(
    // A cancelled customer invoice carries no revenue, no tax and no debt, so
    // it must not post at all — leaving it in was what let a cancelled bill go
    // on inflating turnover and output GST after the fact.
    //
    // Cancelled BRANCH-TRANSFER invoices are the deliberate exception and stay
    // in: rejection raises a credit note that reverses them, so dropping the
    // invoice as well would subtract the same amount twice.
    `SELECT id, invoice_number, sale_date, total_amount, tax_total, amount_paid,
            payment_mode, customer_id, location_type, location_id, line_items,
            branch_transfer_id, other_charges
     FROM sales
     WHERE (cancelled_at IS NULL OR branch_transfer_id IS NOT NULL)
       ${upTo("sale_date", sp)}`, sp
  );
  const spp: any[] = [];
  const { rows: salePays } = await q.query(
    // Allocation receipts (bill-wise settlement vouchers) carry the ledger the
    // money actually landed in — their sale_payments legs must debit THAT
    // ledger, not the method-derived cash/clearing default. Sale-source
    // receipts matter too: when a location's assigned bank/UPI account has
    // reconciliation switched off, the collection is received DIRECTLY into
    // that account's ledger instead of Electronic Clearing, and the books must
    // debit what the receipt actually says.
    `SELECT sp.sale_id, sp.payment_date, sp.method, sp.amount,
            rc.voucher_number AS receipt_vno,
            CASE WHEN rc.source = 'allocation' THEN rc.received_in_ledger_id END AS alloc_in,
            CASE WHEN rc.source = 'sale'       THEN rc.received_in_ledger_id END AS sale_in
     FROM sale_payments sp
     LEFT JOIN receipts rc ON rc.id = sp.clearing_receipt_id AND rc.source IN ('allocation', 'sale')
     WHERE 1=1${upTo("sp.payment_date", spp)}`, spp
  );
  // ALL-TIME collection totals per sale (no cutoff): the gross debtor model
  // below needs to know how much of amount_paid is counter money with no
  // collection row of its own — that slice is dated at the sale, while dated
  // collection rows post on their own payment dates.
  const { rows: spTotals } = await q.query(
    `SELECT sale_id, SUM(amount)::numeric AS total FROM sale_payments GROUP BY sale_id`
  );
  const spTotalBySale = new Map<number, number>(
    (spTotals as any[]).map((r) => [Number(r.sale_id), Number(r.total)]),
  );
  const spBySale = new Map<number, any[]>();
  for (const r of salePays) {
    const arr = spBySale.get(r.sale_id) ?? [];
    arr.push(r);
    spBySale.set(r.sale_id, arr);
  }

  for (const s of sales) {
    const total = Number(s.total_amount);
    const tax = Number(s.tax_total ?? 0);
    // Other Charges on the sale (Packing & Transport, freight, hamali…): the
    // customer owes them — they are inside total_amount — but they are not
    // revenue. Each one credits its own expense ledger (an expense RECOVERY),
    // so the sales-revenue credit must derive as total − tax − charges or the
    // P&L would inflate by every charge collected. The stored ledger id is
    // posted as-is: the chart's delete guard (loadLedgerUsage) refuses to
    // delete a ledger any sale's charges reference, so it cannot dangle.
    const saleCharges: Array<{ ledgerId: number; amount: number }> = [];
    let ocTotal = 0;
    for (const c of (Array.isArray(s.other_charges) ? s.other_charges : []) as any[]) {
      const cLid = Number(c?.ledgerId);
      const cAmt = round2(Number(c?.amount));
      if (!Number.isInteger(cLid) || cLid <= 0 || !(cAmt > 0.004)) continue;
      ocTotal = round2(ocTotal + cAmt);
      saleCharges.push({ ledgerId: cLid, amount: cAmt });
    }
    const net = round2(total - tax - ocTotal);
    const inv = s.invoice_number || `Sale #${s.id}`;
    const loc = locMap.get(`${s.location_type}:${s.location_id}`);
    // A branch-transfer invoice credits the inter-branch clearing ledger, never
    // a sales ledger. It replaces the dispatch journal voucher that used to be
    // raised for the same transfer — both would double the revenue and the tax.
    const isBranchTransfer = s.branch_transfer_id != null;
    const salesLedger = isBranchTransfer
      ? (branchTrf || stdSales)
      : (loc?.sales_ledger_id ?? stdSales);
    const cashLedger = loc?.cash_ledger_id ?? stdCash;
    const eid = `sale:${s.id}`;
    // Every leg of the sale — revenue, GST, cash, clearing, debtor — belongs to
    // the location that rang it up, so the whole entry carries one stamp.
    const sLoc = locOf(s.location_type, s.location_id);

    push({ entryId: eid, date: s.sale_date, ledgerId: salesLedger, debit: 0, credit: net, source: "sale", voucherNumber: s.invoice_number, description: isBranchTransfer ? `Branch transfer out — ${inv}` : `Sales ${inv}`, ...sLoc });
    if (tax > 0) {
      const sLines = (s.line_items ?? []) as any[];
      let cg = 0, sg = 0, ig = 0;
      for (const li of sLines) { const h = lineTaxHeads(li); cg += h.cgst; sg += h.sgst; ig += h.igst; }
      cg = round2(cg); sg = round2(sg); ig = round2(ig);
      const split = round2(cg + sg + ig);
      if (outCgst && outSgst && outIgst && split > 0.004 && Math.abs(split - tax) <= 0.05) {
        if (cg > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outCgst, debit: 0, credit: cg, source: "sale", voucherNumber: s.invoice_number, description: `Output CGST — ${inv}`, ...sLoc });
        if (sg > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outSgst, debit: 0, credit: sg, source: "sale", voucherNumber: s.invoice_number, description: `Output SGST — ${inv}`, ...sLoc });
        if (ig > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outIgst, debit: 0, credit: ig, source: "sale", voucherNumber: s.invoice_number, description: `Output IGST — ${inv}`, ...sLoc });
        const resid = round2(tax - split);
        if (resid > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: resid, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}`, ...sLoc });
        else if (resid < -0.004) push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: -resid, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}`, ...sLoc });
      } else {
        push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: tax, source: "sale", voucherNumber: s.invoice_number, description: `GST on ${inv}`, ...sLoc });
      }
    }
    // Cr each charge's expense ledger — balanced by the Dr side below, which
    // carries the FULL total_amount (customer / cash / clearing), charges
    // included. Branch-transfer invoices never carry charges (no producer),
    // so this loop is empty for them by construction.
    for (const c of saleCharges) {
      push({ entryId: eid, date: s.sale_date, ledgerId: c.ledgerId, debit: 0, credit: c.amount, source: "sale", voucherNumber: s.invoice_number, description: `Sale charge — ${inv}`, ...sLoc });
    }

    // Branch transfers are never settled in cash and never sit against a
    // customer: the whole invoice is owed by the receiving branch. Note that a
    // CANCELLED transfer invoice is still posted here on purpose — the credit
    // note raised at rejection is what reverses it, and skipping the invoice
    // as well would subtract the same amount twice.
    if (isBranchTransfer) {
      push({ entryId: eid, date: s.sale_date, ledgerId: branchDebtor || debtors, debit: total, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Due from branch — ${inv}`, ...sLoc });
      continue;
    }

    // ── Gross debtor model ───────────────────────────────────────────────
    // When the sale names a customer with a provisioned ledger, the party
    // ledger carries the FULL story: Dr customer for the whole invoice at
    // sale date, and a Cr customer leg for every collection, dated the day
    // the money arrived. The entry's net effect on the customer is still
    // exactly total − paid, so every balance, TB row and report total is
    // unchanged — but the customer's statement now reads like a book of
    // account: invoice, receipts, advance adjustments, all visible.
    // Walk-in sales (no customer) and rows whose ledger was hand-deleted
    // keep the old net "Outstanding" shape against Sundry Debtors.
    const custLedgerId = s.customer_id ? byCode.get(`CUST-${s.customer_id}`)?.id : undefined;
    const grossParty = custLedgerId != null;
    if (grossParty) {
      push({ entryId: eid, date: s.sale_date, ledgerId: custLedgerId!, debit: total, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Invoice ${inv}`, ...sLoc });
    }

    let paidViaSp = 0;
    for (const p of spBySale.get(s.id) ?? []) {
      const amt = Number(p.amount);
      paidViaSp += amt;
      // Four flavours of collection leg:
      //  · 'advance' — consumption of a customer advance: Dr the advance
      //    liability (the money arrived when the advance was received).
      //  · allocation-receipt legs — Dr the ledger the voucher received into.
      //  · direct-posted — the sale receipt landed in an explicitly chosen or
      //    assigned account (a bank/UPI account with reconciliation off, or a
      //    cash-type account other than the till): Dr that account's ledger.
      //  · counter collections — cash box or Electronic Clearing, as ever.
      // The receipt's received_in is honoured whenever it names something
      // other than the two defaults (till / clearing); legacy rows point at
      // exactly those defaults, so their postings stay bit-identical.
      let drLedger: number;
      let legDesc: string;
      const saleIn = p.sale_in != null ? Number(p.sale_in) : null;
      const directIn = saleIn != null && saleIn !== elecClr && saleIn !== cashLedger
        ? saleIn : null;
      if (p.method === "advance") {
        // Consuming an advance debits the customer's OWN ledger — the invoice
        // debit eats into their credit (negative) balance. Single ledger per
        // customer; no separate advance ledger.
        drLedger = (s.customer_id ? byCode.get(`CUST-${s.customer_id}`)?.id : 0) || debtors;
        legDesc = `Advance adjusted — ${inv}`;
      } else if (p.alloc_in) {
        drLedger = Number(p.alloc_in);
        legDesc = `Received — ${inv}`;
      } else if (directIn != null) {
        drLedger = directIn;
        legDesc = `Received — ${inv}`;
      } else {
        drLedger = p.method === "cash" ? cashLedger : elecClr;
        legDesc = `${p.method === "cash" ? "Cash" : "Electronic"} received — ${inv}`;
      }
      push({ entryId: eid, date: p.payment_date, ledgerId: drLedger, debit: amt, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: legDesc, ...sLoc });
      if (grossParty) {
        // The matching credit on the customer's own ledger — this is the
        // "receipt" line of their statement. Carries the receipt's voucher
        // number when a real collection voucher exists. For advance-method
        // rows this forms a deliberate Dr/Cr wash on the same ledger: the
        // adjustment stays visible in the statement without moving the net.
        push({ entryId: eid, date: p.payment_date, ledgerId: custLedgerId!, debit: 0, credit: amt, source: "sale", voucherNumber: p.receipt_vno || s.invoice_number, description: p.method === "advance" ? `Advance adjusted — ${inv}` : `Payment received — ${inv}`, ...sLoc });
      }
    }

    const amountPaid = Number(s.amount_paid ?? 0);
    // Counter money with no collection row of its own is dated at the sale.
    // Gross model: measure against ALL collection rows (not the as-of sum) so
    // a report cutoff never backdates a later collection to the sale date —
    // the pairs are self-balancing, so honesty about dates costs nothing.
    // Net model (no customer ledger): keep topping up to the as-of sum, since
    // the single-sided legs only balance against the current due remainder.
    const extra = grossParty
      ? round2(amountPaid - (spTotalBySale.get(Number(s.id)) ?? 0))
      : round2(amountPaid - paidViaSp);
    if (extra > 0.004) {
      // Cash sits in the cash box; bank/UPI/card clear through Electronic Clearing.
      const drLedger = clearsThroughBank(s.payment_mode) ? elecClr : cashLedger;
      push({ entryId: eid, date: s.sale_date, ledgerId: drLedger, debit: extra, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Received — ${inv}`, ...sLoc });
      if (grossParty) {
        push({ entryId: eid, date: s.sale_date, ledgerId: custLedgerId!, debit: 0, credit: extra, source: "sale", voucherNumber: s.invoice_number, description: `Payment received — ${inv}`, ...sLoc });
      }
    }

    // The gross model needs no remainder legs: what the customer still owes
    // (or overpaid) is simply the entry's net on their ledger.
    if (grossParty) continue;

    const due = round2(total - amountPaid);
    if (due > 0.004) {
      const custLedger = s.customer_id ? (byCode.get(`CUST-${s.customer_id}`)?.id ?? debtors) : debtors;
      push({ entryId: eid, date: s.sale_date, ledgerId: custLedger, debit: due, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Outstanding — ${inv}`, ...sLoc });
    } else if (due < -0.004) {
      // Collected beyond the bill — an edit can lower a bill below what was
      // already collected (payments are never wiped), and legacy imports carry
      // such rows too. The excess is money held for the customer: credit their
      // OWN ledger (their advance is that ledger's credit balance) so the
      // entry balances and the credit is visible and adjustable against future
      // invoices. Silently dropping this negative leg is what let the balance
      // sheet drift with "no identifiable cause".
      const overLedger = (s.customer_id
        ? byCode.get(`CUST-${s.customer_id}`)?.id
        : 0) || debtors;
      push({ entryId: eid, date: s.sale_date, ledgerId: overLedger, debit: 0, credit: round2(-due), source: "sale", voucherNumber: s.invoice_number, description: `Overpayment held — ${inv}`, ...sLoc });
    }
  }

  // 6. Purchases: Dr Purchases (taxable + round-off) + Dr Input GST / Cr vendor.
  //    Legacy rows without line-level GST detail stay as a single lump debit.
  const pup: any[] = [];
  const { rows: purchases } = await q.query(
    `SELECT id, vendor_id, purchase_date, invoice_number, total_amount, tax_total, line_items,
            location_type, location_id, branch_transfer_id, other_charges
     FROM purchases WHERE 1=1${upTo("purchase_date", pup)}`, pup
  );
  for (const p of purchases) {
    const amt = Number(p.total_amount);
    const bill = p.invoice_number || `Purchase #${p.id}`;
    // The inward leg of a branch transfer: owed to the sending branch, and its
    // value goes to the inter-branch clearing ledger rather than Purchases, so
    // it offsets the outward leg instead of inflating cost of goods. Replaces
    // the receive journal voucher for the same transfer.
    const isBranchTransfer = p.branch_transfer_id != null;
    const vendLedger = isBranchTransfer
      ? (branchCreditor || creditors)
      : (byCode.get(`VEND-${p.vendor_id}`)?.id ?? creditors);
    // A warehouse's bill debits that warehouse's own purchase ledger; Head
    // Office bills (and anything without a location) keep the standard one.
    const pLoc = locMap.get(`${p.location_type}:${p.location_id}`);
    const purLedger = isBranchTransfer
      ? (branchTrf || stdPur)
      : ((p.location_type && p.location_type !== 'headoffice' && pLoc?.purchase_ledger_id)
        ? Number(pLoc.purchase_ledger_id) : stdPur);
    const pLines = (p.line_items ?? []) as any[];
    let cg = 0, sg = 0, ig = 0;
    for (const li of pLines) { const h = lineTaxHeads(li); cg += h.cgst; sg += h.sgst; ig += h.igst; }
    cg = round2(cg); sg = round2(sg); ig = round2(ig);
    const inputTax = round2(cg + sg + ig);
    // Split only when the head split is internally consistent: per-line heads
    // must agree with the per-line taxAmount sum, and with the stored document
    // tax_total when one exists (legacy purchases have tax_total = 0).
    // Anything inconsistent keeps the legacy lump posting.
    const lineTaxSum = round2(pLines.reduce((a, li) => a + Number(li?.taxAmount ?? 0), 0));
    const pTaxTotal = Number(p.tax_total ?? 0);
    const consistent =
      (lineTaxSum <= 0.004 || Math.abs(inputTax - lineTaxSum) <= 0.05) &&
      (pTaxTotal <= 0.004 || Math.abs(inputTax - pTaxTotal) <= 0.05);
    const eid = `purchase:${p.id}`;
    // Bills without a stored location are Head Office bills — same convention
    // the purchase-ledger fallback above already applies.
    const puLoc = locOf(p.location_type ?? "headoffice", p.location_id ?? 0);
    if (inpCgst && inpSgst && inpIgst && inputTax > 0.004 && inputTax < amt && consistent) {
      push({ entryId: eid, date: p.purchase_date, ledgerId: purLedger, debit: round2(amt - inputTax), credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}`, ...puLoc });
      if (cg > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpCgst, debit: cg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input CGST — ${bill}`, ...puLoc });
      if (sg > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpSgst, debit: sg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input SGST — ${bill}`, ...puLoc });
      if (ig > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpIgst, debit: ig, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input IGST — ${bill}`, ...puLoc });
    } else {
      push({ entryId: eid, date: p.purchase_date, ledgerId: purLedger, debit: amt, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}`, ...puLoc });
    }
    // Other Purchase Charges (freight, hamali, courier…): Dr the chosen expense
    // ledger, and the vendor is credited the bill total PLUS these charges.
    // They are P&L expenses by construction — never part of stock cost, never
    // part of the taxable/GST split above. The stored ledger id is posted as-is:
    // the chart's delete guard (loadLedgerUsage) refuses to delete a ledger any
    // bill's charges reference, so it cannot dangle.
    let ocTotal = 0;
    for (const c of (Array.isArray(p.other_charges) ? p.other_charges : []) as any[]) {
      const cLid = Number(c?.ledgerId);
      const cAmt = round2(Number(c?.amount));
      if (!Number.isInteger(cLid) || cLid <= 0 || !(cAmt > 0.004)) continue;
      ocTotal = round2(ocTotal + cAmt);
      push({ entryId: eid, date: p.purchase_date, ledgerId: cLid, debit: cAmt, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase charge — ${bill}`, ...puLoc });
    }
    push({ entryId: eid, date: p.purchase_date, ledgerId: vendLedger, debit: 0, credit: round2(amt + ocTotal), source: "purchase", voucherNumber: p.invoice_number, description: isBranchTransfer ? `Due to branch — ${bill}` : `Purchase ${bill}`, ...puLoc });
  }

  // 6b. Vendor advances consumed by purchase bills: Dr vendor payable /
  // Cr vendor advance, dated with the bill. The purchase above credited the
  // vendor with the FULL bill; this contra is what settles the advance-covered
  // slice, so the payable only shows what is genuinely still owed. Rows join
  // purchases so a deleted bill drops its application with it.
  const paap: any[] = [];
  const { rows: purchAdvApps } = await q.query(
    `SELECT a.id, a.amount, a.vendor_id, p.purchase_date, p.invoice_number,
            p.location_type, p.location_id
     FROM purchase_advance_applications a
     JOIN purchases p ON p.id = a.purchase_id
     WHERE 1=1${upTo("p.purchase_date", paap)}`, paap
  );
  for (const a of purchAdvApps) {
    const amt = Number(a.amount);
    const vend = byCode.get(`VEND-${a.vendor_id}`)?.id ?? creditors;
    const vadv = byCode.get(`VADV-${a.vendor_id}`)?.id;
    if (!vadv) continue; // ledger deleted by hand — skip rather than misclassify
    const eid = `purchadv:${a.id}`;
    const bill = a.invoice_number || `#${a.id}`;
    const loc = locOf(a.location_type ?? "headoffice", a.location_id ?? 0);
    push({ entryId: eid, date: a.purchase_date, ledgerId: vend, debit: amt, credit: 0, source: "purchase", voucherNumber: a.invoice_number, description: `Advance adjusted — ${bill}`, ...loc });
    push({ entryId: eid, date: a.purchase_date, ledgerId: vadv, debit: 0, credit: amt, source: "purchase", voucherNumber: a.invoice_number, description: `Advance adjusted — ${bill}`, ...loc });
  }

  // 7. Warehouse rent: Dr Rent Expense / Cr Rent Payable, per accrued day.
  //
  // Derived rather than posted as vouchers, for the same reason sales and
  // purchases are: one row per warehouse per day would add thousands of journal
  // vouchers a year and bury the voucher register. Deriving them here puts rent
  // into the trial balance, P&L, balance sheet and ledger statement through the
  // same single stream every other source uses.
  //
  // Ungated by design. Rent is recognised on the day it is incurred, so the
  // running month shows the rent that belongs to it rather than nothing until
  // someone signs the month off. Approval no longer changes what the books say:
  // it locks the month against recalculation and releases the payable for
  // payment. This replaced an `AND p.status IN ('approved','paid')` filter on
  // rent_periods, whose consequence was that approving a month silently restated
  // a P&L that had already been read, reported and acted on.
  //
  // Rent *payments* are real vouchers and arrive via section 3, so the payable is
  // credited here and debited there — no double count.
  const rap: any[] = [];
  const { rows: rentRows } = await q.query(
    `SELECT r.id, r.accrual_date AS date, r.amount, r.warehouse_id, w.name AS warehouse_name,
            a.expense_ledger_id, a.payable_ledger_id
     FROM rent_accruals r
     JOIN warehouse_rent_agreements a ON a.warehouse_id = r.warehouse_id
     JOIN warehouses w ON w.id = r.warehouse_id
     WHERE a.expense_ledger_id IS NOT NULL AND a.payable_ledger_id IS NOT NULL
       ${upTo("r.accrual_date", rap)}`, rap
  );
  for (const r of rentRows) {
    const amt = Number(r.amount);
    if (!(amt > 0.004)) continue;
    const eid = `rent:${r.id}`;
    const desc = `Rent — ${r.warehouse_name}`;
    const rLoc = locOf("warehouse", r.warehouse_id);
    push({ entryId: eid, date: r.date, ledgerId: r.expense_ledger_id, debit: amt, credit: 0, source: "rent", voucherNumber: null, description: desc, ...rLoc });
    push({ entryId: eid, date: r.date, ledgerId: r.payable_ledger_id, debit: 0, credit: amt, source: "rent", voucherNumber: null, description: desc, ...rLoc });
  }

  // 8. Salary: Dr Salary Expense / Cr Salary Payable, per accrued day.
  //
  // Same shape as rent above, ungated for the same reason: the cost belongs to
  // the day it was earned, not to the day someone approved the run.
  //
  // Approval does NOT recognise this cost a second time. postSalaryApproval
  // writes a real voucher that trues the month up to the figure payroll actually
  // computed — it debits only the difference between that figure and what has
  // already accrued here — so the month is recognised once. Salary *payments* are
  // vouchers too, debiting the same payable this credits.
  //
  // Months approved before daily accrual existed carry no accrual rows at all,
  // because the sweep refuses to touch an approved month. Their original
  // full-value voucher therefore stands alone and history is unchanged.
  const sap: any[] = [];
  const { rows: salaryRows } = await q.query(
    `SELECT a.id, a.accrual_date AS date, a.amount, e.name AS employee_name,
            e.branch_type, e.branch_id,
            le.id AS expense_ledger_id, lp.id AS payable_ledger_id
     FROM salary_accruals a
     JOIN employees e ON e.id = a.employee_id
     JOIN account_ledgers le ON le.code = 'SAL-EMP-' || a.employee_id
     JOIN account_ledgers lp ON lp.code = 'SAL-PAY-' || a.employee_id
     WHERE TRUE ${upTo("a.accrual_date", sap)}`, sap
  );
  for (const s of salaryRows) {
    const amt = Number(s.amount);
    if (!(amt > 0.004)) continue;
    const eid = `salary:${s.id}`;
    const desc = `Salary — ${s.employee_name}`;
    // Salary belongs to the branch the employee works at.
    const eLoc = locOf(s.branch_type, s.branch_id);
    push({ entryId: eid, date: s.date, ledgerId: s.expense_ledger_id, debit: amt, credit: 0, source: "salary", voucherNumber: null, description: desc, ...eLoc });
    push({ entryId: eid, date: s.date, ledgerId: s.payable_ledger_id, debit: 0, credit: amt, source: "salary", voucherNumber: null, description: desc, ...eLoc });
  }

  return postings;
}

// ── Day Book ───────────────────────────────────────────────────────────────
//
// One day's entries as double entries, grouped from the same derived posting
// stream the Trial Balance reads. It used to re-query every source table with
// its own posting rules, so a day book total could disagree with the trial
// balance for the same day and journal-only movements were shown as a lump.

router.get("/accounts/day-book", requireModuleView("page:/accounts/day-book"), async (req, res): Promise<void> => {
  // LBAC: the day book is a Head Office accounting view
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ date: "", entries: [], totals: { count: 0, amount: 0, debit: 0, credit: 0, byType: {} } });
    return;
  }
  const q = String((req.query as any).date ?? "");
  const date = isDate(q) ? q : new Date().toISOString().slice(0, 10);
  const locFilter = getPostingLocationFilter(req);

  const dayPostings = (await buildDerivedPostings({ toDate: date }))
    .filter((p) => String(p.date).slice(0, 10) === date);
  // The company-level bucket is reported, never dropped: a filtered day book
  // says how much of the day it cannot attribute to any location.
  const companyLevel = locFilter && locFilter.type !== "company" ? companyLevelSummary(dayPostings) : null;
  const postings = filterPostingsByLocation(dayPostings, locFilter);

  const { rows: ledgerRows } = await pool.query(`SELECT id, name FROM account_ledgers`);
  const nameOf = new Map<number, string>(ledgerRows.map((l: any) => [Number(l.id), l.name as string]));

  type Entry = {
    id: string; refId: number; source: string; voucherNumber: string | null;
    particulars: string; narration: string | null; amount: number;
    debit: number; credit: number;
    lines: Array<{ ledgerId: number; ledgerName: string; debit: number; credit: number }>;
  };

  const byEntry = new Map<string, Entry>();
  for (const p of postings) {
    const key = p.entryId;
    let e = byEntry.get(key);
    if (!e) {
      e = {
        id: key,
        refId: Number(key.split(":")[1] ?? 0),
        source: p.source,
        voucherNumber: p.voucherNumber,
        particulars: "",
        narration: p.description || null,
        amount: 0, debit: 0, credit: 0, lines: [],
      };
      byEntry.set(key, e);
    }
    e.debit = round2(e.debit + p.debit);
    e.credit = round2(e.credit + p.credit);
    e.lines.push({
      ledgerId: p.ledgerId, ledgerName: nameOf.get(p.ledgerId) ?? `Ledger #${p.ledgerId}`,
      debit: p.debit, credit: p.credit,
    });
  }

  const entries: Entry[] = [];
  for (const e of byEntry.values()) {
    // Distinct names only: a sale debits Cash twice when it is part-paid twice,
    // and "Dr Cash, Cash" reads like a mistake.
    const dr = [...new Set(e.lines.filter((l) => l.debit > 0.004).map((l) => l.ledgerName))];
    const cr = [...new Set(e.lines.filter((l) => l.credit > 0.004).map((l) => l.ledgerName))];
    e.particulars = `Dr ${dr.join(", ") || "—"} / Cr ${cr.join(", ") || "—"}`;
    // The entry's value is one side of it, not both added together.
    e.amount = Math.max(e.debit, e.credit);
    e.lines.sort((a, b) => (b.debit - a.debit) || (a.credit - b.credit));
    entries.push(e);
  }
  entries.sort((a, b) => a.source.localeCompare(b.source) || a.refId - b.refId);

  const byType: Record<string, { count: number; amount: number }> = {};
  for (const e of entries) {
    const t = byType[e.source] ?? { count: 0, amount: 0 };
    t.count += 1;
    t.amount = round2(t.amount + e.amount);
    byType[e.source] = t;
  }

  const debit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const credit = round2(entries.reduce((s, e) => s + e.credit, 0));

  res.json({
    date,
    entries,
    totals: {
      count: entries.length,
      amount: round2(entries.reduce((s, e) => s + e.amount, 0)),
      debit,
      credit,
      // A day's postings are balanced in their own right, so a mismatch here
      // means an entry was written with only one leg.
      balanced: Math.abs(debit - credit) < 0.01,
      byType,
    },
    ...(locFilter ? { location: { type: locFilter.type, id: locFilter.id }, companyLevel } : {}),
  });
});

// ── Cash Book / Bank Book ──────────────────────────────────────────────────

// Ledger options for the book selector (cash or bank subtree)
router.get("/accounts/cash-bank-book/ledgers", requireModuleView(["page:/accounts/cash-book", "page:/accounts/bank-book", "page:/accounts/cash-bank"]), async (req, res): Promise<void> => {
  // LBAC: full cash-bank ledger list is Head Office only
  if ((req as any).employee?.branchType !== 'headoffice') { res.json([]); return; }
  const kind = (req.query as any).kind === "bank" ? "bank" : "cash";
  const ids = await ledgerIdsUnderCodes([kind === "bank" ? "STD-BANK" : "STD-CASH"]);
  if (ids.size === 0) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT id, name, code, is_group FROM account_ledgers WHERE id = ANY($1) ORDER BY name`,
    [[...ids]]
  );
  res.json(rows.map((r: any) => ({
    id: r.id, name: r.name, code: r.code ?? null, isGroup: !!r.is_group,
  })));
});

/**
 * The Cash Book / Bank Book computation for one ledger (or a ledger group's
 * whole subtree), extracted from the route so it can be run on a caller-supplied
 * queryable. Returns `null` when the ledger does not exist (the route turns that
 * into a 404); otherwise returns exactly the object the route sends. With no `q`
 * it defaults to the shared pool.
 */
export async function computeCashBankBook(opts: {
  q?: Q;
  ledgerId: number;
  fromDate?: string;
  toDate?: string;
  locFilter?: PostingLocationFilter | null;
}): Promise<Record<string, any> | null> {
  const q = opts.q ?? pool;
  const { ledgerId, fromDate, toDate } = opts;
  const locFilter = opts.locFilter ?? null;

  const { rows: [ledger] } = await q.query(
    `SELECT id, name, code, is_group FROM account_ledgers WHERE id = $1`, [ledgerId]
  );
  if (!ledger) return null;

  // Selecting a group (e.g. the Cash root) consolidates its whole subtree
  const subtree = await ledgerSubtreeIds(ledgerId, q);

  // Opening balances fold in as company-level postings dated at their as-of
  // date — the same mechanism the Trial Balance uses — so the Cash/Bank Book's
  // opening and closing agree with the TB, the Balance Sheet and the Cash &
  // Bank screen (all of which already count them).
  const { openingBalancePostings } = await import("../lib/openingBalances");
  const subtreePostings = (await buildDerivedPostings({ toDate: isDate(toDate) ? toDate : undefined, q }))
    .concat(await openingBalancePostings({ toDate: isDate(toDate) ? toDate : undefined }) as Posting[])
    .filter(p => subtree.has(p.ledgerId));
  const postings = filterPostingsByLocation(subtreePostings, locFilter);
  postings.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));

  const from = isDate(fromDate) ? fromDate : null;
  let opening = 0;
  const inRange: Posting[] = [];
  for (const p of postings) {
    if (from && p.date < from) opening = round2(opening + p.debit - p.credit);
    else inRange.push(p);
  }

  let balance = opening;
  const entries = inRange.map(p => {
    balance = round2(balance + p.debit - p.credit);
    return {
      date: p.date, source: p.source, voucherNumber: p.voucherNumber,
      description: p.description, debit: p.debit, credit: p.credit, balance,
    };
  });

  return {
    ledger: { id: ledger.id, name: ledger.name, code: ledger.code ?? null },
    openingBalance: opening,
    entries,
    totalDebit: round2(entries.reduce((s, e) => s + e.debit, 0)),
    totalCredit: round2(entries.reduce((s, e) => s + e.credit, 0)),
    closingBalance: balance,
    ...(locFilter ? {
      location: { type: locFilter.type, id: locFilter.id },
      companyLevel: locFilter.type !== "company" ? companyLevelSummary(subtreePostings) : null,
    } : {}),
  };
}

router.get("/accounts/cash-bank-book", requireModuleView(["page:/accounts/cash-book", "page:/accounts/bank-book"]), async (req, res): Promise<void> => {
  // LBAC: full cash-bank book is Head Office only
  if ((req as any).employee?.branchType !== 'headoffice') { res.json({ ledger: null, entries: [], openingBalance: 0, closingBalance: 0 }); return; }
  const ledgerId = Number((req.query as any).ledgerId);
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  if (!ledgerId) { res.status(400).json({ error: "ledgerId is required" }); return; }

  const locFilter = getPostingLocationFilter(req);
  const result = await computeCashBankBook({ ledgerId, fromDate, toDate, locFilter });
  if (!result) { res.status(404).json({ error: "Ledger not found" }); return; }
  res.json(result);
});

// ── Trial Balance ──────────────────────────────────────────────────────────

/**
 * The Trial Balance computation, extracted from the route so it can be run on a
 * caller-supplied queryable (e.g. an open transaction). With no `q` it defaults
 * to the shared pool and returns exactly the object the route sends.
 */
export async function computeTrialBalance(opts: {
  q?: Q;
  fromDate?: string;
  toDate?: string;
  locFilter?: PostingLocationFilter | null;
}): Promise<Record<string, any>> {
  const q = opts.q ?? pool;
  const { fromDate, toDate } = opts;
  const locFilter = opts.locFilter ?? null;

  let postings = await buildDerivedPostings({ toDate: isDate(toDate) ? toDate : undefined, q });
  // Opening balances fold in as company-level postings dated at their as-of
  // date, so the TB agrees with the Balance Sheet, the Cash/Bank Books and the
  // Cash & Bank screen — all of which already count them.
  const { openingBalancePostings } = await import("../lib/openingBalances");
  postings = postings.concat(await openingBalancePostings({ toDate: isDate(toDate) ? toDate : undefined }) as Posting[]);
  if (isDate(fromDate)) postings = postings.filter(p => p.date >= fromDate);
  // Bucket totals are computed over the SAME window the rows use, so a
  // location's TB plus its siblings plus this bucket reproduces the
  // consolidated TB exactly.
  const companyLevel = locFilter && locFilter.type !== "company" ? companyLevelSummary(postings) : null;
  postings = filterPostingsByLocation(postings, locFilter);

  const agg = new Map<number, { dr: number; cr: number }>();
  for (const p of postings) {
    const a = agg.get(p.ledgerId) ?? { dr: 0, cr: 0 };
    a.dr = round2(a.dr + p.debit);
    a.cr = round2(a.cr + p.credit);
    agg.set(p.ledgerId, a);
  }

  const { rows: ledgers } = await q.query(
    `SELECT l.id, l.name, l.type, l.code, l.parent_id, p.name AS parent_name
     FROM account_ledgers l
     LEFT JOIN account_ledgers p ON p.id = l.parent_id`
  );
  const ledgerById = new Map<number, any>(ledgers.map((l: any) => [l.id, l]));

  const rows: any[] = [];
  for (const [ledgerId, a] of agg) {
    const net = round2(a.dr - a.cr);
    if (Math.abs(net) < 0.005) continue;
    const l = ledgerById.get(ledgerId);
    rows.push({
      ledgerId,
      name: l?.name ?? `Ledger #${ledgerId}`,
      code: l?.code ?? null,
      type: l?.type ?? null,
      groupName: l?.parent_name ?? null,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    });
  }
  rows.sort((a, b) => String(a.groupName ?? "").localeCompare(String(b.groupName ?? "")) || a.name.localeCompare(b.name));

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  const difference = round2(totalDebit - totalCredit);

  return {
    fromDate: isDate(fromDate) ? fromDate : null,
    toDate: isDate(toDate) ? toDate : null,
    rows,
    totalDebit,
    totalCredit,
    difference,
    balanced: Math.abs(difference) < 0.01,
    ...(locFilter ? { location: { type: locFilter.type, id: locFilter.id }, companyLevel } : {}),
  };
}

router.get("/accounts/trial-balance", requireModuleView("page:/accounts/trial-balance"), async (req, res): Promise<void> => {
  // LBAC: the trial balance is a Head Office accounting view
  if ((req as any).employee?.branchType !== 'headoffice') { res.json([]); return; }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  const locFilter = getPostingLocationFilter(req);
  res.json(await computeTrialBalance({ fromDate, toDate, locFilter }));
});

export default router;

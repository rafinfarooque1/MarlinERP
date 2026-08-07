/**
 * Location scoping for money vouchers (`payments` and `receipts`).
 *
 * Until Phase 8 the whole payment/receipt ledger was Head-Office-only: a
 * warehouse user got an empty list. Warehouses now run their own cash box, so
 * they must be able to record and read their own vouchers — and only those.
 *
 * A voucher belongs to a location when EITHER:
 *   1. it is stamped with that location (`location_type` + `location_id`,
 *      raw-migration columns written by every route that knows its location), or
 *   2. one of its two ledger legs is a ledger that location owns
 *      (its cash ledger or its sales ledger).
 *
 * Rule 2 is what makes the switch safe on live data: rows written before the
 * stamp existed carry the default 'headoffice'/0 and would otherwise vanish
 * from the warehouse's own books. It is also self-healing — any future insert
 * path that forgets to stamp still resolves to the right owner as long as it
 * posts through the location's ledger.
 *
 * Head Office is unrestricted everywhere.
 */

import { pool } from "@workspace/db";
import type { DataScope } from "./dataScope.js";

export interface CallerLocation {
  locationType: string;
  locationId: number;
}

/**
 * The location a newly created voucher belongs to, derived only from the
 * authenticated employee's branch — never from the request body.
 * Head Office keeps the table default ('headoffice' / 0).
 */
export function callerLocation(employee?: {
  branchType?: string;
  branchId?: number;
}): CallerLocation {
  const branchType = employee?.branchType;
  if (!branchType || branchType === "headoffice") {
    return { locationType: "headoffice", locationId: 0 };
  }
  return { locationType: branchType, locationId: Number(employee?.branchId ?? 0) };
}

/**
 * Money scope: the caller's OWN location and nothing else.
 *
 * Deliberately narrower than `getUserDataScope`, which also hands a warehouse
 * every outlet it supplies. Supplying an outlet is a stock relationship, not a
 * shared wallet: each location's till is answerable to its own staff, so cash
 * vouchers never cross the boundary even when the stock does. Head Office keeps
 * unrestricted access.
 */
export function ownLocationScope(employee?: {
  branchType?: string;
  branchId?: number;
}): DataScope {
  const branchType = employee?.branchType;
  if (!branchType || branchType === "headoffice") {
    return { isHeadOffice: true, warehouseIds: [], outletIds: [] };
  }
  const id = Number(employee?.branchId ?? 0);
  return branchType === "warehouse"
    ? { isHeadOffice: false, warehouseIds: [id], outletIds: [] }
    : { isHeadOffice: false, warehouseIds: [], outletIds: [id] };
}

interface LocationLedgerRow {
  ledger_id: number;
  location_type: string;
  location_id: number;
  kind: string;
}

/** Every cash/sales ledger owned by a warehouse or outlet, with its owner. */
async function allLocationLedgers(): Promise<LocationLedgerRow[]> {
  const { rows } = await pool.query<LocationLedgerRow>(`
    SELECT cash_ledger_id  AS ledger_id, 'warehouse' AS location_type, id AS location_id, 'cash'  AS kind FROM warehouses WHERE cash_ledger_id  IS NOT NULL
    UNION ALL
    SELECT sales_ledger_id AS ledger_id, 'warehouse' AS location_type, id AS location_id, 'sales' AS kind FROM warehouses WHERE sales_ledger_id IS NOT NULL
    UNION ALL
    SELECT cash_ledger_id  AS ledger_id, 'outlet'    AS location_type, id AS location_id, 'cash'  AS kind FROM outlets    WHERE cash_ledger_id  IS NOT NULL
    UNION ALL
    SELECT sales_ledger_id AS ledger_id, 'outlet'    AS location_type, id AS location_id, 'sales' AS kind FROM outlets    WHERE sales_ledger_id IS NOT NULL
    UNION ALL
    -- Cash & Bank accounts assigned to a branch behave exactly like the
    -- branch's till: money accounts the location's own staff may move money
    -- through, invisible and unusable to every other branch.
    SELECT ledger_id, location_type, location_id, 'cash' AS kind
    FROM cash_bank_accounts
    WHERE ledger_id IS NOT NULL AND location_id IS NOT NULL
      AND location_type IN ('warehouse', 'outlet')
  `);
  return rows.map((r) => ({ ...r, ledger_id: Number(r.ledger_id), location_id: Number(r.location_id) }));
}

function inScope(scope: DataScope, row: LocationLedgerRow): boolean {
  if (row.location_type === "warehouse") return scope.warehouseIds.includes(row.location_id);
  if (row.location_type === "outlet") return scope.outletIds.includes(row.location_id);
  return false;
}

/**
 * Cash + sales ledger ids owned by the locations in scope.
 * Empty for Head Office (it needs no ledger-leg fallback — it sees everything).
 */
export async function scopeLedgerIds(scope: DataScope): Promise<number[]> {
  if (scope.isHeadOffice) return [];
  const rows = await allLocationLedgers();
  return [...new Set(rows.filter((r) => inScope(scope, r)).map((r) => r.ledger_id))];
}

/** Cash ledger ids the caller owns — the only accounts they may move money through. */
export async function scopeCashLedgerIds(scope: DataScope): Promise<number[]> {
  if (scope.isHeadOffice) return [];
  const rows = await allLocationLedgers();
  return [
    ...new Set(rows.filter((r) => r.kind === "cash" && inScope(scope, r)).map((r) => r.ledger_id)),
  ];
}

/**
 * Ledger ids owned by locations OUTSIDE the caller's scope — never usable.
 *
 * Computed as a set difference on ledger IDS, not on rows: a single ledger can
 * be listed under more than one location (the retired outlets share their cash
 * and sales ledgers with the warehouse rows that replaced them), and a ledger
 * the caller owns must never come back as foreign just because some other row
 * also points at it.
 */
export async function foreignLocationLedgerIds(scope: DataScope): Promise<number[]> {
  if (scope.isHeadOffice) return [];
  const rows = await allLocationLedgers();
  const own = new Set(await scopeLedgerIds(scope));
  return [...new Set(rows.map((r) => r.ledger_id).filter((id) => !own.has(id)))];
}

/**
 * SQL WHERE fragment selecting the payment/receipt rows a caller may see.
 *
 * @param alias    table alias in the query (e.g. 'p' or 'r')
 * @param legCols  the two ledger-leg columns, e.g. ['paid_from_ledger_id', 'paid_to_ledger_id']
 * @param params   positional parameter array, appended to in place
 *
 * Returns 'TRUE' for Head Office and 'FALSE' when the caller owns nothing.
 */
export function scopeMoneyWhere(
  scope: DataScope,
  ledgerIds: number[],
  params: unknown[],
  alias: string,
  legCols: [string, string],
): string {
  if (scope.isHeadOffice) return "TRUE";

  const conds: string[] = [];

  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(
      `(${alias}.location_type = 'warehouse' AND ${alias}.location_id = ANY($${params.length}::int[]))`,
    );
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(
      `(${alias}.location_type = 'outlet' AND ${alias}.location_id = ANY($${params.length}::int[]))`,
    );
  }
  if (ledgerIds.length > 0) {
    params.push(ledgerIds);
    const n = params.length;
    conds.push(
      `(${alias}.${legCols[0]} = ANY($${n}::int[]) OR ${alias}.${legCols[1]} = ANY($${n}::int[]))`,
    );
  }

  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

export interface LegCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate the two ledger legs of a voucher a non-HO user is trying to create.
 *
 * `ownLeg`      — the side that must be the caller's own cash ledger
 *                 (payments: paid_from; receipts: received_in). A warehouse can
 *                 only spend or collect through its own cash box.
 * `otherLeg`    — must not be a ledger owned by another location, and must not
 *                 be a Head Office cash/bank account: a branch user cannot move
 *                 HO's money or another branch's money.
 */
export async function checkVoucherLegs(
  scope: DataScope,
  ownLeg: number,
  otherLeg: number,
  ownLegLabel: string,
): Promise<LegCheckResult> {
  if (scope.isHeadOffice) return { ok: true };

  const cashIds = await scopeCashLedgerIds(scope);
  if (cashIds.length === 0) {
    return {
      ok: false,
      error:
        "Your location has no Cash ledger yet. Ask Head Office to provision ledgers under Accounts → Warehouses/Outlets.",
    };
  }
  if (!cashIds.includes(Number(ownLeg))) {
    return {
      ok: false,
      error: `${ownLegLabel} must be your own location's Cash ledger.`,
    };
  }

  const foreign = await foreignLocationLedgerIds(scope);
  if (foreign.includes(Number(otherLeg))) {
    return { ok: false, error: "That account belongs to another location." };
  }

  // Party ledgers (customers, vendors, employees) are owned by the location
  // their MASTER record is stamped with. A branch may not settle another
  // branch's customer or pay another branch's employee. Head-Office-stamped
  // and unstamped (company-wide) parties stay usable everywhere — central
  // relationships are shared, other branches' books are not.
  const foreignParties = await foreignPartyLedgerIds(scope);
  if (foreignParties.includes(Number(otherLeg))) {
    return { ok: false, error: "That account belongs to another location." };
  }

  // Head Office cash/bank accounts are off-limits to branch users: letting a
  // warehouse post against them would move company money with no HO approval.
  const hoCashBank = await headOfficeCashBankLedgerIds();
  if (hoCashBank.includes(Number(otherLeg)) && !cashIds.includes(Number(otherLeg))) {
    return {
      ok: false,
      error: "Head Office cash and bank accounts can only be used by Head Office.",
    };
  }

  return { ok: true };
}

/**
 * Party ledgers whose MASTER record (customer, vendor, employee) is stamped to
 * a warehouse/outlet OUTSIDE the caller's scope. Ledger↔master linkage is by
 * code (CUST-<id>, VEND-<id>, SAL-EMP-/SAL-PAY-/ADV-EMP-<id>) — the same
 * convention every provisioning path writes. Masters stamped 'headoffice' or
 * not stamped at all are company-wide and never come back as foreign.
 * Empty for Head Office.
 */
export async function foreignPartyLedgerIds(scope: DataScope): Promise<number[]> {
  if (scope.isHeadOffice) return [];
  const { rows } = await pool.query<{ id: number }>(
    `SELECT al.id
     FROM account_ledgers al
     JOIN (
       SELECT 'CUST-' || id AS code, location_type, location_id FROM customers
       UNION ALL SELECT 'VEND-' || id, location_type, location_id FROM vendors
       UNION ALL SELECT 'SAL-EMP-' || id, branch_type, branch_id FROM employees
       UNION ALL SELECT 'SAL-PAY-' || id, branch_type, branch_id FROM employees
       UNION ALL SELECT 'ADV-EMP-' || id, branch_type, branch_id FROM employees
     ) m ON m.code = al.code
     WHERE m.location_type IN ('warehouse', 'outlet')
       AND NOT (
         (m.location_type = 'warehouse' AND m.location_id = ANY($1::int[]))
         OR (m.location_type = 'outlet' AND m.location_id = ANY($2::int[]))
       )`,
    [scope.warehouseIds, scope.outletIds],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Every ledger under the Cash-in-Hand and Bank Accounts groups.
 * Used to keep branch users out of Head Office's cash and bank accounts.
 */
export async function headOfficeCashBankLedgerIds(): Promise<number[]> {
  const { rows } = await pool.query<{ id: number; parent_id: number | null; code: string | null }>(
    `SELECT id, parent_id, code FROM account_ledgers ORDER BY id`,
  );
  const ids = new Set<number>();
  for (const r of rows) if (r.code === "STD-CASH" || r.code === "STD-BANK") ids.add(Number(r.id));
  for (let i = 0; i < 8; i++) {
    for (const r of rows) {
      if (r.parent_id && ids.has(Number(r.parent_id))) ids.add(Number(r.id));
    }
  }
  return [...ids];
}

// ── Voucher location resolution for money vouchers ─────────────────────────

export interface LedgerOwner { locationType: "warehouse" | "outlet"; locationId: number; name: string }

/** All ledger ids at-or-under the given root codes (walks the CoA tree). */
export async function ledgerIdsUnderCodes(rootCodes: string[]): Promise<Set<number>> {
  const { rows } = await pool.query(`SELECT id, parent_id, code FROM account_ledgers`);
  const ids = new Set<number>();
  for (const r of rows) if (rootCodes.includes(String(r.code ?? ""))) ids.add(Number(r.id));
  for (let i = 0; i < 6; i++) {
    for (const r of rows) if (r.parent_id && ids.has(Number(r.parent_id))) ids.add(Number(r.id));
  }
  return ids;
}

/**
 * Every location-owned ledger (cash / sales / warehouse purchase), with ALL of
 * its owners. A mirror location — one place kept as both a warehouse and an
 * outlet — shares a single cash ledger, so a ledger can have several owners
 * and a voucher stamped to any one of them is valid.
 * (Moved here from routes/journal.ts so money vouchers share the same rule.)
 */
export async function locationOwnedLedgerMap(): Promise<Map<number, LedgerOwner[]>> {
  const map = new Map<number, LedgerOwner[]>();
  const add = (ledgerId: unknown, owner: LedgerOwner) => {
    const lid = Number(ledgerId);
    if (!Number.isFinite(lid) || lid <= 0) return;
    const arr = map.get(lid) ?? [];
    arr.push(owner);
    map.set(lid, arr);
  };
  const { rows } = await pool.query(`
    SELECT 'warehouse' AS lt, id, name, cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses
    UNION ALL
    SELECT 'outlet' AS lt, id, name, cash_ledger_id, sales_ledger_id, NULL::integer AS purchase_ledger_id FROM outlets
    UNION ALL
    -- Cash & Bank accounts assigned to a branch: the branch owns that ledger
    -- exactly like its till, so vouchers through it must be stamped to the
    -- owner and its money stays inside the location's own books.
    SELECT cba.location_type AS lt, cba.location_id AS id,
           COALESCE(w.name, o.name, 'branch') AS name,
           cba.ledger_id AS cash_ledger_id, NULL::integer AS sales_ledger_id, NULL::integer AS purchase_ledger_id
    FROM cash_bank_accounts cba
    LEFT JOIN warehouses w ON cba.location_type = 'warehouse' AND w.id = cba.location_id
    LEFT JOIN outlets    o ON cba.location_type = 'outlet'    AND o.id = cba.location_id
    WHERE cba.ledger_id IS NOT NULL AND cba.location_id IS NOT NULL
      AND cba.location_type IN ('warehouse', 'outlet')
  `);
  for (const r of rows) {
    const owner: LedgerOwner = { locationType: r.lt, locationId: Number(r.id), name: r.name };
    add(r.cash_ledger_id, owner);
    add(r.sales_ledger_id, owner);
    add(r.purchase_ledger_id, owner);
  }
  return map;
}

/**
 * The ONE location a money voucher (payment / receipt) is stamped with.
 *
 * The rule the whole ERP follows: the selected transaction location owns the
 * accounting — an Admin recording on behalf of a branch produces a branch
 * voucher, never a Head Office one. Resolution order:
 *
 *   1. An explicit `locationType`/`locationId` in the body — a REQUEST, not
 *      authority: Head Office may act for any location, branch staff only for
 *      their own. It must also agree with the cash/bank leg: a voucher stamped
 *      Ragiguda through Calicut's till would put money in a till that
 *      Ragiguda's own cash book cannot see.
 *   2. No explicit location: the cash/bank account's OWNER speaks for the
 *      voucher (a receipt into a warehouse till is that warehouse's receipt,
 *      whoever typed it). Mirror locations pick the warehouse identity, the
 *      same preference every read-side dedupe applies.
 *   3. Unrecognised money account: `fallback` (the row's current stamp on
 *      edit), else the caller's own location — the pre-existing behaviour.
 */
export async function resolveMoneyVoucherLocation(
  employee: { branchType?: string; branchId?: number } | undefined,
  body: Record<string, any> | undefined,
  tillLedgerId: number,
  fallback?: CallerLocation | null,
): Promise<{ ok: true; loc: CallerLocation } | { ok: false; status: number; error: string }> {
  const owned = await locationOwnedLedgerMap();
  const owners = owned.get(Number(tillLedgerId)) ?? [];
  // HO's own cash/bank = the STD-CASH/STD-BANK subtrees minus every branch till.
  const hoSet = new Set(await headOfficeCashBankLedgerIds());
  for (const id of owned.keys()) hoSet.delete(id);
  const isHoTill = hoSet.has(Number(tillLedgerId));

  const rawType = body?.locationType != null && body.locationType !== "" ? String(body.locationType) : "";
  if (rawType) {
    let explicit: CallerLocation;
    if (rawType === "headoffice") {
      // Head Office is singular — money vouchers store the fixed placeholder 0.
      explicit = { locationType: "headoffice", locationId: 0 };
    } else if (rawType === "warehouse" || rawType === "outlet") {
      const id = Number(body!.locationId);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, status: 400, error: "Please select a location." };
      }
      const table = rawType === "warehouse" ? "warehouses" : "outlets";
      const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
      if (!rows[0]) {
        return { ok: false, status: 400, error: `${rawType === "warehouse" ? "Warehouse" : "Outlet"} not found` };
      }
      explicit = { locationType: rawType, locationId: id };
    } else {
      return { ok: false, status: 400, error: "locationType must be headoffice, warehouse or outlet" };
    }

    const branchType = employee?.branchType;
    if (branchType && branchType !== "headoffice") {
      const own = callerLocation(employee);
      if (own.locationType !== explicit.locationType || Number(own.locationId) !== explicit.locationId) {
        return { ok: false, status: 403, error: "You can only record vouchers for your own location." };
      }
    }

    if (owners.length > 0) {
      const match = owners.some(o => o.locationType === explicit.locationType && Number(o.locationId) === explicit.locationId);
      if (!match) {
        return {
          ok: false, status: 400,
          error: `The selected Cash/Bank account belongs to ${owners[0].name}. Record the voucher under that location, or pick the selected location's own account.`,
        };
      }
    } else if (isHoTill && explicit.locationType !== "headoffice") {
      return {
        ok: false, status: 400,
        error: "That is a Head Office cash/bank account — record the voucher under Head Office, or pick the location's own cash/bank account.",
      };
    }
    return { ok: true, loc: explicit };
  }

  if (owners.length > 0) {
    const pick = owners.find(o => o.locationType === "warehouse") ?? owners[0];
    return { ok: true, loc: { locationType: pick.locationType, locationId: Number(pick.locationId) } };
  }
  if (isHoTill) return { ok: true, loc: { locationType: "headoffice", locationId: 0 } };
  return { ok: true, loc: fallback ?? callerLocation(employee) };
}

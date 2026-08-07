import { Router } from "express";
import { db, customersTable, vendorsTable, couponsTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { eq, sql } from "drizzle-orm";
import { pool } from "@workspace/db";
import { isIsoDate } from "../lib/dateInput";
import {
  CreateCouponBody, UpdateCouponBody, DeleteCouponParams,
} from "@workspace/api-zod";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { parsePaging, setPagingHeaders, applyPaging } from "../lib/paging";
import { resolveMoneyVoucherLocation } from "../lib/moneyScope";
import { outstandingExpr } from "../lib/salePaymentPosition";

const router = Router();

/**
 * Attach the party's ACCOUNTING balance to each master row.
 *
 * `outstandingBalance` keeps its name because every screen already reads it, but
 * its meaning is now precise: the party's ledger balance signed to its natural
 * side — payable for a vendor, receivable for a customer. It is deliberately
 * **not** clamped at zero. A negative figure is a real position (a credit
 * balance on the party's account) and is labelled via `balanceSide` rather
 * than swallowed. For a CUSTOMER that credit balance IS their advance
 * (single-ledger model, Aug 2026): `advanceBalance` is simply its usable
 * (clamped-at-zero) form, from the same ledger via advanceBalanceMap.
 *
 * `hasLedger: false` means the party was never provisioned an account ledger, so
 * nothing can be attributed to it. That is reported rather than shown as a
 * confident zero.
 */
function attachPartyBalance(
  rows: any[],
  idx: { partyBalance(kind: "vendor" | "customer", id: number): { balance: number; net: number; ledgerId: number } | null },
  kind: "vendor" | "customer",
  // partyId → usable advance (advanceBalanceMap): for customers the credit
  // side of their OWN ledger (single-ledger model), for vendors the VADV
  // ledger. Always the same source as /accounts/party-advance, the ageing
  // reports and bill settlement, so every advance surface agrees.
  advances: Map<number, number>,
): void {
  for (const row of rows) {
    const b = idx.partyBalance(kind, Number(row.id));
    row.advanceBalance = advances.get(Number(row.id)) ?? 0;
    if (b == null) {
      // No ledger was ever provisioned for this party, so nothing can be
      // attributed to it. That is NOT a balance of zero — a confident ₹0.00 here
      // is indistinguishable from "settled in full". Send null and let the UI
      // say so.
      row.outstandingBalance = null;
      row.ledgerBalance = null;
      row.balanceSide = null;
      row.ledgerId = null;
      row.hasLedger = false;
      continue;
    }
    const balance = b.balance;
    row.outstandingBalance = balance;
    row.ledgerBalance = balance;
    // Dr/Cr comes from the account's nature and the sign of the raw net, never
    // from the sign of the presented balance — a payable of 100 is Cr, and the
    // same account at −100 is Dr.
    row.balanceSide = Math.abs(balance) < 0.005 ? null : (kind === "vendor" ? (balance > 0 ? "Cr" : "Dr") : (balance > 0 ? "Dr" : "Cr"));
    row.ledgerId = b.ledgerId;
    row.hasLedger = true;
  }
}

// ── Field allowlists (bypass restrictive auto-generated schemas) ───────────
// These include `state` and all fields present in the DB schema.

const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'address', 'gstNumber', 'state', 'notes'] as const;
const VENDOR_FIELDS = ['name', 'phone', 'email', 'address', 'gstNumber', 'state', 'bankName', 'accountNumber'] as const;

type StrRecord = Record<string, any>;

function pickCustomer(body: StrRecord): StrRecord {
  const r: StrRecord = {};
  for (const k of CUSTOMER_FIELDS) { if (k in body) r[k] = body[k]; }
  return r;
}

function pickVendor(body: StrRecord): StrRecord {
  const r: StrRecord = {};
  for (const k of VENDOR_FIELDS) { if (k in body) r[k] = body[k]; }
  return r;
}

/**
 * Resolve a requested location re-assignment on a party PATCH.
 *
 * Returns null when the body carries no locationType (no relocation asked),
 * the validated `{type, id}` stamp when it may proceed, or `{error, status}`.
 * Only Head Office users may move a party between locations — a branch user's
 * writes are stamped by their session, and letting them re-home a record
 * would let them move data out of (or into) their own scope. The guard runs
 * on the EFFECTIVE value: the target must exist, and an outlet target is new
 * outlet activity, refused while outlets are disabled.
 */
async function resolveRelocation(
  req: any,
): Promise<{ type: string; id: number } | { error: string; status: number } | null> {
  const body = (req.body ?? {}) as StrRecord;
  if (!("locationType" in body) || body.locationType == null || body.locationType === "") return null;
  const emp = req.employee as { branchType?: string } | undefined;
  if ((emp?.branchType ?? "") !== "headoffice") {
    return { error: "Only Head Office users can change a record's assigned location", status: 403 };
  }
  const type = String(body.locationType);
  if (type === "headoffice") return { type: "headoffice", id: 0 };
  if (type !== "warehouse" && type !== "outlet") {
    return { error: "locationType must be headoffice, warehouse or outlet", status: 400 };
  }
  const id = Number(body.locationId);
  if (!Number.isFinite(id) || id <= 0) {
    return { error: "locationId is required for a warehouse or outlet", status: 400 };
  }
  const table = type === "warehouse" ? "warehouses" : "outlets";
  const { rows: [target] } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
  if (!target) return { error: `That ${type} does not exist`, status: 400 };
  if (type === "outlet" && await outletWritesBlocked(pool)) {
    return { error: OUTLETS_DISABLED_MESSAGE, status: 409 };
  }
  return { type, id };
}

/**
 * LBAC gate for single-party routes (mutations and the ledger statement).
 *
 * The list endpoints scope by the stored location stamp, but /:id routes
 * address a row directly — without this check a branch user could read or
 * edit another location's party just by knowing its id. Same visibility rule
 * as the lists: customers must be inside the caller's scope; vendors also
 * pass when stamped Head Office (shared master records). Out-of-scope reads
 * as "not_found" — a 404 that does not confirm the record exists.
 */
async function partyScopeCheck(
  req: any,
  kind: "customer" | "vendor",
  id: number,
): Promise<"ok" | "not_found"> {
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if ((emp?.branchType ?? "headoffice") === "headoffice") return "ok";
  const table = kind === "customer" ? "customers" : "vendors";
  const { rows: [row] } = await pool.query<{ lt: string; lid: number }>(
    `SELECT COALESCE(location_type, 'headoffice') AS lt, COALESCE(location_id, 0) AS lid
       FROM ${table} WHERE id = $1`, [id]);
  if (!row) return "not_found";
  if (kind === "vendor" && row.lt === "headoffice") return "ok";
  const { getUserDataScope, isLocationInScope } = await import("../lib/dataScope");
  const scope = await getUserDataScope({ branchType: String(emp!.branchType), branchId: Number(emp!.branchId) });
  return isLocationInScope(scope, row.lt, Number(row.lid)) ? "ok" : "not_found";
}

// ── Credit-control fields & party creation ─────────────────────────────────
// Shared with the Data Import commit path (lib/partyCreate.ts) so an imported
// party is provisioned exactly like a manually created one.
import {
  createCustomerWithLedger, createVendorWithLedger,
  validateCreditFields, applyCreditFields, creditFieldsRow,
} from "../lib/partyCreate";

// ── Customers ─────────────────────────────────────────────────────────────
// Serves HO Sales (POS), Notes (Vouchers) and Customers pages.
router.get("/customers", requireModuleView(["page:/sales/pos", "page:/accounts/vouchers", "page:/customers"]), async (req, res): Promise<void> => {
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (!emp) { res.status(401).json({ error: "Authentication required" }); return; }
  const { getUserDataScope, scopeLocationTypeWhere } = await import("../lib/dataScope");
  const scope = await getUserDataScope(emp);
  const params: any[] = [];
  const conds: string[] = [scopeLocationTypeWhere(scope, params, "c")];
  // View narrowing (page filter or the global selector) — ANDed ON TOP of the
  // LBAC scope above, so it can only narrow what the caller may already see.
  const { getLocationFilter } = await import("../lib/requestLocation");
  const { pushLocationFilter } = await import("../lib/queryFilters");
  pushLocationFilter(conds, params, getLocationFilter(req),
    `COALESCE(c.location_type, 'headoffice')`, `c.location_id`);
  const { rows } = await pool.query<any>(`
    SELECT
      c.*,
      COALESCE(SUM(s.total_amount), 0)  AS "totalPurchases"
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id
    WHERE ${conds.join(" AND ")}
    GROUP BY c.id
    ORDER BY c.id
  `, params);

  // The current balance is the customer's ACCOUNTING ledger balance, so a
  // journal, a receipt voucher or a manual credit note settles the customer
  // here exactly as it does on the Balance Sheet. Summing invoices minus
  // receipts cannot see any of those, which is how this list used to contradict
  // the customer's own ledger.
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  const balIdx = await currentBalanceIndex();
  const { advanceBalanceMap } = await import("../lib/advanceLedgers");
  attachPartyBalance(rows, balIdx, "customer", await advanceBalanceMap("customer", balIdx));
  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows as any[], paging).map((r: any) => ({
    ...r,
    totalPurchases:      Number(r.totalPurchases),
    // Kept nullable on purpose: Number(null) is 0, which would turn "this party
    // has no ledger" back into a confident zero balance.
    outstandingBalance:  r.outstandingBalance == null ? null : Number(r.outstandingBalance),
    ledgerBalance:       r.ledgerBalance == null ? null : Number(r.ledgerBalance),
    advanceBalance:      Number(r.advanceBalance),
    creditLimit:         Number(r.credit_limit ?? 0),
    creditDays:          Number(r.credit_days ?? 0),
    // Raw-migration columns surfaced in camelCase for the UI.
    locationType:        r.location_type ?? null,
    locationId:          r.location_id == null ? null : Number(r.location_id),
  })));
});

router.post("/customers", requireModuleAction("page:/customers", "add"), async (req, res): Promise<void> => {
  const data = pickCustomer(req.body);
  if (!data.name || typeof data.name !== 'string') {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const creditErr = validateCreditFields(req.body);
  if (creditErr) { res.status(400).json({ error: creditErr }); return; }
  // LBAC: stamp location from the authenticated employee's session — never trust client.
  const empLbac = (req as any).employee as { branchType: string; branchId: number } | undefined;
  let stampType = empLbac?.branchType ?? 'headoffice';
  let stampId   = empLbac?.branchId  ?? 0;
  // HO users may assign an explicit location — via the SAME validated resolver
  // as PATCH (target must exist, non-HO callers are refused), so a bad body
  // cannot persist a stamp no location filter will ever match.
  const createLoc = await resolveRelocation(req);
  if (createLoc && "error" in createLoc) { res.status(createLoc.status).json({ error: createLoc.error }); return; }
  if (createLoc) { stampType = createLoc.type; stampId = createLoc.id; }
  // Assigning a new customer to a retired outlet is new outlet activity. Guard the
  // EFFECTIVE stamp, not the request body — an outlet-stationed user lands on an
  // outlet through their session without ever naming one. Checked before the
  // insert so a refusal cannot strand a half-created customer.
  if (stampType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Insert + stamp + debtor-ledger provisioning live in lib/partyCreate.ts —
  // the ONE code path shared with the Data Import commit.
  const { row } = await createCustomerWithLedger(data as any, { type: stampType, id: stampId });

  await applyCreditFields(row.id, req.body);
  const credit = await creditFieldsRow(row.id);
  res.status(201).json({ ...row, ...credit, totalPurchases: Number(row.totalPurchases) });
});

router.get("/customers/:id", requireModuleView("page:/customers"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const credit = await creditFieldsRow(id);
  res.json({ ...row, ...credit, totalPurchases: Number(row.totalPurchases) });
});

router.patch("/customers/:id", requireModuleAction("page:/customers", "edit"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const data = pickCustomer(req.body);
  if (await partyScopeCheck(req, "customer", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }
  const creditErr = validateCreditFields(req.body);
  if (creditErr) { res.status(400).json({ error: creditErr }); return; }
  const hasCreditFields = ('creditLimit' in req.body) || ('creditDays' in req.body);
  const reloc = await resolveRelocation(req);
  if (reloc && "error" in reloc) { res.status(reloc.status).json({ error: reloc.error }); return; }
  if (Object.keys(data).length === 0 && !hasCreditFields && !reloc) { res.status(400).json({ error: "No valid fields to update" }); return; }

  let row;
  if (Object.keys(data).length > 0) {
    [row] = await db.update(customersTable).set(data).where(eq(customersTable.id, id)).returning();
  } else {
    [row] = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  }
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (reloc) {
    // Raw columns: drizzle cannot see location_type/location_id, so the
    // re-assignment writes them via raw SQL (see raw-migration convention).
    await pool.query(`UPDATE customers SET location_type = $1, location_id = $2 WHERE id = $3`,
      [reloc.type, reloc.id, id]);
  }
  await applyCreditFields(id, req.body);
  // Keep the linked debtor ledger's name in sync when the customer is renamed
  if (typeof (data as any).name === "string" && String((data as any).name).trim()) {
    await pool.query(
      `UPDATE account_ledgers SET name = $1, description = $2 WHERE code = $3`,
      [row.name, `Customer ledger — ${row.name}`, `CUST-${id}`]
    ).catch(() => {});
  }
  const credit = await creditFieldsRow(id);
  res.json({ ...row, ...credit, totalPurchases: Number(row.totalPurchases) });
});

router.delete("/customers/:id", requireModuleAction("page:/customers", "delete"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (await partyScopeCheck(req, "customer", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }

  // Always check business documents first — independent of ledger existence
  const { rows: [docCnt] } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sales WHERE customer_id = $1`, [id]
  );
  if (Number(docCnt.count) > 0) {
    res.status(400).json({ error: "This customer cannot be deleted because sales records already exist. Deleting it would affect financial history." });
    return;
  }

  // Also block if ledger-linked accounting entries exist
  const { rows: [ledger] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${id}`]
  );
  if (ledger) {
    const { rows: [ledgerCnt] } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT id FROM payments WHERE paid_from_ledger_id = $1 OR paid_to_ledger_id = $1
         UNION ALL
         SELECT id FROM receipts WHERE received_from_ledger_id = $1 OR received_in_ledger_id = $1
       ) t`,
      [ledger.id]
    );
    if (Number(ledgerCnt.count) > 0) {
      res.status(400).json({ error: "This customer cannot be deleted because accounting entries already exist. Deleting it would affect financial history." });
      return;
    }
    // No entries — safe to delete the orphaned system ledger
    await pool.query(`DELETE FROM account_ledgers WHERE id = $1`, [ledger.id]);
  }

  await db.delete(customersTable).where(eq(customersTable.id, id));
  res.status(204).send();
});

// ── Vendors ────────────────────────────────────────────────────────────────
// Serves Purchases, Notes (Vouchers), Vendors and Parties Reports pages.
router.get("/vendors", requireModuleView(["page:/production/purchase", "page:/accounts/vouchers", "page:/vendors", "page:/reports/sales", "page:/assets/purchases", "page:/assets/register", "page:/assets/reports"]), async (req, res): Promise<void> => {
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (!emp) { res.status(401).json({ error: "Authentication required" }); return; }
  const { getUserDataScope, scopeLocationTypeWhere } = await import("../lib/dataScope");
  const scope = await getUserDataScope(emp);
  const params: any[] = [];
  // HO-created vendors (headoffice/null) are shared master records visible to all locations
  const vendorConds: string[] = [scopeLocationTypeWhere(scope, params, "v", true)];
  // View narrowing (page filter or global selector) — ANDed on top of LBAC.
  const { getLocationFilter } = await import("../lib/requestLocation");
  const { pushLocationFilter } = await import("../lib/queryFilters");
  pushLocationFilter(vendorConds, params, getLocationFilter(req),
    `COALESCE(v.location_type, 'headoffice')`, `v.location_id`);
  const { rows } = await pool.query<any>(`
    SELECT
      v.*,
      -- Source-document totals, informational only. Branch-transfer purchases are
      -- excluded because they are owed to the sending branch's clearing ledger,
      -- not to this vendor — counting them here is what made "billed" disagree
      -- with the vendor's own account.
      -- Goods + other purchase charges: both credit the vendor, so "billed"
      -- must carry the same figure the vendor's ledger is owed.
      COALESCE(SUM(p.total_amount::numeric
        + COALESCE((SELECT SUM((e->>'amount')::numeric)
                      FROM jsonb_array_elements(COALESCE(p.other_charges, '[]'::jsonb)) e
                     WHERE (e->>'amount') ~ '^[0-9.]+$'), 0)) FILTER (WHERE p.branch_transfer_id IS NULL), 0) AS "totalPurchased",
      COALESCE((
        SELECT SUM(pay.amount)
        FROM payments pay
        JOIN account_ledgers al ON al.id = pay.paid_to_ledger_id
        WHERE al.code = 'VEND-' || v.id::text
      ), 0) AS "totalPaid"
    FROM vendors v
    LEFT JOIN purchases p ON p.vendor_id = v.id
    WHERE ${vendorConds.join(" AND ")}
    GROUP BY v.id
    ORDER BY v.id
  `, params);

  // Current payable comes from the vendor's ACCOUNTING ledger, not from
  // purchases minus payments. That old formula could not see a journal voucher,
  // so a payable settled by journal stayed on this list at its full original
  // value while the vendor's own ledger correctly showed zero.
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  const balIdx = await currentBalanceIndex();
  const { advanceBalanceMap } = await import("../lib/advanceLedgers");
  attachPartyBalance(rows, balIdx, "vendor", await advanceBalanceMap("vendor", balIdx));

  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows as any[], paging).map((r: any) => ({
    ...r,
    gstNumber:          r.gst_number ?? null,
    bankName:           r.bank_name ?? null,
    accountNumber:      r.account_number ?? null,
    totalPurchased:     Number(r.totalPurchased),
    totalPaid:          Number(r.totalPaid),
    // Nullable on purpose — see the customers list above.
    outstandingBalance: r.outstandingBalance == null ? null : Number(r.outstandingBalance),
    ledgerBalance:      r.ledgerBalance == null ? null : Number(r.ledgerBalance),
    advanceBalance:     Number(r.advanceBalance),
    locationType:       r.location_type ?? null,
    locationId:         r.location_id == null ? null : Number(r.location_id),
  })));
});

router.post("/vendors", requireModuleAction("page:/vendors", "add"), async (req, res): Promise<void> => {
  const data = pickVendor(req.body);
  if (!data.name || typeof data.name !== 'string') {
    res.status(400).json({ error: "name is required" });
    return;
  }
  // LBAC: stamp location from the authenticated employee's session
  const vendEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  let vendStampType = vendEmp?.branchType ?? 'headoffice';
  let vendStampId   = vendEmp?.branchId  ?? 0;
  // HO users may assign an explicit location — same validated resolver as PATCH.
  const vendLoc = await resolveRelocation(req);
  if (vendLoc && "error" in vendLoc) { res.status(vendLoc.status).json({ error: vendLoc.error }); return; }
  if (vendLoc) { vendStampType = vendLoc.type; vendStampId = vendLoc.id; }
  // Same rule as customers, and on the same effective-stamp basis.
  if (vendStampType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Insert + stamp + creditor-ledger provisioning live in lib/partyCreate.ts —
  // the ONE code path shared with the Data Import commit.
  const { row } = await createVendorWithLedger(data as any, { type: vendStampType, id: vendStampId });

  res.status(201).json(row);
});

router.get("/vendors/:id", requireModuleView("page:/vendors"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.patch("/vendors/:id", requireModuleAction("page:/vendors", "edit"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const data = pickVendor(req.body);
  if (await partyScopeCheck(req, "vendor", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }
  const reloc = await resolveRelocation(req);
  if (reloc && "error" in reloc) { res.status(reloc.status).json({ error: reloc.error }); return; }
  if (Object.keys(data).length === 0 && !reloc) { res.status(400).json({ error: "No valid fields to update" }); return; }
  let row;
  if (Object.keys(data).length > 0) {
    [row] = await db.update(vendorsTable).set(data).where(eq(vendorsTable.id, id)).returning();
  } else {
    [row] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
  }
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (reloc) {
    await pool.query(`UPDATE vendors SET location_type = $1, location_id = $2 WHERE id = $3`,
      [reloc.type, reloc.id, id]);
  }
  // Keep the linked creditor ledger's name in sync when the vendor is renamed
  if (typeof (data as any).name === "string" && String((data as any).name).trim()) {
    await pool.query(
      `UPDATE account_ledgers SET name = $1, description = $2 WHERE code = $3`,
      [row.name, `Vendor ledger — ${row.name}`, `VEND-${id}`]
    ).catch(() => {});
  }
  res.json(row);
});

router.delete("/vendors/:id", requireModuleAction("page:/vendors", "delete"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (await partyScopeCheck(req, "vendor", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }

  // Always check business documents first — independent of ledger existence
  const { rows: [docCnt] } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM purchases WHERE vendor_id = $1`, [id]
  );
  if (Number(docCnt.count) > 0) {
    res.status(400).json({ error: "This vendor cannot be deleted because purchase records already exist. Deleting it would affect financial history." });
    return;
  }

  // Also block if ledger-linked accounting entries exist
  const { rows: [ledger] } = await pool.query<{ id: number }>(
    `SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${id}`]
  );
  if (ledger) {
    const { rows: [ledgerCnt] } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT id FROM payments WHERE paid_from_ledger_id = $1 OR paid_to_ledger_id = $1
         UNION ALL
         SELECT id FROM receipts WHERE received_from_ledger_id = $1 OR received_in_ledger_id = $1
       ) t`,
      [ledger.id]
    );
    if (Number(ledgerCnt.count) > 0) {
      res.status(400).json({ error: "This vendor cannot be deleted because accounting entries already exist. Deleting it would affect financial history." });
      return;
    }
    await pool.query(`DELETE FROM account_ledgers WHERE id = $1`, [ledger.id]);
  }

  await db.delete(vendorsTable).where(eq(vendorsTable.id, id));
  res.status(204).send();
});

/**
 * Document-side totals for a party, shown alongside the ledger statement.
 *
 * These are source-document figures, NOT a balance. They are what was invoiced
 * and what was recorded as settled against those invoices, which is useful
 * context but must never be subtracted into a "current balance" — that is the
 * ledger's job, and doing it here is what produced two different answers for the
 * same party.
 */
async function partyDocumentTotals(
  kind: "vendor" | "customer",
  id: number,
  // Located view: when the statement is narrowed to one location, these
  // context figures must describe the SAME slice — a company-wide "billed"
  // next to a located balance reads like a discrepancy.
  loc?: { type: string; id: number | null } | null,
) {
  const locCond = (typeExpr: string, idExpr: string, params: unknown[]): string => {
    if (!loc || loc.type === "company") return "TRUE";
    if (loc.type === "headoffice") return `${typeExpr} = 'headoffice'`; // type alone — HO ids vary per table
    params.push(loc.type, Number(loc.id ?? 0));
    return `${typeExpr} = $${params.length - 1} AND ${idExpr} = $${params.length}`;
  };
  if (kind === "customer") {
    const params: unknown[] = [id];
    // Sale location per the sale-location-resolution convention (legacy rows
    // carry only outlet_id).
    const cond = locCond(`COALESCE(s.location_type, 'outlet')`, `COALESCE(s.location_id, s.outlet_id, 0)`, params);
    const { rows } = await pool.query<any>(
      `SELECT COALESCE(SUM(total_amount), 0) AS billed, COALESCE(SUM(amount_paid), 0) AS paid
         FROM sales s
        WHERE s.customer_id = $1 AND s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL AND ${cond}`,
      params,
    );
    return { totalBilled: Number(rows[0]?.billed ?? 0), totalPaid: Number(rows[0]?.paid ?? 0) };
  }
  const prParams: unknown[] = [id];
  const prCond = locCond(`COALESCE(p.location_type, 'headoffice')`, `COALESCE(p.location_id, 0)`, prParams);
  const payParams: unknown[] = [`VEND-${id}`];
  const payCond = locCond(`COALESCE(pay.location_type, 'headoffice')`, `COALESCE(pay.location_id, 0)`, payParams);
  const [{ rows: pr }, { rows: payr }] = await Promise.all([
    pool.query<any>(
      `SELECT COALESCE(SUM(total_amount::numeric
                + COALESCE((SELECT SUM((e->>'amount')::numeric)
                              FROM jsonb_array_elements(COALESCE(p.other_charges, '[]'::jsonb)) e
                             WHERE (e->>'amount') ~ '^[0-9.]+$'), 0)), 0) AS billed
         FROM purchases p
        WHERE p.vendor_id = $1 AND p.branch_transfer_id IS NULL AND ${prCond}`,
      prParams,
    ),
    pool.query<any>(
      `SELECT COALESCE(SUM(pay.amount), 0) AS paid FROM payments pay
         JOIN account_ledgers al ON al.id = pay.paid_to_ledger_id
        WHERE al.code = $1 AND ${payCond}`,
      payParams,
    ),
  ]);
  return { totalPurchased: Number(pr[0]?.billed ?? 0), totalPaid: Number(payr[0]?.paid ?? 0) };
}

/**
 * The located ledger view is a VIEW request, never authority: a non-HO caller
 * may only ask for location slices inside their own scope. Head Office and
 * "company" slices are HO-only — a branch's LBAC does not include them.
 */
async function postingFilterInScope(
  req: any,
  loc: { type: string; id: number | null } | null,
): Promise<boolean> {
  if (!loc) return true;
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if ((emp?.branchType ?? "headoffice") === "headoffice") return true;
  if (loc.type === "headoffice" || loc.type === "company") return false;
  const { getUserDataScope, isLocationInScope } = await import("../lib/dataScope");
  const scope = await getUserDataScope({ branchType: String(emp!.branchType), branchId: Number(emp!.branchId) });
  return isLocationInScope(scope, loc.type, Number(loc.id ?? 0));
}

// ── Customer ledger (the customer's account, from the posting stream) ─────
router.get("/customers/:id/ledger", requireModuleView(["page:/customers", "page:/outstanding"]), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (await partyScopeCheck(req, "customer", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }
  const { currentPartyStatement } = await import("../lib/ledgerBalances");
  // Located view: the global selector's headers (or explicit query params)
  // narrow the statement to postings stamped with that location. The figures
  // then describe the located slice, not the company-wide balance.
  const { getPostingLocationFilter } = await import("../lib/requestLocation");
  const { postingMatchesLocation } = await import("../lib/postingLocation");
  const loc = getPostingLocationFilter(req);
  if (!(await postingFilterInScope(req, loc))) {
    res.status(403).json({ error: "You do not have access to that location's view" }); return;
  }
  const [statement, docs] = await Promise.all([
    currentPartyStatement("customer", id, loc ? { postingFilter: (p) => postingMatchesLocation(p as any, loc) } : {}),
    partyDocumentTotals("customer", id, loc),
  ]);
  res.json({
    // Authoritative: the customer's ledger balance, receivable-positive.
    balance: statement.closing,
    opening: statement.opening,
    totalDebit: statement.totalDebit,
    totalCredit: statement.totalCredit,
    hasLedger: statement.hasLedger,
    // Source-document context, not a balance.
    totalBilled: docs.totalBilled,
    totalPaid: docs.totalPaid,
    entries: statement.entries,
  });
});

// ── Vendor ledger (the vendor's account, from the posting stream) ─────────
router.get("/vendors/:id/ledger", requireModuleView(["page:/vendors", "page:/outstanding"]), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (await partyScopeCheck(req, "vendor", id) !== "ok") { res.status(404).json({ error: "Not found" }); return; }
  const { currentPartyStatement } = await import("../lib/ledgerBalances");
  const { getPostingLocationFilter } = await import("../lib/requestLocation");
  const { postingMatchesLocation } = await import("../lib/postingLocation");
  const loc = getPostingLocationFilter(req);
  if (!(await postingFilterInScope(req, loc))) {
    res.status(403).json({ error: "You do not have access to that location's view" }); return;
  }
  const [statement, docs] = await Promise.all([
    currentPartyStatement("vendor", id, loc ? { postingFilter: (p) => postingMatchesLocation(p as any, loc) } : {}),
    partyDocumentTotals("vendor", id, loc),
  ]);
  res.json({
    // Authoritative: the vendor's ledger balance, payable-positive.
    balance: statement.closing,
    opening: statement.opening,
    totalDebit: statement.totalDebit,
    totalCredit: statement.totalCredit,
    hasLedger: statement.hasLedger,
    // Source-document context, not a balance.
    totalPurchased: docs.totalPurchased,
    totalPaid: docs.totalPaid,
    entries: statement.entries,
  });
});

// ── Record vendor payment ─────────────────────────────────────────────────
router.post("/vendors/:id/payment", requireModuleAction(["page:/vendors", "page:/accounts/vouchers"], "add"), async (req, res): Promise<void> => {
  const vendorId = parseInt(req.params.id, 10);
  const { date, amount, cashBankLedgerId, narration } = req.body as {
    date: string; amount: number; cashBankLedgerId: number; narration?: string;
  };
  if (!date || !amount || !cashBankLedgerId) {
    res.status(400).json({ error: "date, amount and cashBankLedgerId are required" }); return;
  }
  // payments.payment_date is a real DATE column.
  if (!isIsoDate(date)) {
    res.status(400).json({ error: "date must be a real calendar date in YYYY-MM-DD form" }); return;
  }

  // Find the VEND-{id} ledger account
  const { rows: [vendorLedger] } = await pool.query(
    `SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${vendorId}`],
  );
  if (!vendorLedger) {
    res.status(400).json({ error: `Ledger account VEND-${vendorId} not found. Please re-save the vendor to create it.` }); return;
  }

  // The voucher belongs to the location that owns the paying account (an
  // explicit body location is validated against it) — never silently the
  // caller's own branch, so Admin-recorded branch payments land in the
  // branch's books.
  const locRes = await resolveMoneyVoucherLocation((req as any).employee, req.body as any, Number(cashBankLedgerId));
  if (!locRes.ok) { res.status(locRes.status).json({ error: locRes.error }); return; }

  // Auto-number the payment voucher (FY-aware sequence)
  const voucherNumber = await nextVoucherNumber(pool, 'payment', date);

  const { rows: [row] } = await pool.query<any>(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, source, location_type, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'vendor', $7, $8) RETURNING *`,
    [voucherNumber, date, cashBankLedgerId, vendorLedger.id, amount, narration ?? `Payment to vendor #${vendorId}`,
     locRes.loc.locationType, Number(locRes.loc.locationId)],
  );

  res.status(201).json({
    id: row.id, voucherNumber: row.voucher_number, paymentDate: row.payment_date,
    amount: Number(row.amount), narration: row.narration,
  });
});

// ── Coupons ────────────────────────────────────────────────────────────────
router.get("/coupons", requireModuleView("page:/coupons"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(couponsTable).orderBy(couponsTable.id);
  const paging = parsePaging(_req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows, paging).map((r) => ({ ...r, discountValue: Number(r.discountValue) })));
});

router.post("/coupons", requireModuleAction("page:/coupons", "add"), async (req, res): Promise<void> => {
  const parsed = CreateCouponBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + parsed.data.validDays);
  const [row] = await db.insert(couponsTable).values({
    ...parsed.data,
    discountValue: String(parsed.data.discountValue),
    expiryDate: expiryDate.toISOString().split("T")[0],
  }).returning();
  res.status(201).json({ ...row, discountValue: Number(row.discountValue) });
});

router.patch("/coupons/:id", requireModuleAction("page:/coupons", "edit"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateCouponBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.discountValue !== undefined) updateData.discountValue = String(parsed.data.discountValue);
  const [row] = await db.update(couponsTable).set(updateData).where(eq(couponsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, discountValue: Number(row.discountValue) });
});

router.delete("/coupons/:id", requireModuleAction("page:/coupons", "delete"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(couponsTable).where(eq(couponsTable.id, id));
  res.status(204).send();
});

export default router;

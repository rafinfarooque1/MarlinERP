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
import { outstandingExpr } from "../lib/salePaymentPosition";

const router = Router();

/**
 * Attach the party's ACCOUNTING balance to each master row.
 *
 * `outstandingBalance` keeps its name because every screen already reads it, but
 * its meaning is now precise: the party's ledger balance signed to its natural
 * side — payable for a vendor, receivable for a customer. It is deliberately
 * **not** clamped at zero. A negative figure is a real position (an advance paid
 * to a vendor, or an advance received from a customer) and is surfaced separately
 * as `advanceBalance` so the UI can label it rather than swallow it.
 *
 * `hasLedger: false` means the party was never provisioned an account ledger, so
 * nothing can be attributed to it. That is reported rather than shown as a
 * confident zero.
 */
function attachPartyBalance(
  rows: any[],
  idx: { partyBalance(kind: "vendor" | "customer", id: number): { balance: number; net: number; ledgerId: number } | null },
  kind: "vendor" | "customer",
): void {
  for (const row of rows) {
    const b = idx.partyBalance(kind, Number(row.id));
    if (b == null) {
      // No ledger was ever provisioned for this party, so nothing can be
      // attributed to it. That is NOT a balance of zero — a confident ₹0.00 here
      // is indistinguishable from "settled in full". Send null and let the UI
      // say so.
      row.outstandingBalance = null;
      row.ledgerBalance = null;
      row.advanceBalance = 0;
      row.balanceSide = null;
      row.ledgerId = null;
      row.hasLedger = false;
      continue;
    }
    const balance = b.balance;
    row.outstandingBalance = balance;
    row.ledgerBalance = balance;
    row.advanceBalance = balance < -0.004 ? Math.round(-balance * 100) / 100 : 0;
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

// ── Credit-control fields (raw columns — not in the Drizzle schema) ────────
function validateCreditFields(body: StrRecord): string | null {
  if ('creditLimit' in body && body.creditLimit !== null) {
    const v = Number(body.creditLimit);
    if (!Number.isFinite(v) || v < 0) return "creditLimit must be a number ≥ 0";
  }
  if ('creditDays' in body && body.creditDays !== null) {
    const v = Number(body.creditDays);
    if (!Number.isInteger(v) || v < 0) return "creditDays must be a whole number ≥ 0";
  }
  return null;
}

async function applyCreditFields(id: number, body: StrRecord): Promise<void> {
  if ('creditLimit' in body) {
    const v = body.creditLimit === null ? 0 : Math.round(Number(body.creditLimit) * 100) / 100;
    await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [v, id]);
  }
  if ('creditDays' in body) {
    const v = body.creditDays === null ? 0 : Number(body.creditDays);
    await pool.query(`UPDATE customers SET credit_days = $1 WHERE id = $2`, [v, id]);
  }
}

async function creditFieldsRow(id: number): Promise<{ creditLimit: number; creditDays: number }> {
  const { rows: [r] } = await pool.query<any>(
    `SELECT COALESCE(credit_limit, 0)::numeric AS cl, COALESCE(credit_days, 0) AS cd FROM customers WHERE id = $1`, [id]
  );
  return { creditLimit: Number(r?.cl ?? 0), creditDays: Number(r?.cd ?? 0) };
}

// ── Customers ─────────────────────────────────────────────────────────────
// Serves HO Sales (POS), Notes (Vouchers) and Customers pages.
router.get("/customers", requireModuleView(["page:/sales/pos", "page:/accounts/vouchers", "page:/customers"]), async (req, res): Promise<void> => {
  const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (!emp) { res.status(401).json({ error: "Authentication required" }); return; }
  const { getUserDataScope, scopeLocationTypeWhere } = await import("../lib/dataScope");
  const scope = await getUserDataScope(emp);
  const params: any[] = [];
  const scopeCond = scopeLocationTypeWhere(scope, params, "c");
  const { rows } = await pool.query<any>(`
    SELECT
      c.*,
      COALESCE(SUM(s.total_amount), 0)  AS "totalPurchases",
      -- Invoice-level exposure, kept as a source-document figure only. It is NOT
      -- the customer's current balance: see the ledger balance attached below.
      GREATEST(0, COALESCE(SUM(${outstandingExpr("s")}), 0)) AS "invoiceOutstanding"
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id
    WHERE ${scopeCond}
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
  attachPartyBalance(rows, balIdx, "customer");
  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows as any[], paging).map((r: any) => ({
    ...r,
    totalPurchases:      Number(r.totalPurchases),
    invoiceOutstanding:  Number(r.invoiceOutstanding),
    // Kept nullable on purpose: Number(null) is 0, which would turn "this party
    // has no ledger" back into a confident zero balance.
    outstandingBalance:  r.outstandingBalance == null ? null : Number(r.outstandingBalance),
    ledgerBalance:       r.ledgerBalance == null ? null : Number(r.ledgerBalance),
    advanceBalance:      Number(r.advanceBalance),
    creditLimit:         Number(r.credit_limit ?? 0),
    creditDays:          Number(r.credit_days ?? 0),
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
  // LBAC: stamp location from the authenticated employee's session — never trust client
  const empLbac = (req as any).employee as { branchType: string; branchId: number } | undefined;
  let stampType = empLbac?.branchType ?? 'headoffice';
  let stampId   = empLbac?.branchId  ?? 0;
  // HO users may explicitly assign a customer to a specific location via request body
  if (stampType === 'headoffice') {
    const { locationType: ct, locationId: ci } = req.body as { locationType?: string; locationId?: number };
    if (ct && ci) { stampType = ct; stampId = Number(ci); }
  }
  // Assigning a new customer to a retired outlet is new outlet activity. Guard the
  // EFFECTIVE stamp, not the request body — an outlet-stationed user lands on an
  // outlet through their session without ever naming one. Checked before the
  // insert so a refusal cannot strand a half-created customer.
  if (stampType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Insert and stamp are one transaction. The guard above authorised this row to
  // exist *at this location*; a row that survives without its stamp is one whose
  // access scoping silently falls back to something nobody approved, so a failed
  // stamp must take the insert down with it rather than leave that behind.
  const row = await db.transaction(async (tx) => {
    // pickCustomer whitelists keys and the guard above ensures name is present
    const [created] = await tx.insert(customersTable)
      .values(data as typeof customersTable.$inferInsert).returning();
    // location_type/location_id came from a startup migration, so drizzle cannot
    // see them on the insert — they have to be written as raw SQL.
    await tx.execute(
      sql`UPDATE customers SET location_type = ${stampType}, location_id = ${stampId} WHERE id = ${created.id}`,
    );
    return created;
  });

  // Auto-create a debtor ledger under Sundry Debtors
  try {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-DEBTORS'`);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [row.name, `CUST-${row.id}`, parent.id, `Customer ledger — ${row.name}`],
      );
    }
  } catch { /* non-fatal — ledger can be created manually */ }

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
  const creditErr = validateCreditFields(req.body);
  if (creditErr) { res.status(400).json({ error: creditErr }); return; }
  const hasCreditFields = ('creditLimit' in req.body) || ('creditDays' in req.body);
  if (Object.keys(data).length === 0 && !hasCreditFields) { res.status(400).json({ error: "No valid fields to update" }); return; }

  let row;
  if (Object.keys(data).length > 0) {
    [row] = await db.update(customersTable).set(data).where(eq(customersTable.id, id)).returning();
  } else {
    [row] = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  }
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
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
  const scopeCond = scopeLocationTypeWhere(scope, params, "v", true);
  const { rows } = await pool.query<any>(`
    SELECT
      v.*,
      -- Source-document totals, informational only. Branch-transfer purchases are
      -- excluded because they are owed to the sending branch's clearing ledger,
      -- not to this vendor — counting them here is what made "billed" disagree
      -- with the vendor's own account.
      COALESCE(SUM(p.total_amount) FILTER (WHERE p.branch_transfer_id IS NULL), 0) AS "totalPurchased",
      COALESCE((
        SELECT SUM(pay.amount)
        FROM payments pay
        JOIN account_ledgers al ON al.id = pay.paid_to_ledger_id
        WHERE al.code = 'VEND-' || v.id::text
      ), 0) AS "totalPaid"
    FROM vendors v
    LEFT JOIN purchases p ON p.vendor_id = v.id
    WHERE ${scopeCond}
    GROUP BY v.id
    ORDER BY v.id
  `, params);

  // Current payable comes from the vendor's ACCOUNTING ledger, not from
  // purchases minus payments. That old formula could not see a journal voucher,
  // so a payable settled by journal stayed on this list at its full original
  // value while the vendor's own ledger correctly showed zero.
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  const balIdx = await currentBalanceIndex();
  attachPartyBalance(rows, balIdx, "vendor");

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
  // HO users may override via request body
  if (vendStampType === 'headoffice') {
    const { locationType: ct, locationId: ci } = req.body as { locationType?: string; locationId?: number };
    if (ct && ci) { vendStampType = ct; vendStampId = Number(ci); }
  }
  // Same rule as customers, and on the same effective-stamp basis.
  if (vendStampType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  // Atomic for the same reason as customers — and note the stamp failure here used
  // to be swallowed outright, which quietly produced exactly the unscoped row the
  // guard exists to prevent.
  const row = await db.transaction(async (tx) => {
    // pickVendor whitelists keys and the guard above ensures name is present
    const [created] = await tx.insert(vendorsTable)
      .values(data as typeof vendorsTable.$inferInsert).returning();
    await tx.execute(
      sql`UPDATE vendors SET location_type = ${vendStampType}, location_id = ${vendStampId} WHERE id = ${created.id}`,
    );
    return created;
  });

  // Auto-create a creditor ledger under Sundry Creditors
  try {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-CREDITORS'`);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, 'liability', $2, 'balance_sheet', $3, false, $4
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [row.name, `VEND-${row.id}`, parent.id, `Vendor ledger — ${row.name}`],
      );
    }
  } catch { /* non-fatal */ }

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
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
  const [row] = await db.update(vendorsTable).set(data).where(eq(vendorsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
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
async function partyDocumentTotals(kind: "vendor" | "customer", id: number) {
  if (kind === "customer") {
    const { rows } = await pool.query<any>(
      `SELECT COALESCE(SUM(total_amount), 0) AS billed, COALESCE(SUM(amount_paid), 0) AS paid
         FROM sales
        WHERE customer_id = $1 AND branch_transfer_id IS NULL AND cancelled_at IS NULL`,
      [id],
    );
    return { totalBilled: Number(rows[0]?.billed ?? 0), totalPaid: Number(rows[0]?.paid ?? 0) };
  }
  const [{ rows: pr }, { rows: payr }] = await Promise.all([
    pool.query<any>(
      `SELECT COALESCE(SUM(total_amount), 0) AS billed FROM purchases
        WHERE vendor_id = $1 AND branch_transfer_id IS NULL`,
      [id],
    ),
    pool.query<any>(
      `SELECT COALESCE(SUM(pay.amount), 0) AS paid FROM payments pay
         JOIN account_ledgers al ON al.id = pay.paid_to_ledger_id
        WHERE al.code = $1`,
      [`VEND-${id}`],
    ),
  ]);
  return { totalPurchased: Number(pr[0]?.billed ?? 0), totalPaid: Number(payr[0]?.paid ?? 0) };
}

// ── Customer ledger (the customer's account, from the posting stream) ─────
router.get("/customers/:id/ledger", requireModuleView(["page:/customers", "page:/outstanding"]), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { currentPartyStatement } = await import("../lib/ledgerBalances");
  const [statement, docs] = await Promise.all([
    currentPartyStatement("customer", id),
    partyDocumentTotals("customer", id),
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
  const { currentPartyStatement } = await import("../lib/ledgerBalances");
  const [statement, docs] = await Promise.all([
    currentPartyStatement("vendor", id),
    partyDocumentTotals("vendor", id),
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

  // Auto-number the payment voucher (FY-aware sequence)
  const voucherNumber = await nextVoucherNumber(pool, 'payment', date);

  const { rows: [row] } = await pool.query<any>(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, source)
     VALUES ($1, $2, $3, $4, $5, $6, 'vendor') RETURNING *`,
    [voucherNumber, date, cashBankLedgerId, vendorLedger.id, amount, narration ?? `Payment to vendor #${vendorId}`],
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

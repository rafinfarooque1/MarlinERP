import { Router } from "express";
import { db, pool, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams,
} from "@workspace/api-zod";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS } from "../lib/voucherNumber";
import { lineTaxHeads } from "../lib/gst";
import { logActivity } from "../lib/audit";
import { closingStockValuation } from "../lib/valuation";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { getUserDataScope, scopeSalesWhere, scopeBranchWhere } from "../lib/dataScope";
import {
  callerLocation, ownLocationScope, scopeLedgerIds, scopeCashLedgerIds, scopeMoneyWhere,
  checkVoucherLegs, foreignLocationLedgerIds,
} from "../lib/moneyScope";

const router = Router();

// ── Chart of Accounts (tree) ───────────────────────────────────────────────
// Consumers: Chart of Accounts page, and the Expenses page's ledger dropdown.
router.get("/accounts/chart", requireModuleView(["page:/accounts/chart", "page:/accounts/expenses"]), async (_req, res): Promise<void> => {
  const result = await pool.query(`SELECT * FROM account_ledgers ORDER BY id`);
  const rows = result.rows;

  // Build tree in memory
  const map = new Map<number, any>();
  rows.forEach((r: any) => map.set(r.id, {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id ?? null,
    description: r.description ?? null,
    code: r.code ?? null,
    section: r.section ?? null,
    isSystemGroup: r.is_system_group ?? false,
    isGroup: r.is_group ?? false,
    createdAt: r.created_at,
    children: [],
    balance: 0,
  }));
  const roots: any[] = [];
  rows.forEach((r: any) => {
    const node = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) {
      map.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  res.json(roots);
});

// Also expose flat list for dropdowns
// Fills account dropdowns on Journal, Contra/Notes, Vouchers and Ledger.
router.get("/accounts/chart/flat", requireModuleView(["page:/accounts/vouchers", "page:/accounts/ledger"]), async (_req, res): Promise<void> => {
  const result = await pool.query(`SELECT * FROM account_ledgers ORDER BY id`);
  res.json(result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id ?? null,
    description: r.description ?? null,
    code: r.code ?? null,
    section: r.section ?? null,
    isSystemGroup: r.is_system_group ?? false,
    isGroup: r.is_group ?? false,
    bankDetails: r.bank_details ?? null,
    balance: 0,
  })));
});

// Cash/Bank ledgers only — for Received In / Paid From dropdowns
// Serves Cash & Bank and Expenses pages.
router.get("/accounts/cash-bank-ledgers", requireModuleView(["page:/accounts/cash-bank", "page:/accounts/expenses", "page:/accounts/vouchers", "page:/vendors"]), async (req, res): Promise<void> => {
  const { rows } = await pool.query(`SELECT * FROM account_ledgers ORDER BY id`);
  const bankRoot = rows.find((r: any) => r.code === 'STD-BANK');
  const cashRoot = rows.find((r: any) => r.code === 'STD-CASH');
  const ids = new Set<number>();
  if (bankRoot) ids.add(bankRoot.id);
  if (cashRoot) ids.add(cashRoot.id);
  // Multi-level descendant walk (up to 4 levels)
  for (let i = 0; i < 4; i++) {
    for (const r of rows) {
      if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
    }
  }
  // LBAC: this list populates the "money account" pickers on Payments and
  // Receipts. A branch may only move its OWN cash, so it sees exactly one
  // account: its own till. Head Office keeps the full cash + bank tree.
  const cbScope = ownLocationScope((req as any).employee);
  if (!cbScope.isHeadOffice) {
    const own = await scopeCashLedgerIds(cbScope);
    for (const id of Array.from(ids)) if (!own.includes(id)) ids.delete(id);
  }
  res.json(rows.filter((r: any) => ids.has(r.id)).map((r: any) => ({
    id: r.id, name: r.name, type: r.type,
    parentId: r.parent_id ?? null, code: r.code ?? null,
    bankDetails: r.bank_details ?? null,
  })));
});

router.post("/accounts/chart", requireModuleAction("page:/accounts/chart", "add"), async (req, res): Promise<void> => {
  const parsed = CreateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const code = (req.body as any).code ?? null;
  const bankDetails = (req.body as any).bankDetails ?? null;
  const isGroup = !!(req.body as any).isGroup;
  const [row] = await db.insert(accountLedgersTable).values({ ...parsed.data, ...(code ? {} : {}) }).returning();
  // Set code, bank_details, and is_group via raw query if provided
  if (code || bankDetails || isGroup) {
    await pool.query(
      `UPDATE account_ledgers SET
         code = COALESCE($1, code),
         bank_details = COALESCE($2, bank_details),
         is_group = CASE WHEN $4 THEN true ELSE is_group END
       WHERE id = $3`,
      [code, bankDetails ? JSON.stringify(bankDetails) : null, row.id, isGroup]
    );
  }
  const parentName = parsed.data.parentId
    ? (await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, parsed.data.parentId!)).limit(1))[0]?.name ?? null
    : null;
  res.status(201).json({ ...row, code, bankDetails, isGroup, parentName, children: [], balance: 0 });
});

router.patch("/accounts/chart/:id", requireModuleAction("page:/accounts/chart", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Block rename of system ledgers (those with a code)
  if (parsed.data.name !== undefined) {
    const { rows: [ledger] } = await pool.query(`SELECT code FROM account_ledgers WHERE id = $1`, [id]);
    if (!ledger) { res.status(404).json({ error: "Not found" }); return; }
    if (ledger.code) { res.status(400).json({ error: "System ledger name cannot be changed." }); return; }
  }

  const [row] = await db.update(accountLedgersTable).set(parsed.data).where(eq(accountLedgersTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if ((req.body as any).code !== undefined) {
    await pool.query(`UPDATE account_ledgers SET code = $1 WHERE id = $2`, [(req.body as any).code, id]);
  }
  res.json({ ...row, code: (req.body as any).code ?? null, parentName: null, children: [], balance: 0 });
});

// ── Move account to a different parent (drag-and-drop reparent) ───────────────
router.patch("/accounts/chart/:id/move", requireModuleAction("page:/accounts/chart", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { parentId } = req.body as { parentId: number };
  if (!parentId) { res.status(400).json({ error: "parentId is required" }); return; }

  // Node must exist and must not be a system group
  const { rows: [node] } = await pool.query(
    `SELECT is_system_group, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!node) { res.status(404).json({ error: "Account not found" }); return; }
  if (node.is_system_group) { res.status(400).json({ error: "System groups cannot be moved" }); return; }

  // Target parent must exist and must be a group (container)
  const { rows: [parent] } = await pool.query(
    `SELECT id, is_group FROM account_ledgers WHERE id = $1`, [parentId]
  );
  if (!parent) { res.status(404).json({ error: "Target parent not found" }); return; }
  if (!parent.is_group) { res.status(400).json({ error: "Target must be a group or sub-group, not a leaf ledger" }); return; }

  // Prevent circular reference: target must not be a descendant of the node being moved
  const { rows: circular } = await pool.query(`
    WITH RECURSIVE descendants AS (
      SELECT id FROM account_ledgers WHERE parent_id = $1
      UNION ALL
      SELECT al.id FROM account_ledgers al JOIN descendants d ON al.parent_id = d.id
    )
    SELECT id FROM descendants WHERE id = $2
  `, [id, parentId]);
  if (circular.length > 0) {
    res.status(400).json({ error: "Cannot move a group into one of its own sub-groups" }); return;
  }

  await pool.query(`UPDATE account_ledgers SET parent_id = $1 WHERE id = $2`, [parentId, id]);
  res.json({ success: true });
});

router.delete("/accounts/chart/:id", requireModuleAction("page:/accounts/chart", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [row] } = await pool.query(`SELECT is_system_group, code FROM account_ledgers WHERE id = $1`, [id]);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // Protect system group heads and system ledgers (those with a code)
  if (row.is_system_group) { res.status(400).json({ error: "System group accounts cannot be deleted." }); return; }
  if (row.code) { res.status(400).json({ error: "System ledger cannot be deleted." }); return; }
  // Check for children
  const children = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.parentId, id));
  if (children.length > 0) { res.status(400).json({ error: "Cannot delete account with sub-accounts. Delete sub-accounts first." }); return; }
  // Check for entries in payments and receipts
  const { rows: payRows } = await pool.query(
    `SELECT COUNT(*) FROM payments WHERE paid_from_ledger_id = $1 OR paid_to_ledger_id = $1`, [id]
  );
  const { rows: recRows } = await pool.query(
    `SELECT COUNT(*) FROM receipts WHERE received_from_ledger_id = $1 OR received_in_ledger_id = $1`, [id]
  );
  const entryCount = Number(payRows[0].count) + Number(recRows[0].count);
  if (entryCount > 0) {
    res.status(400).json({ error: `Cannot delete: this ledger has ${entryCount} voucher entr${entryCount === 1 ? 'y' : 'ies'}. Remove those entries first.` });
    return;
  }
  await db.delete(accountLedgersTable).where(eq(accountLedgersTable.id, id));
  res.status(204).send();
});

// ── Payments ──────────────────────────────────────────────────────────────
// LBAC: each location keeps its own payment book — a branch sees the vouchers
// that belong to it (stamped location, or a leg on one of its own ledgers) and
// Head Office sees everything. See lib/moneyScope.ts for the ownership rule.
router.get("/accounts/payments", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  const result = await pool.query(`
    SELECT p.*, 
      pf.name AS paid_from_name,
      pt.name AS paid_to_name
    FROM payments p
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    WHERE ${where}
    ORDER BY p.id DESC
  `, params);
  res.json(result.rows.map(r => ({
    id: r.id,
    voucherNumber: r.voucher_number,
    paymentDate: r.payment_date,
    paidFromLedgerId: r.paid_from_ledger_id,
    paidFromName: r.paid_from_name,
    paidToLedgerId: r.paid_to_ledger_id,
    paidToName: r.paid_to_name,
    amount: Number(r.amount),
    narration: r.narration,
    locationType: r.location_type ?? 'headoffice',
    locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  })));
});

router.post("/accounts/payments", requireModuleAction("page:/accounts/vouchers", "add"), async (req, res): Promise<void> => {
  const { paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration } = req.body as {
    paymentDate: string; paidFromLedgerId: number; paidToLedgerId: number; amount: number; narration?: string;
  };
  if (!paymentDate || !paidFromLedgerId || !paidToLedgerId || !amount) {
    res.status(400).json({ error: "paymentDate, paidFromLedgerId, paidToLedgerId and amount are required" }); return;
  }
  // A branch user may only pay out of its own cash box, and never into another
  // location's or Head Office's cash/bank accounts.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(paidFromLedgerId), Number(paidToLedgerId), 'Paid from');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  const { locationType, locationId } = callerLocation((req as any).employee);
  const voucherNumber = await nextVoucherNumber(pool, 'payment', paymentDate);
  const result = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [voucherNumber, paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration ?? null, locationType, locationId]
  );
  const r = result.rows[0];
  const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidFromLedgerId))).limit(1);
  const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidToLedgerId))).limit(1);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
    paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
    paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  });
});

router.delete("/accounts/payments/:id", requireModuleAction("page:/accounts/vouchers", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }
  // Scope the DELETE itself: a branch user must not be able to remove another
  // location's (or Head Office's) voucher by guessing its id.
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [id];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  const { rowCount } = await pool.query(
    `DELETE FROM payments p WHERE p.id = $1 AND ${where}`, params
  );
  if (!rowCount) { res.status(404).json({ error: "Payment not found" }); return; }
  res.status(204).send();
});

// ── Receipts ──────────────────────────────────────────────────────────────
// LBAC: same ownership rule as payments — a branch sees its own receipts only.
router.get("/accounts/receipts", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const result = await pool.query(`
    SELECT r.*,
      rf.name AS received_from_name,
      ri.name AS received_in_name
    FROM receipts r
    LEFT JOIN account_ledgers rf ON r.received_from_ledger_id = rf.id
    LEFT JOIN account_ledgers ri ON r.received_in_ledger_id = ri.id
    WHERE ${where}
    ORDER BY r.id DESC
  `, params);
  res.json(result.rows.map(r => ({
    id: r.id,
    voucherNumber: r.voucher_number,
    receiptDate: r.receipt_date,
    receivedFromLedgerId: r.received_from_ledger_id,
    receivedFromName: r.received_from_name,
    receivedInLedgerId: r.received_in_ledger_id,
    receivedInName: r.received_in_name,
    amount: Number(r.amount),
    narration: r.narration,
    locationType: r.location_type ?? 'headoffice',
    locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  })));
});

router.post("/accounts/receipts", requireModuleAction("page:/accounts/vouchers", "add"), async (req, res): Promise<void> => {
  const { receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration } = req.body as {
    receiptDate: string; receivedFromLedgerId: number; receivedInLedgerId: number; amount: number; narration?: string;
  };
  if (!receiptDate || !receivedFromLedgerId || !receivedInLedgerId || !amount) {
    res.status(400).json({ error: "receiptDate, receivedFromLedgerId, receivedInLedgerId and amount are required" }); return;
  }
  // A branch user may only collect into its own cash box.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(receivedInLedgerId), Number(receivedFromLedgerId), 'Received in');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  const { locationType, locationId } = callerLocation((req as any).employee);
  const voucherNumber = await nextVoucherNumber(pool, 'receipt', receiptDate);
  const result = await pool.query(
    `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [voucherNumber, receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration ?? null, locationType, locationId]
  );
  const r = result.rows[0];
  const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedFromLedgerId))).limit(1);
  const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedInLedgerId))).limit(1);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
    receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
    receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  });
});

router.delete("/accounts/receipts/:id", requireModuleAction("page:/accounts/vouchers", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid receipt id" }); return; }
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [id];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const { rowCount } = await pool.query(
    `DELETE FROM receipts r WHERE r.id = $1 AND ${where}`, params
  );
  if (!rowCount) { res.status(404).json({ error: "Receipt not found" }); return; }
  res.status(204).send();
});

// ── Ledger Statement ──────────────────────────────────────────────────────
// LBAC: a branch may pull a statement, but only its own movements appear —
// vouchers it owns, its own sales and its own purchase bills. Head-Office-only
// sources (the expenses table, journal-family vouchers) are left out for branch
// users because they carry no location dimension.
router.get("/accounts/ledger-statement", requireModuleView("page:/accounts/ledger"), async (req, res): Promise<void> => {
  const qp = GetLedgerStatementQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }

  const accountId = Number(qp.data.accountId);
  const fromDate = qp.data.fromDate as string | undefined;
  const toDate = qp.data.toDate as string | undefined;

  const [account] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, accountId)).limit(1);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  // Two scopes on purpose: money vouchers follow the caller's own till
  // (`moneyScopeCtx`), while sales and purchases keep the wider location scope
  // the Sales and Purchases modules already use.
  const scope = await getUserDataScope((req as any).employee);
  const moneyScopeCtx = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(moneyScopeCtx);
  if (!moneyScopeCtx.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(moneyScopeCtx);
    if (foreign.includes(accountId)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }

  const entries: any[] = [];

  // Payments where this account is involved
  const pmtParams: unknown[] = [accountId];
  const pmtScope = scopeMoneyWhere(moneyScopeCtx, ledgerIds, pmtParams, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  const pmtRes = await pool.query(
    `SELECT p.* FROM payments p
     WHERE (p.paid_from_ledger_id = $1 OR p.paid_to_ledger_id = $1) AND ${pmtScope}`,
    pmtParams,
  );
  for (const p of pmtRes.rows) {
    entries.push({
      date: p.payment_date,
      description: p.narration || `Payment ${p.voucher_number}`,
      debit: p.paid_to_ledger_id == accountId ? Number(p.amount) : 0,
      credit: p.paid_from_ledger_id == accountId ? Number(p.amount) : 0,
      entryType: 'payment',
    });
  }

  // Receipts where this account is involved
  const recParams: unknown[] = [accountId];
  const recScope = scopeMoneyWhere(moneyScopeCtx, ledgerIds, recParams, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const recRes = await pool.query(
    `SELECT r.* FROM receipts r
     WHERE (r.received_from_ledger_id = $1 OR r.received_in_ledger_id = $1) AND ${recScope}`,
    recParams,
  );
  for (const r of recRes.rows) {
    entries.push({
      date: r.receipt_date,
      description: r.narration || `Receipt ${r.voucher_number}`,
      debit: r.received_in_ledger_id == accountId ? Number(r.amount) : 0,
      credit: r.received_from_ledger_id == accountId ? Number(r.amount) : 0,
      entryType: 'receipt',
    });
  }

  // Expenses tagged to this account — the expenses table is Head Office only
  // (branch spending is recorded as location-expense payments, already above).
  if (scope.isHeadOffice) {
    const exps = await db.select().from(expensesTable).where(eq(expensesTable.ledgerAccountId, accountId));
    entries.push(...exps.map(e => ({
      date: e.expenseDate, description: e.description ?? "Expense",
      debit: Number(e.amount), credit: 0, entryType: 'expense',
    })));
  }

  // Sales rows feeding income and GST ledgers, scoped to the caller's locations
  const needsSales = account.type === 'income' || (account as any).code === 'STD-DTX';
  let scopedSales: Array<{ id: number; sale_date: string; invoice_number: string | null; total_amount: string; tax_total: string }> = [];
  if (needsSales) {
    const salesParams: unknown[] = [];
    const salesWhere = scopeSalesWhere(scope, salesParams);
    const { rows } = await pool.query(
      `SELECT s.id, s.sale_date, s.invoice_number, s.total_amount, s.tax_total
       FROM sales s WHERE s.branch_transfer_id IS NULL AND ${salesWhere}`, salesParams,
    );
    scopedSales = rows as typeof scopedSales;
  }

  // Income accounts: include sales
  if (account.type === 'income') {
    entries.push(...scopedSales.map(s => ({
      date: s.sale_date,
      description: `Sales Invoice ${s.invoice_number || '#' + s.id}`,
      debit: 0, credit: Number(s.total_amount), entryType: 'sale',
    })));
  }

  // Duty & Tax ledger (STD-DTX): show GST collected on each sale as a credit
  const accountCode = (account as any).code ?? null;
  if (accountCode === 'STD-DTX') {
    for (const s of scopedSales) {
      const tax = Number(s.tax_total ?? 0);
      if (tax > 0) {
        entries.push({
          date: s.sale_date,
          description: `GST on ${s.invoice_number || 'Sale #' + s.id}`,
          debit: 0, credit: tax, entryType: 'sale_gst',
        });
      }
    }
  }

  // Purchase-type expense accounts: include purchases (branch-scoped — a
  // warehouse buys on its own bills since Phase 7)
  if (account.type === 'expense' && account.name.toLowerCase().includes('purchase')) {
    const purParams: unknown[] = [];
    const purWhere = scopeBranchWhere(scope, purParams, 'p');
    const { rows: purRows } = await pool.query(
      `SELECT p.id, p.purchase_date, p.invoice_number, p.total_amount
       FROM purchases p WHERE p.branch_transfer_id IS NULL AND ${purWhere}`, purParams,
    );
    entries.push(...purRows.map((p: any) => ({
      date: p.purchase_date,
      description: `Purchase Bill ${p.invoice_number || '#' + p.id}`,
      debit: Number(p.total_amount), credit: 0, entryType: 'purchase',
    })));
  }

  // Journal-family voucher lines touching this ledger (journal/contra/CN/DN).
  // Journal vouchers carry no location dimension, so they stay Head Office.
  const { rows: jvLines } = scope.isHeadOffice ? await pool.query(
    `SELECT v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1`, [accountId]
  ).catch(() => ({ rows: [] as any[] })) : { rows: [] as any[] };
  for (const jl of jvLines) {
    entries.push({
      date: jl.date,
      description: jl.narration || `${jl.voucher_type === 'contra' ? 'Contra' : jl.voucher_type === 'credit_note' ? 'Credit Note' : jl.voucher_type === 'debit_note' ? 'Debit Note' : 'Journal'} ${jl.voucher_number}`,
      debit: Number(jl.debit), credit: Number(jl.credit),
      entryType: jl.voucher_type,
    });
  }

  // Filter by date range
  let filtered = entries;
  if (fromDate) filtered = filtered.filter(e => e.date >= fromDate!);
  if (toDate) filtered = filtered.filter(e => e.date <= toDate!);
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  // Running balance
  let balance = 0;
  const entriesWithBalance = filtered.map(e => {
    balance += (e.debit || 0) - (e.credit || 0);
    return { ...e, balance };
  });

  res.json({
    accountId, accountName: account.name,
    openingBalance: 0, closingBalance: balance,
    entries: entriesWithBalance,
    transactions: entriesWithBalance,
  });
});

// ── Cash & Bank (kept for backward compat) ────────────────────────────────
router.get("/accounts/cash-bank", requireModuleView("page:/accounts/cash-bank"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(cashBankAccountsTable).orderBy(cashBankAccountsTable.id);
  res.json(rows.map(r => ({ ...r, balance: Number(r.balance) })));
});

router.post("/accounts/cash-bank", requireModuleAction("page:/accounts/cash-bank", "add"), async (req, res): Promise<void> => {
  const parsed = CreateCashBankAccountBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { openingBalance, ...rest } = parsed.data as typeof parsed.data & { openingBalance?: number };
  const [row] = await db.insert(cashBankAccountsTable).values({ ...rest, balance: String(openingBalance ?? 0) }).returning();
  res.status(201).json({ ...row, balance: Number(row.balance) });
});

// ── Expenses (merged: expenses table + location expense payments) ──────────
// No mapped consumer; serves the Expenses pages (accounts + sales).
router.get("/expenses", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const expEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const isHO = !expEmp || expEmp.branchType === 'headoffice';

  type ExpenseRow = {
    id: number; source: 'direct' | 'location'; expenseDate: any;
    description: string | null; ledgerAccountId: number; ledgerAccountName: string;
    paymentAccountId: number; paymentAccountName: string; amount: number;
    voucherNumber: string | null; createdAt: any;
    expenseNumber: string | null; category: string | null; attachmentUrl: string | null;
    locationType: string | null; locationId: number | null; locationName: string;
  };
  let directExpenses: ExpenseRow[] = [];

  // 1. Expenses recorded at Head Office, paid from a company cash/bank account.
  //    A branch user sees the ones attributed to their own location — Head
  //    Office often pays a warehouse's bill centrally, and that spend belongs on
  //    the warehouse's expense list even though the warehouse never touched it.
  //    Raw SQL because the audit columns come from a startup migration and are
  //    invisible to Drizzle's select().
  {
    const params: any[] = [];
    let locFilter = '';
    if (!isHO && expEmp) {
      params.push(expEmp.branchType, Number(expEmp.branchId));
      locFilter = `WHERE e.location_type = $1 AND e.location_id = $2`;
    }
    const { rows } = await pool.query(`
      SELECT e.id, e.expense_date, e.description, e.ledger_account_id, e.payment_account_id,
             e.amount, e.created_at, e.expense_number, e.category, e.attachment_url,
             e.location_type, e.location_id,
             al.name AS ledger_name, cb.name AS cash_bank_name,
             COALESCE(w.name, o.name) AS location_name
      FROM expenses e
      LEFT JOIN account_ledgers    al ON al.id = e.ledger_account_id
      LEFT JOIN cash_bank_accounts cb ON cb.id = e.payment_account_id
      LEFT JOIN warehouses w ON e.location_type = 'warehouse' AND w.id = e.location_id
      LEFT JOIN outlets    o ON e.location_type = 'outlet'    AND o.id = e.location_id
      ${locFilter}
      ORDER BY e.id DESC
    `, params);
    directExpenses = rows.map((r: any) => ({
      id: r.id,
      source: 'direct' as const,
      expenseDate: r.expense_date,
      description: r.description ?? null,
      ledgerAccountId: r.ledger_account_id,
      ledgerAccountName: r.ledger_name ?? "",
      paymentAccountId: r.payment_account_id,
      paymentAccountName: r.cash_bank_name ?? "",
      amount: Number(r.amount),
      voucherNumber: r.expense_number ?? null,
      createdAt: r.created_at,
      expenseNumber: r.expense_number ?? null,
      category: r.category ?? null,
      attachmentUrl: r.attachment_url ?? null,
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      locationName: r.location_name ?? 'Head Office',
    }));
  }

  // 2. Location expenses: payments where paid_to is in Direct/Indirect Expense subtree
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  let locationExpenses: ExpenseRow[] = [];
  if (expenseLedgerIds.length > 0) {
    // LBAC: non-HO users see only their location's expenses (from their cash ledger)
    let cashLedgerFilter = '';
    const pmtParams: any[] = [expenseLedgerIds];
    if (!isHO && expEmp) {
      const locTable = expEmp.branchType === 'warehouse' ? 'warehouses' : 'outlets';
      const { rows: [locRow] } = await pool.query(
        `SELECT cash_ledger_id FROM ${locTable} WHERE id = $1`, [expEmp.branchId]
      );
      if (locRow?.cash_ledger_id) {
        pmtParams.push(locRow.cash_ledger_id);
        cashLedgerFilter = ` AND p.paid_from_ledger_id = $${pmtParams.length}`;
      } else {
        // Location has no cash ledger configured — return empty
        res.json([]); return;
      }
    }

    const { rows: pmtRows } = await pool.query(`
      SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id,
             p.paid_to_ledger_id, p.amount, p.narration, p.created_at,
             p.expense_category, p.attachment_url, p.location_type, p.location_id,
             pf.name AS paid_from_name, pt.name AS paid_to_name,
             COALESCE(w.name, o.name) AS location_name
      FROM payments p
      LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
      LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
      LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
      LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
      WHERE p.paid_to_ledger_id = ANY($1)${cashLedgerFilter}
        -- Must be spent out of a location's own cash box. Without this, an
        -- ordinary Head Office payment to an expense head is dressed up as a
        -- location expense with a blank location, and its voucher prints as
        -- one. A payment is a location expense only if a location paid it.
        AND (w.id IS NOT NULL OR o.id IS NOT NULL)
      ORDER BY p.id DESC
    `, pmtParams);

    locationExpenses = pmtRows.map((r: any) => ({
      id: r.id,
      source: 'location' as const,
      expenseDate: r.payment_date,
      description: r.narration ?? null,
      ledgerAccountId: r.paid_to_ledger_id,
      ledgerAccountName: r.paid_to_name ?? "",
      paymentAccountId: r.paid_from_ledger_id,
      paymentAccountName: r.paid_from_name ?? "",
      amount: Number(r.amount),
      voucherNumber: r.voucher_number ?? null,
      createdAt: r.created_at,
      expenseNumber: r.voucher_number ?? null,
      category: r.expense_category ?? null,
      attachmentUrl: r.attachment_url ?? null,
      locationType: r.location_type ?? null,
      locationId: r.location_id ?? null,
      locationName: r.location_name ?? '',
    }));
  }

  // Merge and sort by expenseDate descending (most recent first)
  const all = [...directExpenses, ...locationExpenses].sort(
    (a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate))
  );
  res.json(all);
});

/** Expense categories. Free text would fragment the audit trail across
 *  "Fuel", "fuel" and "Diesel/Fuel", so the set is fixed and validated here. */
export const EXPENSE_CATEGORIES = [
  'Uncategorised', 'Salaries & Wages', 'Rent & Utilities', 'Freight & Transport',
  'Fuel', 'Repairs & Maintenance', 'Packing & Consumables', 'Office & Admin',
  'Professional Fees', 'Marketing', 'Bank & Finance Charges', 'Taxes & Statutory',
  'Cold Storage', 'Travel', 'Other',
] as const;

/** Read category + attachment from the RAW body — zod strips unknown keys. */
function readExpenseExtras(body: any): { category: string; attachmentUrl: string | null } | { error: string } {
  const rawCat = body?.category;
  let category = 'Uncategorised';
  if (rawCat !== undefined && rawCat !== null && String(rawCat).trim() !== '') {
    const match = EXPENSE_CATEGORIES.find(c => c.toLowerCase() === String(rawCat).trim().toLowerCase());
    if (!match) return { error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` };
    category = match;
  }
  const rawAtt = body?.attachmentUrl;
  let attachmentUrl: string | null = null;
  if (rawAtt !== undefined && rawAtt !== null && String(rawAtt).trim() !== '') {
    const v = String(rawAtt).trim();
    // Only our own object-storage paths — an arbitrary URL here would let a
    // voucher point anywhere, and the PDF/link would leave the app.
    if (!/^\/objects\/[A-Za-z0-9._\-/]+$/.test(v)) {
      return { error: 'attachmentUrl must be an uploaded file path' };
    }
    attachmentUrl = v;
  }
  return { category, attachmentUrl };
}

router.post("/expenses", requireModuleAction("page:/accounts/expenses", "add"), async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Head Office only. This row is paid from a company cash/bank account, which
  // a branch does not operate — a branch records spending through
  // /accounts/location-expenses, where its own cash balance is checked.
  const emp = (req as any).employee as { branchType: string; branchId: number; id?: number } | undefined;
  if (emp && emp.branchType !== 'headoffice') {
    res.status(403).json({
      error: "Only Head Office can record an expense against a company cash or bank account. Record this under Sales → Expenses to pay it from your location's cash.",
    });
    return;
  }

  const extras = readExpenseExtras(req.body);
  if ('error' in extras) { res.status(400).json({ error: extras.error }); return; }

  // Attribution: which location the spend belongs to. Defaults to Head Office.
  let locationType = 'headoffice';
  let locationId: number | null = null;
  const rawLocType = (req.body as any)?.locationType;
  if (rawLocType !== undefined && rawLocType !== null && String(rawLocType).trim() !== '') {
    locationType = String(rawLocType).trim();
    if (!['headoffice', 'warehouse', 'outlet'].includes(locationType)) {
      res.status(400).json({ error: "locationType must be headoffice, warehouse or outlet" }); return;
    }
    if (locationType !== 'headoffice') {
      locationId = Number((req.body as any)?.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        res.status(400).json({ error: "locationId is required when locationType is not headoffice" }); return;
      }
      const table = locationType === 'warehouse' ? 'warehouses' : 'outlets';
      const { rows: [loc] } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [locationId]);
      if (!loc) { res.status(400).json({ error: `No such ${locationType}` }); return; }
    }
  }

  const expenseNumber = await nextVoucherNumber(pool, 'expense', String(parsed.data.expenseDate));

  const [row] = await db.insert(expensesTable).values({ ...parsed.data, amount: String(parsed.data.amount) }).returning();
  // Audit columns come from a startup migration, so Drizzle cannot write them.
  await pool.query(
    `UPDATE expenses SET expense_number = $1, category = $2, attachment_url = $3,
            location_type = $4, location_id = $5, created_by = $6
     WHERE id = $7`,
    [expenseNumber, extras.category, extras.attachmentUrl, locationType, locationId, emp?.id ?? null, row.id]
  );
  await db.execute(sql`UPDATE cash_bank_accounts SET balance = balance::numeric - ${parsed.data.amount} WHERE id = ${parsed.data.paymentAccountId}`);
  const [ledger] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, row.ledgerAccountId)).limit(1);
  const [cashBank] = await db.select().from(cashBankAccountsTable).where(eq(cashBankAccountsTable.id, row.paymentAccountId)).limit(1);
  res.status(201).json({
    ...row, ledgerAccountName: ledger?.name ?? "", paymentAccountName: cashBank?.name ?? "",
    amount: Number(row.amount),
    expenseNumber, voucherNumber: expenseNumber,
    category: extras.category, attachmentUrl: extras.attachmentUrl,
    locationType, locationId,
  });
});

// Category list for the pickers — one source of truth, shared by both pages.
router.get("/expenses/categories", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (_req, res): Promise<void> => {
  res.json(EXPENSE_CATEGORIES.map((name) => ({ name })));
});

// ── Location-scoped Expenses (Sales segment) ───────────────────────────────

/** Walk CoA tree to collect all descendant IDs of the given root node codes. */
async function getDescendantLedgerIds(rootCodes: string[]): Promise<number[]> {
  const { rows } = await pool.query(`SELECT id, parent_id, code, is_system_group FROM account_ledgers ORDER BY id`);
  const rootIds = new Set<number>(
    rows.filter((r: any) => rootCodes.includes(r.code)).map((r: any) => r.id)
  );
  for (let i = 0; i < 8; i++) {
    for (const r of rows) {
      if (r.parent_id && rootIds.has(r.parent_id)) rootIds.add(r.id);
    }
  }
  return rows
    .filter((r: any) => rootIds.has(r.id) && !r.is_system_group)
    .map((r: any) => r.id);
}

/** Resolve the cash_ledger_id for a given warehouse or outlet. */
async function resolveLocationCashLedger(locationType: string, locationId: number): Promise<number | null> {
  if (locationType === 'warehouse') {
    const { rows } = await pool.query(`SELECT cash_ledger_id FROM warehouses WHERE id = $1`, [locationId]);
    return rows[0]?.cash_ledger_id ?? null;
  } else if (locationType === 'outlet') {
    const { rows } = await pool.query(`SELECT cash_ledger_id FROM outlets WHERE id = $1`, [locationId]);
    return rows[0]?.cash_ledger_id ?? null;
  }
  return null;
}

// Returns only Direct Expense + Indirect Expense leaf ledgers for the dropdown
// No mapped consumer; serves the Expenses page.
router.get("/accounts/expense-ledgers", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (_req, res): Promise<void> => {
  const ids = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (ids.length === 0) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT id, name, type, code, parent_id FROM account_ledgers WHERE id = ANY($1) ORDER BY name`,
    [ids]
  );
  res.json(rows.map((r: any) => ({ id: r.id, name: r.name, type: r.type, code: r.code ?? null, parentId: r.parent_id ?? null })));
});

// Summary: all locations with expense count + total, for the "By Location" overview tab
router.get("/accounts/location-expenses/summary", requireModuleView("page:/accounts/expenses"), async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);

  // LBAC: non-HO users see only their own location
  const sumEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const sumIsHO = !sumEmp || sumEmp.branchType === 'headoffice';

  // Fetch warehouses and outlets (scoped to user's location if non-HO)
  let warehouses: any[] = [];
  let outlets: any[] = [];
  if (sumIsHO) {
    const wRes = await pool.query(`SELECT id, name, cash_ledger_id FROM warehouses WHERE cash_ledger_id IS NOT NULL ORDER BY name`);
    const oRes = await pool.query(`SELECT id, name, cash_ledger_id FROM outlets WHERE cash_ledger_id IS NOT NULL ORDER BY name`);
    warehouses = wRes.rows;
    outlets = oRes.rows;
  } else if (sumEmp.branchType === 'warehouse') {
    const { rows } = await pool.query(`SELECT id, name, cash_ledger_id FROM warehouses WHERE id = $1 AND cash_ledger_id IS NOT NULL`, [sumEmp.branchId]);
    warehouses = rows;
  } else {
    const { rows } = await pool.query(`SELECT id, name, cash_ledger_id FROM outlets WHERE id = $1 AND cash_ledger_id IS NOT NULL`, [sumEmp.branchId]);
    outlets = rows;
  }

  const locations: Array<{
    locationType: string; locationId: number; locationName: string;
    cashLedgerId: number; count: number; total: number;
  }> = [];

  if (expenseLedgerIds.length === 0) {
    // No expense ledgers configured yet — return all locations with zero totals
    for (const w of warehouses) {
      locations.push({ locationType: 'warehouse', locationId: w.id, locationName: w.name, cashLedgerId: w.cash_ledger_id, count: 0, total: 0 });
    }
    for (const o of outlets) {
      locations.push({ locationType: 'outlet', locationId: o.id, locationName: o.name, cashLedgerId: o.cash_ledger_id, count: 0, total: 0 });
    }
    res.json(locations); return;
  }

  // Collect all cash_ledger_ids → location mapping
  const allLocations = [
    ...warehouses.map((w: any) => ({ locationType: 'warehouse', locationId: w.id, locationName: w.name, cashLedgerId: w.cash_ledger_id })),
    ...outlets.map((o: any) => ({ locationType: 'outlet', locationId: o.id, locationName: o.name, cashLedgerId: o.cash_ledger_id })),
  ];

  if (allLocations.length === 0) { res.json([]); return; }

  const cashLedgerIds = allLocations.map(l => l.cashLedgerId);

  // One query: count + sum grouped by paid_from_ledger_id
  const { rows: stats } = await pool.query(`
    SELECT paid_from_ledger_id, COUNT(*) AS cnt, SUM(amount) AS total
    FROM payments
    WHERE paid_from_ledger_id = ANY($1)
      AND paid_to_ledger_id = ANY($2)
    GROUP BY paid_from_ledger_id
  `, [cashLedgerIds, expenseLedgerIds]);

  const statsMap = new Map<number, { count: number; total: number }>(
    stats.map((r: any) => [Number(r.paid_from_ledger_id), { count: Number(r.cnt), total: Number(r.total) }])
  );

  for (const loc of allLocations) {
    const s = statsMap.get(loc.cashLedgerId) ?? { count: 0, total: 0 };
    locations.push({ ...loc, count: s.count, total: s.total });
  }

  res.json(locations);
});

// List expenses for a specific location (payments where paid_from = location's cash ledger
// AND paid_to belongs to Direct/Indirect Expense ledger subtree)
// ── GET /accounts/location-expenses/all — all locations combined ──────────────
// No mapped consumer; serves the Expenses page.
router.get("/accounts/location-expenses/all", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (expenseLedgerIds.length === 0) { res.json([]); return; }

  // LBAC: non-HO users see only their own location's expenses
  const allEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const allIsHO = !allEmp || allEmp.branchType === 'headoffice';

  let cashLedgerFilterAll = '';
  const allParams: any[] = [expenseLedgerIds];
  if (!allIsHO && allEmp) {
    const locTable = allEmp.branchType === 'warehouse' ? 'warehouses' : 'outlets';
    const { rows: [locRow] } = await pool.query(
      `SELECT cash_ledger_id FROM ${locTable} WHERE id = $1`, [allEmp.branchId]
    );
    if (locRow?.cash_ledger_id) {
      allParams.push(locRow.cash_ledger_id);
      cashLedgerFilterAll = ` AND p.paid_from_ledger_id = $${allParams.length}`;
    } else {
      res.json([]); return;
    }
  }

  // Join warehouses and outlets on their cash ledger to tag each payment with location info
  const { rows } = await pool.query(`
    SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id, p.paid_to_ledger_id,
           p.amount, p.narration, p.created_at, p.expense_category, p.attachment_url,
           pt.name AS expense_ledger_name,
           COALESCE(w.name, o.name)         AS location_name,
           CASE WHEN w.id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END AS location_type,
           COALESCE(w.id, o.id)             AS location_id
    FROM payments p
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
    LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
    WHERE p.paid_to_ledger_id = ANY($1)
      AND (w.id IS NOT NULL OR o.id IS NOT NULL)${cashLedgerFilterAll}
    ORDER BY p.payment_date DESC, p.id DESC
  `, allParams);

  res.json(rows.map((r: any) => ({
    id: r.id,
    voucherNumber: r.voucher_number,
    expenseDate: r.payment_date,
    expenseLedgerId: r.paid_to_ledger_id,
    expenseLedgerName: r.expense_ledger_name ?? '',
    amount: Number(r.amount),
    description: r.narration,
    locationName: r.location_name,
    locationType: r.location_type,
    locationId: Number(r.location_id),
    createdAt: r.created_at,
    category: r.expense_category ?? null,
    attachmentUrl: r.attachment_url ?? null,
  })));
});

router.get("/accounts/location-expenses", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const { locationType, locationId } = req.query as { locationType?: string; locationId?: string };
  if (!locationType || !locationId) {
    res.status(400).json({ error: "locationType and locationId are required" }); return;
  }
  // LBAC: non-HO users may only view their own location's expenses
  const locExpEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (locExpEmp && locExpEmp.branchType !== 'headoffice') {
    const reqLocType = String(locationType);
    const reqLocId   = Number(locationId);
    const empLocType = locExpEmp.branchType; // 'warehouse' or 'outlet'
    if (reqLocType !== empLocType || reqLocId !== locExpEmp.branchId) {
      res.status(403).json({ error: "Access denied: you may only view your own location's expenses" }); return;
    }
  }
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  if (!cashLedgerId) {
    res.status(404).json({ error: "Location has no Cash ledger assigned. Provision it under Accounts → Warehouses/Outlets." }); return;
  }
  // Fetch cash ledger name regardless of whether any expenses or expense ledgers exist.
  // Always return the wrapper shape so the frontend can gate UI on cashLedgerName.
  const { rows: clRows } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [cashLedgerId]);
  const cashLedgerName = clRows[0]?.name ?? '';

  // Only include payments to expense-category ledgers (Direct + Indirect Expense subtree)
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (expenseLedgerIds.length === 0) {
    // No expense categories configured yet — return wrapper with correct metadata and empty list
    res.json({ cashLedgerId, cashLedgerName, expenses: [] }); return;
  }

  const { rows } = await pool.query(`
    SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id, p.paid_to_ledger_id, p.amount, p.narration, p.created_at,
           p.expense_category, p.attachment_url,
           pf.name AS paid_from_name, pt.name AS paid_to_name
    FROM payments p
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    WHERE p.paid_from_ledger_id = $1
      AND p.paid_to_ledger_id = ANY($2)
    ORDER BY p.id DESC
  `, [cashLedgerId, expenseLedgerIds]);
  // Return wrapper object so cashLedgerName is always available even when no expenses exist
  res.json({
    cashLedgerId,
    cashLedgerName,
    expenses: rows.map((r: any) => ({
      id: r.id,
      voucherNumber: r.voucher_number,
      expenseDate: r.payment_date,
      expenseLedgerId: r.paid_to_ledger_id,
      expenseLedgerName: r.paid_to_name ?? '',
      cashLedgerId: r.paid_from_ledger_id,
      cashLedgerName: r.paid_from_name ?? '',
      amount: Number(r.amount),
      description: r.narration,
      createdAt: r.created_at,
      category: r.expense_category ?? null,
      attachmentUrl: r.attachment_url ?? null,
    })),
  });
});

// ── Helper: compute running cash balance for a ledger ────────────────────────
async function getLocationCashBalance(ledgerId: number): Promise<number> {
  const { rows: recRows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN received_in_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN received_from_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0) AS balance
     FROM receipts WHERE received_in_ledger_id = $1 OR received_from_ledger_id = $1`,
    [ledgerId]
  );
  const { rows: payRows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN paid_to_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN paid_from_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0) AS balance
     FROM payments WHERE paid_to_ledger_id = $1 OR paid_from_ledger_id = $1`,
    [ledgerId]
  );
  return Number(recRows[0]?.balance ?? 0) + Number(payRows[0]?.balance ?? 0);
}

// Create a location-scoped expense (Dr expenseLedger, Cr location cashLedger via payments)
router.post("/accounts/location-expenses", requireModuleAction("page:/sales/expenses", "add"), async (req, res): Promise<void> => {
  const { locationType, locationId, expenseLedgerId, amount, expenseDate, description, reference } = req.body as {
    locationType: string; locationId: number; expenseLedgerId: number;
    amount: number; expenseDate: string; description: string; reference?: string;
  };
  if (!locationType || !locationId || !expenseLedgerId || !amount || !expenseDate || !description) {
    res.status(400).json({ error: "locationType, locationId, expenseLedgerId, amount, expenseDate and description are required" }); return;
  }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    res.status(400).json({ error: "Amount must be positive." }); return;
  }
  // A retired outlet cannot take on new spending — that would be fresh outlet
  // activity in the books. Past outlet expenses stay readable.
  if (locationType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  // Server-side validation: expenseLedgerId must be within Direct/Indirect Expense subtree
  const allowedExpenseIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (!allowedExpenseIds.includes(Number(expenseLedgerId))) {
    res.status(400).json({ error: "expenseLedgerId must be a Direct or Indirect Expense ledger account." }); return;
  }
  // LBAC: a branch user may only spend its own location's cash.
  const expEmployee = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (expEmployee && expEmployee.branchType !== 'headoffice') {
    if (String(locationType) !== expEmployee.branchType || Number(locationId) !== Number(expEmployee.branchId)) {
      res.status(403).json({ error: "Access denied: you may only record expenses for your own location" }); return;
    }
  }
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  if (!cashLedgerId) {
    res.status(400).json({ error: "This location has no Cash ledger. Provision ledgers under Accounts → Warehouses/Outlets first." }); return;
  }
  // ── Cash balance check: expenses must not exceed available cash ──────────────
  const cashBalance = await getLocationCashBalance(cashLedgerId);
  if (parsedAmount > cashBalance + 0.001) {
    res.status(400).json({
      error: `Insufficient cash. Available balance is ₹${cashBalance.toFixed(2)} but expense is ₹${parsedAmount.toFixed(2)}.`,
    }); return;
  }
  const extras = readExpenseExtras(req.body);
  if ('error' in extras) { res.status(400).json({ error: extras.error }); return; }

  const narration = reference ? `${description} [Ref: ${reference}]` : description;
  const voucherNumber = await nextVoucherNumber(pool, 'payment', expenseDate);
  const { rows: [r] } = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id, expense_category, attachment_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [voucherNumber, expenseDate, cashLedgerId, Number(expenseLedgerId), parsedAmount, narration,
     String(locationType), Number(locationId), extras.category, extras.attachmentUrl]
  );
  const { rows: [pf] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [cashLedgerId]);
  const { rows: [pt] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [expenseLedgerId]);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, expenseDate: r.payment_date,
    expenseLedgerId: r.paid_to_ledger_id, expenseLedgerName: pt?.name ?? '',
    cashLedgerId: r.paid_from_ledger_id, cashLedgerName: pf?.name ?? '',
    amount: Number(r.amount), description: r.narration, createdAt: r.created_at,
    category: extras.category, attachmentUrl: extras.attachmentUrl,
  });
});

// Delete a location expense recorded in error (Phase 7, task #40).
// Guards: the payment row must actually BE a location expense — paid_from must
// be a location's cash ledger and paid_to must sit in the Direct/Indirect
// Expense subtree. Anything else must be deleted from its own page.
router.delete("/accounts/location-expenses/:id", requireModuleAction("page:/sales/expenses", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid expense id" }); return; }

  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  const { rows: [row] } = await pool.query(`
    SELECT p.id, p.voucher_number, p.amount, p.paid_to_ledger_id,
           pt.name AS expense_name,
           COALESCE(w.name, o.name) AS location_name,
           o.id AS outlet_id
    FROM payments p
    LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
    LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
    LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
    WHERE p.id = $1
  `, [id]);
  if (!row) { res.status(404).json({ error: "Expense not found" }); return; }
  if (!row.location_name || !expenseLedgerIds.includes(Number(row.paid_to_ledger_id))) {
    res.status(400).json({ error: "This voucher is not a location expense. Delete it from Accounts → Vouchers instead." });
    return;
  }
  // Outlet history is never destroyed while the module is retired — deleting an
  // outlet's expense voucher would silently rewrite an audited past period.
  if (row.outlet_id != null && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  await pool.query(`DELETE FROM payments WHERE id = $1`, [id]);
  logActivity({
    action: 'DELETE', module: 'accounts', entityType: 'location-expense', entityId: id,
    description: `Deleted location expense ${row.voucher_number} — ${row.expense_name ?? 'expense'} ₹${Number(row.amount)} at ${row.location_name}`,
    user: (req as any).employee?.username ?? 'system',
  }).catch(() => {});
  res.json({ ok: true, id });
});

// ── Financial Statements (Balance Sheet + P&L) ────────────────────────────
router.get("/accounts/financial-statements", requireModuleView(["page:/accounts/chart", "page:/reports/sales"]), async (req, res): Promise<void> => {
  // LBAC: P&L and Balance Sheet are Head Office accounting
  if ((req as any).employee?.branchType !== 'headoffice') { res.json({ pl: null, bs: null }); return; }
  const { fromDate, toDate, outletId } = req.query as {
    fromDate?: string; toDate?: string; outletId?: string;
  };

  // Load all ledgers
  const { rows: allLedgers } = await pool.query(`SELECT * FROM account_ledgers ORDER BY id`);

  // Build id→node map with children
  const ledgerMap = new Map<number, any>();
  for (const r of allLedgers) {
    ledgerMap.set(r.id, {
      id: r.id, name: r.name, type: r.type,
      parentId: r.parent_id ?? null, code: r.code ?? null,
      section: r.section ?? null, isSystemGroup: r.is_system_group ?? false,
      children: [], balance: 0,
    });
  }
  for (const r of allLedgers) {
    if (r.parent_id && ledgerMap.has(r.parent_id)) {
      ledgerMap.get(r.parent_id).children.push(ledgerMap.get(r.id));
    }
  }

  // Helpers to build parameterised date conditions
  const makeDateConds = (dateCol: string, params: any[]): string => {
    const conds: string[] = [];
    if (fromDate) { params.push(fromDate); conds.push(`${dateCol} >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conds.push(`${dateCol} <= $${params.length}`); }
    return conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  };

  // ── Ledger balance computation ──────────────────────────────────────────
  const balanceMap = new Map<number, number>();
  const add = (id: number, v: number) => balanceMap.set(id, (balanceMap.get(id) ?? 0) + v);

  // Expenses → debit to ledger_account_id
  const ep: any[] = [];
  const { rows: expRows } = await pool.query(
    `SELECT ledger_account_id, COALESCE(SUM(amount::numeric), 0) AS total
     FROM expenses ${makeDateConds('expense_date', ep)}
     GROUP BY ledger_account_id`, ep
  );
  for (const r of expRows) add(Number(r.ledger_account_id), Number(r.total));

  // Payments
  const pp: any[] = [];
  const { rows: pmtRows } = await pool.query(
    `SELECT paid_to_ledger_id, paid_from_ledger_id, amount::numeric AS amount
     FROM payments ${makeDateConds('payment_date', pp)}`, pp
  );
  for (const r of pmtRows) {
    const amt = Number(r.amount);
    add(Number(r.paid_to_ledger_id), amt);
    add(Number(r.paid_from_ledger_id), -amt);
  }

  // Receipts
  const rp: any[] = [];
  const { rows: recRows } = await pool.query(
    `SELECT received_in_ledger_id, received_from_ledger_id, amount::numeric AS amount
     FROM receipts ${makeDateConds('receipt_date', rp)}`, rp
  );
  for (const r of recRows) {
    const amt = Number(r.amount);
    add(Number(r.received_in_ledger_id), amt);
    add(Number(r.received_from_ledger_id), -amt);
  }

  // Journal vouchers — Indirect Expenses only.
  //
  // Payroll approval, and only payroll approval, records an expense as a
  // journal voucher rather than through the expenses/payments tables. Without
  // this the salary bill was completely absent from the P&L: the voucher was in
  // the trial balance but the statement never looked at journal lines, so
  // reported profit was overstated by every salary approved.
  //
  // Deliberately restricted to the Indirect Expense subtree. Direct Expenses
  // must NOT be included: production costing credits STD-PROD-ABS there to
  // relieve the cost it capitalises into stock, and this statement already
  // relieves that cost through closing stock on the income side. Reading both
  // would relieve it twice. Reconciling the direct-expense side belongs with
  // the wider financial-statement work, not here.
  const jp: any[] = [];
  const { rows: jvRows } = await pool.query(
    `WITH RECURSIVE indexp AS (
       SELECT id FROM account_ledgers WHERE code = 'SYS-INDEXP'
       UNION ALL
       SELECT a.id FROM account_ledgers a JOIN indexp ON a.parent_id = indexp.id
     )
     SELECT l.ledger_id,
            COALESCE(SUM(l.debit::numeric), 0) - COALESCE(SUM(l.credit::numeric), 0) AS net
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id IN (SELECT id FROM indexp)
       ${(() => { const c = makeDateConds('v.voucher_date', jp); return c ? c.replace(/^WHERE/, 'AND') : ''; })()}
     GROUP BY l.ledger_id`, jp
  );
  for (const r of jvRows) add(Number(r.ledger_id), Number(r.net));

  // Apply balances
  for (const [id, bal] of balanceMap) {
    const node = ledgerMap.get(id);
    if (node) node.balance = bal;
  }

  // ── STD-DTX (Duty & Tax) balance = GST collected on sales (date-filtered) ──
  // This is computed below after salesTaxTotal is known; placeholder set here
  // so the ledgerMap node exists when buildGroup walks the tree.

  // Recursively sum children (for group totals)
  const sumNode = (node: any): number => {
    const childSum = node.children.reduce((s: number, c: any) => s + sumNode(c), 0);
    return node.isSystemGroup ? childSum : node.balance + childSum;
  };

  const serializeNode = (node: any): any => ({
    id: node.id, name: node.name, type: node.type,
    parentId: node.parentId, code: node.code,
    isGroup: node.isGroup ?? false,
    isSystemGroup: node.isSystemGroup ?? false,
    balance: Math.round(node.balance * 100) / 100,
    children: node.children.map(serializeNode),
  });

  const buildGroup = (code: string) => {
    const r = allLedgers.find((l: any) => l.code === code);
    const node = r ? ledgerMap.get(r.id) : null;
    if (!node) return { id: null, name: code, code, total: 0, children: [] };
    return {
      id: node.id, name: node.name, code: node.code, type: node.type,
      total: Math.round(Math.abs(sumNode(node)) * 100) / 100,
      children: node.children.map(serializeNode),
    };
  };

  // ── Auto-computed amounts ───────────────────────────────────────────────
  // Sales total + tax collected (filtered by outlet if provided)
  const sp: any[] = [];
  // Branch-transfer invoices are excluded from BOTH the sales and purchases
  // totals here. They are tax documents for moving own stock: including them
  // would inflate turnover and cost of goods by the same amount, so the P&L
  // must not see them at all. Their value posts to the inter-branch clearing
  // ledger in the balance sheet instead (see buildDerivedPostings).
  const salesConds: string[] = ['branch_transfer_id IS NULL'];
  if (fromDate) { sp.push(fromDate); salesConds.push(`sale_date >= $${sp.length}`); }
  if (toDate)   { sp.push(toDate);   salesConds.push(`sale_date <= $${sp.length}`); }
  if (outletId) { sp.push(Number(outletId)); salesConds.push(`outlet_id = $${sp.length}`); }
  const salesWhere = salesConds.length ? `WHERE ${salesConds.join(' AND ')}` : '';
  const { rows: salesRows } = await pool.query(
    `SELECT COALESCE(SUM(total_amount::numeric), 0) AS total,
            COALESCE(SUM(tax_total::numeric), 0) AS tax_total
     FROM sales ${salesWhere}`, sp
  );
  const salesTotal    = Number(salesRows[0]?.total     ?? 0);
  const salesTaxTotal = Number(salesRows[0]?.tax_total ?? 0); // → Duty & Tax (Current Liab)

  // ── Set STD-DTX balance from sales tax so it appears in COA tree ──────────
  const dtxLedgerRow = allLedgers.find((l: any) => l.code === 'STD-DTX');
  if (dtxLedgerRow) {
    const dtxNode = ledgerMap.get(dtxLedgerRow.id);
    if (dtxNode) dtxNode.balance = salesTaxTotal;
  }

  // Purchases total
  const pup: any[] = [];
  const { rows: purRows } = await pool.query(
    `SELECT COALESCE(SUM(total_amount::numeric), 0) AS total FROM purchases
      ${makeDateConds('purchase_date', pup) || 'WHERE TRUE'} AND branch_transfer_id IS NULL`, pup
  );
  const purchasesTotal = Number(purRows[0]?.total ?? 0);

  // Closing stock, via the one shared valuation function.
  // Previously this read `items.production_stock` — a counter that sales never
  // decremented, so it reported ~76 units against a real ~3,389 — and valued it
  // at MRP, which capitalises unrealised profit into inventory. Both are fixed
  // by deriving quantity from the stock truth and valuing at cost.
  //
  // It now covers raw materials and packing materials as well as finished goods,
  // and counts stock dispatched but not yet received (owned by the sender until
  // it lands). Closing stock is everything the business owns on the last day:
  // leaving materials out understated it by the entire material holding, and
  // leaving in-transit out made profit dip for the length of every transfer.
  // `inTransit` is reported separately so the drill-down reconciles to the total.
  const valuation = await closingStockValuation(pool);
  const stockItems = valuation.items.map((i) => ({
    id: i.id, name: i.name, unit: i.unit,
    stock: i.stock, unitCost: i.unitCost, total: i.total,
    materialType: i.materialType, typeLabel: i.typeLabel,
  }));
  const closingStock = valuation.total;
  const closingStockInTransit = valuation.inTransit;
  // Intentionally zero: the business has not gone live, so there is no
  // historical stock to carry in. Not a defect.
  const openingStock = 0;

  // ── P&L ────────────────────────────────────────────────────────────────
  const directExp   = buildGroup('SYS-DIREXP');
  const indirectExp = buildGroup('SYS-INDEXP');
  const directInc   = buildGroup('SYS-DIRINC');
  const indirectInc = buildGroup('SYS-INDINC');

  const totalExpenses = openingStock + purchasesTotal + directExp.total + indirectExp.total;
  const totalIncomes  = salesTotal + closingStock + directInc.total + indirectInc.total;
  const netProfit     = totalIncomes - totalExpenses;

  // ── Balance Sheet ───────────────────────────────────────────────────────
  const capitalGroup = buildGroup('SYS-CAP');
  const loansGroup   = buildGroup('SYS-LOAN');
  const curlBase     = buildGroup('SYS-CURL');
  const fixedGroup   = buildGroup('SYS-FIXD');
  const curaGroup    = buildGroup('SYS-CURA');

  // Current Liabilities — STD-DTX balance already set from salesTaxTotal above;
  // curlBase.total now includes it automatically via buildGroup → sumNode.
  const dutyAndTax = Math.round(salesTaxTotal * 100) / 100;
  const curlGroup  = { ...curlBase, dutyAndTax }; // total already correct

  const pandlFwd    = Math.round(netProfit * 100) / 100;
  const assetsTotal = fixedGroup.total + curaGroup.total;
  const liabBase    = capitalGroup.total + loansGroup.total + curlGroup.total;
  const liabTotal   = liabBase + (pandlFwd > 0 ? pandlFwd : 0);
  const difference  = Math.round((assetsTotal - liabTotal - (pandlFwd < 0 ? Math.abs(pandlFwd) : 0)) * 100) / 100;

  // Filters
  const { rows: warehouses } = await pool.query(`SELECT id, name FROM warehouses ORDER BY id`);
  const { rows: outlets }    = await pool.query(`SELECT id, name FROM outlets ORDER BY id`);

  res.json({
    filters: { warehouses, outlets },
    profitAndLoss: {
      expenses: {
        // Opening stock is zero, so it carries no item breakdown. Sending the
        // closing-stock list here made the statement look like it opened with
        // the stock it actually closed with.
        openingStock, openingStockItems: [],
        purchases: purchasesTotal,
        directExpenses: directExp, indirectExpenses: indirectExp,
        total: Math.round(totalExpenses * 100) / 100,
      },
      incomes: {
        sales: salesTotal,
        closingStock: Math.round(closingStock * 100) / 100,
        closingStockItems: stockItems,
        // Part of closingStock above, broken out so a reader can see how much of
        // the closing figure is still on a lorry rather than on a shelf.
        closingStockInTransit: Math.round(closingStockInTransit * 100) / 100,
        directIncomes: directInc, indirectIncomes: indirectInc,
        total: Math.round(totalIncomes * 100) / 100,
      },
      netProfit: Math.round(netProfit * 100) / 100,
    },
    balanceSheet: {
      liabilities: {
        capitalAccount: capitalGroup, loans: loansGroup, currentLiabilities: curlGroup,
        pandlCarryForward: pandlFwd,
        difference: Math.abs(difference) > 0.01 ? difference : 0,
        total: Math.round((liabTotal + (pandlFwd < 0 ? Math.abs(pandlFwd) : 0) + (difference > 0 ? difference : 0)) * 100) / 100,
      },
      assets: {
        fixedAssets: fixedGroup, currentAssets: curaGroup,
        total: Math.round(assetsTotal * 100) / 100,
      },
    },
  });
});

// ── Ledger Statement ──────────────────────────────────────────────────────
// LBAC: branch users get their own movements on the requested ledger; the
// expenses table and journal-family vouchers stay Head Office (no location).
router.get("/accounts/ledger/:id/statement", requireModuleView("page:/accounts/ledger"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid ledger id" }); return; }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, type, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }

  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  if (!scope.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(scope);
    if (foreign.includes(id)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }
  /** Money-voucher scope fragment for this caller, appended to `params`. */
  const moneyScope = (params: any[], alias: 'p' | 'r'): string => {
    const legs: [string, string] = alias === 'p'
      ? ['paid_from_ledger_id', 'paid_to_ledger_id']
      : ['received_in_ledger_id', 'received_from_ledger_id'];
    return ` AND ${scopeMoneyWhere(scope, ledgerIds, params, alias, legs)}`;
  };

  // Build date-range helpers
  const dateClause = (col: string, params: any[]) => {
    const conds: string[] = [];
    if (fromDate) { params.push(fromDate); conds.push(`${col} >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conds.push(`${col} <= $${params.length}`); }
    return conds.length ? ` AND ${conds.join(' AND ')}` : '';
  };

  // Payments where this ledger is the source (credit — money leaves)
  const pFromParams: any[] = [id];
  const { rows: payFromRows } = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.voucher_number, p.narration,
            pt.name AS other_name
     FROM payments p
     LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
     WHERE p.paid_from_ledger_id = $1${dateClause('p.payment_date', pFromParams)}${moneyScope(pFromParams, 'p')}
     ORDER BY p.payment_date, p.id`, pFromParams
  );

  // Payments where this ledger is the destination (debit — money arrives)
  const pToParams: any[] = [id];
  const { rows: payToRows } = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.voucher_number, p.narration,
            pf.name AS other_name
     FROM payments p
     LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
     WHERE p.paid_to_ledger_id = $1${dateClause('p.payment_date', pToParams)}${moneyScope(pToParams, 'p')}
     ORDER BY p.payment_date, p.id`, pToParams
  );

  // Receipts where this ledger is the source (credit)
  const rFromParams: any[] = [id];
  const { rows: recFromRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            ri.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers ri ON ri.id = r.received_in_ledger_id
     WHERE r.received_from_ledger_id = $1${dateClause('r.receipt_date', rFromParams)}${moneyScope(rFromParams, 'r')}
     ORDER BY r.receipt_date, r.id`, rFromParams
  ).catch(() => ({ rows: [] }));

  // Receipts where this ledger is the destination (debit)
  const rToParams: any[] = [id];
  const { rows: recToRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            rf.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers rf ON rf.id = r.received_from_ledger_id
     WHERE r.received_in_ledger_id = $1${dateClause('r.receipt_date', rToParams)}${moneyScope(rToParams, 'r')}
     ORDER BY r.receipt_date, r.id`, rToParams
  ).catch(() => ({ rows: [] }));

  // Expenses charged to this ledger (debit) — Head Office table only
  const expParams: any[] = [id];
  const { rows: expRows } = scope.isHeadOffice ? await pool.query(
    `SELECT e.id, e.expense_date AS date, e.amount, e.description, e.category
     FROM expenses e
     WHERE e.ledger_account_id = $1${dateClause('e.expense_date', expParams)}
     ORDER BY e.expense_date, e.id`, expParams
  ).catch(() => ({ rows: [] })) : { rows: [] as any[] };

  // Journal-family voucher lines touching this ledger — no location dimension,
  // so branch users don't see them (they never create them either).
  const jvParams: any[] = [id];
  const { rows: jvRows } = scope.isHeadOffice ? await pool.query(
    `SELECT l.id, v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1${dateClause('v.voucher_date', jvParams)}
     ORDER BY v.voucher_date, l.id`, jvParams
  ).catch(() => ({ rows: [] })) : { rows: [] as any[] };

  // Merge all entries
  const combined: { sortKey: string; date: string; description: string; reference: string; entryType: string; debit: number; credit: number }[] = [];

  for (const r of payFromRows) combined.push({
    sortKey: `${r.date}P-${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Payment to ${r.other_name}`,
    entryType: 'payment', debit: 0, credit: Number(r.amount),
  });
  for (const r of payToRows) combined.push({
    sortKey: `${r.date}P+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Payment from ${r.other_name}`,
    entryType: 'payment', debit: Number(r.amount), credit: 0,
  });
  for (const r of recFromRows) combined.push({
    sortKey: `${r.date}R-${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Receipt to ${r.other_name}`,
    entryType: 'receipt', debit: 0, credit: Number(r.amount),
  });
  for (const r of recToRows) combined.push({
    sortKey: `${r.date}R+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Receipt from ${r.other_name}`,
    entryType: 'receipt', debit: Number(r.amount), credit: 0,
  });
  for (const r of expRows) combined.push({
    sortKey: `${r.date}E+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: `EXP-${r.id}`,
    description: r.description || r.category || 'Expense',
    entryType: 'expense', debit: Number(r.amount), credit: 0,
  });
  for (const r of jvRows) combined.push({
    sortKey: `${r.date}J+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || (r.voucher_type === 'contra' ? 'Contra entry'
      : r.voucher_type === 'credit_note' ? 'Credit note'
      : r.voucher_type === 'debit_note' ? 'Debit note' : 'Journal entry'),
    entryType: r.voucher_type, debit: Number(r.debit), credit: Number(r.credit),
  });

  combined.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let balance = 0;
  const entries = combined.map(({ sortKey: _sk, ...e }) => {
    balance += e.debit - e.credit;
    return { ...e, balance };
  });

  const totalDebit  = entries.reduce((s, e) => s + e.debit,  0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);

  res.json({
    ledger: { id: ledger.id, name: ledger.name, type: ledger.type, code: ledger.code },
    entries, totalDebit, totalCredit, closingBalance: balance,
  });
});

// ── GST Summary ───────────────────────────────────────────────────────────
router.get("/gst/summary", requireModuleView(["page:/accounts/gst", "page:/accounts/gst-returns"]), async (req, res): Promise<void> => {
  // LBAC: GST summary is Head Office accounting
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ salesByRate: [], purchasesByRate: [], totals: {} }); return;
  }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  let allSales = await db.select().from(salesTable).orderBy(salesTable.saleDate);
  if (fromDate) allSales = allSales.filter(s => s.saleDate >= fromDate);
  if (toDate) allSales = allSales.filter(s => s.saleDate <= toDate);

  let allPurchases = await db.select().from(purchasesTable).orderBy(purchasesTable.purchaseDate);
  if (fromDate) allPurchases = allPurchases.filter(p => p.purchaseDate >= fromDate);
  if (toDate) allPurchases = allPurchases.filter(p => p.purchaseDate <= toDate);

  // Document-level tax: prefer the stored total when present, else the
  // per-line head sum via lineTaxHeads (legacy purchases have tax_total = 0).
  const docTax = (lines: any[], stored: number): number => {
    if (stored > 0.004) return stored;
    const headSum = lines.reduce((a, li) => { const h = lineTaxHeads(li); return a + h.cgst + h.sgst + h.igst; }, 0);
    return Math.round(headSum * 100) / 100;
  };

  const salesByRate = new Map<number, { taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }>();
  for (const sale of allSales) {
    const lineItems = (sale.lineItems ?? []) as any[];
    for (const li of lineItems) {
      const rate = Number(li.taxRate ?? 0);
      const sub = Number(li.lineSubtotal ?? (li.quantity * li.unitPrice - (li.discount ?? 0)));
      const existing = salesByRate.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      existing.taxableValue += sub;
      existing.cgst += h.cgst;
      existing.sgst += h.sgst;
      existing.igst += h.igst;
      existing.taxAmount += Number(li.taxAmount ?? 0);
      salesByRate.set(rate, existing);
    }
  }

  // Aggregate input tax from purchases using actual gstRate per line
  const purchasesByRate = new Map<number, { taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }>();
  for (const p of allPurchases) {
    const lineItems = (p.lineItems ?? []) as any[];
    for (const li of lineItems) {
      const rate = Number(li.gstRate ?? 0);
      const existing = purchasesByRate.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      existing.taxableValue += Number(li.taxableValue ?? 0);
      existing.cgst += h.cgst;
      existing.sgst += h.sgst;
      existing.igst += h.igst;
      existing.taxAmount += Number(li.taxAmount ?? 0);
      purchasesByRate.set(rate, existing);
    }
  }

  const totalSales = allSales.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxCollected = allSales.reduce((s, r) => s + docTax((r.lineItems ?? []) as any[], Number(r.taxTotal ?? 0)), 0);
  const totalPurchases = allPurchases.reduce((s, p) => s + Number(p.totalAmount), 0);
  const totalTaxPaid = allPurchases.reduce((s, p) => s + docTax((p.lineItems ?? []) as any[], Number((p as any).taxTotal ?? 0)), 0);
  const netGstLiability = totalTaxCollected - totalTaxPaid;

  // Month-wise breakdown (output vs input tax per calendar month)
  const monthMap = new Map<string, { outputTaxable: number; outputTax: number; inputTaxable: number; inputTax: number }>();
  for (const s of allSales) {
    const k = String((s as any).saleDate).slice(0, 7);
    const e = monthMap.get(k) ?? { outputTaxable: 0, outputTax: 0, inputTaxable: 0, inputTax: 0 };
    const tax = docTax((s.lineItems ?? []) as any[], Number((s as any).taxTotal ?? 0));
    e.outputTax += tax;
    e.outputTaxable += Number(s.totalAmount) - tax;
    monthMap.set(k, e);
  }
  for (const p of allPurchases) {
    const k = String((p as any).purchaseDate).slice(0, 7);
    const e = monthMap.get(k) ?? { outputTaxable: 0, outputTax: 0, inputTaxable: 0, inputTax: 0 };
    const tax = docTax((p.lineItems ?? []) as any[], Number((p as any).taxTotal ?? 0));
    e.inputTax += tax;
    e.inputTaxable += Number(p.totalAmount) - tax;
    monthMap.set(k, e);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const monthWise = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      outputTaxable: r2(d.outputTaxable), outputTax: r2(d.outputTax),
      inputTaxable: r2(d.inputTaxable), inputTax: r2(d.inputTax),
      netGst: r2(d.outputTax - d.inputTax),
    }));

  const warehouses = await db.select().from(warehousesTable);

  res.json({
    totalSales, totalTaxCollected, totalPurchases, totalTaxPaid, netGstLiability, monthWise,
    salesByRate: Array.from(salesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d })),
    purchasesByRate: Array.from(purchasesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d, estimated: false })),
    byWarehouse: warehouses.map(w => ({ warehouseId: w.id, warehouseName: w.name, gstNumber: w.gstNumber, salesTax: 0, purchaseTax: 0 })),
  });
});

// ── Opening Balances ───────────────────────────────────────────────────────
// Opening balances allow the COA to reflect historical account positions so
// the Trial Balance, P&L and Balance Sheet are accurate from day one.

router.get("/accounts/opening-balances", requireModuleView("page:/accounts/chart"), async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT ob.id, ob.ledger_id, ob.balance::float AS balance, ob.balance_type,
           ob.as_of_date, ob.financial_year, ob.notes, ob.created_by, ob.created_at, ob.updated_at,
           al.name AS ledger_name, al.code AS ledger_code, al.type AS ledger_type
    FROM opening_balances ob
    JOIN account_ledgers al ON al.id = ob.ledger_id
    ORDER BY ob.as_of_date DESC, al.name
  `);
  res.json(rows.map((r: any) => ({
    id: r.id,
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    ledgerCode: r.ledger_code,
    ledgerType: r.ledger_type,
    balance: Number(r.balance),
    balanceType: r.balance_type,
    asOfDate: r.as_of_date instanceof Date ? r.as_of_date.toISOString().slice(0, 10) : String(r.as_of_date).slice(0, 10),
    financialYear: r.financial_year,
    notes: r.notes ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  })));
});

router.post("/accounts/opening-balances", requireModuleAction("page:/accounts/chart", "add"), async (req, res): Promise<void> => {
  const body = req.body as any;
  const ledgerId = Number(body.ledgerId);
  const balance = Number(body.balance);
  const balanceType = String(body.balanceType ?? "debit");
  const asOfDate = String(body.asOfDate ?? "").slice(0, 10);
  const financialYear = String(body.financialYear ?? "").trim();
  const notes = body.notes ? String(body.notes).trim() || null : null;

  if (!Number.isFinite(ledgerId) || ledgerId <= 0) {
    res.status(400).json({ error: "ledgerId is required" }); return;
  }
  if (!Number.isFinite(balance) || balance < 0) {
    res.status(400).json({ error: "balance must be a non-negative number" }); return;
  }
  if (!["debit", "credit"].includes(balanceType)) {
    res.status(400).json({ error: "balanceType must be 'debit' or 'credit'" }); return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    res.status(400).json({ error: "asOfDate (YYYY-MM-DD) is required" }); return;
  }

  // Verify ledger exists and is postable (not a group)
  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, is_group, is_system_group FROM account_ledgers WHERE id = $1`, [ledgerId]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }
  if (ledger.is_group || ledger.is_system_group) {
    res.status(400).json({ error: `"${ledger.name}" is a group ledger — post opening balances to specific ledgers under it` }); return;
  }

  // Upsert: one opening balance record per ledger per financial year
  const { rows: [row] } = await pool.query(`
    INSERT INTO opening_balances (ledger_id, balance, balance_type, as_of_date, financial_year, notes, created_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (ledger_id, financial_year)
    DO UPDATE SET balance = EXCLUDED.balance, balance_type = EXCLUDED.balance_type,
                  as_of_date = EXCLUDED.as_of_date, notes = EXCLUDED.notes,
                  updated_at = NOW()
    RETURNING *
  `, [ledgerId, balance.toFixed(2), balanceType, asOfDate, financialYear,
      notes, req.employee?.username ?? "system"]);

  logActivity({
    action: "CREATE", module: "accounts", entityType: "opening_balance", entityId: row.id,
    description: `Opening balance set for ${ledger.name} — ₹${balance.toFixed(2)} ${balanceType}`,
    metadata: { after: { ledgerId, balance, balanceType, asOfDate, financialYear } },
  }).catch(() => {});

  res.status(201).json({ id: row.id, ledgerId, balance, balanceType, asOfDate, financialYear, notes });
});

router.delete("/accounts/opening-balances/:id", requireModuleAction("page:/accounts/chart", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [deleted] } = await pool.query(
    `DELETE FROM opening_balances WHERE id = $1 RETURNING ledger_id`, [id]
  );
  if (!deleted) { res.status(404).json({ error: "Opening balance not found" }); return; }
  logActivity({
    action: "DELETE", module: "accounts", entityType: "opening_balance", entityId: id,
    description: `Opening balance deleted for ledger ${deleted.ledger_id}`,
  }).catch(() => {});
  res.status(204).send();
});

export default router;


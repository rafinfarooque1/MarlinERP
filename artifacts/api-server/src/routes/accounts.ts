import { Router } from "express";
import { db, pool, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams,
} from "@workspace/api-zod";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS } from "../lib/voucherNumber";
import { lineTaxHeads } from "../lib/gst";

const router = Router();

// ── Chart of Accounts (tree) ───────────────────────────────────────────────
router.get("/accounts/chart", async (_req, res): Promise<void> => {
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
router.get("/accounts/chart/flat", async (_req, res): Promise<void> => {
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
router.get("/accounts/cash-bank-ledgers", async (_req, res): Promise<void> => {
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
  res.json(rows.filter((r: any) => ids.has(r.id)).map((r: any) => ({
    id: r.id, name: r.name, type: r.type,
    parentId: r.parent_id ?? null, code: r.code ?? null,
    bankDetails: r.bank_details ?? null,
  })));
});

router.post("/accounts/chart", async (req, res): Promise<void> => {
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

router.patch("/accounts/chart/:id", async (req, res): Promise<void> => {
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
router.patch("/accounts/chart/:id/move", async (req, res): Promise<void> => {
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

router.delete("/accounts/chart/:id", async (req, res): Promise<void> => {
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
router.get("/accounts/payments", async (_req, res): Promise<void> => {
  const result = await pool.query(`
    SELECT p.*, 
      pf.name AS paid_from_name,
      pt.name AS paid_to_name
    FROM payments p
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    ORDER BY p.id DESC
  `);
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
    createdAt: r.created_at,
  })));
});

router.post("/accounts/payments", async (req, res): Promise<void> => {
  const { paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration } = req.body as {
    paymentDate: string; paidFromLedgerId: number; paidToLedgerId: number; amount: number; narration?: string;
  };
  if (!paymentDate || !paidFromLedgerId || !paidToLedgerId || !amount) {
    res.status(400).json({ error: "paymentDate, paidFromLedgerId, paidToLedgerId and amount are required" }); return;
  }
  const voucherNumber = await nextVoucherNumber(pool, 'payment', paymentDate);
  const result = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [voucherNumber, paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration ?? null]
  );
  const r = result.rows[0];
  const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidFromLedgerId))).limit(1);
  const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidToLedgerId))).limit(1);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
    paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
    paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
    amount: Number(r.amount), narration: r.narration, createdAt: r.created_at,
  });
});

router.delete("/accounts/payments/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM payments WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Receipts ──────────────────────────────────────────────────────────────
router.get("/accounts/receipts", async (_req, res): Promise<void> => {
  const result = await pool.query(`
    SELECT r.*,
      rf.name AS received_from_name,
      ri.name AS received_in_name
    FROM receipts r
    LEFT JOIN account_ledgers rf ON r.received_from_ledger_id = rf.id
    LEFT JOIN account_ledgers ri ON r.received_in_ledger_id = ri.id
    ORDER BY r.id DESC
  `);
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
    createdAt: r.created_at,
  })));
});

router.post("/accounts/receipts", async (req, res): Promise<void> => {
  const { receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration } = req.body as {
    receiptDate: string; receivedFromLedgerId: number; receivedInLedgerId: number; amount: number; narration?: string;
  };
  if (!receiptDate || !receivedFromLedgerId || !receivedInLedgerId || !amount) {
    res.status(400).json({ error: "receiptDate, receivedFromLedgerId, receivedInLedgerId and amount are required" }); return;
  }
  const voucherNumber = await nextVoucherNumber(pool, 'receipt', receiptDate);
  const result = await pool.query(
    `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [voucherNumber, receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration ?? null]
  );
  const r = result.rows[0];
  const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedFromLedgerId))).limit(1);
  const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedInLedgerId))).limit(1);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
    receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
    receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
    amount: Number(r.amount), narration: r.narration, createdAt: r.created_at,
  });
});

router.delete("/accounts/receipts/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM receipts WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Ledger Statement ──────────────────────────────────────────────────────
router.get("/accounts/ledger-statement", async (req, res): Promise<void> => {
  const qp = GetLedgerStatementQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }

  const accountId = Number(qp.data.accountId);
  const fromDate = qp.data.fromDate as string | undefined;
  const toDate = qp.data.toDate as string | undefined;

  const [account] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, accountId)).limit(1);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const entries: any[] = [];

  // Payments where this account is involved
  const pmtRes = await pool.query(`SELECT * FROM payments WHERE paid_from_ledger_id = $1 OR paid_to_ledger_id = $1`, [accountId]);
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
  const recRes = await pool.query(`SELECT * FROM receipts WHERE received_from_ledger_id = $1 OR received_in_ledger_id = $1`, [accountId]);
  for (const r of recRes.rows) {
    entries.push({
      date: r.receipt_date,
      description: r.narration || `Receipt ${r.voucher_number}`,
      debit: r.received_in_ledger_id == accountId ? Number(r.amount) : 0,
      credit: r.received_from_ledger_id == accountId ? Number(r.amount) : 0,
      entryType: 'receipt',
    });
  }

  // Expenses tagged to this account
  const exps = await db.select().from(expensesTable).where(eq(expensesTable.ledgerAccountId, accountId));
  entries.push(...exps.map(e => ({
    date: e.expenseDate, description: e.description ?? "Expense",
    debit: Number(e.amount), credit: 0, entryType: 'expense',
  })));

  // Income accounts: include sales
  if (account.type === 'income') {
    const allSales = await db.select().from(salesTable);
    entries.push(...allSales.map(s => ({
      date: s.saleDate,
      description: `Sales Invoice ${s.invoiceNumber || '#' + s.id}`,
      debit: 0, credit: Number(s.totalAmount), entryType: 'sale',
    })));
  }

  // Duty & Tax ledger (STD-DTX): show GST collected on each sale as a credit
  const accountCode = (account as any).code ?? null;
  if (accountCode === 'STD-DTX') {
    const allSales = await db.select().from(salesTable);
    for (const s of allSales) {
      const tax = Number(s.taxTotal ?? 0);
      if (tax > 0) {
        entries.push({
          date: s.saleDate,
          description: `GST on ${s.invoiceNumber || 'Sale #' + s.id}`,
          debit: 0, credit: tax, entryType: 'sale_gst',
        });
      }
    }
  }

  // Purchase-type expense accounts: include purchases
  if (account.type === 'expense' && account.name.toLowerCase().includes('purchase')) {
    const allPurchases = await db.select().from(purchasesTable);
    entries.push(...allPurchases.map(p => ({
      date: p.purchaseDate,
      description: `Purchase Bill ${p.invoiceNumber || '#' + p.id}`,
      debit: Number(p.totalAmount), credit: 0, entryType: 'purchase',
    })));
  }

  // Journal-family voucher lines touching this ledger (journal/contra/CN/DN)
  const { rows: jvLines } = await pool.query(
    `SELECT v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1`, [accountId]
  ).catch(() => ({ rows: [] as any[] }));
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
router.get("/accounts/cash-bank", async (_req, res): Promise<void> => {
  const rows = await db.select().from(cashBankAccountsTable).orderBy(cashBankAccountsTable.id);
  res.json(rows.map(r => ({ ...r, balance: Number(r.balance) })));
});

router.post("/accounts/cash-bank", async (req, res): Promise<void> => {
  const parsed = CreateCashBankAccountBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { openingBalance, ...rest } = parsed.data as typeof parsed.data & { openingBalance?: number };
  const [row] = await db.insert(cashBankAccountsTable).values({ ...rest, balance: String(openingBalance ?? 0) }).returning();
  res.status(201).json({ ...row, balance: Number(row.balance) });
});

// ── Expenses (merged: expenses table + location expense payments) ──────────
router.get("/expenses", async (_req, res): Promise<void> => {
  // 1. Regular expenses from the expenses table
  const rows = await db.select().from(expensesTable).orderBy(expensesTable.id);
  const ledgers = await db.select().from(accountLedgersTable);
  const cashBanks = await db.select().from(cashBankAccountsTable);
  const lMap = new Map(ledgers.map(l => [l.id, l.name]));
  const cbMap = new Map(cashBanks.map(cb => [cb.id, cb.name]));

  const directExpenses = rows.map(r => ({
    id: r.id,
    source: 'direct' as const,
    expenseDate: r.expenseDate,
    description: r.description ?? null,
    ledgerAccountId: r.ledgerAccountId,
    ledgerAccountName: lMap.get(r.ledgerAccountId) ?? "",
    paymentAccountId: r.paymentAccountId,
    paymentAccountName: cbMap.get(r.paymentAccountId) ?? "",
    amount: Number(r.amount),
    voucherNumber: null as string | null,
    createdAt: r.createdAt,
  }));

  // 2. Location expenses: payments where paid_to is in Direct/Indirect Expense subtree
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  let locationExpenses: Array<{
    id: number; source: 'direct' | 'location'; expenseDate: any;
    description: string | null; ledgerAccountId: number; ledgerAccountName: string;
    paymentAccountId: number; paymentAccountName: string; amount: number;
    voucherNumber: string | null; createdAt: any;
  }> = [];
  if (expenseLedgerIds.length > 0) {
    const { rows: pmtRows } = await pool.query(`
      SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id,
             p.paid_to_ledger_id, p.amount, p.narration, p.created_at,
             pf.name AS paid_from_name, pt.name AS paid_to_name
      FROM payments p
      LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
      LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
      WHERE p.paid_to_ledger_id = ANY($1)
      ORDER BY p.id DESC
    `, [expenseLedgerIds]);

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
    }));
  }

  // Merge and sort by expenseDate descending (most recent first)
  const all = [...directExpenses, ...locationExpenses].sort(
    (a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate))
  );
  res.json(all);
});

router.post("/expenses", async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(expensesTable).values({ ...parsed.data, amount: String(parsed.data.amount) }).returning();
  await db.execute(sql`UPDATE cash_bank_accounts SET balance = balance::numeric - ${parsed.data.amount} WHERE id = ${parsed.data.paymentAccountId}`);
  const [ledger] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, row.ledgerAccountId)).limit(1);
  const [cashBank] = await db.select().from(cashBankAccountsTable).where(eq(cashBankAccountsTable.id, row.paymentAccountId)).limit(1);
  res.status(201).json({ ...row, ledgerAccountName: ledger?.name ?? "", paymentAccountName: cashBank?.name ?? "", amount: Number(row.amount) });
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
router.get("/accounts/expense-ledgers", async (_req, res): Promise<void> => {
  const ids = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (ids.length === 0) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT id, name, type, code, parent_id FROM account_ledgers WHERE id = ANY($1) ORDER BY name`,
    [ids]
  );
  res.json(rows.map((r: any) => ({ id: r.id, name: r.name, type: r.type, code: r.code ?? null, parentId: r.parent_id ?? null })));
});

// Summary: all locations with expense count + total, for the "By Location" overview tab
router.get("/accounts/location-expenses/summary", async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);

  // Fetch all warehouses and outlets with their cash ledger ids
  const { rows: warehouses } = await pool.query(
    `SELECT id, name, cash_ledger_id FROM warehouses WHERE cash_ledger_id IS NOT NULL ORDER BY name`
  );
  const { rows: outlets } = await pool.query(
    `SELECT id, name, cash_ledger_id FROM outlets WHERE cash_ledger_id IS NOT NULL ORDER BY name`
  );

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
router.get("/accounts/location-expenses/all", async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (expenseLedgerIds.length === 0) { res.json([]); return; }

  // Join warehouses and outlets on their cash ledger to tag each payment with location info
  const { rows } = await pool.query(`
    SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id, p.paid_to_ledger_id,
           p.amount, p.narration, p.created_at,
           pt.name AS expense_ledger_name,
           COALESCE(w.name, o.name)         AS location_name,
           CASE WHEN w.id IS NOT NULL THEN 'warehouse' ELSE 'outlet' END AS location_type,
           COALESCE(w.id, o.id)             AS location_id
    FROM payments p
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
    LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
    WHERE p.paid_to_ledger_id = ANY($1)
      AND (w.id IS NOT NULL OR o.id IS NOT NULL)
    ORDER BY p.payment_date DESC, p.id DESC
  `, [expenseLedgerIds]);

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
  })));
});

router.get("/accounts/location-expenses", async (req, res): Promise<void> => {
  const { locationType, locationId } = req.query as { locationType?: string; locationId?: string };
  if (!locationType || !locationId) {
    res.status(400).json({ error: "locationType and locationId are required" }); return;
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
    })),
  });
});

// Create a location-scoped expense (Dr expenseLedger, Cr location cashLedger via payments)
router.post("/accounts/location-expenses", async (req, res): Promise<void> => {
  const { locationType, locationId, expenseLedgerId, amount, expenseDate, description, reference } = req.body as {
    locationType: string; locationId: number; expenseLedgerId: number;
    amount: number; expenseDate: string; description: string; reference?: string;
  };
  if (!locationType || !locationId || !expenseLedgerId || !amount || !expenseDate || !description) {
    res.status(400).json({ error: "locationType, locationId, expenseLedgerId, amount, expenseDate and description are required" }); return;
  }
  // Server-side validation: expenseLedgerId must be within Direct/Indirect Expense subtree
  const allowedExpenseIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (!allowedExpenseIds.includes(Number(expenseLedgerId))) {
    res.status(400).json({ error: "expenseLedgerId must be a Direct or Indirect Expense ledger account." }); return;
  }
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  if (!cashLedgerId) {
    res.status(400).json({ error: "This location has no Cash ledger. Provision ledgers under Accounts → Warehouses/Outlets first." }); return;
  }
  const narration = reference ? `${description} [Ref: ${reference}]` : description;
  const voucherNumber = await nextVoucherNumber(pool, 'payment', expenseDate);
  const { rows: [r] } = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [voucherNumber, expenseDate, cashLedgerId, Number(expenseLedgerId), Number(amount), narration]
  );
  const { rows: [pf] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [cashLedgerId]);
  const { rows: [pt] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [expenseLedgerId]);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, expenseDate: r.payment_date,
    expenseLedgerId: r.paid_to_ledger_id, expenseLedgerName: pt?.name ?? '',
    cashLedgerId: r.paid_from_ledger_id, cashLedgerName: pf?.name ?? '',
    amount: Number(r.amount), description: r.narration, createdAt: r.created_at,
  });
});

// ── Financial Statements (Balance Sheet + P&L) ────────────────────────────
router.get("/accounts/financial-statements", async (req, res): Promise<void> => {
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
  const salesConds: string[] = [];
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
    `SELECT COALESCE(SUM(total_amount::numeric), 0) AS total FROM purchases ${makeDateConds('purchase_date', pup)}`, pup
  );
  const purchasesTotal = Number(purRows[0]?.total ?? 0);

  // Item-wise stock (closing = current finished goods; opening = 0 without historical records)
  const { rows: stockRows } = await pool.query(
    `SELECT id, name, unit, production_stock::float AS stock, mrp::float
     FROM items WHERE production_stock > 0 ORDER BY name`
  );
  const stockItems = stockRows.map((r: any) => ({
    id: Number(r.id), name: r.name, unit: r.unit || 'unit',
    stock: Number(r.stock), mrp: Number(r.mrp),
    total: Math.round(Number(r.stock) * Number(r.mrp) * 100) / 100,
  }));
  const closingStock = stockItems.reduce((s: number, i: any) => s + i.total, 0);
  const openingStock = 0; // set to 0 until opening-balance journal entry is supported

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
        openingStock, openingStockItems: stockItems,
        purchases: purchasesTotal,
        directExpenses: directExp, indirectExpenses: indirectExp,
        total: Math.round(totalExpenses * 100) / 100,
      },
      incomes: {
        sales: salesTotal,
        closingStock: Math.round(closingStock * 100) / 100,
        closingStockItems: stockItems,
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
router.get("/accounts/ledger/:id/statement", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, type, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }

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
     WHERE p.paid_from_ledger_id = $1${dateClause('p.payment_date', pFromParams)}
     ORDER BY p.payment_date, p.id`, pFromParams
  );

  // Payments where this ledger is the destination (debit — money arrives)
  const pToParams: any[] = [id];
  const { rows: payToRows } = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.voucher_number, p.narration,
            pf.name AS other_name
     FROM payments p
     LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
     WHERE p.paid_to_ledger_id = $1${dateClause('p.payment_date', pToParams)}
     ORDER BY p.payment_date, p.id`, pToParams
  );

  // Receipts where this ledger is the source (credit)
  const rFromParams: any[] = [id];
  const { rows: recFromRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            ri.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers ri ON ri.id = r.received_in_ledger_id
     WHERE r.received_from_ledger_id = $1${dateClause('r.receipt_date', rFromParams)}
     ORDER BY r.receipt_date, r.id`, rFromParams
  ).catch(() => ({ rows: [] }));

  // Receipts where this ledger is the destination (debit)
  const rToParams: any[] = [id];
  const { rows: recToRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            rf.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers rf ON rf.id = r.received_from_ledger_id
     WHERE r.received_in_ledger_id = $1${dateClause('r.receipt_date', rToParams)}
     ORDER BY r.receipt_date, r.id`, rToParams
  ).catch(() => ({ rows: [] }));

  // Expenses charged to this ledger (debit)
  const expParams: any[] = [id];
  const { rows: expRows } = await pool.query(
    `SELECT e.id, e.expense_date AS date, e.amount, e.description, e.category
     FROM expenses e
     WHERE e.ledger_account_id = $1${dateClause('e.expense_date', expParams)}
     ORDER BY e.expense_date, e.id`, expParams
  ).catch(() => ({ rows: [] }));

  // Journal-family voucher lines touching this ledger
  const jvParams: any[] = [id];
  const { rows: jvRows } = await pool.query(
    `SELECT l.id, v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1${dateClause('v.voucher_date', jvParams)}
     ORDER BY v.voucher_date, l.id`, jvParams
  ).catch(() => ({ rows: [] }));

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
router.get("/gst/summary", async (req, res): Promise<void> => {
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

export default router;

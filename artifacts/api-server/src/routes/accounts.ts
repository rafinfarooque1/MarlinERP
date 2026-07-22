import { Router } from "express";
import { db, pool, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams,
} from "@workspace/api-zod";

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
  const [row] = await db.insert(accountLedgersTable).values({ ...parsed.data, ...(code ? {} : {}) }).returning();
  // Set code and bank_details via raw query if provided
  if (code || bankDetails) {
    await pool.query(
      `UPDATE account_ledgers SET code = COALESCE($1, code), bank_details = COALESCE($2, bank_details) WHERE id = $3`,
      [code, bankDetails ? JSON.stringify(bankDetails) : null, row.id]
    );
  }
  const parentName = parsed.data.parentId
    ? (await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, parsed.data.parentId!)).limit(1))[0]?.name ?? null
    : null;
  res.status(201).json({ ...row, code, bankDetails, parentName, children: [], balance: 0 });
});

router.patch("/accounts/chart/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(accountLedgersTable).set(parsed.data).where(eq(accountLedgersTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if ((req.body as any).code !== undefined) {
    await pool.query(`UPDATE account_ledgers SET code = $1 WHERE id = $2`, [(req.body as any).code, id]);
  }
  res.json({ ...row, code: (req.body as any).code ?? null, parentName: null, children: [], balance: 0 });
});

router.delete("/accounts/chart/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // Protect system group heads
  const { rows: [row] } = await pool.query(`SELECT is_system_group FROM account_ledgers WHERE id = $1`, [id]);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.is_system_group) { res.status(400).json({ error: "System group heads cannot be deleted." }); return; }
  // Check for children
  const children = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.parentId, id));
  if (children.length > 0) { res.status(400).json({ error: "Cannot delete account with sub-accounts. Delete sub-accounts first." }); return; }
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
  const countRes = await pool.query(`SELECT COUNT(*) FROM payments`);
  const voucherNumber = `PAY-${String(Number(countRes.rows[0].count) + 1).padStart(4, '0')}`;
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
  const countRes = await pool.query(`SELECT COUNT(*) FROM receipts`);
  const voucherNumber = `REC-${String(Number(countRes.rows[0].count) + 1).padStart(4, '0')}`;
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

// ── Expenses (kept for backward compat) ───────────────────────────────────
router.get("/expenses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(expensesTable).orderBy(expensesTable.id);
  const ledgers = await db.select().from(accountLedgersTable);
  const cashBanks = await db.select().from(cashBankAccountsTable);
  const lMap = new Map(ledgers.map(l => [l.id, l.name]));
  const cbMap = new Map(cashBanks.map(cb => [cb.id, cb.name]));
  res.json(rows.map(r => ({
    ...r,
    ledgerAccountName: lMap.get(r.ledgerAccountId) ?? "",
    paymentAccountName: cbMap.get(r.paymentAccountId) ?? "",
    amount: Number(r.amount),
  })));
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
    if (fromDate) { params.push(fromDate); conds.push(`${dateCol} >= ${params.length}`); }
    if (toDate)   { params.push(toDate);   conds.push(`${dateCol} <= ${params.length}`); }
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
  if (fromDate) { sp.push(fromDate); salesConds.push(`sale_date >= ${sp.length}`); }
  if (toDate)   { sp.push(toDate);   salesConds.push(`sale_date <= ${sp.length}`); }
  if (outletId) { sp.push(Number(outletId)); salesConds.push(`outlet_id = ${sp.length}`); }
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

// ── GST Summary ───────────────────────────────────────────────────────────
router.get("/gst/summary", async (req, res): Promise<void> => {
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  let allSales = await db.select().from(salesTable).orderBy(salesTable.saleDate);
  if (fromDate) allSales = allSales.filter(s => s.saleDate >= fromDate);
  if (toDate) allSales = allSales.filter(s => s.saleDate <= toDate);

  let allPurchases = await db.select().from(purchasesTable).orderBy(purchasesTable.purchaseDate);
  if (fromDate) allPurchases = allPurchases.filter(p => p.purchaseDate >= fromDate);
  if (toDate) allPurchases = allPurchases.filter(p => p.purchaseDate <= toDate);

  const salesByRate = new Map<number, { taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }>();
  for (const sale of allSales) {
    const lineItems = (sale.lineItems ?? []) as any[];
    for (const li of lineItems) {
      const rate = Number(li.taxRate ?? 0);
      const sub = Number(li.lineSubtotal ?? (li.quantity * li.unitPrice - (li.discount ?? 0)));
      const existing = salesByRate.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      existing.taxableValue += sub;
      existing.cgst += Number(li.cgst ?? 0);
      existing.sgst += Number(li.sgst ?? 0);
      existing.igst += Number(li.igst ?? 0);
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
      existing.taxableValue += Number(li.taxableValue ?? 0);
      existing.cgst += Number(li.cgst ?? 0);
      existing.sgst += Number(li.sgst ?? 0);
      existing.igst += Number(li.igst ?? 0);
      existing.taxAmount += Number(li.taxAmount ?? 0);
      purchasesByRate.set(rate, existing);
    }
  }

  const totalSales = allSales.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxCollected = allSales.reduce((s, r) => s + Number(r.taxTotal ?? 0), 0);
  const totalPurchases = allPurchases.reduce((s, p) => s + Number(p.totalAmount), 0);
  const totalTaxPaid = allPurchases.reduce((s, p) => s + Number((p as any).taxTotal ?? 0), 0);
  const netGstLiability = totalTaxCollected - totalTaxPaid;
  const warehouses = await db.select().from(warehousesTable);

  res.json({
    totalSales, totalTaxCollected, totalPurchases, totalTaxPaid, netGstLiability,
    salesByRate: Array.from(salesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d })),
    purchasesByRate: Array.from(purchasesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d, estimated: false })),
    byWarehouse: warehouses.map(w => ({ warehouseId: w.id, warehouseName: w.name, gstNumber: w.gstNumber, salesTax: 0, purchaseTax: 0 })),
  });
});

export default router;

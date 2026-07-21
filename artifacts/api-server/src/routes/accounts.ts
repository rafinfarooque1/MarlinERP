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
    balance: 0,
  })));
});

router.post("/accounts/chart", async (req, res): Promise<void> => {
  const parsed = CreateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const code = (req.body as any).code ?? null;
  const [row] = await db.insert(accountLedgersTable).values({ ...parsed.data, ...(code ? {} : {}) }).returning();
  // Set code via raw query if provided
  if (code) {
    await pool.query(`UPDATE account_ledgers SET code = $1 WHERE id = $2`, [code, row.id]);
  }
  const parentName = parsed.data.parentId
    ? (await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, parsed.data.parentId!)).limit(1))[0]?.name ?? null
    : null;
  res.status(201).json({ ...row, code, parentName, children: [], balance: 0 });
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

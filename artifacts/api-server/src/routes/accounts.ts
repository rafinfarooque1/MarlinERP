import { Router } from "express";
import { db, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ── Chart of Accounts ─────────────────────────────────────────────────────
router.get("/accounts/chart", async (_req, res): Promise<void> => {
  const rows = await db.select().from(accountLedgersTable).orderBy(accountLedgersTable.id);
  res.json(rows.map((r) => ({
    ...r,
    parentName: null,
    balance: 0,
  })));
});

router.post("/accounts/chart", async (req, res): Promise<void> => {
  const parsed = CreateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(accountLedgersTable).values(parsed.data).returning();
  res.status(201).json({ ...row, parentName: null, balance: 0 });
});

router.patch("/accounts/chart/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateAccountLedgerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.update(accountLedgersTable).set(parsed.data).where(eq(accountLedgersTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, parentName: null, balance: 0 });
});

// ── Ledger Statement ──────────────────────────────────────────────────────
router.get("/accounts/ledger-statement", async (req, res): Promise<void> => {
  const qp = GetLedgerStatementQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }

  const accountId = Number(qp.data.accountId);
  const [account] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, accountId)).limit(1);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const expenses = await db.select().from(expensesTable).where(eq(expensesTable.ledgerAccountId, accountId));
  const transactions = expenses.map((e) => ({
    id: e.id,
    date: e.expenseDate,
    description: e.description ?? "Expense",
    debit: Number(e.amount),
    credit: 0,
    balance: Number(e.amount),
  }));

  res.json({
    accountId,
    accountName: account.name,
    openingBalance: 0,
    closingBalance: transactions.reduce((s, t) => s + t.debit - t.credit, 0),
    transactions,
  });
});

// ── Cash & Bank ───────────────────────────────────────────────────────────
router.get("/accounts/cash-bank", async (_req, res): Promise<void> => {
  const rows = await db.select().from(cashBankAccountsTable).orderBy(cashBankAccountsTable.id);
  res.json(rows.map((r) => ({ ...r, balance: Number(r.balance) })));
});

router.post("/accounts/cash-bank", async (req, res): Promise<void> => {
  const parsed = CreateCashBankAccountBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { openingBalance, ...rest } = parsed.data as typeof parsed.data & { openingBalance?: number };
  const [row] = await db.insert(cashBankAccountsTable).values({
    ...rest,
    balance: String(openingBalance ?? 0),
  }).returning();
  res.status(201).json({ ...row, balance: Number(row.balance) });
});

// ── Expenses ──────────────────────────────────────────────────────────────
router.get("/expenses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(expensesTable).orderBy(expensesTable.id);
  const ledgers = await db.select().from(accountLedgersTable);
  const cashBanks = await db.select().from(cashBankAccountsTable);
  const lMap = new Map(ledgers.map((l) => [l.id, l.name]));
  const cbMap = new Map(cashBanks.map((cb) => [cb.id, cb.name]));
  res.json(rows.map((r) => ({
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
  res.status(201).json({
    ...row,
    ledgerAccountName: ledger?.name ?? "",
    paymentAccountName: cashBank?.name ?? "",
    amount: Number(row.amount),
  });
});

// ── GST Summary (by rate slab) ────────────────────────────────────────────
router.get("/gst/summary", async (req, res): Promise<void> => {
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  // Fetch sales (with optional date range)
  let allSales = await db.select().from(salesTable).orderBy(salesTable.saleDate);
  if (fromDate) allSales = allSales.filter(s => s.saleDate >= fromDate);
  if (toDate) allSales = allSales.filter(s => s.saleDate <= toDate);

  // Fetch purchases (with optional date range)
  let allPurchases = await db.select().from(purchasesTable).orderBy(purchasesTable.purchaseDate);
  if (fromDate) allPurchases = allPurchases.filter(p => p.purchaseDate >= fromDate);
  if (toDate) allPurchases = allPurchases.filter(p => p.purchaseDate <= toDate);

  // ── Aggregate Output Tax from sales lineItems ─────────────────────────────
  // lineItems is JSONB: [{taxRate, taxType, cgst, sgst, igst, taxAmount, lineSubtotal, ...}]
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

  // ── Aggregate Input Tax from purchases ────────────────────────────────────
  // Purchases don't have per-line GST rates stored, so estimate 5% input tax on total purchase value
  const totalPurchaseValue = allPurchases.reduce((s, p) => s + Number(p.totalAmount), 0);
  const purchaseTaxEstimate = Math.round(totalPurchaseValue * 0.05 * 100) / 100;
  const purchasesByRate = totalPurchaseValue > 0
    ? [{ taxRate: 5, taxableValue: totalPurchaseValue, cgst: purchaseTaxEstimate / 2, sgst: purchaseTaxEstimate / 2, igst: 0, taxAmount: purchaseTaxEstimate, estimated: true }]
    : [];

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalSales = allSales.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxCollected = allSales.reduce((s, r) => s + Number(r.taxTotal), 0);
  const totalPurchases = totalPurchaseValue;
  const totalTaxPaid = purchaseTaxEstimate;
  const netGstLiability = totalTaxCollected - totalTaxPaid;

  const warehouses = await db.select().from(warehousesTable);

  res.json({
    totalSales,
    totalTaxCollected,
    totalPurchases,
    totalTaxPaid,
    netGstLiability,
    salesByRate: Array.from(salesByRate.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([taxRate, d]) => ({ taxRate, ...d })),
    purchasesByRate,
    byWarehouse: warehouses.map((w) => ({
      warehouseId: w.id,
      warehouseName: w.name,
      gstNumber: w.gstNumber,
      salesTax: 0,
      purchaseTax: 0,
    })),
  });
});

export default router;

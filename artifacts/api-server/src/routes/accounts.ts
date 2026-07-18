import { Router } from "express";
import { db, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams, GetGstSummaryQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ── Chart of Accounts ─────────────────────────────────────────────────────
router.get("/accounts/chart", async (_req, res): Promise<void> => {
  const rows = await db.select().from(accountLedgersTable).orderBy(accountLedgersTable.id);
  res.json(rows.map((r) => ({
    ...r,
    parentName: null, // Could do a join but keeping it simple
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

  // Return expenses for expense accounts as transactions
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

  // Deduct from cash/bank balance
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

// ── GST ───────────────────────────────────────────────────────────────────
router.get("/gst/summary", async (req, res): Promise<void> => {
  const qp = GetGstSummaryQueryParams.safeParse(req.query);
  const allSales = await db.select().from(salesTable);
  const allPurchases = await db.select().from(purchasesTable);
  const warehouses = await db.select().from(warehousesTable);

  const totalSales = allSales.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxCollected = allSales.reduce((s, r) => s + Number(r.taxTotal), 0);
  const totalPurchases = allPurchases.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxPaid = totalPurchases * 0.05; // simplified 5% GST
  const netGstLiability = totalTaxCollected - totalTaxPaid;

  res.json({
    totalSales,
    totalTaxCollected,
    totalPurchases,
    totalTaxPaid,
    netGstLiability,
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

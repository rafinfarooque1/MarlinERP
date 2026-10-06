import assert from "node:assert/strict";

import {
  rangeBankExpensesByLedger,
  rangeBankReceiptBreakdown,
  rangeCashExpensesByLedger,
  rangeCashReceiptBreakdown,
} from "../src/lib/dashboardFinancials";

const postings = [
  { source: "sale", date: "2026-10-03", ledgerId: 10, debit: 125.25, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "sale", date: "2026-10-03", ledgerId: 20, debit: 40, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "sale", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 8, locationType: "warehouse", locationId: 7 },
  { source: "receipt", date: "2026-10-03", ledgerId: 10, debit: 75.55, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "receipt", date: "2026-10-03", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 8 },
  { source: "receipt", date: "2026-10-02", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", date: "2026-10-03", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:cash", date: "2026-10-03", ledgerId: 30, debit: 15.25, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:cash", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 15.25, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:bank", date: "2026-10-03", ledgerId: 30, debit: 40, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:bank", date: "2026-10-03", ledgerId: 20, debit: 0, credit: 40, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:unpaid", date: "2026-10-03", ledgerId: 30, debit: 50, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:unpaid", date: "2026-10-03", ledgerId: 40, debit: 0, credit: 50, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:other-location", date: "2026-10-03", ledgerId: 31, debit: 20, credit: 0, locationType: "warehouse", locationId: 8 },
  { source: "expense", entryId: "expense:other-location", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 20, locationType: "warehouse", locationId: 8 },
  { source: "expense", entryId: "expense:other-date", date: "2026-10-02", ledgerId: 32, debit: 25, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:other-date", date: "2026-10-02", ledgerId: 10, debit: 0, credit: 25, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:indirect-cash", date: "2026-10-03", ledgerId: 35, debit: 15, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:indirect-cash", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 15, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:indirect-bank", date: "2026-10-03", ledgerId: 36, debit: 18, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:indirect-bank", date: "2026-10-03", ledgerId: 20, debit: 0, credit: 18, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:not-expense", date: "2026-10-03", ledgerId: 40, debit: 24, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "payment", entryId: "payment:not-expense", date: "2026-10-03", ledgerId: 20, debit: 0, credit: 24, locationType: "warehouse", locationId: 7 },
  { source: "journal_voucher", entryId: "jv:cash", date: "2026-10-03", ledgerId: 33, debit: 60, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "journal_voucher", entryId: "jv:cash", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 60, locationType: "warehouse", locationId: 7 },
  { source: "sale", date: "2026-10-03", ledgerId: 20, debit: 205.5, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "receipt", date: "2026-10-03", ledgerId: 20, debit: 45.25, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:bank-only", date: "2026-10-03", ledgerId: 34, debit: 27.5, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", entryId: "expense:bank-only", date: "2026-10-03", ledgerId: 20, debit: 0, credit: 27.5, locationType: "warehouse", locationId: 7 },
];

const testSubtree = (code: string) => {
  if (code === "STD-CASH") return [10];
  if (code === "STD-BANK") return [20];
  if (code === "SYS-DIREXP") return [30, 34];
  if (code === "SYS-INDEXP") return [35, 36];
  return [];
};

const result = rangeCashReceiptBreakdown(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: testSubtree,
});

assert.deepEqual(result, {
  bySale: 125.25,
  receiptVouchers: 75.55,
  total: 200.8,
});

const bankReceipts = rangeBankReceiptBreakdown(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: testSubtree,
});

assert.deepEqual(bankReceipts, {
  bySale: 245.5,
  receiptVouchers: 45.25,
  total: 290.75,
});

const cashExpenses = rangeCashExpensesByLedger(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: testSubtree,
});

assert.deepEqual(cashExpenses, {
  total: 30.25,
  ledgers: [
    { ledgerId: 30, amount: 15.25 },
    { ledgerId: 35, amount: 15 },
  ],
});

const bankExpenses = rangeBankExpensesByLedger(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: testSubtree,
});

assert.deepEqual(bankExpenses, {
  total: 85.5,
  ledgers: [
    { ledgerId: 30, amount: 40 },
    { ledgerId: 34, amount: 27.5 },
    { ledgerId: 36, amount: 18 },
  ],
});

console.log("Dashboard financial matrix cash and bank receipt/expense scope checks passed.");
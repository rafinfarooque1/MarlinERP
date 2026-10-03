import assert from "node:assert/strict";

import { rangeCashExpensesByLedger, rangeCashReceiptBreakdown } from "../src/lib/dashboardFinancials";

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
  { source: "journal_voucher", entryId: "jv:cash", date: "2026-10-03", ledgerId: 33, debit: 60, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "journal_voucher", entryId: "jv:cash", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 60, locationType: "warehouse", locationId: 7 },
];

const result = rangeCashReceiptBreakdown(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: (code) => code === "STD-CASH" ? [10] : code === "STD-BANK" ? [20] : [],
});

assert.deepEqual(result, {
  bySale: 125.25,
  receiptVouchers: 75.55,
  total: 200.8,
});

const cashExpenses = rangeCashExpensesByLedger(postings as never[], {
  fromDate: "2026-10-03",
  toDate: "2026-10-03",
  location: { type: "warehouse", id: 7 },
  subtree: (code) => code === "STD-CASH" ? [10] : code === "STD-BANK" ? [20] : [],
});

assert.deepEqual(cashExpenses, {
  total: 15.25,
  ledgers: [{ ledgerId: 30, amount: 15.25 }],
});

console.log("Dashboard financial matrix cash receipt and cash expense scope checks passed.");
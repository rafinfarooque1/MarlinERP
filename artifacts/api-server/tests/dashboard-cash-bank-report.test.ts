import assert from "node:assert/strict";
import { aggregateDashboardCashBankReport } from "../src/lib/dashboardCashBankReport";

const accounts = [
  { ledgerId: 10, name: "Main cash", kind: "cash" as const },
  { ledgerId: 11, name: "Petty cash", kind: "cash" as const },
  { ledgerId: 20, name: "Current account", kind: "bank" as const },
];
const postings = [
  // Brought forward, including an opening-balance posting before the period.
  { date: "2026-04-01", ledgerId: 10, debit: 100, credit: 0 },
  { date: "2026-04-02", ledgerId: 20, debit: 0, credit: 25 },
  // The start date is part of the selected period.
  { date: "2026-04-03", ledgerId: 10, debit: 0.1, credit: 0 },
  { date: "2026-04-03", ledgerId: 10, debit: 0, credit: 0.03 },
  { date: "2026-04-04", ledgerId: 20, debit: 50.25, credit: 0 },
  { date: "2026-04-04", ledgerId: 20, debit: 0, credit: 10 },
  // After the end date: excluded from movements and closing balance.
  { date: "2026-04-06", ledgerId: 10, debit: 999, credit: 0 },
];

const report = aggregateDashboardCashBankReport(
  accounts,
  postings,
  "2026-04-03",
  "2026-04-05",
);

assert.deepEqual(report.cash, {
  rows: [{
    ledgerId: 10,
    name: "Main cash",
    opening: 100,
    receipt: 0.1,
    payment: 0.03,
    closing: 100.07,
  }],
  totals: { opening: 100, receipt: 0.1, payment: 0.03, closing: 100.07 },
});
assert.deepEqual(report.bank, {
  rows: [{
    ledgerId: 20,
    name: "Current account",
    opening: -25,
    receipt: 50.25,
    payment: 10,
    closing: 15.25,
  }],
  totals: { opening: -25, receipt: 50.25, payment: 10, closing: 15.25 },
});

console.log("Dashboard cash and bank account balances reconcile by period.");

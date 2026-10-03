import assert from "node:assert/strict";

import { rangeCashReceiptBreakdown } from "../src/lib/dashboardFinancials";

const postings = [
  { source: "sale", date: "2026-10-03", ledgerId: 10, debit: 125.25, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "sale", date: "2026-10-03", ledgerId: 20, debit: 40, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "sale", date: "2026-10-03", ledgerId: 10, debit: 0, credit: 8, locationType: "warehouse", locationId: 7 },
  { source: "receipt", date: "2026-10-03", ledgerId: 10, debit: 75.55, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "receipt", date: "2026-10-03", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 8 },
  { source: "receipt", date: "2026-10-02", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 7 },
  { source: "expense", date: "2026-10-03", ledgerId: 10, debit: 999, credit: 0, locationType: "warehouse", locationId: 7 },
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

console.log("Dashboard financial matrix cash-receipt source and scope checks passed.");
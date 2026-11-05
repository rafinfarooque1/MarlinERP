import assert from "node:assert/strict";
import { buildUnmatchedAllocationPostings } from "../src/routes/journal";

const rows = [
  {
    sale_payment_id: 1, sale_id: 10, payment_date: "2026-07-18", method: "bank",
    amount: "879.98", clearing_receipt_id: 1703, receipt_vno: "REC/2026-27/0320",
    receipt_narration: "Historic receipt", alloc_in: 270, alloc_from: 183,
    receipt_location_type: "warehouse", receipt_location_id: 4,
  },
  {
    sale_payment_id: 2, sale_id: 11, payment_date: "2026-07-21", method: "cash",
    amount: "0.01", clearing_receipt_id: 1693, receipt_vno: "REC/2026-27/0310",
    alloc_in: 159, alloc_from: 187, receipt_location_type: "outlet", receipt_location_id: 2,
  },
  {
    sale_payment_id: 3, sale_id: 12, payment_date: "2026-07-22", method: "advance",
    amount: "10.00", clearing_receipt_id: 1800, receipt_vno: "REC/2026-27/0400",
    alloc_in: 159, alloc_from: 222,
  },
  {
    sale_payment_id: 4, sale_id: 13, payment_date: "2026-07-23", method: "bank",
    amount: "50.00", clearing_receipt_id: 1801, receipt_vno: "REC/2026-27/0401",
    alloc_in: null, alloc_from: null,
  },
];

const postings = buildUnmatchedAllocationPostings(rows, new Set([1]), 39, 2);

assert.equal(postings.length, 2, "adds only nonzero allocation settlements whose sale leg was omitted");
assert.deepEqual(
  postings.map(({ entryId, date, ledgerId, debit, credit, locationType, locationId }) => ({
    entryId, date, ledgerId, debit, credit, locationType, locationId,
  })),
  [
    {
      entryId: "receipt:1693", date: "2026-07-21", ledgerId: 39, debit: 0.01, credit: 0,
      locationType: "outlet", locationId: 2,
    },
    {
      entryId: "receipt:1800", date: "2026-07-22", ledgerId: 222, debit: 10, credit: 0,
      locationType: "headoffice", locationId: 0,
    },
  ],
  "uses the receipt clearing ledger for cash allocations and the original party for advance settlements",
);

console.log("Passed: unmatched allocation posting tests");

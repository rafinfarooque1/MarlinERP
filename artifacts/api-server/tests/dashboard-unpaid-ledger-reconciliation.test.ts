import assert from "node:assert/strict";
import { computePaymentPosition } from "../src/lib/salePaymentPosition";

// Mirrors the screenshot's customer: a ₹400 credit note and ₹780 payment
// against an older ₹780 invoice leave ₹400 credit on that invoice's customer
// ledger. A separate ₹760 invoice has only ₹460 received, so that invoice still
// owes ₹300 even though the customer's net ledger is ₹100 in credit.
const invoiceTotals = [780, 760, 760, 760];
const amountReceived = [780, 760, 0, 0];
const creditNotes = [400, 0, 0, 0];
const receiptAllocations = [
  { invoice: 2, amount: 760 },
  { invoice: 3, amount: 460 },
];
for (const allocation of receiptAllocations) {
  amountReceived[allocation.invoice] = (amountReceived[allocation.invoice] ?? 0) + allocation.amount;
}

const positions = invoiceTotals.map((total, index) => computePaymentPosition({
  totalAmount: total,
  amountReceived: amountReceived[index],
  creditAdjustments: creditNotes[index],
}));

assert.equal(positions[3]?.outstanding, 300, "the dashboard should show the specific invoice's ₹300 due");
assert.equal(positions[0]?.overpaid, 400, "the prior credit note/payment should remain a customer credit");

// The final ₹1,220 receipt is allocated across the last two invoices (₹760 +
// ₹460); the first two receipts are ₹780 and ₹760 respectively.
const ledgerNet = invoiceTotals.reduce((balance, total, index) =>
  balance + total - (amountReceived[index] ?? 0) - (creditNotes[index] ?? 0), 0);
assert.equal(ledgerNet, -100, "the customer's ledger should end ₹100 in credit");
assert.equal(
  positions.reduce((sum, position) => sum + position.outstanding, 0),
  300,
  "invoice dues are not reduced by credit held on a different invoice",
);

console.log("Dashboard invoice due and customer ledger balance reconcile across allocated receipts and a credit note.");

---
name: Regression battery residue
description: Running the full api-server test battery leaves real documents in the live dev books — how to detect and unwind the residue.
---

# Regression battery residue

**The rule:** a "40/44 suites green" battery run is NOT evidence the books are untouched. Several suites leak live documents into the dev DB (which holds real business data). Always snapshot TB/receivables/payables/bi/stockCount BEFORE a battery run and diff after.

**Why:** an Aug 2026 full-battery run left: leaked parties+purchase+credit-sale+item (gst-filters), an in-transit transfer with a BTR twin invoice (location-books), two sales+returns+CN/refund (location-returns), an approved salary JV + employee ledgers (salary-accrual leak path), and an orphan receipt against a nonexistent legacy invoice. Every one had test-prefixed names or battery-window timestamps.

**How to unwind (prefer app paths — books are derived from documents):**
- transfer in_transit → PATCH /stock/transfers/:id/reject (creates offsetting CN for invoice-mode; balances return to baseline, documents remain as honest history)
- sales → POST /sales/:id/cancel (refuses with non-counter payments: first POST /accounts/receipts/:id/system-delete — level-1 only, needs a `reason` ≥5 chars, unwinds sale_payments+amount_paid; also handles orphan receipts)
- purchases → DELETE /purchases/:id — but if some qty was already sold, the floor-at-zero reversal INVENTS stock (entries/batches read positive while stock_ledger nets 0); fix entries+batches+ledger rows by SQL before deleting the item
- returns have NO delete route: SQL unwind (sales_returns row, CN JV lines+voucher or refund payments row, stock_entries −qty, stock_batches −qty on the batchRestore lot, stock_ledger rows), THEN cancel the sale
- payroll residue: replicate salary-accrual's own cleanup() SQL recipe (accruals, attendance, payroll, pay_components, JVs by narration, SAL-*/ADV- ledgers, employee)
- customers with cancelled sales cannot be deleted (financial-history guard) — leave the master row, it carries no balance

**Stranded-fixture trap:** before diagnosing a derivation "bug" when an advance/balance assertion fails, check the fixture party for stranded uncancelled documents from an earlier failed run — a leftover sale shifts the party balance and perfectly mimics broken code.

gst.test.mjs is fixed (valid GSTIN fixture, self-cleanup); gst-filters / location-books / location-returns still leak by omission.

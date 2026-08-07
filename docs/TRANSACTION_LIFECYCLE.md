# Transaction Lifecycle & Single Sources of Truth

**Marlin Frozen Fruits ERP — August 2026.** This document records the complete
lifecycle of every transaction type and names the ONE owner of each derived
figure. Any new feature that needs one of these figures must call the owner —
never recompute it. Companion: `docs/ERP_SYSTEM_AUDIT.md` (full system audit).

## The five sources of truth

| Figure | Single owner | Notes |
|---|---|---|
| Invoice status & outstanding | `api-server/src/lib/salePaymentPosition.ts` — `computePaymentPosition()` (in-process) + `outstandingExpr`/`outstandingAsOfExpr` (SQL builders) | Status is **money-derived at read time**: payments + credit notes + cancellation. The stored `sales.payment_status`/`amount_paid` columns are write-through projections kept in sync by every writer via the same helper; readers must prefer the derived position. |
| Vendor bill settlement | `api-server/src/lib/vendorBillSettlement.ts` | Purchases have **no** `amount_paid` column. Settlement derives from the vendor ledger: explicit allocations first (pinned money never enters the pool), then FIFO over the residual. |
| Payment allocation | Allocation-receipt recipe in `routes/accounts.ts` (reused verbatim by `lib/importVouchers.ts`) | A receipt with `allocations[]` writes `sale_payments` rows (via `clearing_receipt_id`), updates the aggregate + status through `computePaymentPosition`, parks excess as customer credit / vendor VADV. Deletion = full unwind. |
| Ledger posting | `buildDerivedPostings()` in `routes/journal.ts` | There is **no stored postings table**. Trial balance, day book, cash/bank book, P&L, balance sheet, party statements ALL derive on the fly from transaction tables. GST legs split by ONE classifier (`lib/gst.ts` `lineTaxHeads()`). |
| Inventory posting | `stock_entries.quantity` (mutable quantity truth) + `stock_ledger` via `lib/stockLedger.ts` (append-only movement audit, business-dated) | Every **transactional movement producer** (sales, purchases, returns, production, transfers, adjustments, imports) updates the quantity and appends a ledger row through the shared helper, inside the same transaction. One-time boot migrations may restate `stock_entries` without ledger rows. Batches are an additive FEFO lot layer over `stock_entries`. |

Supporting owners: party balances = `lib/ledgerBalances.ts` (`currentPartyStatement`,
`currentBalanceIndex`); voucher numbers = `lib/voucherNumber.ts` (atomic sequence,
never COUNT(*)); per-location invoice numbers = stamped allocator columns.

## 1. Sales

**Entry → Save.** Payment modes accepted at entry: Cash, Bank, UPI, Credit
(legacy `card`/`bank_transfer` rows are read as Bank, never rewritten). There is
no separate "mixed" mode — a mixed payment is a Credit sale plus one or more
collections. Save is ONE transaction: MRP-floor + credit-limit validation
(ledger-based, under the per-customer advisory lock, **inside** the txn), stock
deduction (row-locked, FEFO batch consumption), invoice number from the
per-location allocator, optional advance application.

**Money at save.**
- Cash/Bank/UPI: settled at creation — `amount_paid = total`, status `paid`.
- Credit: `amount_paid` = applied advance only (usually 0), status from
  `computePaymentPosition` → `unpaid`, or `paid`/`partially_paid` if an advance
  covered it. **No automatic payment is invented.**
- A legacy display row lands in `receipts` (voucher = invoice number). It is
  cash-book trail ONLY — `buildDerivedPostings` excludes all sale-linked
  receipts; sales + `sale_payments` are the money truth.

**Books (gross debtor model).** A sale to a customer with a provisioned
`CUST-` ledger posts: Dr customer for the full total at sale date, Cr customer
per collection at its payment date (receipt voucher number attached), money legs
to Cash/Electronic Clearing, Cr Sales + Cr Output GST (per-line classifier,
paise split = half + exact remainder). What the customer owes is simply the net
of their ledger. Walk-ins keep a net remainder on Sundry Debtors.

**After save.** Collections (manual, allocation receipts, imports) append
`sale_payments` and re-derive status through the one helper. Credit notes
(returns) reduce outstanding as adjustments — they are not payments. Edit
re-derives `amount_paid` from `sale_payments` (never trusts the stored figure)
and re-checks the credit limit in-txn. Cancel is terminal: stock reversed,
status `cancelled`, every later write path refuses the sale; real payments
block cancellation, advance-only payments are unwound.

**Status glossary.** `paid` = outstanding ≤ 0 · `partially_paid` = something
received/credited but not all · `unpaid` = nothing yet · `cancelled` =
terminal. "Returned" is not a status: a return issues a credit note that
reduces outstanding (and may flip status to `paid`). **Payment mode records how
the sale was booked; status records whether money has arrived.** A Credit
invoice that has since been collected correctly shows `Credit + Paid`.

## 2. Receipts & Payments

Money vouchers are rows in `receipts`/`payments`: Dr received-in / Cr
received-from (and mirror for payments). Each stores `source` provenance
(manual, allocation, sale, import…) — every producer must stamp it; edit rights
derive from it. Bill-wise allocation vouchers are edit-locked; delete = full
unwind (409 once a parked advance was consumed). Customer excess = credit
balance on the same `CUST-` ledger (single-ledger model); vendor excess parks
on `VADV-`. Collections route to the location's assigned cash/bank/UPI account;
the receipt row is display, `buildDerivedPostings` is truth.

## 3. Purchases

Save is one transaction: stock IN valued at **taxable** cost (net of GST and
discount), batch lots created, vendor ledger Cr for goods + bill-borne other
charges. No stored paid/status columns — settlement always derives from the
vendor ledger via `vendorBillSettlement.ts` (explicit allocations first, FIFO
residual). Cash purchase = purchase + immediate payment voucher; credit
purchase = vendor balance until payment vouchers settle it. Edits diff lines
(kind:id:batch) and touch only changed stock; refused once goods moved if the
reversal would invent stock; settled floor re-checked under the row lock.

## 4. Returns

Sales return: stock back IN, credit note posted against the sales/GST heads,
customer outstanding reduced via `creditAdjustments` in the position helper —
invoice status recomputes automatically. Purchase return: stock OUT, debit note,
vendor balance reduced (bill-borne other charges intentionally stay). Edits are
full-state PATCHes with delta-based stock. The BOOKS see returns (note-sourced
postings reduce the sales/purchases subtrees); the GSTR-1/GSTR-3B **reports do
NOT yet subtract credit/debit notes** — that is open task "Make credit and
debit notes reduce GST returns" and must not be assumed fixed.

## 5. Inventory

`stock_entries.quantity` is the ONE quantity truth (the item-table column is
stale by design — never read it). All five transactional movement families
(sales, purchases, returns, production, transfers/adjustments) update it
row-locked in-txn and append business-dated `stock_ledger` rows through the
shared helper — running balances and historical statements derive from the
ledger. (One-time boot migrations are the only writers allowed to restate
quantities without ledger rows.) Batches: additive
FEFO lot layer; shortfall consumes "Untracked". Transfers are two-step
(dispatch → receive), in-transit stock is sender-owned; cross-GSTIN transfers
write real sale/purchase twins. Valuation: ONE at-cost function (3 stock kinds
+ in-transit) feeds the report, dashboard and P&L closing stock. COGS uses
moving average cost, unwound with quantity on reversals.

## 6. Accounting

Everything derives from `buildDerivedPostings()`: sales (gross model),
purchases, receipts/payments, expenses (daily rent/salary accruals), journal
vouchers, production, transfers, opening balances, imports. Reports (TB, BS,
P&L, day book, cash/bank book, GST, party statements, dashboard tiles) are
different projections of the SAME stream — they cannot disagree with each
other, only with hand-rolled arithmetic outside the stream. The dashboard reads
the P&L's own summary; tiles never re-sum subtrees.

## 7. Imports

The data-import framework commits through the SAME libraries as manual entry,
in one transaction per batch (all-or-nothing, file-order). Legacy old-software
reports: named-customer sales import as **Credit** on purpose so the old
Receipt report can settle them exactly as it did historically — a fully
collected imported invoice therefore shows Credit + Paid with its receipt
voucher on the customer ledger. Imported documents behave identically to
manual ones afterwards (collections, returns, edits, books).

## 8. Location

Every transaction is stamped with `location_type` + `location_id` at write time
via validated resolvers; branch users cannot choose another location (LBAC).
Head Office is a real location with per-table placeholder ids — match on type,
never on id. Nothing posts to HO unless the acting context IS HO.

## Known intentional deviations

- Stored `sales.payment_status`/`amount_paid` remain as write-through
  projections (cheap list scans); every reader that matters uses the derived
  position. Do not add readers of the stored columns.
- Sale-linked `receipts` rows are display/trail only and excluded from books.
- Per-invoice "due" figures inside settlement/allocation flows are
  allocation-local residuals of the owning module — not independent sources.

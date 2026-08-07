---
name: Sales settlement & discount semantics
description: Domain rules for sale payment settlement (which modes settle at creation) and the two-tier discount model (line vs bill), including how each interacts with GST.
---

**Rule:** cash/upi/card sales are settled at the counter — they are fully paid the moment they exist. Only credit ("pay later") sales carry a balance, require a customer, and are subject to credit-limit control. The canonical payment-status enum is `unpaid | partially_paid | paid`.

**Why:** dues everywhere are computed as invoice total minus amount paid. If settled sales are stored with zero paid, customers get falsely blocked by credit limits and settled invoices appear as receivables/collections. A completion review rejected the phase for exactly this.

**How to apply:**
- Any dues, aging, collections, or exposure computation must use balance (total − paid) as the only source — never infer dues from the payment mode or status label alone.
- Any code path that records a sale must apply the same settlement rule; any path that edits one must preserve collected payments rather than recomputing from scratch.
- Ledger routing mirrors settlement: cash → location cash ledger, upi/card → electronic clearing (awaiting bank), credit → the customer's debtor ledger only.
- Startup data backfills must run after the DDL that creates the columns they touch, guarded one-time via the existing migration-log convention (completion review boots older snapshot DBs).

## Discount semantics (two tiers — never mix)

**Rule:** Per-line `discount` (₹ off that line's MRP gross) is applied BEFORE GST back-calculation — it reduces `lineSubtotal`/`taxAmount` and is therefore already inside `subtotal`/`tax_total`. `discount_total` holds ONLY the bill-level (coupon) discount, applied AFTER tax: `total_amount = subtotal + tax_total − discount_total`. Line discounts must never be summed into `discount_total` (double-count).

**Why:** GST law requires pre-tax discounts to reduce taxable value; the books derive GST from stored per-line net fields (`lineSubtotal`/`lineTaxHeads`), so netting at the line keeps GST returns correct with zero accounting changes. A prior fallback (`discountTotal ?? Σ li.discount`) was a latent double-count.

**How to apply:**
- `CreateSaleBody` (generated zod) strips `discountTotal` — it must be read from the raw request body (same pattern as locationType/locationId) in BOTH the create and edit handlers.
- Both handlers validate: 0 ≤ line discount ≤ qty×unitPrice, and 0 ≤ discountTotal ≤ subtotal+tax.
- Reporting: item-level discounts live only in `line_items` JSONB (sum via `jsonb_array_elements`); pre-discount gross = subtotal + tax + Σ line discounts; "total discount" for an invoice = Σ line discounts + discount_total.
- Counter-settled cash sales that predate the sale_payments legs producer are healed by a one-time boot backfill (history row only: method cash, amount = amount_paid, dated sale_date — NO receipts/vouchers; books never read sale_payments for these, so postings are untouched by construction). Scope rule: only payment_mode=cash AND payment_status=paid rows qualify — legacy rows with amount_paid but status unpaid are contradictory data; inventing history for them would assert a collection nobody recorded.

## Credit-limit guards (Aug 2026)
Both the sale CREATE and EDIT guards read the customer's LEDGER balance via `currentPartyStatement` (opening balances, journals, credit notes and unallocated receipts all count) and BOTH run inside their write transaction under the `customer-credit` advisory lock, taken before any stock row locks.
**Why:** a guard outside the transaction lets two concurrent writes both read the old balance and both pass; and an edit guard using the STORED `amount_paid` projects zero exposure when a settled cash sale is converted to credit (the save path re-derives paid from `sale_payments`, normally 0).
**How to apply:** the edit guard must project the POST-edit paid figure with the save path's own semantics (sum of `sale_payments`), never the stored one; subtract the sale's current contribution only when it already belongs to that customer.

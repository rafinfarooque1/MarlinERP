---
name: Sale Other Charges
description: POS "Other Charges" (packing/freight/hamali) — totals asymmetry vs purchases, books derivation, return policy
---

# Other Charges on POS sales

Raw jsonb column `sales.other_charges` (`[{ledgerId, amount}]`, boot migration — invisible to drizzle, raw SQL everywhere). Shares `lib/otherCharges.ts` validation with purchase bills: postable ACTIVE expense ledger, outside SYS-PUR, non-system code, amount > 0 at paise precision.

## Totals asymmetry vs purchases — INTENTIONAL
- **Sale `total_amount` INCLUDES charges.** Dues, receipts, credit checks, advance capping, customer Dr, PDF grand total all key off `total_amount`, so folding charges in makes every consumer right automatically.
- **Purchase `total_amount` EXCLUDES charges** — every payable reader adds them (see purchase-other-charges.md).
- `subtotal`/`tax_total` stay goods-only on both sides: charges carry NO GST, so taxable value and GST reports are untouched by construction (`invoiceValue` reads total_amount = legally correct invoice value).

**Why:** the sale side has ~10 consumers of "what the customer owes" and one figure feeds them all; the purchase side grew the other way historically and retrofitting either would touch every reader.

**How to apply:** any new consumer of sale money uses `total_amount` as-is; any new revenue/goods analysis must derive goods as `total − tax − otherChargesTotal(other_charges)`, never `total − tax`.

## Books (buildDerivedPostings, sales section)
Revenue Cr = `round2(total − tax − ocTotal)` — forgetting the ocTotal term inflates the P&L by every charge collected. One Cr per charge to its stored ledgerId (an expense RECOVERY — credit balance on an expense ledger is normal here). Dr side (cash/clearing/CUST-) carries the FULL total, so entries balance. `loadLedgerUsage` has a `sales.other_charges` jsonb branch guarding ledger deletes (probe list must include "sales").

## Edit / returns / conversion policy
- PUT: supplied list REPLACES, absent field PRESERVES (via parseStoredOtherCharges of the stored row), `[]` CLEARS. Frontend always sends the list so removing the last row genuinely clears.
- **Returns NEVER refund charges** (by design, mirrors purchase returns): return = goods+GST from lines only; the charge stays owed/paid and its ledger credit stands. Refunding a charge = edit the sale or manual voucher. Documented in returns.ts.
- Quotations carry no charges; conversion starts with `[]`. Branch-transfer invoices never have charges (no producer).

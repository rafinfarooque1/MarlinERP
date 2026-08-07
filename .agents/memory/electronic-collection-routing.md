---
name: Electronic collection routing & per-account reconciliation
description: How bank/UPI sale collections pick a destination account and how the reconciliation switch changes posting; the derived-books trap that comes with it.
---

## The rule
`POST /sales/:id/payments` (the ONE electronic write path) routes bank/UPI money by the sale's location:
- Look up `cash_bank_accounts` assigned to the sale's location with matching `account_type` (`upi`→upi, every other electronic method→bank), active ledger, `ORDER BY id LIMIT 1` (oldest wins — silent pick, no primary-account model yet).
- HO sales match HO accounts on TYPE alone (`location_type='headoffice'` with NULL location_id vs sales' placeholder id 1 — ho-location-convention).
- Assigned + `requires_reconciliation=false` → receipt `received_in` = the account's CBA ledger, `sale_payments.reconciliation_status = NULL` (never appears in the pending queue).
- Assigned + flag true, or no assignment → legacy STD-ELEC-CLR + `'pending'` (unchanged).

`requires_reconciliation` is a raw-migration boolean on cash_bank_accounts (default false; one-time backfill set non-cash rows true to preserve behaviour). Cash never consults it; PATCH rejects the toggle for cash accounts.

## The trap that review caught
The receipt row alone is NOT the books. `buildDerivedPostings()` (journal.ts) excludes sale-linked receipts and REBUILDS collection legs from `sale_payments` — by method, it debited cash-till or STD-ELEC-CLR only. A direct-posted receipt displayed fine but TB/Bank Book/dashboards still debited clearing.

**Fix pattern:** the salePays derivation query joins the linked receipt for `source IN ('allocation','sale')` and, for non-cash legs, debits the sale receipt's `received_in_ledger_id` whenever it differs from STD-ELEC-CLR. Legacy rows stay bit-identical (their receipts point at clearing).

**Why:** any new destination for sale money must be taught to the derivation, not just the receipt writer — the receipt is display, the derivation is truth.

## Known limits (deliberate)
- Multiple same-type accounts on one location: oldest silently receives everything. If this matters, add a primary/routing flag rather than a second query.
- Counter-settled electronic sales at creation and importers still post to clearing; new sales only allow cash/credit so this is mostly moot.
- Toggle vs in-flight payment: unlocked; a payment started before the toggle uses the old policy. Accepted.

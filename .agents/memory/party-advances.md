---
name: Party advances & bill-wise settlement
description: Single-ledger customer advances (credit balance on CUST-), vendor VADV ledger, allocation voucher lifecycle, explicit-first settlement, and report-visibility traps.
---

# Ledger model (asymmetric ON PURPOSE — owner decision, Aug 2026, final)
- **Customer:** ONE ledger per customer (`CUST-<id>`, Sundry Debtors). An advance is that ledger's CREDIT (negative) balance. No CADV ledgers, no "Customer Advances" group — folded away by boot migration `customer_advances_fold_v1` (retries every boot until no CADV row is referenced; only then writes its marker).
- **Vendor:** unchanged — `VADV-<vendorId>` (asset, under STD-GRP-VEND-ADV/SYS-CURA). Prefix length ≠ 5 ON PURPOSE: legacy parsers do `SUBSTRING(code FROM 6)` on `VEND-`/`CUST-` codes and must never match it.
- **Why:** the owner wants one signed figure per customer; "we hold their money" is just the negative side of "they owe us".
- `advanceAvailable('customer')` = max(0, −net(CUST)) — NETTED against everything owed (open bills, credit notes, journals all move it). A customer owing anything shows available 0 even with parked receipts. This is intended, and test expectations must be derived from the net, not from summed advance_amounts.
- `ensureAdvanceLedger('customer', …)` never creates anything — it resolves CUST- or THROWS. Only vendor branch provisions.
- Availability is ledger-authoritative and reads COMMITTED data only — consumers take `pg_advisory_xact_lock(hashtext('customer-advance'|'vendor-advance'), partyId)` FIRST, then re-read inside the txn.

# Posting shape
- Receipt (any excess included): single Cr received_from for the FULL amount. Allocation receipts: bill slices derive via sale_payments (section 5), the advance slice via the `receiptadv:` pass — both credit CUST-.
- Sale `method='advance'` payment leg: Dr CUST- (the invoice debit eats the credit balance). Overpayment leg: Cr CUST- (fallback SYS-DEBTORS). Vendor payment split to VADV unchanged.
- `receipts.advance_ledger_id` is NULL for customers going forward (vendor payments still store VADV). `advance_amount` still marks the parked slice — it drives FIFO attribution and delete guards, NOT the books.

# Allocation vouchers
- Receipts/payments with `allocations` get `source='allocation'`: locked for edit, deletable with a full unwind.
- Delete guard under the advance lock: (1) precise — `advance_consumptions` rows referencing this voucher refuse 409; (2) aggregate `advanceAvailable >= advance_amount` backstop is **VENDOR-ONLY** now. The netted customer figure says nothing about whether THIS voucher's money was used (open bills legitimately absorb it), so it would wrongly block customer deletes.
- Customer side reuses `sale_payments` via `clearing_receipt_id`; vendor side has `payment_bill_allocations` + `purchase_advance_applications`.

# Consumption attribution (advance_consumptions) — UNCHANGED by the fold
- FIFO oldest-voucher-first over receipts keyed by received_from = CUST- ledger + advance_amount > 0; slice rows pin consumption to the parking voucher; NULL-source remainder row. Runs in the consumer's txn under the advance lock (lock order: advance → item → rows).
- Release is symmetric and atomic: purchase delete and sale cancel call `releaseAdvanceConsumption` in the same txn.

# Sale cancellation policy for advances — UNCHANGED
- Non-advance payment → 409 PAYMENTS_RECORDED. Advance-only → cancel proceeds: advance lock EARLY, delete `method='advance'` rows + consumption rows, subtract from amount_paid. Derived postings drop with the rows.

# Explicit-first settlement rule — UNCHANGED
- Pinned money (bill allocations + advance applications) settles its exact bill and NEVER enters the FIFO pool. Every consumer must carve explicit out before the oldest-first walk.

# Reports
- Ageing/receivables `advance` field = max(0, −CUST net), i.e. only visible when credits EXCEED all bills; `netDue` is the signed ledger balance. Advance-only customers surface via the ledger seed (their CUST balance is nonzero-negative now — the old zero-ledger seed problem dissolved).
- Customer list `advanceBalance` = same clamped figure from `advanceBalanceMap('customer')` which now scans CUST- ledgers.

# Report visibility traps (still apply to any NEW money figure)
1. computed map, 2. the SEED loop, 3. the final visibility FILTER — seeded rows are hand-built literals and silently omit new fields.

# Field diagnostic: the rolling-advance / "duplicate receipt" complaint (seen in prod, Aug 2026)
- An owner reporting "the receipt shows the FULL invoice amount but the ledger shows advance + smaller payment" is almost never a books bug — it is ONE allocation voucher: the entered amount exceeded the outstanding (an advance was auto-applied at sale creation), the engine allocated the due and parked the excess as a NEW advance, which auto-applies to the NEXT invoice → the same ₹X advance "rolls" forward every time a cashier types the invoice total instead of the due.
- The Receipt Voucher LIST also shows the sale's trail row (voucher_number = invoice number, source='sale'; for CREDIT sales it displays the full total with zero cash moved), so two same-amount rows sit side by side and look like duplication. buildDerivedPostings excludes trail rows (invoice-number match) and linked allocation slices — verify with: sale-source receipts not matching any invoice AND not in sale_payments.clearing_receipt_id must be ZERO.
- Genuine cash overstatement hides in allocation vouchers where allocated = 0 and the WHOLE amount parked as advance for parties that can't have advances (Walking Customer) — likely re-entries of POS-settled cash. Paise-level advance_amounts (1–4p) are rounding residue, not money.

# Wire contract — UNCHANGED
- Receipt `allocations:[{saleId,amount}]` + optional `advanceAmount` (sum ±0.011); sale/purchase `useAdvance:true` in raw body (zod strips unknown keys — read req.body), response `advanceApplied`, capped min(available, total).
- `GET /accounts/settlement-context?ledgerId=`, `GET /accounts/party-advance?kind=&partyId=`; receipts list marks allocation vouchers `origin:'system', editable:false`.

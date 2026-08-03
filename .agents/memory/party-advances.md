---
name: Party advances & bill-wise settlement
description: CADV/VADV advance ledger design, allocation voucher lifecycle, explicit-first settlement, and the report-visibility traps for advance-only parties.
---

# Advance ledgers
- `CADV-<customerId>` (liability, under STD-GRP-CUST-ADV/SYS-CURL) and `VADV-<vendorId>` (asset, under STD-GRP-VEND-ADV/SYS-CURA). Prefix length ≠ 5 ON PURPOSE: legacy parsers do `SUBSTRING(code FROM 6)` on `VEND-`/`CUST-` codes and must never match an advance ledger.
- **Why:** advance money must not sit on the party's payable/receivable ledger or every "what do we owe" query silently nets it in.
- Availability is ledger-authoritative: `advanceAvailable` = max(0, ∓net) from currentBalanceIndex. It reads COMMITTED data only — any consumer must take `pg_advisory_xact_lock(hashtext('customer-advance'|'vendor-advance'), partyId)` FIRST, then re-read inside the txn.

# Allocation vouchers
- Receipts/payments with `allocations` get `source='allocation'`: locked for edit (PATCH refuses), deletable with a full unwind — refused 409 when the advance slice was already adjusted against a later bill.
- Delete guard is TWO checks under the advance lock, in order: (1) precise — `advance_consumptions` rows referencing this voucher (a second advance replenishing the pool must NOT free a consumed voucher; aggregate arithmetic would); (2) aggregate `advanceAvailable >= advance_amount` as backstop for drains slice-tracking can't see (manual JVs on the advance ledger).
- Customer side reuses `sale_payments` rows linked via `clearing_receipt_id`; vendor side has `payment_bill_allocations` + `purchase_advance_applications` (purchases have no amount_paid).
- Deleting a purchase with an advance application restores the advance automatically — the contra is DERIVED by joining purchases, so removing the row removes the posting.

# Consumption attribution (advance_consumptions)
- Every consumption (sale `useAdvance`, purchase `useAdvance`) writes slice rows pinning the amount to the parking voucher(s), FIFO oldest-voucher-first (`attributeAdvanceConsumption` in advanceLedgers.ts); remainder not covered by any voucher gets a NULL-source row so totals reconcile. Must run in the consumer's txn, under the advance lock, same lock order as create (advance → item → rows).
- **Why:** immutable source references — "which money settled which bill" must never be rewritten by later pool arithmetic.
- Release is symmetric and atomic: purchase delete and sale cancel call `releaseAdvanceConsumption` in the same txn.

# Sale cancellation policy for advances
- `POST /sales/:id/cancel` splits payments: any NON-advance payment → 409 PAYMENTS_RECORDED (unchanged). Advance-only → cancel proceeds: take the advance lock EARLY (before stock restoration, matching create's lock order), delete the `method='advance'` sale_payments rows + consumption rows, subtract from amount_paid. Derived postings drop the CADV debit with the row, so the advance restores automatically.
- **Why:** an adjusted advance is the customer's money merely parked against the bill — no cash changed hands at that bill, so cancel returns the slice instead of stranding the invoice forever.

# Explicit-first settlement rule
- Pinned money (bill allocations + advance applications) settles its exact bill and NEVER enters the FIFO pool. Pool = billed − ledgerBal − explicit. Every consumer (payables ageing, GST purchase register, settlement-context) must carve explicit out before the oldest-first walk or the same rupee settles two bills.

# Report visibility traps (bit us twice in one session)
A new money figure on an ageing report needs THREE hooks, not one:
1. computed map (`advByCustomer`/`advByVendor`),
2. the SEED loop (a party with only that figure has a zero party-ledger and no bills → never enters the row map),
3. the final visibility FILTER (`netDue/totalDue/unallocatedCredit` predicates drop a row whose only nonzero figure is the new one).
Seeded rows are hand-built object literals — they silently omit the new field unless added there too.

# Wire contract
- Receipt: `allocations:[{saleId,amount}]`; payment: `[{purchaseId,amount}]`; optional `advanceAmount` (allocations+advance must equal voucher amount ±0.011). Sale/purchase create: `useAdvance:true` in raw body (zod strips unknown keys — read from req.body), response carries `advanceApplied`; server caps at min(available, bill total).
- `GET /accounts/settlement-context?ledgerId=` (bills keyed saleId/purchaseId, oldest first, branch callers own-location only; non-party ledger → `{kind:null}`), `GET /accounts/party-advance?kind=&partyId=`.
- Receipts list marks allocation vouchers `origin:'system', editable:false` (no `source` field on the wire).

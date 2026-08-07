---
name: Admin system receipt delete
description: level-1 admins may delete sale-sourced receipts with a full unwind; the two receipt shapes reverse differently and every sale_payments writer must serialize on the sale row
---

Rule: sale-generated receipts (source='sale') stay locked in the normal voucher workflow, but a level-1 Administrator can delete one via `POST /accounts/receipts/:id/system-delete` (reason ≥5 chars, audited) with `GET .../delete-impact` feeding the warning dialog. The two shapes unwind differently:

- **Collection receipt** (sale_payments rows point at it via `clearing_receipt_id`): delete the legs, decrement `sales.amount_paid`, recompute `payment_status` via `computePaymentPosition` — same unwind as the allocation-receipt delete.
- **Invoice-trail receipt** (`voucher_number = sales.invoice_number`, excluded from derived books): the reversible slice is `amount_paid − Σ(sale_payments)`, NEVER the raw receipt amount — later edits/collections may own part of the money. Sale matched by invoice number, disambiguated by receipt location when numbers repeat; ambiguous = blocked, zero matches = orphan (plain delete; with no matching sale the exclusion marker no longer fires, so the receipt was posting ordinarily and deleting it just removes that posting).
- Cancelled sales block deletion (terminal-state rule). Every other system source (expense/refund/deposit/settlement) still refuses — those vouchers shadow an owning record.

**Why:** 300+ real sale receipts were undeletable even when a collection was recorded against the wrong invoice; books are fully derived, so the unwind IS the reversal — no journal rows needed.

**How to apply:**
- The `systemDeletable` flag on the receipts list (admin && source='sale') is display routing only; both endpoints re-check level + eligibility + money scope, and the DELETE recomputes the impact under row locks (receipt first, then sales ascending).
- **Concurrency contract:** any writer that derives `amount_paid` from `SUM(sale_payments)` must take the sale row lock FIRST and read the SUM inside that transaction. The sale-edit path was fixed to do this (it previously read the SUM on pool before its txn and could silently overwrite a concurrent receipt unwind).
- Admin check = `hierarchies.level === 1` looked up per request (`isLevelOneAdmin` in routes/accounts.ts); there is no cached level on `req.employee`.
- Frontend: shared `SystemReceiptDeleteDialog` (Vouchers page + operations Receipt Voucher page); reason gates the confirm button; blockers from the impact endpoint disable it.

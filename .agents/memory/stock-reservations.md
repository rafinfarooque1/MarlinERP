---
name: Stock reservations (reserved vs available)
description: How reserved quantity works in Marlin ERP — the two kinds, why in_transit does not reduce availability, and the lock discipline every consumption path must follow
---

# Reserved quantity

`stock_reservations` is the only store for "this stock is already promised". Reserved is
always SUMmed from active rows; there is deliberately **no** mirrored column on the stock or
batch row.

## Two kinds, and the distinction is load-bearing

- **`hold`** — goods still on the shelf and still counted in on-hand stock, committed to a
  document that has not shipped. **Reduces available.**
- **`in_transit`** — goods already deducted from the sender at dispatch, so they sit in no
  location's on-hand figure. **Does NOT reduce available.** Subtracting it would double-count
  the dispatch and refuse orders the business can actually fulfil. It exists so in-flight
  stock stays visible and can be valued, as the **sender's** stock, until receipt.

**Why:** the two kinds answer different questions — one is "can I promise this?", the other is
"where is my money?". Collapsing them into one number breaks whichever question loses.

## `hold` has no producer

There is no order concept in this system (no sales order, quotation or requisition) and sales
deduct stock at creation, so nothing can promise stock it has not already taken. The kind is
implemented and enforced everywhere anyway, so an order document can be added later without
revisiting every consumption site. Do not "clean up" the unused kind.

## Lock discipline (the actual bug that was fixed)

The original double-promise was in sales: availability was read without a lock and the
deduction happened after the read. Two requests both passed.

**How to apply:** every consumption path must, inside ONE transaction: lock the stock row,
read availability from that locked row, then deduct. Reservation writes and releases go in the
same transaction as the movement they describe. Release is by document (`docType` + `docId`)
and idempotent, so a retried approve/reject cannot free stock twice.

Availability is computed from the **stock row**, never from batch totals — batch totals are
known to have drifted from stock rows in both directions, and enforcement built on them would
be wrong from day one. Lot-level reserved figures are for pickers; a hold naming no lot is
reported at product level rather than pinned to an arbitrary batch.

## Release only what is resolved

Releasing a whole document's rows on receipt looks harmless until a receipt is **short**: the
sender's stock is already gone, so the unreceived difference vanishes from on-hand and from
in-transit simultaneously, and both quantity and value silently disappear.

**How to apply:** on a short receipt, keep the shortfall as an active in-transit row owned by
the sender, flagged unreconciled, and surface it in the response. Do not auto-write-off, do not
credit it back to the sender's shelf — either invents a fact. The same test applies to any new
release site: after every terminal state, total valuation must still equal on-hand + in-transit.

## One refusal wording

`insufficientStockMessage` is the single refusal text and names available, on hand, reserved
and requested. A path that writes its own wording will drift from it — manual batch overrides
had their own and were moved onto it.

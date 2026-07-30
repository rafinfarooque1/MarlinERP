---
name: Purchase bill costing & edit reversal
description: What a purchase bill values stock at, and why editing one is refused once the goods have moved.
---

## Inventory is valued at the taxable value, never the gross

Stock, average cost, lots and the stock ledger all take `taxableValue / quantity`
— net of line discount AND net of GST.

**Why:** input GST is recoverable, so it is not part of the cost of the goods; it
is debited to the input-tax heads instead. `buildDerivedPostings` has always
split the bill that way, so valuing stock at the gross rate made the inventory
asset disagree with the books. Under an inclusive rate the gap was the whole tax
amount — a ₹105 inclusive line at 5% was carried at ₹105 instead of ₹100.

**How to apply:** any new write path for a purchase (or anything that mirrors
one) must use the same basis. If a figure is going into stock, it is the taxable
value; if it is going to the vendor, it is the gross.

## Editing a bill is refused once its stock has been consumed

An edit reverses everything the bill added, then re-applies the new lines. Every
reversal in this codebase floors at zero (`GREATEST(0, …)`, `debitBatchByNumber`).

**Why:** a floor cannot express "8 of these are already gone". Buy 10, issue 8,
re-save the bill unchanged, and the reversal removes only the 2 that are left
while the re-apply puts all 10 back — the location silently ends up holding 10
instead of 2. The transaction makes that atomic, which only means it commits the
wrong number reliably.

**How to apply:** check the lot AND the location balance under `FOR UPDATE`
before writing anything, and return 409 telling the user to reverse the
movements or raise a purchase return. Note `FOR UPDATE` is rejected on an
aggregate query — select the rows and sum them in JS.

## A reversed quantity must reverse its average cost too

Decrementing the quantity while leaving `avg_cost` alone makes the
post-purchase average the baseline for the replacement line, so every re-save
drifts the valuation further.

**Why:** the weighted average is a running figure, not a stored history.

**How to apply:** unwind with `(qty*avg − outQty*outCost) / (qty − outQty)`,
computed from the balance that still includes the line. Exact while this inbound
is the latest one; approximate once later purchases have rolled in — the only
real fix is replaying movements, which the schema does not currently support.

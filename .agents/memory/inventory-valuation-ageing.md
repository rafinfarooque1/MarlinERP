---
name: Inventory valuation and ageing
description: The one at-cost valuation (all three product kinds + in-transit) and the ageing/movement-class rules, including why reported profit moved
---

# Valuation

`stockValuation()` serves the live stock valuation report, dashboard stock tile and current/no-end-date P&L closing stock. Historical P&L/Balance Sheet uses a separate `stockAsOf()` reconstruction; the historic reader paths are not identical.

The live valuation covers **all three product kinds** (finished goods, raw materials, packing
materials) across every location, and appends in-transit rows at their dispatched cost, owned
by the sender.

Every roll-up (per location, per kind, per product, grand total) is derived from the same row
set, so a drill-down always sums to the headline. A new `SUM(quantity * cost)` anywhere is a
defect, not an optimisation.

Transfer line and batch costs remain the traceable inventory cost, but an active in-transit
reservation must use the product weighted-average valuation cost used for on-hand stock.
Otherwise dispatch temporarily changes closing stock and P&L until receipt.

**Why:** a FEFO lot can cost differently from the product-wide average; mixing those bases makes
an otherwise neutral transfer appear to create or destroy inventory while it is in transit.

**How to apply:** preserve lot cost/date/batch identity on the transfer and destination rows, but
pass the product valuation cost to in-transit reservation valuation.

## Historical statement and valuation readers are distinct

The as-of stock valuation report uses checkpoint-backed evidence and excludes rows with missing
or mismatched checkpoints, negative historical quantity, or missing historical cost. Its route
disables in-transit rows when an `asOf` cutoff is supplied. In the live path, transit without a
positive dispatch cost is omitted and reported. Historical P&L/Balance Sheet instead rewinds
current quantity through `stock_ledger`, uses a persisted checkpoint when present, and falls
back to current product-master cost when no dated checkpoint exists while marking the result
unreliable. That statement path also adds sender-owned in-transit stock using the historical
transfer lifecycle.

**Why:** the two readers answer related but not identical historical questions. Treating their
numbers as interchangeable can hide a difference in evidence policy or transit inclusion.

**How to apply:** keep each route's evidence and transit policy explicit; compare historical
outputs only against a declared rule and verified fixtures before sharing or replacing either
implementation.

**Valued at cost, never MRP.** Closing stock used to be MRP-priced and read from a retired
counter.

**Consequence to state out loud whenever this is touched:** reported profit changed when
closing stock started including materials, in-transit and cost pricing. The in-transit portion
is reported as its own figure so the difference is auditable instead of mysterious. Producing
alone still moves net profit, because finished goods enter closing stock.

**Scoping asymmetry to watch:** on-hand rows are filtered in SQL, in-transit rows are
post-filtered in JS. Any change to location scoping has to be applied to both, or a
warehouse user sees another location's in-flight goods.

# Ageing

Expiry tiers (7 / 15 / 30 / 60 / 90 days, plus expired and no-expiry-date) and movement classes
(fast / slow / dormant / dead) live in one module as data, never as literals in SQL, so a
report, a tile and a future alert cannot disagree about what "near expiry" means. A lot falls
in the **narrowest** tier it qualifies for, so it is counted once. No expiry date is its own
bucket — a data gap, not a fresh lot.

**Movement class is measured from the last OUTBOUND movement**, not any movement.

**Why:** receiving more of something that never leaves does not make it alive; an inbound-only
history is exactly what dead stock looks like.

**How to apply:** the stock ledger has holes and a recent start date, so rows with no ledger
history are flagged as such and the ledger's start date is reported alongside. Never present
"dead" as a fact about stock that predates the ledger.

---
name: Inventory valuation and ageing
description: The one at-cost valuation (all three product kinds + in-transit) and the ageing/movement-class rules, including why reported profit moved
---

# Valuation

One function serves the stock valuation report, the dashboard stock tile and P&L closing stock.
It covers **all three product kinds** (finished goods, raw materials, packing materials) across
every location, and appends in-transit rows at their dispatched cost, owned by the sender.

Every roll-up (per location, per kind, per product, grand total) is derived from the same row
set, so a drill-down always sums to the headline. A new `SUM(quantity * cost)` anywhere is a
defect, not an optimisation.

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

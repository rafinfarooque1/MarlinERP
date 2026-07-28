---
name: Historical stock positions are mostly not derivable
description: Why "stock as at a past date" cannot be trusted in this ERP, and what the only trustworthy anchors are.
---

# Historical stock positions are mostly not derivable

`stock_entries` holds only **today's** quantity. There is no dated inventory
sub-ledger. So any "stock as at <past date>" figure is a reconstruction, and the
reconstruction is usually not sound.

## The trap

`stock_ledger.created_at` is the timestamp the **row was inserted**, not the
business date the goods moved. The table has no business-date column at all.
Two consequences that look fine until you check them:

- Rewinding today's quantity through movements "after" a past date silently
  rewinds through *insert* order, not trading order.
- `MIN(created_at)` is when **logging started**, not when **trading started**.
  Treating a date before it as "the business held nothing" is false whenever the
  log is younger than the data — which it is here, because the log was added
  after seeded/live stock already existed.

Transfers make it worse: a transfer records a dispatch date but **no receipt
date**, so which shipments were in transit on a past date is unrecoverable. Any
historical closing stock therefore excludes in-transit goods.

## The rule

Financial statements must date closing stock to the period's `toDate`, never to
today — using today's stock for a historical period corrupts COGS, net profit
and balance-sheet inventory simultaneously. But a dated figure is only
trustworthy when the movement log **fully explains today's quantity** on every
product+location line. Check that first; it is what decides whether the log can
be read as a complete history.

The one fact that survives an incomplete log: **before the earliest
stock-moving business document there was no stock.** Derive that from the
documents' own business dates (purchase/sale/production/transfer dates), not
from the log. Without this anchor every normal financial-year statement flags
its own opening stock as unknowable, because the log cannot reach back to the
1 April before trading began — a false alarm on the default range, which is the
fastest way to make users ignore the integrity banner entirely.

**Why:** an unreliable inventory number that *looks* confident is worse than one
labelled unknown — it flows into COGS, profit and total assets at once, and the
statements still balance while being wrong, so nothing catches it.

**How to apply:** when a period's stock cannot be established, still return a
figure (statements must balance) but mark it unreliable **and** raise a real
integrity issue. Never substitute today's stock, and never substitute zero —
both are fabrications that read as facts.

## The zero-today trap (easy to miss, silently wrong)

The at-cost valuation helpers filter `quantity > 0`, because for *today's*
position an empty line is genuinely nothing. A historical rewind that takes its
keys from those helpers inherits the filter and drops every product+location
that is empty **now** — which is precisely the stock that was sold out,
consumed or transferred away during the period, i.e. the lines a past-date
statement most needs.

It fails twice over: the line is missing from the total, and because it was
never visited it is never reconciled either, so the result is still reported as
*reliable*. A confident wrong number, which is the exact failure the rest of
this file exists to prevent.

**How to apply:** source the rewind's key set from the **union** of the quantity
truth (`stock_entries`, unfiltered, zeros included) and every key in the
movement log. A key the log knows about but that has no `stock_entries` row is a
**zero baseline, not an absent one**. Take cost from the product master
(avg-cost-else-cost) rather than from a positive-only valuation view, so the
filter cannot creep back in.

Related: product ids are only unique **within** a kind — a finished good, a
material and a packing material can all be id `1`. Anything keyed by stock item
(maps, React keys, dedupe) must key on `materialType:id`.

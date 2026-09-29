---
name: Location-authoritative inventory costing
description: Rules for preventing cross-location average-cost changes from creating false P&L and for preserving transfer value through rounded stock rows.
---

Inventory statements must value each location's quantity using its latest exact product/location cost checkpoint, not a mutable global product average. A purchase at another location can change the global average without changing this location's stock, so live master costing creates artificial Gross Profit. Transfer dispatch, in-transit value, and receipt must share the sender's checkpoint cost; the original dispatch reservations preserve that basis for legacy ledger rows and partial-receipt replacements. Transfer-in checkpoint fallback uses the sender location, and batch breakdown costs remain lot traceability rather than location valuation. When legacy stock rows round cost to paise, reports must retain the precise blended cost in the dated checkpoint through value calculation.

**Why:** The 15 September production cases showed Gross Profit with no same-day movement: Ecity was revalued by ₹5,793.72 and Calicut by ₹3,062.95. Transfer tests also found legacy movement and replacement-reservation costs diverging, plus a one-paise gain when a precise blended value was rounded before multiplication.

**How to apply:** Keep quantity truth in `stock_entries`, use the latest exact location checkpoint for valuation with master-cost fallback only when absent, reuse the original dispatch reservation consistently across movement and transit boundaries, and test no-activity cross-location repricing plus dispatch/receipt neutrality at paise precision.
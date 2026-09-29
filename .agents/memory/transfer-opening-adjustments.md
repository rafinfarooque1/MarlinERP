---
name: Transfer opening-stock adjustments
description: How periodic books keep stock transfers neutral without double-counting closing inventory
---

For each scoped location, the period transfer adjustment is:

`dated transfer-ledger movement value + closing sender-owned transit value - opening sender-owned transit value`

Use the day before `fromDate` for the opening transit boundary and `toDate` for the closing boundary. Closing stock valuation still includes transit owned by the sender. The boundary delta handles transfers dispatched before the period, transfers still pending at both ends, and partial receipts without double-counting. Transfer ledger postings remain available for audit but must not enter operating revenue, expenses, COGS, or Gross Profit.

For transfer movements, use the complete original dispatch-reservation set as the sender's persisted cost basis, even when a legacy ledger row or replacement shortfall reservation carries a different lot cost. Reuse that basis for receipt movements and in-transit shortfalls. If it is unavailable, use the dated sender-location checkpoint, then a positive recorded movement or saved line cost. `batchBreakdown` is lot traceability, not proof of location-average value. A completed transfer with unknown cost may be treated as neutral only in a consolidated scope when both sides balance and no transit remains at either boundary; its cost is still unknown for branch statements.

**Why:** Movement-only adjustments omit old shipments received during the period and misstate Gross Profit; treating Transfer-In/Out account balances as trading activity also creates artificial profit from internal relocation. Applying both transit boundaries makes the adjusted opening position reconcile to physical closing stock.

**How to apply:** Keep the same location identity scope as stock valuation, use original dispatch reservations consistently for transfer movement and transit values, and resolve transfer-in checkpoint fallback from the sender location. Never turn missing cost into a zero-cost valuation; only allow exact unknown-pair cancellation for completed consolidated transfers. Keep raw account postings as memo/audit data, outside operating subtotals.
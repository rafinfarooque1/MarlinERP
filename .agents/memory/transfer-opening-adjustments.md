---
name: Transfer opening-stock adjustments
description: How periodic books keep stock transfers neutral without double-counting closing inventory
---

For each scoped location, the period transfer adjustment is:

`dated transfer-ledger movement value + closing sender-owned transit value - opening sender-owned transit value`

Use the day before `fromDate` for the opening transit boundary and `toDate` for the closing boundary. Closing stock valuation still includes transit owned by the sender. The boundary delta handles transfers dispatched before the period, transfers still pending at both ends, and partial receipts without double-counting. Transfer ledger postings remain available for audit but must not enter operating revenue, expenses, COGS, or Gross Profit.

Use recorded positive movement cost or a dated cost checkpoint. For transit, use the dispatch reservation's cost/value. If historical cost is unavailable, mark the valuation unreliable; do not invent it from today's mutable product master.

**Why:** Movement-only adjustments omit old shipments received during the period and misstate Gross Profit; treating Transfer-In/Out account balances as trading activity also creates artificial profit from internal relocation. Applying both transit boundaries makes the adjusted opening position reconcile to physical closing stock.

**How to apply:** Keep the same location identity scope as stock valuation, derive each transfer's dated movement values from `stock_ledger`, and derive in-transit boundary values from active reservations. Keep the raw account postings as memo/audit data, outside all operating subtotals.
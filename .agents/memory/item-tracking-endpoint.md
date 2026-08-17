---
name: Item Tracking endpoint
description: Design rules for the read-only product lifecycle endpoint (per-item purchases/sales/returns/transfers/production history + summary buckets).
---

**Rule:** the lifecycle view derives from SOURCE DOCUMENTS (purchases/sales/returns/transfers/productions/adjustments JSONB line scans), never from stock_ledger. Summary buckets exclude cancelled and branch-transfer documents; history still LISTS them, flagged, so the trail stays complete.

**Why:** stock_ledger is an audit trail with write strategies that vary by route and an insert-time created_at — reconstructing "what happened to this product" from it double-counts and mis-dates. Source documents are the truth the rest of the books already derive from.

**How to apply:**
- Line-key conventions differ per document family: sales/sales_returns/transfers key `itemId`; purchases/purchase_returns key `materialId`+`materialType`.
- Absent `materialType` on a purchase line defaults to **'item'** — that matches the purchase module's own identity paths (batch identity, stock-ledger writes). A 'material' default silently hides legacy finished-item purchases; the permanent suite pins a type-less fixture line.
- Valuation fields are OMITTED (never zeroed) without the stock-valuation right; LBAC scope fragments are injected per document family with each table's own location convention.
- Current stock comes from stock_entries (qty truth), scoped the same way; stockByLocation must sum to it.
- The UI's running Balance column is computed CLIENT-side, walked BACKWARDS from summary.currentStock (newest row's balance = current stock) — never forward from a fake opening balance, because the 200-per-family cap truncates old history. Rows with zero effect (cancelled, branch transfers — global balance unchanged, rejected transfers) carry the balance through unchanged and render muted; the truncation note must say the oldest visible balance is NOT an opening balance.

## Rendering the histories as a movement timeline
Cancelled documents and branch-transfer twin invoices appear in the history arrays FLAGGED — they moved no
live stock (the transfer itself is its own neutral row). Any timeline that shows signed qty deltas must
render those rows delta-less, or it overstates movement. The endpoint is item-GLOBAL (all locations in the
caller's scope, header view filter ignored): label per-location detail screens accordingly instead of
trying to scope it client-side.

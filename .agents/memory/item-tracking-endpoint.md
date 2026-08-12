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

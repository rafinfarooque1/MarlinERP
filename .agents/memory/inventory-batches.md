---
name: Inventory batch layer
description: Phase-3 batch/expiry/valuation invariants future inventory & costing work must stay consistent with
---

# Inventory batch layer — design invariants

- **stock_entries stays the single source of truth for quantities.** `stock_batches` is an ADDITIVE lot layer; reports and drill-downs join it, but quantity math never depends on it. A batch shortfall is legal and rendered as "Untracked" residual (legacy stock predates batch tracking).
  **Why:** batch tracking was retrofitted; forcing full batch coverage would have blocked all existing flows.
  **How to apply:** any new flow that moves stock updates stock_entries first; batch consumption/creation piggybacks and is clamped (never negative, never a hard failure on shortfall).
- **FEFO everywhere:** earliest expiry first, NULL expiry last. Consumption helpers clamp to available batch qty.
- **Weighted-average cost** (`items.avg_cost`) updates on production completion and item purchases; legacy stock was seeded by startup migrations with price-fallback chain. Phase-5 costing must extend, not replace, this.
- **Optional API passthrough fields:** zod route schemas strip unknown keys, so optional additive fields (e.g. transfer `batchOverride`) are read from the RAW request body in the route while zod validates the rest. Alternative is regenerating the whole spec/codegen chain for every additive field.
  **How to apply:** fine for optional metadata; anything required or security-relevant must go into openapi.yaml (source of truth) + codegen instead.
- **Server-side override validation:** manual batch overrides must sum exactly to the line quantity, reference batches owned by (item, source location), and fit availability — validated inside the consuming transaction with row locks (id-sorted to avoid deadlocks). UI enforces it too but server is authoritative.
- **State transitions = atomic claims:** flip voucher/transfer status via conditional \`UPDATE … WHERE status='<expected>' RETURNING\` inside the same tx as the stock effects. Read-then-check-then-write status double-applies under concurrency.
- **Batch decrements always carry an owner predicate** (item + location in the WHERE, FOR UPDATE): a crafted batch id must never touch another item's or location's rows.
- **Sales-location pages** (`/sales/*`) read a localStorage-backed location context; pages must redirect to `/sales` picker when unset (returning null blanks the whole page — no error boundary).

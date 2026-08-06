---
name: Warehouse lifecycle (disable / permanent delete)
description: Disabled-warehouse guards on every transaction producer; permanent delete = one txn cascade + post-delete validation; blockers vs deletable rationale.
---

# Warehouse lifecycle

## Disable (reversible)
- `warehouses.disabled_at/disabled_by` are RAW startup-migration columns (invisible to generated types — list route selects them explicitly, client casts `(w as any).disabledAt`).
- `disabledWarehouseError(queryable, locs[])` in api-server `lib/warehouseLifecycle.ts` is the ONE guard helper. Outlets inherit their parent warehouse's disabled state.
- The guard must run on the EFFECTIVE resolved location (after resolveActingLocation / resolveMoneyVoucherLocation / resolveVoucherLocation etc.), never the raw body. Inside-transaction call sites must ROLLBACK before returning 409.
- Guarded producers: sales, purchases, quotations (create+edit), production, stock transfers (both endpoints), payments/receipts/location-expenses, journal vouchers (create+edit), returns, stock verification, rent pay, import approve/commit, payroll pay + advances, asset purchases, cash deposits. **Any NEW transaction producer must add this guard** — receiving in-transit transfers and record edits stay allowed by design (wind-down).

## Permanent delete (Super-Admin only)
- All lifecycle routes gated by `requireLevelOne` (hierarchy level === 1, fails closed).
- Two-step UI: choice dialog recommending Disable (shows delete-summary counts + blockers) → typed `DELETE <name>` phrase. Server re-checks the phrase against the CURRENT name INSIDE the txn (rename race), re-checks blockers inside the txn too.
- One txn + advisory lock; cascade is children-first; parties deleted only if unreferenced elsewhere, else restamped to NULL location; own ledgers deleted only if unreferenced; ends with `sweepOrphanPartyLedgers`.
- **Blockers (409, never cascaded)**: outlets attached, stock transfers touching the WH (would corrupt the counterparty), employees assigned, asset purchases, cash deposits, import batches/migrations, ledgers shared with an outlet mirror.
- Post-delete validation inside the same txn: zero remaining rows per stamped table, own ledgers gone, TB debit==credit, no orphaned JV lines — any failure rolls the whole thing back and returns 409 with `failures[]`.

**Why:** deletion in a location-stamped double-entry system either takes everything in one atomic validated sweep or corrupts a counterparty; anything cross-location is a blocker, not a cascade target.

**How to apply:** adding a new warehouse-stamped table? Add it to the cascade, the summary counts, AND the post-delete validation list — the validation is what catches a forgotten table at runtime.

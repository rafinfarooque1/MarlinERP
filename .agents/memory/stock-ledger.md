---
name: Stock Ledger implementation
description: Append-only audit table for every inventory movement; how writes are wired into each mutation route.
---

## The rule
Every stock mutation writes one or more rows to `stock_ledger` — an append-only table (no UPDATE/DELETE). Running balance is computed via a window function at query time, not stored.

## Table (startup migration in index.ts)
```sql
CREATE TABLE IF NOT EXISTS stock_ledger (
  id BIGSERIAL PRIMARY KEY,
  txn_type TEXT NOT NULL,        -- purchase | purchase_reversal | production_consumption |
                                 --   production_output | transfer_out | transfer_in |
                                 --   sales_return | purchase_return
  material_type TEXT NOT NULL,   -- item | material | raw_material
  ref_id INTEGER NOT NULL,
  item_name TEXT, unit TEXT,
  branch_type TEXT, branch_id INTEGER, branch_name TEXT,
  qty_change NUMERIC(14,4) NOT NULL,  -- signed: + = in, - = out
  unit_cost NUMERIC(14,4),
  doc_type TEXT, doc_id INTEGER, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Helper: `artifacts/api-server/src/lib/stockLedger.ts`
- `writeStockLedger(db, entries[])` — bulk INSERT, works with both pool and transaction client
- `batchResolveMeta(pool, lines[])` — resolves name+unit for a batch of (materialType, refId) pairs

## Write strategy per route
| Route / event | Strategy | Location in code |
|---|---|---|
| purchases CREATE | fire-and-forget after stock loop, before Patch | purchases.ts |
| purchases UPDATE (full edit) | 2 fire-and-forget: reversal of old lines, then re-apply of new lines | purchases.ts |
| purchases DELETE | fire-and-forget before db.delete | purchases.ts |
| production CREATE | `await writeStockLedger(client, ...)` INSIDE transaction, before COMMIT | production.ts |
| production DELETE | `await writeStockLedger(client, ...)` INSIDE transaction, before DELETE | production.ts |
| transfer dispatch | `await writeStockLedger(client, ...)` INSIDE transaction; names from RETURNING + pool lookup for items | stock.ts |
| transfer approve | fire-and-forget AFTER transaction, uses batchResolveMeta | stock.ts |
| transfer reject | fire-and-forget AFTER transaction, uses batchResolveMeta | stock.ts |
| sales return | fire-and-forget AFTER transaction (after ret INSERT) | returns.ts |
| purchase return | fire-and-forget AFTER transaction (after ret INSERT) | returns.ts |

## API endpoint
`GET /stock/ledger` — paginated, filters: q, from, to, materialType, txnType. Returns runningBalance via window function over ALL history (not just filtered window), so balance is always correct even when filtering by date.

## Frontend
- Page: `artifacts/marlin-erp/src/pages/headoffice/StockLedger.tsx`
- Hook: `lib/api-client-react/src/stock-ledger.ts` → `usePaginatedStockLedger`
- Route: `/headoffice/stock-ledger`
- Registry key: `'Stock Ledger'` under Inventory nav group

**Why fire-and-forget for most routes:** The ledger is an audit trail, not transactional. A ledger write failure must never block the main stock operation. For production (always uses txn client), the writes are inside the transaction for full atomicity.

**Why transfer dispatch writes INSIDE transaction:** It already has the RETURNING names from the UPDATE queries, making in-transaction writes cheap and avoiding an extra round-trip.

---
name: LBAC Implementation
description: Location-Based Access Control — which routes are scoped how, and the key decisions made.
---

## Summary
Full LBAC implemented across the API. Three user types: Head Office (sees all), Warehouse (own warehouse + child outlets), Outlet (own outlet only). All filtering enforced on the backend — frontend never trusted.

## Key helpers
- `getUserDataScope(emp)` → `{ isHeadOffice, warehouseIds, outletIds }`
- `scopeSalesWhere(scope, params, alias?)` — appends to params, returns SQL condition for `sales` table
- `scopeBranchWhere(scope, params, alias?)` — for tables with `branch_type`/`branch_id`
- `scopeLocationTypeWhere(scope, params, alias, includeHeadoffice?)` — for tables with `location_type`/`location_id` columns

## Startup migrations added (in index.ts)
- `vendors`: `location_type TEXT DEFAULT 'headoffice'`, `location_id INT DEFAULT 0`
- `purchases`: `branch_type TEXT DEFAULT 'headoffice'`, `branch_id INT DEFAULT 1`

## Decision: Purchases are Head Office only
All purchases recorded at HO. Warehouse/outlet users get empty on all purchase endpoints.

## Decision: GST is Head Office only
GSTR-1, GSTR-3B, HSN summary, GST reconciliation, GST summary — all return empty for non-HO.

## Decision: Double-entry accounting is Head Office only — PARTLY REVERSED
Journal vouchers, day book, trial balance, cash-bank book, financial statements: still HO-only.
**Money vouchers are no longer HO-only.** Payments, receipts and ledger statements are now
location-scoped so each warehouse runs its own till. See `money-voucher-ownership.md`.

**Money scope ≠ LBAC scope.** `getUserDataScope` hands a warehouse every outlet it supplies —
fine for stock, wrong for cash (it would let one location spend another's till, and retired
outlets share ledger ids with warehouse rows). Money paths use an own-location-only scope
instead; sales/purchases *inside* a ledger statement keep the wider scope.

## Decision: Production is Head Office only
Production batches and production reports return empty for non-HO users.

## Per-file status

| File | Scope applied |
|---|---|
| `customers.ts` | GET /customers → scopeLocationTypeWhere; GET /vendors → scopeLocationTypeWhere(includeHO=true); POST /customers and POST /vendors → stamp location from session |
| `search.ts` | All 4 search queries scoped |
| `sales.ts` | GET /sales → scopeSalesWhere (pre-existing); GET /sales/summary → scopeSalesWhere |
| `returns.ts` | GET /sales-returns → scopeLocationTypeWhere; GET /purchase-returns → HO-only; receivables → scopeSalesWhere; payables → HO-only; collections → scopeSalesWhere |
| `purchases.ts` | GET /purchases → HO-only |
| `reports.ts` | sales-by-item, sales-by-location, profitability, discounts, sales-stock-combined → scopeSalesWhere; purchase-register, purchases-by-vendor, purchases-by-material → HO-only |
| `accounts.ts` | GET /expenses → HO gets both direct+location; non-HO gets only their cash ledger location expenses; location-expenses/summary, /all, /single → scoped to location; payments, receipts, ledger-statement, ledger/:id/statement, cash-bank-ledgers → own-location scoped (see `money-voucher-ownership.md`); gst/summary, financial-statements → HO-only |
| `gst.ts` | All 4 endpoints → HO-only |
| `journal.ts` | journal-vouchers, day-book, trial-balance, cash-bank-book/ledgers, cash-bank-book → HO-only |
| `production.ts` | GET /productions, GET /productions/reports → HO-only |
| `reconciliation.ts` | GET /reconciliation/pending → outlet users auto-scoped to their outlet |
| `dashboard.ts` | 3 dashboard handlers already scoped via scopeSalesWhere (pre-existing) |
| `stock.ts`, `hr.ts`, `cash-in-outlet.ts`, `inventory-batches.ts` | Pre-existing scoping via scopeBranchWhere |

## Vendor location stamping
- Outlet/warehouse employees: their session `branchType`/`branchId` is stamped onto new vendors they create
- HO users: can optionally pass `locationType`/`locationId` in the request body to assign to a specific location; defaults to headoffice (shared)
- HO-created vendors (headoffice) are visible to all locations via `includeHeadoffice=true`

## Location expenses for non-HO
Non-HO users on `/expenses`: directExpenses=[] (expenses table is HO-level); only location expenses whose `paid_from_ledger_id` matches their location's `cash_ledger_id` are returned.

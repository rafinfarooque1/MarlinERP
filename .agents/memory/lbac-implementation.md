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

## Decision: Purchases are Head Office only — REVERSED
Purchases now take a body-selectable location validated against scope. Legacy purchases with
NULL `location_type` = headoffice/1. **This is a purchases-only convention**: legacy sales with
NULL `location_type` COALESCE to `'outlet'` (with `outlet_id`) — never assume the two tables
share a legacy default.

## Decision: GST is Head Office only — REVERSED (Aug 2026)
Branch sessions are now PINNED to their own registration inside `parseGstScope` (gst.ts) and
`/gst/summary` (accounts.ts): warehouse → own GSTIN scope, outlet → parent warehouse's, orphan
outlet → empty scope (matches nothing). Query params/view header cannot widen the pin.
`/gst/filters` returns only the branch's own registration group. **GST reconciliation stays
HO-only on purpose** (books-vs-register self-check is a filing activity).

## Decision: Double-entry accounting is Head Office only — PARTLY REVERSED
Journal vouchers, day book, trial balance, cash-bank book: still HO-only.
**Financial statements are no longer HO-only**: branch users get their own location slice
pinned server-side (view header cannot widen), with `companyLevel` nulled — the company-wide
remainder is HO information.

## Returns act at the DOCUMENT's location (Aug 2026)
Sales/purchase returns derive every stock op, refund ledger, and note stamp from the sale's/
purchase's stored location — never the caller's. POST guards: caller must have the document's
location in scope (404 for foreign — scoped list ≠ scoped resource). Credit/debit notes are
stamped with that location (JV convention: HO stores id 0, matched on type alone);
`note_voucher_location_stamp_v1` boot migration repaired pre-existing NULL-stamped notes.
HO walk-in refunds fall back to STD-CASH/STD-SALES, mirroring sale derivation.
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
| `returns.ts` | GET /sales-returns → scopeLocationTypeWhere; GET /purchase-returns → scoped via joined purchase's location; POST both returns → document-location scope guard (404 foreign); receivables → scopeSalesWhere; collections → scopeSalesWhere |
| `purchases.ts` | location-selectable, validated against scope (no longer HO-only) |
| `reports.ts` | sales-by-item, sales-by-location, profitability, discounts, sales-stock-combined → scopeSalesWhere; purchase-register, purchases-by-vendor, purchases-by-material → HO-only |
| `accounts.ts` | GET /expenses → HO gets both direct+location; non-HO gets only their cash ledger location expenses; location-expenses/summary, /all, /single → scoped to location; payments, receipts, ledger-statement, ledger/:id/statement, cash-bank-ledgers → own-location scoped (see `money-voucher-ownership.md`); gst/summary → branch pinned to own registration; financial-statements → branch pinned to own location |
| `gst.ts` | branch sessions pinned to own registration via parseGstScope; reconciliation HO-only |
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

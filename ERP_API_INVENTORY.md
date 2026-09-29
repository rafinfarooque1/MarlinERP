# Frozen Fruits ERP — API Inventory

**Audit status:** PARTIAL — static route manifest, OpenAPI reconciliation, and source review of route-level guards/effects completed; exact per-operation contracts, callers, and end-to-end effects remain open
**Snapshot date:** 2026-09-29  
**Production database:** NOT QUERIED  
**Functional changes:** none

## Scope and counting rules

This inventory is a static source scan, not a live HTTP probe. `artifacts/api-server/src/app.ts` mounts the business router at `/api`; `artifacts/api-server/src/routes/index.ts` mounts 42 router modules without additional module prefixes. The route paths below are therefore the path literals after `/api`. Dynamic `:id` parameters are normalized for method/path comparison. The scan found:

- **410 unique method/path route declarations** across 42 route modules; no duplicate method/path pairs in the scanned declarations.
- OpenAPI declares 66 path keys and 110 HTTP operations. All 110 matched a route declaration after parameter-name normalization; 300 declared operations are absent from OpenAPI; no OpenAPI-only operation was found.
- The 110 OpenAPI operations' operation IDs, declared parameters, request bodies, and success response shapes are indexed in `ERP_API_OPENAPI_CONTRACTS.md`. These are specification declarations, not runtime-verified contracts.
- These counts do not prove every route is reachable at runtime under all mount conditions, nor do they prove that an absent frontend caller means an endpoint is unused.

### OpenAPI operation coverage by router

`Documented` means the route's normalized method/path pair occurs in `lib/api-spec/openapi.yaml`. The spec-declared request/response shapes are catalogued in `ERP_API_OPENAPI_CONTRACTS.md`, but have not been verified against runtime handlers.

| Router | Source operations | In OpenAPI | Not in OpenAPI |
|---|---:|---:|---:|
| `accounts` | 43 | 11 | 32 |
| `adminRenumber` | 4 | 0 | 4 |
| `assets` | 13 | 0 | 13 |
| `audit` | 2 | 0 | 2 |
| `auth` | 6 | 4 | 2 |
| `backup` | 14 | 0 | 14 |
| `bom` | 5 | 0 | 5 |
| `branches` | 14 | 10 | 4 |
| `cash-in-outlet` | 4 | 0 | 4 |
| `company` | 11 | 5 | 6 |
| `customers` | 17 | 12 | 5 |
| `dashboard` | 8 | 3 | 5 |
| `dispatch` | 2 | 0 | 2 |
| `financialReports` | 11 | 0 | 11 |
| `gst` | 6 | 0 | 6 |
| `health` | 3 | 1 | 2 |
| `hr` | 37 | 20 | 17 |
| `imports` | 29 | 0 | 29 |
| `integrity` | 1 | 0 | 1 |
| `inventory` | 20 | 15 | 5 |
| `inventory-batches` | 9 | 0 | 9 |
| `invoiceShareLinks` | 6 | 0 | 6 |
| `itemTracking` | 1 | 0 | 1 |
| `journal` | 10 | 0 | 10 |
| `payments` | 2 | 0 | 2 |
| `pdfGen` | 12 | 0 | 12 |
| `periods` | 5 | 0 | 5 |
| `production` | 6 | 3 | 3 |
| `publicInvoices` | 1 | 0 | 1 |
| `publicQuotations` | 1 | 0 | 1 |
| `purchases` | 5 | 3 | 2 |
| `quotationShareLinks` | 6 | 0 | 6 |
| `quotations` | 14 | 11 | 3 |
| `reconciliation` | 23 | 2 | 21 |
| `rent` | 10 | 0 | 10 |
| `reports` | 12 | 0 | 12 |
| `returns` | 9 | 0 | 9 |
| `sales` | 12 | 6 | 6 |
| `search` | 1 | 0 | 1 |
| `stock` | 7 | 4 | 3 |
| `storage` | 2 | 0 | 2 |
| `storageLocations` | 6 | 0 | 6 |

## Authentication, permission, and location policy

- The global `/api` guard requires a Bearer-authenticated session for all operations except the explicit paths below. The authenticated user is re-resolved server-side.
- Global-auth exceptions: health-check exact paths; `POST /api/auth/login`; `GET /api/public/invoices/*`; `GET /api/public/quotations/*`; `GET /api/share/invoice/*`; `GET /api/share/quotation/*`; and exact `GET /api/public/app`, `/api/public/app/apk`, `/api/public/app/info`. The public document/share handlers apply route-specific token checks. `/api/health` is an auth exception but no corresponding route declaration was found.
- Most business route modules use `requireModuleView` for reads and `requireModuleAction` for writes/downloads. Permission keys, role requirements, and location checks differ by route; they have not been expanded for all 410 operations. Do not infer authorization or location behavior from HTTP method or router name.
- Auth, admin invoice renumbering, search, storage, and some company/period reads have custom or no visible route-local module guard. This is not a statement that they are unauthenticated: the global guard still applies unless explicitly excepted.
- `ROLE`, `LOCATION SCOPE`, `INPUT`, `OUTPUT`, `SERVICE`, `DATABASE`, `ACCOUNTING`, `INVENTORY`, `GST`, `AUDIT`, and exact `USED BY UI` remain **NOT VERIFIED per operation** unless documented in the workflow and report traces in `ERP_CURRENT_SYSTEM_MASTER.md` and `ERP_REPORT_INVENTORY.md`.

## Route-level guard and effect review

Source review covered all 42 routers and 410 declarations in three disjoint groups:

1. 12 routers / 84 operations: `sales`, `payments`, `purchases`, `returns`, `stock`, `inventory`, `inventory-batches`, `production`, `bom`, `itemTracking`, `storage`, `storageLocations`.
2. 11 routers / 145 operations: `accounts`, `journal`, `financialReports`, `reports`, `gst`, `reconciliation`, `dashboard`, `cash-in-outlet`, `periods`, `rent`, `assets`.
3. 19 routers / 181 operations: `auth`, `adminRenumber`, `audit`, `backup`, `branches`, `company`, `customers`, `dispatch`, `health`, `hr`, `imports`, `integrity`, `invoiceShareLinks`, `quotationShareLinks`, `publicInvoices`, `publicQuotations`, `quotations`, `pdfGen`, `search`.

These disjoint groups reconcile to the route manifest count. This is static source review; it does not establish runtime reachability, exhaustive request/response schemas, or test behavior. Fields not explicit in a handler remain **NOT VERIFIED**.

### Specific guard and location-scope findings

- Most business routes use `requireModuleView` or `requireModuleAction`; individual exceptions must not be inferred from HTTP method. Some operations have inline checks rather than route middleware.
- Route handlers with no visible route-local module middleware include authentication endpoints, admin renumbering, health, search, selected company/HR reads, public document/share handlers, the sales share-token/PDF paths, and money-voucher PDF. Global Bearer auth still applies unless the path is one of the listed public exceptions; storage uses custom employee/attachment-scope checks.
- Admin sales renumbering calls an inline level-one check. Item/material/raw-material/item/asset master writes have an explicit Head Office check. Accounting-period lock/unlock POSTs use a page-view guard plus an inline Administrator check; the lock list GET has no route-local module middleware.
- Location ownership is sometimes checked inside handlers/SQL rather than by middleware, including dispatch, parties, quotations, share-link management, search, selected HR/payroll/PDF paths, and imports. A blank route-local scope helper is not evidence of unrestricted access when custom checks exist; each handler must be read.
- `GET /stock/reorder-report` has `requireModuleView("page:/headoffice/inventory-reports")`, but its query reads all `stock_entries` below each item's reorder level without a visible authenticated-location predicate (`inventory-batches.ts:484-510`). Source review confirms any hierarchy with that view permission (or level 1, which bypasses permission rows) can reach it; the page is administrator-grantable and the legacy seed could have granted it to existing non-level-1 hierarchies. New hierarchies default-deny. Actual current grants and exposure were not queried or tested. See GAP-012.
- Inventory master mutations have explicit Head Office restrictions. Storage placement is an overlay and does not alter stock quantity/books; BOM changes are master/audit writes. These are not stock adjustments.
- Explicit period-lock checks are present in sales/payment/purchase/return/stock-verification/transfer/production write families. Cash-deposit writes also check location scope, disabled location, available balance, and period lock. Rent approval is distinct from payment/posting.
- `GET /stock/reorder-report` is the one specific location-scope exception elevated for follow-up; other route-by-route scope and caller uncertainties remain listed as **NOT VERIFIED**, not “unused” or “unguarded.”
- Grouped source notes on validation, response shapes, direct table/effect evidence, and searchable frontend callers are in `ERP_API_CONTRACT_MATRIX.md`. That supplement records only what the cited source establishes; it is not a one-row-per-operation catalogue or runtime authorization certification.

## Complete static route manifest

All paths are relative to `/api`. The route-module filename is the source owner unless otherwise noted. Method and path are the unique operation identity used for this scan.

| Router | Declared operations |
|---|---|
| `accounts` | GET `/accounts/chart`; GET `/accounts/chart/flat`; GET `/accounts/internal-transfer-balances`; GET `/accounts/voucher-parties`; GET `/accounts/cash-bank-ledgers`; POST `/accounts/chart`; PATCH `/accounts/chart/:id`; PATCH `/accounts/chart/:id/move`; DELETE `/accounts/chart/:id`; GET `/accounts/payments`; GET `/accounts/voucher-employees`; POST `/accounts/payments`; PATCH `/accounts/payments/:id`; DELETE `/accounts/payments/:id`; GET `/accounts/receipts`; POST `/accounts/receipts`; PATCH `/accounts/receipts/:id`; DELETE `/accounts/receipts/:id`; GET `/accounts/receipts/:id/delete-impact`; POST `/accounts/receipts/:id/system-delete`; GET `/accounts/ledger-statement`; GET `/accounts/cash-bank`; POST `/accounts/cash-bank`; PATCH `/accounts/cash-bank/:id`; DELETE `/accounts/cash-bank/:id`; GET `/expenses`; POST `/expenses`; GET `/expenses/categories`; GET `/accounts/expense-ledgers`; GET `/accounts/location-expenses/summary`; GET `/accounts/location-expenses/all`; GET `/accounts/location-expenses`; POST `/accounts/location-expenses`; DELETE `/accounts/location-expenses/:id`; GET `/accounts/financial-statements`; GET `/accounts/financial-statements/monthly`; GET `/accounts/ledger/:id/statement`; GET `/gst/summary`; GET `/accounts/opening-balances`; POST `/accounts/opening-balances`; GET `/accounts/settlement-context`; GET `/accounts/party-advance`; DELETE `/accounts/opening-balances/:id` |
| `adminRenumber` | POST `/admin/sales-renumber/preview`; POST `/admin/sales-renumber/apply`; POST `/admin/sales-renumber/reset-lock`; GET `/admin/sales-renumber/log` |
| `assets` | GET `/assets/categories`; POST `/assets/categories`; PATCH `/assets/categories/:id`; GET `/assets/purchases`; POST `/assets/purchases`; PATCH `/assets/purchases/:id`; DELETE `/assets/purchases/:id`; GET `/assets/transfers`; POST `/assets/transfers`; GET `/assets/disposals`; POST `/assets/disposals`; POST `/assets/depreciation/run`; GET `/assets/summary` |
| `audit` | GET `/audit/logs`; GET `/audit/logs/:id` |
| `auth` | POST `/auth/login`; POST `/auth/logout`; POST `/auth/change-password`; GET `/auth/me`; PUT `/auth/location-pref`; PATCH `/auth/profile` |
| `backup` | GET `/backup/dashboard`; GET `/backup/list`; GET `/backup/history`; POST `/backup/create`; GET `/backup/:id/download`; DELETE `/backup/:id`; GET `/backup/:id/validate`; POST `/backup/:id/verify`; POST `/backup/upload`; POST `/backup/upload-url`; POST `/backup/upload/finalize`; POST `/backup/:id/restore`; GET `/backup/settings`; PATCH `/backup/settings` |
| `bom` | GET `/bom-templates`; GET `/bom-templates/item/:itemId`; POST `/bom-templates`; PUT `/bom-templates/:id`; DELETE `/bom-templates/:id` |
| `branches` | GET `/warehouses`; POST `/warehouses`; GET `/warehouses/:id`; PATCH `/warehouses/:id`; DELETE `/warehouses/:id`; POST `/warehouses/:id/disable`; POST `/warehouses/:id/enable`; GET `/warehouses/:id/delete-summary`; DELETE `/warehouses/:id/permanent`; GET `/outlets`; POST `/outlets`; GET `/outlets/:id`; PATCH `/outlets/:id`; DELETE `/outlets/:id` |
| `cash-in-outlet` | GET `/cash-in-outlet`; GET `/cash-in-outlet/deposits`; POST `/cash-in-outlet/deposits`; POST `/cash-in-outlet/deposits/:id/reconcile` |
| `company` | GET `/company/settings`; PATCH `/company/settings`; GET `/public/app`; GET `/public/app/apk`; GET `/public/app/info`; GET `/company/login-history`; GET `/company/permissions`; POST `/company/permissions`; GET `/company/permissions/rbac-audit`; POST `/company/reset`; POST `/company/clear-transactions` |
| `customers` | GET `/customers`; POST `/customers`; GET `/customers/:id`; PATCH `/customers/:id`; DELETE `/customers/:id`; GET `/vendors`; POST `/vendors`; GET `/vendors/:id`; PATCH `/vendors/:id`; DELETE `/vendors/:id`; GET `/customers/:id/ledger`; GET `/vendors/:id/ledger`; POST `/vendors/:id/payment`; GET `/coupons`; POST `/coupons`; PATCH `/coupons/:id`; DELETE `/coupons/:id` |
| `dashboard` | GET `/dashboard/summary`; GET `/dashboard/stock-alerts`; GET `/dashboard/recent-activity`; GET `/dashboard/sales-trend`; GET `/dashboard/top-items`; GET `/dashboard/sales-by-location`; GET `/dashboard/bi`; GET `/dashboard/production-trend` |
| `dispatch` | GET `/dispatch/queue`; POST `/dispatch/:saleId/status` |
| `financialReports` | GET `/reports/fin/ledgers`; GET `/reports/fin/ledger-statement`; GET `/reports/fin/ledger-options`; GET `/reports/fin/trial-balance`; GET `/reports/fin/cash`; GET `/reports/fin/bank`; GET `/reports/fin/cash-bank`; GET `/reports/fin/gst`; GET `/reports/fin/expenses`; GET `/reports/fin/salary`; GET `/reports/fin/day-book` |
| `gst` | GET `/gst/hsn-summary`; GET `/gst/gstr1`; GET `/gst/gstr3b`; GET `/gst/reconciliation`; GET `/gst/filters`; GET `/gst/documents` |
| `health` | GET `/healthz/live`; GET `/healthz`; GET `/healthz/schema` |
| `hr` | GET `/hr/hierarchies`; POST `/hr/hierarchies`; PATCH `/hr/hierarchies/:id`; DELETE `/hr/hierarchies/:id`; GET `/hr/employees`; POST `/hr/employees`; GET `/hr/employees/:id`; PATCH `/hr/employees/:id`; DELETE `/hr/employees/:id`; GET `/hr/pay-components/:employeeId`; PUT `/hr/pay-components/:employeeId`; GET `/hr/payroll`; POST `/hr/payroll/generate`; GET `/hr/payroll/unclassified-absences`; PATCH `/hr/payroll/:id`; GET `/hr/salary-accruals`; POST `/hr/payroll/:id/approve`; POST `/hr/payroll/:id/pay`; GET `/hr/advances`; POST `/hr/advances`; PATCH `/hr/advances/:id`; DELETE `/hr/advances/:id`; GET `/hr/attendance`; GET `/hr/attendance/config`; GET `/hr/holidays`; POST `/hr/holidays`; DELETE `/hr/holidays/:id`; GET `/hr/leave-balance`; POST `/hr/attendance/check-in`; POST `/hr/attendance/check-out`; GET `/hr/leaves`; POST `/hr/leaves`; POST `/hr/leaves/:id/approve`; POST `/hr/leaves/:id/cancel`; PUT `/hr/attendance`; PUT `/hr/attendance/bulk`; POST `/hr/employees/:id/reset-password` |
| `imports` | GET `/imports/templates/:module`; POST `/imports/parse`; GET `/imports/batches/:id/mappings`; POST `/imports/batches/:id/mappings`; GET `/imports/mappings`; GET `/imports/mapping-candidates`; PUT `/imports/mappings/:id`; DELETE `/imports/mappings/:id`; GET `/imports/batches`; GET `/imports/batches/:id`; GET `/imports/batches/:id/error-file`; POST `/imports/batches/:id/demo`; GET `/imports/batches/:id/demo-report`; POST `/imports/batches/:id/approve`; POST `/imports/batches/:id/discard`; POST `/imports/batches/:id/commit`; POST `/imports/batches/:id/rollback`; POST `/imports/migrations`; GET `/imports/migrations`; GET `/imports/migrations/:id`; POST `/imports/migrations/:id/files`; DELETE `/imports/migrations/:id/files/:module`; GET `/imports/migrations/:id/mappings`; POST `/imports/migrations/:id/mappings`; POST `/imports/migrations/:id/demo`; GET `/imports/migrations/:id/demo-report`; POST `/imports/migrations/:id/approve`; POST `/imports/migrations/:id/discard`; POST `/imports/migrations/:id/rollback` |
| `integrity` | GET `/accounts/integrity` |
| `inventory` | GET `/materials`; POST `/materials`; GET `/materials/:id`; PATCH `/materials/:id`; DELETE `/materials/:id`; GET `/raw-materials`; POST `/raw-materials`; GET `/raw-materials/:id`; PATCH `/raw-materials/:id`; DELETE `/raw-materials/:id`; GET `/items`; POST `/items`; GET `/items/:id`; PATCH `/items/:id`; DELETE `/items/:id`; GET `/assets`; POST `/assets`; GET `/assets/:id`; PATCH `/assets/:id`; DELETE `/assets/:id` |
| `inventory-batches` | GET `/stock/batches`; GET `/stock/batches/suggest`; GET `/stock/expiry-report`; GET `/stock/valuation`; GET `/stock/movement-analysis`; GET `/stock/reorder-report`; POST `/stock/verifications`; GET `/stock/verifications`; GET `/stock/verifications/:id` |
| `invoiceShareLinks` | GET `/sales/:id/share-link`; POST `/sales/:id/share-link`; POST `/sales/:id/share-link/regenerate`; POST `/sales/:id/share-link/revoke`; GET `/share/invoice/:publicId`; GET `/share/invoice/:publicId/pdf` |
| `itemTracking` | GET `/item-tracking` |
| `journal` | GET `/accounts/journal-vouchers`; GET `/accounts/voucher-locations`; POST `/accounts/journal-vouchers`; GET `/accounts/journal-vouchers/:id`; PATCH `/accounts/journal-vouchers/:id`; DELETE `/accounts/journal-vouchers/:id`; GET `/accounts/day-book`; GET `/accounts/cash-bank-book/ledgers`; GET `/accounts/cash-bank-book`; GET `/accounts/trial-balance` |
| `payments` | GET `/sales/:id/payments`; POST `/sales/:id/payments` |
| `pdfGen` | POST `/pdf/transfer-invoice`; POST `/pdf/challan`; POST `/pdf/purchase-bill`; POST `/pdf/report`; POST `/xlsx/report`; POST `/pdf/expense-voucher`; POST `/pdf/money-voucher`; POST `/pdf/advance-voucher`; POST `/pdf/journal-voucher`; POST `/pdf/sales-return`; POST `/pdf/purchase-return`; POST `/pdf/payslip` |
| `periods` | GET `/accounting-periods/locks`; GET `/accounting-periods/events`; GET `/accounting-periods/:year/:month/summary`; POST `/accounting-periods/:year/:month/lock`; POST `/accounting-periods/:year/:month/unlock` |
| `production` | GET `/productions`; GET `/productions/reports`; POST `/productions`; GET `/productions/:id`; PATCH `/productions/:id`; DELETE `/productions/:id` |
| `publicInvoices` | GET `/public/invoices/:token` |
| `publicQuotations` | GET `/public/quotations/:token` |
| `purchases` | GET `/purchases`; POST `/purchases`; GET `/purchases/:id`; PATCH `/purchases/:id`; DELETE `/purchases/:id` |
| `quotationShareLinks` | GET `/quotations/:id/share-link`; POST `/quotations/:id/share-link`; POST `/quotations/:id/share-link/regenerate`; POST `/quotations/:id/share-link/revoke`; GET `/share/quotation/:publicId`; GET `/share/quotation/:publicId/pdf` |
| `quotations` | GET `/quotations/notifications/expired`; GET `/quotations/salespeople`; GET `/quotation-payment-terms`; POST `/quotation-payment-terms`; PATCH `/quotation-payment-terms/:id`; DELETE `/quotation-payment-terms/:id`; GET `/quotations`; POST `/quotations`; GET `/quotations/:id`; PUT `/quotations/:id`; POST `/quotations/:id/status`; DELETE `/quotations/:id`; GET `/quotations/:id/stock-check`; POST `/quotations/:id/share-token` |
| `reconciliation` | GET `/accounts/reconciliation/audit`; GET `/accounts/reconciliation/customer-receivables`; GET `/reconciliation/bank-ledgers`; GET `/reconciliation/bank-transactions`; GET `/reconciliation/bank-audit`; GET `/reconciliation/bank-batches`; GET `/reconciliation/bank-batches/:id`; POST `/reconciliation/bank-batches`; PATCH `/reconciliation/bank-batches/:id`; POST `/reconciliation/bank-reset`; POST `/reconciliation/bank-book/:entryId/reconcile`; POST `/reconciliation/bank-accounts`; GET `/reconciliation/pending-queue`; GET `/reconciliation/pending-manual-vouchers`; POST `/reconciliation/manual-vouchers`; POST `/reconciliation/settle-queue`; GET `/reconciliation/pending`; GET `/reconciliation/batches`; GET `/reconciliation/batches/:id`; POST `/reconciliation/batches`; GET `/reconciliation/reconciled`; POST `/reconciliation/:id/match`; POST `/reconciliation/:id/unmatch` |
| `rent` | GET `/rent/agreements`; PATCH `/rent/agreements/:warehouseId`; GET `/rent/accruals`; POST `/rent/accrue`; GET `/rent/periods`; POST `/rent/periods/:warehouseId/:year/:month/approve`; POST `/rent/periods/:warehouseId/:year/:month/pay`; GET `/rent/payments`; GET `/rent/dashboard`; GET `/rent/ledger-postings` |
| `reports` | GET `/reports/sales-register`; GET `/reports/sales-by-salesperson`; GET `/reports/sales-by-item`; GET `/reports/sales-by-location`; GET `/reports/discounts`; GET `/reports/purchase-register`; GET `/reports/purchases-by-vendor`; GET `/reports/purchases-by-material`; GET `/reports/profitability`; GET `/reports/sales-stock-combined`; GET `/reports/gst-transfers`; GET `/reports/branch-transfers` |
| `returns` | POST `/sales-returns`; GET `/sales-returns`; PATCH `/sales-returns/:id`; POST `/purchase-returns`; GET `/purchase-returns`; PATCH `/purchase-returns/:id`; GET `/outstanding/receivables`; GET `/outstanding/payables`; GET `/outstanding/collections` |
| `sales` | GET `/item-prices`; POST `/item-prices`; GET `/sales`; POST `/sales`; PUT `/sales/:id`; POST `/sales/:id/cancel`; GET `/sales/price-history`; GET `/sales/summary`; POST `/sales/:id/share-token`; GET `/sales/:id/invoice.pdf`; GET `/sales/salespeople`; GET `/sales/:id` |
| `search` | GET `/search` |
| `stock` | GET `/stock`; GET `/stock/ledger`; GET `/stock/transfers`; POST `/stock/transfers`; PATCH `/stock/transfers/:id/approve`; PATCH `/stock/transfers/:id/reject`; GET `/stock/transfers/:id` |
| `storage` | POST `/storage/uploads/request-url`; GET `/storage/objects/*path` |
| `storageLocations` | GET `/storage-locations`; POST `/storage-locations`; PATCH `/storage-locations/:id`; DELETE `/storage-locations/:id`; GET `/storage-stock`; POST `/storage-placements/move` |

## Known gaps and classification

- `DUPLICATE`: no duplicate literal method/path pair was identified in the current static scan. Similar business concepts still have distinct legacy and Reports Center routes; see `ERP_REPORT_INVENTORY.md`.
- `LEGACY`: identified legacy routes are noted in the master/report inventory; a complete per-operation lifecycle classification is **NOT VERIFIED**.
- `UNUSED`: not assigned from absent frontend call-site searches alone.
- `MISSING FROM OPENAPI`: 300 source-declared operations in the static comparison; the full grouped identity list follows below.
- `OPENAPI ONLY`: 0 in the normalized static comparison.
- Exact request schemas, response schemas, route-local permission roles, location enforcement, and table/accounting/GST effects still need operation-by-operation inspection. This file is a complete method/path manifest only, not a complete endpoint contract catalogue.

### Source-declared operations absent from OpenAPI

This list is the normalized source route set minus the normalized OpenAPI operation set. Paths are relative to `/api`; it identifies specification coverage only, not whether a route is active, externally supported, or unused.

#### `accounts` (32)

`DELETE /accounts/chart/:id`; `DELETE /accounts/location-expenses/:id`; `DELETE /accounts/opening-balances/:id`; `DELETE /accounts/payments/:id`; `DELETE /accounts/receipts/:id`; `GET /accounts/cash-bank-ledgers`; `GET /accounts/chart/flat`; `GET /accounts/expense-ledgers`; `GET /accounts/financial-statements`; `GET /accounts/financial-statements/monthly`; `GET /accounts/internal-transfer-balances`; `GET /accounts/ledger/:id/statement`; `GET /accounts/location-expenses`; `GET /accounts/location-expenses/all`; `GET /accounts/location-expenses/summary`; `GET /accounts/opening-balances`; `GET /accounts/party-advance`; `GET /accounts/payments`; `GET /accounts/receipts`; `GET /accounts/receipts/:id/delete-impact`; `GET /accounts/settlement-context`; `GET /accounts/voucher-employees`; `GET /accounts/voucher-parties`; `GET /expenses/categories`; `PATCH /accounts/chart/:id/move`; `PATCH /accounts/payments/:id`; `PATCH /accounts/receipts/:id`; `POST /accounts/location-expenses`; `POST /accounts/opening-balances`; `POST /accounts/payments`; `POST /accounts/receipts`; `POST /accounts/receipts/:id/system-delete`

#### `adminRenumber` (4)

`GET /admin/sales-renumber/log`; `POST /admin/sales-renumber/apply`; `POST /admin/sales-renumber/preview`; `POST /admin/sales-renumber/reset-lock`

#### `assets` (13)

`DELETE /assets/purchases/:id`; `GET /assets/categories`; `GET /assets/disposals`; `GET /assets/purchases`; `GET /assets/summary`; `GET /assets/transfers`; `PATCH /assets/categories/:id`; `PATCH /assets/purchases/:id`; `POST /assets/categories`; `POST /assets/depreciation/run`; `POST /assets/disposals`; `POST /assets/purchases`; `POST /assets/transfers`

#### `audit` (2)

`GET /audit/logs`; `GET /audit/logs/:id`

#### `auth` (2)

`PATCH /auth/profile`; `PUT /auth/location-pref`

#### `backup` (14)

`DELETE /backup/:id`; `GET /backup/:id/download`; `GET /backup/:id/validate`; `GET /backup/dashboard`; `GET /backup/history`; `GET /backup/list`; `GET /backup/settings`; `PATCH /backup/settings`; `POST /backup/:id/restore`; `POST /backup/:id/verify`; `POST /backup/create`; `POST /backup/upload`; `POST /backup/upload-url`; `POST /backup/upload/finalize`

#### `bom` (5)

`DELETE /bom-templates/:id`; `GET /bom-templates`; `GET /bom-templates/item/:itemId`; `POST /bom-templates`; `PUT /bom-templates/:id`

#### `branches` (4)

`DELETE /warehouses/:id/permanent`; `GET /warehouses/:id/delete-summary`; `POST /warehouses/:id/disable`; `POST /warehouses/:id/enable`

#### `cash-in-outlet` (4)

`GET /cash-in-outlet`; `GET /cash-in-outlet/deposits`; `POST /cash-in-outlet/deposits`; `POST /cash-in-outlet/deposits/:id/reconcile`

#### `company` (6)

`GET /company/login-history`; `GET /company/permissions/rbac-audit`; `GET /public/app`; `GET /public/app/apk`; `POST /company/clear-transactions`; `POST /company/reset`

#### `customers` (5)

`DELETE /customers/:id`; `DELETE /vendors/:id`; `GET /customers/:id/ledger`; `GET /vendors/:id/ledger`; `POST /vendors/:id/payment`

#### `dashboard` (5)

`GET /dashboard/bi`; `GET /dashboard/production-trend`; `GET /dashboard/sales-by-location`; `GET /dashboard/sales-trend`; `GET /dashboard/top-items`

#### `dispatch` (2)

`GET /dispatch/queue`; `POST /dispatch/:saleId/status`

#### `financialReports` (11)

`GET /reports/fin/bank`; `GET /reports/fin/cash`; `GET /reports/fin/cash-bank`; `GET /reports/fin/day-book`; `GET /reports/fin/expenses`; `GET /reports/fin/gst`; `GET /reports/fin/ledger-options`; `GET /reports/fin/ledger-statement`; `GET /reports/fin/ledgers`; `GET /reports/fin/salary`; `GET /reports/fin/trial-balance`

#### `gst` (6)

`GET /gst/documents`; `GET /gst/filters`; `GET /gst/gstr1`; `GET /gst/gstr3b`; `GET /gst/hsn-summary`; `GET /gst/reconciliation`

#### `health` (2)

`GET /healthz/live`; `GET /healthz/schema`

#### `hr` (17)

`DELETE /hr/advances/:id`; `DELETE /hr/holidays/:id`; `GET /hr/advances`; `GET /hr/attendance/config`; `GET /hr/holidays`; `GET /hr/leave-balance`; `GET /hr/pay-components/:employeeId`; `GET /hr/payroll/unclassified-absences`; `GET /hr/salary-accruals`; `PATCH /hr/advances/:id`; `PATCH /hr/payroll/:id`; `POST /hr/advances`; `POST /hr/employees/:id/reset-password`; `POST /hr/holidays`; `POST /hr/payroll/:id/approve`; `POST /hr/payroll/generate`; `PUT /hr/pay-components/:employeeId`

#### `imports` (29)

`DELETE /imports/mappings/:id`; `DELETE /imports/migrations/:id/files/:module`; `GET /imports/batches`; `GET /imports/batches/:id`; `GET /imports/batches/:id/demo-report`; `GET /imports/batches/:id/error-file`; `GET /imports/batches/:id/mappings`; `GET /imports/mapping-candidates`; `GET /imports/mappings`; `GET /imports/migrations`; `GET /imports/migrations/:id`; `GET /imports/migrations/:id/demo-report`; `GET /imports/migrations/:id/mappings`; `GET /imports/templates/:module`; `POST /imports/batches/:id/approve`; `POST /imports/batches/:id/commit`; `POST /imports/batches/:id/demo`; `POST /imports/batches/:id/discard`; `POST /imports/batches/:id/mappings`; `POST /imports/batches/:id/rollback`; `POST /imports/migrations`; `POST /imports/migrations/:id/approve`; `POST /imports/migrations/:id/demo`; `POST /imports/migrations/:id/discard`; `POST /imports/migrations/:id/files`; `POST /imports/migrations/:id/mappings`; `POST /imports/migrations/:id/rollback`; `POST /imports/parse`; `PUT /imports/mappings/:id`

#### `integrity` (1)

`GET /accounts/integrity`

#### `inventory-batches` (9)

`GET /stock/batches`; `GET /stock/batches/suggest`; `GET /stock/expiry-report`; `GET /stock/movement-analysis`; `GET /stock/reorder-report`; `GET /stock/valuation`; `GET /stock/verifications`; `GET /stock/verifications/:id`; `POST /stock/verifications`

#### `inventory` (5)

`DELETE /assets/:id`; `GET /assets`; `GET /assets/:id`; `PATCH /assets/:id`; `POST /assets`

#### `invoiceShareLinks` (6)

`GET /sales/:id/share-link`; `GET /share/invoice/:publicId`; `GET /share/invoice/:publicId/pdf`; `POST /sales/:id/share-link`; `POST /sales/:id/share-link/regenerate`; `POST /sales/:id/share-link/revoke`

#### `itemTracking` (1)

`GET /item-tracking`

#### `journal` (10)

`DELETE /accounts/journal-vouchers/:id`; `GET /accounts/cash-bank-book`; `GET /accounts/cash-bank-book/ledgers`; `GET /accounts/day-book`; `GET /accounts/journal-vouchers`; `GET /accounts/journal-vouchers/:id`; `GET /accounts/trial-balance`; `GET /accounts/voucher-locations`; `PATCH /accounts/journal-vouchers/:id`; `POST /accounts/journal-vouchers`

#### `payments` (2)

`GET /sales/:id/payments`; `POST /sales/:id/payments`

#### `pdfGen` (12)

`POST /pdf/advance-voucher`; `POST /pdf/challan`; `POST /pdf/expense-voucher`; `POST /pdf/journal-voucher`; `POST /pdf/money-voucher`; `POST /pdf/payslip`; `POST /pdf/purchase-bill`; `POST /pdf/purchase-return`; `POST /pdf/report`; `POST /pdf/sales-return`; `POST /pdf/transfer-invoice`; `POST /xlsx/report`

#### `periods` (5)

`GET /accounting-periods/:year/:month/summary`; `GET /accounting-periods/events`; `GET /accounting-periods/locks`; `POST /accounting-periods/:year/:month/lock`; `POST /accounting-periods/:year/:month/unlock`

#### `production` (3)

`DELETE /productions/:id`; `GET /productions/reports`; `PATCH /productions/:id`

#### `publicInvoices` (1)

`GET /public/invoices/:token`

#### `publicQuotations` (1)

`GET /public/quotations/:token`

#### `purchases` (2)

`DELETE /purchases/:id`; `PATCH /purchases/:id`

#### `quotationShareLinks` (6)

`GET /quotations/:id/share-link`; `GET /share/quotation/:publicId`; `GET /share/quotation/:publicId/pdf`; `POST /quotations/:id/share-link`; `POST /quotations/:id/share-link/regenerate`; `POST /quotations/:id/share-link/revoke`

#### `quotations` (3)

`GET /quotations/:id/stock-check`; `GET /quotations/notifications/expired`; `POST /quotations/:id/share-token`

#### `reconciliation` (21)

`GET /accounts/reconciliation/audit`; `GET /accounts/reconciliation/customer-receivables`; `GET /reconciliation/bank-audit`; `GET /reconciliation/bank-batches`; `GET /reconciliation/bank-batches/:id`; `GET /reconciliation/bank-ledgers`; `GET /reconciliation/bank-transactions`; `GET /reconciliation/batches`; `GET /reconciliation/batches/:id`; `GET /reconciliation/pending`; `GET /reconciliation/pending-manual-vouchers`; `GET /reconciliation/reconciled`; `PATCH /reconciliation/bank-batches/:id`; `POST /reconciliation/:id/match`; `POST /reconciliation/:id/unmatch`; `POST /reconciliation/bank-accounts`; `POST /reconciliation/bank-batches`; `POST /reconciliation/bank-book/:entryId/reconcile`; `POST /reconciliation/bank-reset`; `POST /reconciliation/batches`; `POST /reconciliation/manual-vouchers`

#### `rent` (10)

`GET /rent/accruals`; `GET /rent/agreements`; `GET /rent/dashboard`; `GET /rent/ledger-postings`; `GET /rent/payments`; `GET /rent/periods`; `PATCH /rent/agreements/:warehouseId`; `POST /rent/accrue`; `POST /rent/periods/:warehouseId/:year/:month/approve`; `POST /rent/periods/:warehouseId/:year/:month/pay`

#### `reports` (12)

`GET /reports/branch-transfers`; `GET /reports/discounts`; `GET /reports/gst-transfers`; `GET /reports/profitability`; `GET /reports/purchase-register`; `GET /reports/purchases-by-material`; `GET /reports/purchases-by-vendor`; `GET /reports/sales-by-item`; `GET /reports/sales-by-location`; `GET /reports/sales-by-salesperson`; `GET /reports/sales-register`; `GET /reports/sales-stock-combined`

#### `returns` (9)

`GET /outstanding/collections`; `GET /outstanding/payables`; `GET /outstanding/receivables`; `GET /purchase-returns`; `GET /sales-returns`; `PATCH /purchase-returns/:id`; `PATCH /sales-returns/:id`; `POST /purchase-returns`; `POST /sales-returns`

#### `sales` (6)

`GET /sales/:id/invoice.pdf`; `GET /sales/price-history`; `GET /sales/salespeople`; `POST /sales/:id/cancel`; `POST /sales/:id/share-token`; `PUT /sales/:id`

#### `search` (1)

`GET /search`

#### `stock` (3)

`GET /stock/ledger`; `PATCH /stock/transfers/:id/approve`; `PATCH /stock/transfers/:id/reject`

#### `storage` (2)

`GET /storage/objects/*path`; `POST /storage/uploads/request-url`

#### `storageLocations` (6)

`DELETE /storage-locations/:id`; `GET /storage-locations`; `GET /storage-stock`; `PATCH /storage-locations/:id`; `POST /storage-locations`; `POST /storage-placements/move`

## Source anchors

- Router mounts/order: `artifacts/api-server/src/routes/index.ts:1-91`.
- Global auth exceptions: `artifacts/api-server/src/app.ts:100-129`.
- Route declarations: `artifacts/api-server/src/routes/*.ts`.
- OpenAPI: `lib/api-spec/openapi.yaml`; generated client config: `lib/api-spec/orval.config.ts`.
- Permission middleware: `artifacts/api-server/src/middleware/permissions.ts`.
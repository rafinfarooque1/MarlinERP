# Permission & Route-Guard Audit Matrix

**GENERATED FILE — do not edit by hand.**
Regenerate: `pnpm --filter @workspace/scripts run audit:guards:write`
Source of truth: `scripts/src/audit-route-guards.ts` (policy + exemptions) scanning `artifacts/api-server/src/routes/*.ts`.
This check runs in `pnpm --filter @workspace/scripts run typecheck`; an unguarded write endpoint fails CI.

## Model (unchanged by this audit)

- **Default-deny five-action RBAC** — `requireModuleView` / `requireModuleAction(page-key, add|edit|delete|download)`
  (`artifacts/api-server/src/middleware/permissions.ts`). Level-1 bypasses; a missing permission row denies.
- **Page keys** = `page:` + sidebar href, generated from `artifacts/marlin-erp/src/lib/moduleRegistry.ts`
  into `artifacts/api-server/src/lib/pagePermissions.ts` (checked by `scripts/src/check-permissions.ts`).
- **LBAC** (location scoping) is orthogonal and unconditional: page right runs first (403), location scope second
  (404 for foreign scoped resources). The sidebar location selector only narrows reads, never grants.
- **GET endpoints** are guarded per-page where sensitive; shared lookup GETs use any-of view guards. The
  hierarchy/permission GETs stay unguarded by design so clients can resolve their own rights.

## Client-side enforcement (verified by the health-check audit)

- **Route guard** — every App.tsx route wraps its page in `PermGuard` (AuthGuard + RoutePermissionGuard);
  `scripts/src/check-permissions.ts` check 6 fails CI when a route is missing its guard, guards with the
  wrong page's key, or resolves to an unregistered key (which would fall through unrestricted).
- **Selector lockdown** — non-HO users get read-only location labels, never dropdowns
  (`useActingLocation.canChoose`, `LocationSelectField`, `LocationFilter`); a single-option user sees
  text, not a picker. The server never trusts any of it: LBAC is unconditional
  (proved by `artifacts/api-server/tests/permission-location-audit.test.mjs` sections E/F).
- **No stale grants** — the Permissions page refetches after save (staleTime 0) and the server reads
  permission rows per-request, so a revocation applies to the very next call on the same token
  (proved by the same suite, section D).

## Summary

- Routes scanned: **376** across 41 route files
- Write endpoints: **179**, of which **165** carry `requireModuleAction` middleware
- Documented exemptions (self-service / level-1 / dynamic in-handler guards): **14**

## Documented write exemptions

| Endpoint | Why it is safe without `requireModuleAction` middleware |
| --- | --- |
| `POST /auth/login` | Public credential entry point; rate-limited + lockout table. |
| `POST /auth/logout` | Self-service; audit-log write only. |
| `POST /auth/change-password` | Self-service; re-verifies the current password in-handler. |
| `PUT /auth/location-pref` | Self display preference; never authority (LBAC unconditional). |
| `PATCH /auth/profile` | Self-service; writes only the caller's own employee row. |
| `POST /admin/sales-renumber/preview` | requireLevelOne() in-handler; level-1-only admin tool. |
| `POST /admin/sales-renumber/apply` | requireLevelOne() in-handler; level-1-only admin tool. |
| `POST /admin/sales-renumber/reset-lock` | requireLevelOne() in-handler; level-1-only admin tool. |
| `POST /accounting-periods/:year/:month/lock` | requireModuleView + isAdmin() in-handler: month locking is level-1-only, deliberately above the five-action model. |
| `POST /accounting-periods/:year/:month/unlock` | requireModuleView + isAdmin() in-handler + mandatory reason; level-1-only. |
| `POST /hr/leaves/:id/cancel` | View-gated; handler enforces caller.id === leave.employee_id (only the requester may cancel a PENDING request; approvers reject instead, which records who/why). |
| `POST /pdf/money-voucher` | requireModuleAction(kindKey, "download") invoked in-handler — the receipt/payment page key is derived from the voucher kind in the body (any-of bound to request kind). |
| `POST /sales/:id/share-token` | hasModuleAction(download on POS/Outstanding) + LBAC sale-scope check in-handler; token is minutes-lived. |
| `POST /storage/uploads/request-url` | Authenticated presigned-PUT only; object path embeds the uploader's employee id and reads are ACLed by mayReadObject (uploader or record-visibility). |

## Full route matrix

Legend: **Guards** = middleware position (action: page keys). **In-handler** = dynamic permission checks,
level-1 admin gates, and LBAC markers detected inside the handler body.

### accounts.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/accounts/chart` | `view: page:/accounts/chart, page:/accounts/expenses` | `dynamic view: page:/accounts/chart, page:/accounts/expenses` |
| GET | `/accounts/chart/flat` | `view: page:/accounts/vouchers, page:/accounts/ledger, page:/operations/receipt-voucher, page:/operations/payment-voucher, page:/production/purchase` | — |
| GET | `/accounts/cash-bank-ledgers` | `view: page:/accounts/cash-bank, page:/accounts/expenses, page:/accounts/vouchers, page:/vendors, page:/sales/expenses, page:/hr/payroll, page:/hr/advances, page:/operations/receipt-voucher, page:/operations/payment-voucher, page:/sales/pos, page:/outstanding, page:/customers` | — |
| POST | `/accounts/chart` | `add: page:/accounts/chart` | — |
| PATCH | `/accounts/chart/:id` | `edit: page:/accounts/chart` | — |
| PATCH | `/accounts/chart/:id/move` | `edit: page:/accounts/chart` | — |
| DELETE | `/accounts/chart/:id` | `delete: page:/accounts/chart` | — |
| GET | `/accounts/payments` | `view: page:/accounts/vouchers, page:/operations/payment-voucher` | `level-1 admin gate` |
| GET | `/accounts/voucher-employees` | `view: page:/accounts/vouchers, page:/operations/receipt-voucher, page:/operations/payment-voucher` | `dynamic view: page:/accounts/vouchers, page:/operations/receipt-voucher, page:/operations/payment-voucher` |
| POST | `/accounts/payments` | `add: page:/accounts/vouchers, page:/operations/payment-voucher` | — |
| PATCH | `/accounts/payments/:id` | `edit: page:/accounts/vouchers, page:/operations/payment-voucher` | — |
| DELETE | `/accounts/payments/:id` | `delete: page:/accounts/vouchers, page:/operations/payment-voucher` | `level-1 admin gate` |
| GET | `/accounts/receipts` | `view: page:/accounts/vouchers, page:/operations/receipt-voucher` | `level-1 admin gate` |
| POST | `/accounts/receipts` | `add: page:/accounts/vouchers, page:/operations/receipt-voucher` | — |
| PATCH | `/accounts/receipts/:id` | `edit: page:/accounts/vouchers, page:/operations/receipt-voucher` | — |
| DELETE | `/accounts/receipts/:id` | `delete: page:/accounts/vouchers, page:/operations/receipt-voucher` | `level-1 admin gate` |
| GET | `/accounts/receipts/:id/delete-impact` | `delete: page:/accounts/vouchers, page:/operations/receipt-voucher` | `level-1 admin gate` |
| POST | `/accounts/receipts/:id/system-delete` | `delete: page:/accounts/vouchers, page:/operations/receipt-voucher` | `level-1 admin gate` |
| GET | `/accounts/ledger-statement` | `view: page:/accounts/ledger` | — |
| GET | `/accounts/cash-bank` | `view: page:/accounts/cash-bank` | `dynamic view: page:/accounts/cash-bank` |
| POST | `/accounts/cash-bank` | `add: page:/accounts/cash-bank` | — |
| PATCH | `/accounts/cash-bank/:id` | `edit: page:/accounts/cash-bank` | — |
| DELETE | `/accounts/cash-bank/:id` | `delete: page:/accounts/cash-bank` | — |
| GET | `/expenses` | `view: page:/accounts/expenses, page:/sales/expenses` | — |
| POST | `/expenses` | `add: page:/accounts/expenses` | — |
| GET | `/expenses/categories` | `view: page:/accounts/expenses, page:/sales/expenses` | `dynamic view: page:/accounts/expenses, page:/sales/expenses` |
| GET | `/accounts/expense-ledgers` | `view: page:/accounts/expenses, page:/sales/expenses` | — |
| GET | `/accounts/location-expenses/summary` | `view: page:/accounts/expenses` | — |
| GET | `/accounts/location-expenses/all` | `view: page:/accounts/expenses, page:/sales/expenses` | — |
| GET | `/accounts/location-expenses` | `view: page:/accounts/expenses, page:/sales/expenses` | — |
| POST | `/accounts/location-expenses` | `add: page:/sales/expenses` | — |
| DELETE | `/accounts/location-expenses/:id` | `delete: page:/sales/expenses` | — |
| GET | `/accounts/financial-statements` | `view: page:/accounts/chart, page:/reports/sales` | — |
| GET | `/accounts/ledger/:id/statement` | `view: page:/accounts/ledger` | — |
| GET | `/gst/summary` | `view: page:/accounts/gst, page:/accounts/gst-returns` | — |
| GET | `/accounts/opening-balances` | `view: page:/accounts/chart` | `dynamic view: page:/accounts/chart` |
| POST | `/accounts/opening-balances` | `add: page:/accounts/chart` | — |
| GET | `/accounts/settlement-context` | `view: page:/accounts/vouchers, page:/operations/receipt-voucher, page:/operations/payment-voucher` | — |
| GET | `/accounts/party-advance` | `view: page:/sales/pos, page:/production/purchase, page:/accounts/vouchers, page:/operations/receipt-voucher, page:/operations/payment-voucher` | — |
| DELETE | `/accounts/opening-balances/:id` | `delete: page:/accounts/chart` | — |

### adminRenumber.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| POST | `/admin/sales-renumber/preview` | *exempt (see table above)* | `level-1 admin gate` |
| POST | `/admin/sales-renumber/apply` | *exempt (see table above)* | `level-1 admin gate` |
| POST | `/admin/sales-renumber/reset-lock` | *exempt (see table above)* | `level-1 admin gate` |
| GET | `/admin/sales-renumber/log` | — | `level-1 admin gate` |

### assets.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/assets/categories` | `view: page:/assets/purchases, page:/assets/register, page:/assets/categories, page:/assets/transfers, page:/assets/disposal, page:/assets/reports` | `dynamic view: page:/assets/purchases, page:/assets/register, page:/assets/categories, page:/assets/transfers, page:/assets/disposal, page:/assets/reports` |
| POST | `/assets/categories` | `add: page:/assets/categories` | — |
| PATCH | `/assets/categories/:id` | `edit: page:/assets/categories` | — |
| GET | `/assets/purchases` | `view: page:/assets/purchases, page:/assets/register, page:/assets/categories, page:/assets/transfers, page:/assets/disposal, page:/assets/reports` | `LBAC` |
| POST | `/assets/purchases` | `add: page:/assets/purchases` | — |
| PATCH | `/assets/purchases/:id` | `edit: page:/assets/register` | `LBAC` |
| DELETE | `/assets/purchases/:id` | `delete: page:/assets/register` | `LBAC` |
| GET | `/assets/transfers` | `view: page:/assets/transfers, page:/assets/register, page:/assets/reports` | `LBAC` |
| POST | `/assets/transfers` | `add: page:/assets/transfers` | `LBAC` |
| GET | `/assets/disposals` | `view: page:/assets/disposal, page:/assets/register, page:/assets/reports` | `LBAC` |
| POST | `/assets/disposals` | `add: page:/assets/disposal` | `LBAC` |
| GET | `/assets/summary` | `view: page:/assets/purchases, page:/assets/register, page:/assets/categories, page:/assets/transfers, page:/assets/disposal, page:/assets/reports` | `LBAC` |

### audit.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/audit/logs` | `view: page:/company/audit` | — |
| GET | `/audit/logs/:id` | `view: page:/company/audit` | — |

### auth.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| POST | `/auth/login` | *exempt (see table above)* | — |
| POST | `/auth/logout` | *exempt (see table above)* | — |
| POST | `/auth/change-password` | *exempt (see table above)* | — |
| GET | `/auth/me` | — | — |
| PUT | `/auth/location-pref` | *exempt (see table above)* | — |
| PATCH | `/auth/profile` | *exempt (see table above)* | — |

### backup.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/backup/dashboard` | `view: page:/company/backup` | `dynamic view: page:/company/backup` |
| GET | `/backup/list` | `view: page:/company/backup` | `dynamic view: page:/company/backup` |
| GET | `/backup/history` | `view: page:/company/backup` | `dynamic view: page:/company/backup` |
| POST | `/backup/create` | `add: page:/company/backup` | — |
| GET | `/backup/:id/download` | `download: page:/company/backup` | — |
| DELETE | `/backup/:id` | `delete: page:/company/backup` | — |
| GET | `/backup/:id/validate` | `view: page:/company/backup` | — |
| POST | `/backup/:id/verify` | `add: page:/company/backup` | — |
| POST | `/backup/upload` | `edit: page:/company/backup`<br>`HO-only location gate` | — |
| POST | `/backup/:id/restore` | `edit: page:/company/backup`<br>`HO-only location gate` | — |
| GET | `/backup/settings` | `view: page:/company/backup` | `dynamic view: page:/company/backup` |
| PATCH | `/backup/settings` | `edit: page:/company/backup`<br>`HO-only location gate` | — |

### bom.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/bom-templates` | `view: page:/production/item-master` | `dynamic view: page:/production/item-master` |
| GET | `/bom-templates/item/:itemId` | `view: page:/production/production` | — |
| POST | `/bom-templates` | `add: page:/production/production` | — |
| PUT | `/bom-templates/:id` | `edit: page:/production/production` | — |
| DELETE | `/bom-templates/:id` | `delete: page:/production/production` | — |

### branches.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/warehouses` | `view: page:/, page:/production/item-master, page:/headoffice/stock-verification, page:/headoffice/warehouses, page:/headoffice/outlets, page:/headoffice/item-price, page:/headoffice/inventory-reports, page:/headoffice/stock, page:/hr/attendance, page:/hr/payroll, page:/hr/employees, page:/accounts/expenses, page:/reports/sales, page:/transfers, page:/assets/purchases, page:/assets/register, page:/assets/transfers, page:/assets/reports` | `dynamic view: page:/, page:/production/item-master, page:/headoffice/stock-verification, page:/headoffice/warehouses, page:/headoffice/outlets, page:/headoffice/item-price, page:/headoffice/inventory-reports, page:/headoffice/stock, page:/hr/attendance, page:/hr/payroll, page:/hr/employees, page:/accounts/expenses, page:/reports/sales, page:/transfers, page:/assets/purchases, page:/assets/register, page:/assets/transfers, page:/assets/reports` |
| POST | `/warehouses` | `add: page:/headoffice/warehouses` | — |
| GET | `/warehouses/:id` | `view: page:/headoffice/warehouses` | — |
| PATCH | `/warehouses/:id` | `edit: page:/headoffice/warehouses` | — |
| DELETE | `/warehouses/:id` | `delete: page:/headoffice/warehouses` | `level-1 admin gate` |
| POST | `/warehouses/:id/disable` | `edit: page:/headoffice/warehouses` | `level-1 admin gate` |
| POST | `/warehouses/:id/enable` | `edit: page:/headoffice/warehouses` | `level-1 admin gate` |
| GET | `/warehouses/:id/delete-summary` | `delete: page:/headoffice/warehouses` | `level-1 admin gate` |
| DELETE | `/warehouses/:id/permanent` | `delete: page:/headoffice/warehouses` | `level-1 admin gate` |
| GET | `/outlets` | `view: page:/, page:/production/item-master, page:/headoffice/stock-verification, page:/headoffice/warehouses, page:/headoffice/outlets, page:/headoffice/item-price, page:/headoffice/inventory-reports, page:/headoffice/stock, page:/hr/attendance, page:/hr/payroll, page:/hr/employees, page:/accounts/expenses, page:/reports/sales, page:/transfers, page:/sales/pos, page:/sales/expenses, page:/assets/purchases, page:/assets/register, page:/assets/transfers, page:/assets/reports` | `dynamic view: page:/, page:/production/item-master, page:/headoffice/stock-verification, page:/headoffice/warehouses, page:/headoffice/outlets, page:/headoffice/item-price, page:/headoffice/inventory-reports, page:/headoffice/stock, page:/hr/attendance, page:/hr/payroll, page:/hr/employees, page:/accounts/expenses, page:/reports/sales, page:/transfers, page:/sales/pos, page:/sales/expenses, page:/assets/purchases, page:/assets/register, page:/assets/transfers, page:/assets/reports` |
| POST | `/outlets` | `add: page:/headoffice/outlets` | — |
| GET | `/outlets/:id` | `view: page:/headoffice/outlets` | — |
| PATCH | `/outlets/:id` | `edit: page:/headoffice/outlets` | — |
| DELETE | `/outlets/:id` | `delete: page:/headoffice/outlets` | — |

### cash-in-outlet.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/cash-in-outlet` | `view: page:/accounts/cash-in-outlet, page:/sales/expenses` | `LBAC` |
| GET | `/cash-in-outlet/deposits` | `view: page:/accounts/cash-in-outlet` | `LBAC` |
| POST | `/cash-in-outlet/deposits` | `add: page:/accounts/cash-in-outlet` | `LBAC` |
| POST | `/cash-in-outlet/deposits/:id/reconcile` | `edit: page:/accounts/cash-in-outlet, page:/accounts/reconciliation` | `LBAC` |

### company.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/company/settings` | — | — |
| PATCH | `/company/settings` | `edit: page:/company/settings` | — |
| GET | `/company/login-history` | `view: page:/company/login-history, page:/company/settings` | — |
| GET | `/company/permissions` | — | — |
| POST | `/company/permissions` | `edit: page:/company/permissions` | — |
| GET | `/company/permissions/rbac-audit` | `view: page:/company/permissions` | `dynamic view: page:/company/permissions` |
| POST | `/company/reset` | `delete: page:/company/settings` | `dynamic delete: page:/company/settings` |
| POST | `/company/clear-transactions` | `delete: page:/company/settings` | — |

### customers.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/customers` | `view: page:/sales/pos, page:/accounts/vouchers, page:/customers` | `LBAC` |
| POST | `/customers` | `add: page:/customers` | — |
| GET | `/customers/:id` | `view: page:/customers` | — |
| PATCH | `/customers/:id` | `edit: page:/customers` | — |
| DELETE | `/customers/:id` | `delete: page:/customers` | — |
| GET | `/vendors` | `view: page:/production/purchase, page:/accounts/vouchers, page:/vendors, page:/reports/sales, page:/assets/purchases, page:/assets/register, page:/assets/reports` | `LBAC` |
| POST | `/vendors` | `add: page:/vendors` | — |
| GET | `/vendors/:id` | `view: page:/vendors` | — |
| PATCH | `/vendors/:id` | `edit: page:/vendors` | — |
| DELETE | `/vendors/:id` | `delete: page:/vendors` | `LBAC` |
| GET | `/customers/:id/ledger` | `view: page:/customers, page:/outstanding` | — |
| GET | `/vendors/:id/ledger` | `view: page:/vendors, page:/outstanding` | — |
| POST | `/vendors/:id/payment` | `add: page:/vendors, page:/accounts/vouchers` | — |
| GET | `/coupons` | `view: page:/coupons` | `dynamic view: page:/coupons` |
| POST | `/coupons` | `add: page:/coupons` | — |
| PATCH | `/coupons/:id` | `edit: page:/coupons` | — |
| DELETE | `/coupons/:id` | `delete: page:/coupons` | — |

### dashboard.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/dashboard/summary` | `view: page:/` | `LBAC` |
| GET | `/dashboard/stock-alerts` | `view: page:/` | — |
| GET | `/dashboard/recent-activity` | `view: page:/` | — |
| GET | `/dashboard/sales-trend` | `view: page:/` | `LBAC` |
| GET | `/dashboard/top-items` | `view: page:/` | `LBAC` |
| GET | `/dashboard/sales-by-location` | `view: page:/` | `LBAC` |
| GET | `/dashboard/bi` | `view: page:/` | `LBAC` |
| GET | `/dashboard/production-trend` | `view: page:/` | — |

### dispatch.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/dispatch/queue` | `view: page:/operations/dispatch` | `LBAC` |
| POST | `/dispatch/:saleId/status` | `edit: page:/operations/dispatch` | `LBAC` |

### financialReports.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/reports/fin/ledgers` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/ledger-statement` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/ledger-options` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/trial-balance` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/cash` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/bank` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/cash-bank` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/gst` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/expenses` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/salary` | `view: page:/reports/sales` | — |
| GET | `/reports/fin/day-book` | `view: page:/reports/sales` | — |

### gst.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/gst/hsn-summary` | `view: page:/accounts/gst-returns` | — |
| GET | `/gst/gstr1` | `view: page:/accounts/gst-returns` | — |
| GET | `/gst/gstr3b` | `view: page:/accounts/gst-returns` | — |
| GET | `/gst/reconciliation` | `view: page:/accounts/gst-returns` | — |
| GET | `/gst/filters` | `view: page:/accounts/gst, page:/accounts/gst-returns` | — |
| GET | `/gst/documents` | `view: page:/accounts/gst, page:/accounts/gst-returns` | — |

### health.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/healthz` | — | — |
| GET | `/healthz/schema` | — | — |

### hr.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/hr/hierarchies` | — | `hasModuleAction delete: page:/hr/hierarchy` |
| POST | `/hr/hierarchies` | `add: page:/hr/hierarchy` | — |
| PATCH | `/hr/hierarchies/:id` | `edit: page:/hr/hierarchy` | — |
| DELETE | `/hr/hierarchies/:id` | `delete: page:/hr/hierarchy` | — |
| GET | `/hr/employees` | `view: page:/hr/employees` | `LBAC` |
| POST | `/hr/employees` | `add: page:/hr/employees` | — |
| GET | `/hr/employees/:id` | `view: page:/hr/employees` | — |
| PATCH | `/hr/employees/:id` | `edit: page:/hr/employees` | — |
| DELETE | `/hr/employees/:id` | `delete: page:/hr/employees` | — |
| GET | `/hr/pay-components/:employeeId` | `view: page:/hr/employees` | — |
| PUT | `/hr/pay-components/:employeeId` | `edit: page:/hr/employees, page:/hr/payroll` | — |
| GET | `/hr/payroll` | `view: page:/hr/payroll` | `hasModuleAction add: page:/hr/payroll` |
| POST | `/hr/payroll/generate` | `add: page:/hr/payroll` | — |
| GET | `/hr/payroll/unclassified-absences` | `view: page:/hr/payroll` | — |
| PATCH | `/hr/payroll/:id` | `edit: page:/hr/payroll` | — |
| GET | `/hr/salary-accruals` | `view: page:/hr/payroll` | `LBAC` |
| POST | `/hr/payroll/:id/approve` | `edit: page:/hr/payroll` | — |
| POST | `/hr/payroll/:id/pay` | `edit: page:/hr/payroll` | — |
| GET | `/hr/advances` | — | `hasModuleAction view: page:/hr/advances` |
| POST | `/hr/advances` | `add: page:/hr/advances` | — |
| PATCH | `/hr/advances/:id` | `edit: page:/hr/advances` | — |
| DELETE | `/hr/advances/:id` | `delete: page:/hr/advances` | — |
| GET | `/hr/attendance` | `view: page:/hr/attendance` | — |
| GET | `/hr/attendance/config` | `view: page:/hr/attendance` | `dynamic view: page:/hr/attendance` |
| GET | `/hr/holidays` | `view: page:/hr/attendance` | — |
| POST | `/hr/holidays` | `edit: page:/hr/attendance` | — |
| DELETE | `/hr/holidays/:id` | `edit: page:/hr/attendance` | — |
| GET | `/hr/leave-balance` | `view: page:/hr/attendance` | — |
| POST | `/hr/attendance/check-in` | `add: page:/hr/attendance` | — |
| POST | `/hr/attendance/check-out` | `add: page:/hr/attendance` | — |
| GET | `/hr/leaves` | `view: page:/hr/attendance` | `hasModuleAction edit: page:/hr/attendance`<br>`LBAC` |
| POST | `/hr/leaves` | `add: page:/hr/attendance` | — |
| POST | `/hr/leaves/:id/approve` | `edit: page:/hr/attendance` | `LBAC` |
| POST | `/hr/leaves/:id/cancel` | `view: page:/hr/attendance` | — |
| PUT | `/hr/attendance` | `edit: page:/hr/attendance` | — |
| POST | `/hr/employees/:id/reset-password` | `edit: page:/hr/employees` | `LBAC` |

### imports.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/imports/templates/:module` | `download: page:/company/import` | — |
| POST | `/imports/parse` | `add: page:/company/import` | `LBAC` |
| GET | `/imports/batches/:id/mappings` | `view: page:/company/import` | — |
| POST | `/imports/batches/:id/mappings` | `add: page:/company/import` | — |
| GET | `/imports/mappings` | `view: page:/company/import` | — |
| GET | `/imports/mapping-candidates` | `view: page:/company/import` | — |
| PUT | `/imports/mappings/:id` | `edit: page:/company/import` | — |
| DELETE | `/imports/mappings/:id` | `delete: page:/company/import` | — |
| GET | `/imports/batches` | `view: page:/company/import` | `dynamic view: page:/company/import` |
| GET | `/imports/batches/:id` | `view: page:/company/import` | — |
| GET | `/imports/batches/:id/error-file` | `download: page:/company/import` | — |
| POST | `/imports/batches/:id/demo` | `add: page:/company/import` | — |
| GET | `/imports/batches/:id/demo-report` | `view: page:/company/import` | — |
| POST | `/imports/batches/:id/approve` | `add: page:/company/import` | — |
| POST | `/imports/batches/:id/discard` | `add: page:/company/import` | — |
| POST | `/imports/batches/:id/commit` | `add: page:/company/import` | — |
| POST | `/imports/batches/:id/rollback` | `delete: page:/company/import` | — |
| POST | `/imports/migrations` | `add: page:/company/import` | — |
| GET | `/imports/migrations` | `view: page:/company/import` | `dynamic view: page:/company/import` |
| GET | `/imports/migrations/:id` | `view: page:/company/import` | — |
| POST | `/imports/migrations/:id/files` | `add: page:/company/import` | — |
| DELETE | `/imports/migrations/:id/files/:module` | `add: page:/company/import` | — |
| GET | `/imports/migrations/:id/mappings` | `view: page:/company/import` | — |
| POST | `/imports/migrations/:id/mappings` | `add: page:/company/import` | — |
| POST | `/imports/migrations/:id/demo` | `add: page:/company/import` | — |
| GET | `/imports/migrations/:id/demo-report` | `view: page:/company/import` | — |
| POST | `/imports/migrations/:id/approve` | `add: page:/company/import` | — |
| POST | `/imports/migrations/:id/discard` | `add: page:/company/import` | — |
| POST | `/imports/migrations/:id/rollback` | `delete: page:/company/import` | — |

### inventory-batches.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/stock/batches` | `view: page:/headoffice/stock, page:/transfers` | `LBAC` |
| GET | `/stock/batches/suggest` | `view: page:/transfers` | — |
| GET | `/stock/expiry-report` | `view: page:/headoffice/inventory-reports` | `LBAC` |
| GET | `/stock/valuation` | `view: page:/headoffice/inventory-reports` | `LBAC` |
| GET | `/stock/movement-analysis` | `view: page:/headoffice/inventory-reports` | `LBAC` |
| GET | `/stock/reorder-report` | `view: page:/headoffice/inventory-reports` | `dynamic view: page:/headoffice/inventory-reports` |
| POST | `/stock/verifications` | `add: page:/headoffice/stock-verification` | — |
| GET | `/stock/verifications` | `view: page:/headoffice/stock-verification` | — |
| GET | `/stock/verifications/:id` | `view: page:/headoffice/stock-verification` | — |

### inventory.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/materials` | `view: page:/production/item-master, page:/production/production, page:/production/purchase, page:/transfers` | — |
| POST | `/materials` | `add: page:/production/item-master` | — |
| GET | `/materials/:id` | `view: page:/production/item-master` | — |
| PATCH | `/materials/:id` | `edit: page:/production/item-master` | — |
| DELETE | `/materials/:id` | `delete: page:/production/item-master` | — |
| GET | `/raw-materials` | `view: page:/production/item-master, page:/production/production, page:/production/purchase, page:/transfers` | — |
| POST | `/raw-materials` | `add: page:/production/item-master` | — |
| GET | `/raw-materials/:id` | `view: page:/production/item-master` | — |
| PATCH | `/raw-materials/:id` | `edit: page:/production/item-master` | — |
| DELETE | `/raw-materials/:id` | `delete: page:/production/item-master` | — |
| GET | `/items` | `view: page:/production/item-master, page:/production/production, page:/production/purchase, page:/headoffice/item-price, page:/sales/pos, page:/returns, page:/headoffice/stock, page:/transfers` | — |
| POST | `/items` | `add: page:/production/item-master` | — |
| GET | `/items/:id` | `view: page:/production/item-master` | — |
| PATCH | `/items/:id` | `edit: page:/production/item-master` | — |
| DELETE | `/items/:id` | `delete: page:/production/item-master` | — |
| GET | `/assets` | `view: page:/production/item-master, page:/production/purchase, page:/assets/purchases, page:/assets/register, page:/assets/reports` | — |
| POST | `/assets` | `add: page:/production/item-master` | — |
| GET | `/assets/:id` | `view: page:/production/item-master, page:/production/purchase, page:/assets/purchases, page:/assets/register, page:/assets/reports` | — |
| PATCH | `/assets/:id` | `edit: page:/production/item-master` | — |
| DELETE | `/assets/:id` | `delete: page:/production/item-master` | — |

### invoiceShareLinks.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/sales/:id/share-link` | `download: page:/sales/pos, page:/outstanding` | — |
| POST | `/sales/:id/share-link` | `download: page:/sales/pos, page:/outstanding` | — |
| POST | `/sales/:id/share-link/regenerate` | `download: page:/sales/pos, page:/outstanding` | — |
| POST | `/sales/:id/share-link/revoke` | `download: page:/sales/pos, page:/outstanding` | — |
| GET | `/share/invoice/:publicId` | — | — |
| GET | `/share/invoice/:publicId/pdf` | — | — |

### itemTracking.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/item-tracking` | `view: page:/headoffice/stock, page:/production/item-master` | `LBAC` |

### journal.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/accounts/journal-vouchers` | `view: page:/accounts/vouchers` | — |
| GET | `/accounts/voucher-locations` | `view: page:/accounts/vouchers, page:/operations/receipt-voucher, page:/operations/payment-voucher, page:/sales/pos, page:/outstanding, page:/customers` | — |
| POST | `/accounts/journal-vouchers` | `add: page:/accounts/vouchers` | — |
| GET | `/accounts/journal-vouchers/:id` | `view: page:/accounts/vouchers` | — |
| PATCH | `/accounts/journal-vouchers/:id` | `edit: page:/accounts/vouchers` | — |
| DELETE | `/accounts/journal-vouchers/:id` | `delete: page:/accounts/vouchers` | `level-1 admin gate` |
| GET | `/accounts/day-book` | `view: page:/accounts/day-book` | — |
| GET | `/accounts/cash-bank-book/ledgers` | `view: page:/accounts/cash-book, page:/accounts/bank-book, page:/accounts/cash-bank` | — |
| GET | `/accounts/cash-bank-book` | `view: page:/accounts/cash-book, page:/accounts/bank-book` | — |
| GET | `/accounts/trial-balance` | `view: page:/accounts/trial-balance` | — |

### payments.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/sales/:id/payments` | `view: page:/sales/pos` | `LBAC` |
| POST | `/sales/:id/payments` | `add: page:/sales/pos, page:/outstanding, page:/customers` | — |

### pdfGen.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| POST | `/pdf/challan` | `download: page:/transfers` | — |
| POST | `/pdf/report` | `download: page:/reports/sales, page:/accounts/ledger, page:/accounts/day-book, page:/accounts/cash-book, page:/accounts/bank-book, page:/accounts/trial-balance` | — |
| POST | `/xlsx/report` | `download: page:/reports/sales, page:/accounts/ledger, page:/accounts/day-book, page:/accounts/cash-book, page:/accounts/bank-book, page:/accounts/trial-balance` | — |
| POST | `/pdf/expense-voucher` | `download: page:/accounts/expenses, page:/sales/expenses` | — |
| POST | `/pdf/money-voucher` | *exempt (see table above)* | `dynamic download: page:/accounts/vouchers` |
| POST | `/pdf/payslip` | `download: page:/hr/payroll` | — |

### periods.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/accounting-periods/locks` | — | — |
| GET | `/accounting-periods/events` | `view: page:/accounts/periods` | — |
| GET | `/accounting-periods/:year/:month/summary` | `view: page:/accounts/periods` | — |
| POST | `/accounting-periods/:year/:month/lock` | `view: page:/accounts/periods` | `level-1 admin gate` |
| POST | `/accounting-periods/:year/:month/unlock` | `view: page:/accounts/periods` | `level-1 admin gate` |

### production.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/productions` | `view: page:/production/production` | `LBAC` |
| GET | `/productions/reports` | `view: page:/production/reports` | `LBAC` |
| POST | `/productions` | `add: page:/production/production` | — |
| GET | `/productions/:id` | `view: page:/production/production` | `LBAC` |
| PATCH | `/productions/:id` | `edit: page:/production/production` | `LBAC` |
| DELETE | `/productions/:id` | `delete: page:/production/production` | `LBAC` |

### publicInvoices.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/public/invoices/:token` | — | — |

### publicQuotations.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/public/quotations/:token` | — | — |

### purchases.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/purchases` | `view: page:/production/purchase, page:/returns` | `LBAC` |
| POST | `/purchases` | `add: page:/production/purchase` | — |
| GET | `/purchases/:id` | `view: page:/production/purchase` | `LBAC` |
| PATCH | `/purchases/:id` | `edit: page:/production/purchase` | `LBAC` |
| DELETE | `/purchases/:id` | `delete: page:/production/purchase` | `LBAC` |

### quotationShareLinks.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/quotations/:id/share-link` | `download: page:/sales/quotations` | — |
| POST | `/quotations/:id/share-link` | `download: page:/sales/quotations` | — |
| POST | `/quotations/:id/share-link/regenerate` | `download: page:/sales/quotations` | — |
| POST | `/quotations/:id/share-link/revoke` | `download: page:/sales/quotations` | — |
| GET | `/share/quotation/:publicId` | — | — |
| GET | `/share/quotation/:publicId/pdf` | — | — |

### quotations.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/quotations/notifications/expired` | `view: page:/sales/quotations` | `LBAC` |
| GET | `/quotations/salespeople` | `view: page:/sales/quotations` | `dynamic view: page:/sales/quotations` |
| GET | `/quotation-payment-terms` | `view: page:/company/settings` | `dynamic view: page:/company/settings` |
| POST | `/quotation-payment-terms` | `edit: page:/company/settings` | — |
| PATCH | `/quotation-payment-terms/:id` | `edit: page:/company/settings` | — |
| DELETE | `/quotation-payment-terms/:id` | `edit: page:/company/settings` | — |
| GET | `/quotations` | `view: page:/sales/quotations` | `LBAC` |
| POST | `/quotations` | `add: page:/sales/quotations` | `LBAC` |
| GET | `/quotations/:id` | `view: page:/sales/quotations` | — |
| PUT | `/quotations/:id` | `edit: page:/sales/quotations` | `LBAC` |
| POST | `/quotations/:id/status` | `edit: page:/sales/quotations` | — |
| DELETE | `/quotations/:id` | `delete: page:/sales/quotations` | — |
| GET | `/quotations/:id/stock-check` | `view: page:/sales/quotations` | — |
| POST | `/quotations/:id/share-token` | `download: page:/sales/quotations` | — |

### reconciliation.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/reconciliation/bank-ledgers` | `view: page:/accounts/reconciliation, page:/accounts/cash-in-outlet` | `dynamic view: page:/accounts/reconciliation, page:/accounts/cash-in-outlet` |
| POST | `/reconciliation/bank-accounts` | `add: page:/accounts/reconciliation` | — |
| GET | `/reconciliation/pending` | `view: page:/accounts/reconciliation` | — |
| GET | `/reconciliation/batches` | `view: page:/accounts/reconciliation` | `dynamic view: page:/accounts/reconciliation` |
| GET | `/reconciliation/batches/:id` | `view: page:/accounts/reconciliation` | — |
| POST | `/reconciliation/batches` | `add: page:/accounts/reconciliation` | — |
| GET | `/reconciliation/reconciled` | `view: page:/accounts/reconciliation` | — |
| POST | `/reconciliation/:id/match` | `edit: page:/accounts/reconciliation` | — |
| POST | `/reconciliation/:id/unmatch` | `edit: page:/accounts/reconciliation` | — |

### rent.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/rent/agreements` | `view: page:/hr/rent` | `LBAC` |
| PATCH | `/rent/agreements/:warehouseId` | `edit: page:/hr/rent` | `LBAC` |
| GET | `/rent/accruals` | `view: page:/hr/rent` | `LBAC` |
| POST | `/rent/accrue` | `edit: page:/hr/rent` | `LBAC` |
| GET | `/rent/periods` | `view: page:/hr/rent` | `LBAC` |
| POST | `/rent/periods/:warehouseId/:year/:month/approve` | `edit: page:/hr/rent` | `LBAC` |
| POST | `/rent/periods/:warehouseId/:year/:month/pay` | `add: page:/hr/rent` | `LBAC` |
| GET | `/rent/payments` | `view: page:/hr/rent` | `LBAC` |
| GET | `/rent/dashboard` | `view: page:/hr/rent` | `LBAC` |
| GET | `/rent/ledger-postings` | `view: page:/hr/rent` | `LBAC` |

### reports.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/reports/sales-register` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/sales-by-item` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/sales-by-location` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/discounts` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/purchase-register` | `view: page:/reports/sales` | — |
| GET | `/reports/purchases-by-vendor` | `view: page:/reports/sales` | — |
| GET | `/reports/purchases-by-material` | `view: page:/reports/sales` | — |
| GET | `/reports/profitability` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/sales-stock-combined` | `view: page:/reports/sales` | `LBAC` |
| GET | `/reports/gst-transfers` | `view: page:/reports/sales` | — |
| GET | `/reports/branch-transfers` | `view: page:/reports/sales` | `LBAC` |

### returns.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| POST | `/sales-returns` | `add: page:/returns, page:/sales/pos` | `LBAC` |
| GET | `/sales-returns` | `view: page:/returns` | `LBAC` |
| PATCH | `/sales-returns/:id` | `edit: page:/returns` | `LBAC` |
| POST | `/purchase-returns` | `add: page:/returns, page:/production/purchase` | `LBAC` |
| GET | `/purchase-returns` | `view: page:/returns` | `LBAC` |
| PATCH | `/purchase-returns/:id` | `edit: page:/returns` | `LBAC` |
| GET | `/outstanding/receivables` | `view: page:/outstanding, page:/customers` | `LBAC` |
| GET | `/outstanding/payables` | `view: page:/outstanding, page:/vendors` | — |
| GET | `/outstanding/collections` | `view: page:/outstanding` | `LBAC` |

### sales.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/item-prices` | `view: page:/headoffice/item-price, page:/sales/pos` | — |
| POST | `/item-prices` | `add: page:/headoffice/item-price` | — |
| GET | `/sales` | `view: page:/sales/pos, page:/returns, page:/` | `LBAC` |
| POST | `/sales` | `add: page:/sales/pos` | `hasModuleAction edit: page:/outstanding, page:/returns`<br>`LBAC` |
| PUT | `/sales/:id` | `edit: page:/sales/pos` | `hasModuleAction edit: page:/outstanding, page:/returns`<br>`LBAC` |
| POST | `/sales/:id/cancel` | `delete: page:/sales/pos` | `LBAC` |
| GET | `/sales/price-history` | `view: page:/sales/pos` | `LBAC` |
| GET | `/sales/summary` | `view: page:/sales/pos, page:/` | `LBAC` |
| POST | `/sales/:id/share-token` | *exempt (see table above)* | `hasModuleAction download: page:/sales/pos, page:/outstanding`<br>`LBAC` |
| GET | `/sales/:id/invoice.pdf` | — | `hasModuleAction download: page:/sales/pos, page:/outstanding`<br>`LBAC` |
| GET | `/sales/:id` | `view: page:/sales/pos` | `LBAC` |

### search.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/search` | — | `LBAC` |

### stock.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/stock` | `view: page:/, page:/production/item-master, page:/headoffice/stock-verification, page:/sales/pos, page:/headoffice/stock, page:/transfers` | `LBAC` |
| GET | `/stock/ledger` | `view: page:/headoffice/stock-ledger, page:/headoffice/inventory-reports, page:/headoffice/stock` | — |
| GET | `/stock/transfers` | `view: page:/transfers` | `LBAC` |
| POST | `/stock/transfers` | `add: page:/transfers` | `LBAC` |
| PATCH | `/stock/transfers/:id/approve` | `edit: page:/transfers` | `LBAC` |
| PATCH | `/stock/transfers/:id/reject` | `edit: page:/transfers` | `LBAC` |
| GET | `/stock/transfers/:id` | `view: page:/transfers` | `LBAC` |

### storage.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| POST | `/storage/uploads/request-url` | *exempt (see table above)* | — |
| GET | `/storage/objects/*path` | — | — |

### storageLocations.ts

| Method | Path | Guards | In-handler |
| --- | --- | --- | --- |
| GET | `/storage-locations` | `view: page:/headoffice/stock` | — |
| POST | `/storage-locations` | `add: page:/headoffice/stock` | — |
| PATCH | `/storage-locations/:id` | `edit: page:/headoffice/stock` | — |
| DELETE | `/storage-locations/:id` | `delete: page:/headoffice/stock` | — |
| GET | `/storage-stock` | `view: page:/headoffice/stock` | — |
| POST | `/storage-placements/move` | `edit: page:/headoffice/stock` | — |


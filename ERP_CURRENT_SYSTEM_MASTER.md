# Frozen Fruits ERP — Current System Master

**Audit status:** IN PROGRESS — Phases 1–6 partial
**Snapshot date:** 2026-09-30
**Evidence scope:** current repository source and read-only development-database schema metadata
**Production database:** NOT QUERIED
**Functional changes during this audit:** none

> This is the new working master document. It does not replace code as the authority. Findings labelled **NOT VERIFIED** are deliberately left open until the relevant route, service, schema and tests are traced.

## 1. Audit scope and source precedence

For this audit, use evidence in this order:

1. Current route, service, UI and migration code.
2. Read-only schema metadata from the development PostgreSQL database.
3. Existing documentation as historical context only.

The Drizzle schema is a partial view of the database. Raw PostgreSQL queries and startup migrations also create or alter operational schema. Do not infer the complete schema from Drizzle alone. No production database was queried and no database writes, migrations, restores, or tests against business data were performed during this documentation phase.

## 2. Current architecture

### Runtime components

| Component | Current location | Verified role |
|---|---|---|
| ERP web application | `artifacts/marlin-erp` | React/Vite browser UI; route tree is in `src/App.tsx`, page/module navigation and permission metadata in `src/lib/moduleRegistry.ts`. |
| API server | `artifacts/api-server` | Express/TypeScript API. `src/app.ts` installs request logging, CORS, body parsing, global API authentication and JSON error handling; `src/routes/index.ts` mounts business routers. |
| Employee application | `artifacts/employee-app` | Expo/React Native application; screens are under `app/`. Individual screen behavior remains to be audited. |
| Component preview sandbox | `artifacts/mockup-sandbox` | Design/component preview service; not an ERP business runtime. |
| Shared libraries | `lib/*` | Database schema/types, API specification/Zod/client hooks, PDF helpers and purchase-pricing code. Exact usage by module remains to be traced. |
| Database | PostgreSQL | API uses `pg` and Drizzle helpers. Many business queries and boot migrations use raw SQL. |

### Request and reporting flow

```text
ERP browser / employee mobile app
        ↓
React Query or app API client
        ↓
Express API (request middleware → authentication → mounted route)
        ↓
module authorization, location scope and business/date guards
        ↓
route and shared service/library logic
        ↓
PostgreSQL source documents, ledgers and inventory tables
        ↓
accounting derivation / inventory valuation / report-specific readers
        ↓
JSON and document/export responses
```

End-to-end screen-to-export coverage remains **NOT VERIFIED**. Core accounting, inventory, GST, payroll and asset paths have now been traced to current source, but not every consumer has been proven to use one universal calculation.

### Current platform/workflow inventory

Four managed workflows are configured: API Server, ERP web, employee Expo app, and component preview sandbox. At the audit snapshot all four were reported running. The first three serve the ERP; the sandbox is auxiliary.

## 3. Initial code inventory

These are mechanical source counts, not a final count of unique business modules or API operations:

| Inventory | Phase 1 count | Counting rule / caveat |
|---|---:|---|
| API route files | 43 | Files directly under `artifacts/api-server/src/routes`, including the router index. |
| Mounted route modules | 42 | `router.use(...)` calls in `src/routes/index.ts`. |
| API route declarations | 410 | Unique normalized literal method/path pairs from the static route scan; no duplicate pair was found. Not a live runtime probe. |
| Frontend module registry entries | 55 | `MODULE_REGISTRY` entries; the registry also retains retired/compatibility surfaces. Not the final count of active user-facing modules. |
| Frontend page source files | 105 | `.ts`/`.tsx` files under `artifacts/marlin-erp/src/pages`; not equivalent to screens or modules. |
| Employee-app route source files | 20 | `.ts`/`.tsx` files under `artifacts/employee-app/app`; not a verified count of distinct workflows. |
| Configured Replit workflows | 4 | API, web, Expo employee app, component preview sandbox. |
| Public development database base tables | 93 | Read-only `information_schema` snapshot on 2026-09-29. Production count is NOT VERIFIED. |
| Public development database trigger objects | 3 | Two stock-master guards and one stock-ledger daily-close guard; the metadata query returned six event rows because each trigger handles two events. |
| Module registry keys | 55 | 48 navigable, non-retired keys; 4 hidden compatibility keys; 3 explicitly retired keys. Not a distinct production-usage count. |
| Permission page keys | 57 | Generated `pagePermissions.ts` keys; compatibility and alias keys make this different from the registry count. |
| Unique static API operations | 410 | Normalized literal method/path pairs from current route declarations; not a live runtime probe. See `ERP_API_INVENTORY.md`. |
| Reports Center | 9 categories / 40 report slots | Current UI category and report-option arrays; several slots share endpoints. See `ERP_REPORT_INVENTORY.md`. |

The current development schema includes the future-only stock-close tables: `stock_daily_close_baseline`, `stock_daily_close_baseline_entries`, `stock_daily_close_runs`, and `stock_daily_close_entries`. The stock-close implementation and its effects on FI-08 are present in current source; full operational behavior and report parity are deferred to the inventory/report phases.

`MODULE_REGISTRY` is the navigation/permission source of truth, but its 55 keys are not 55 distinct business modules: 48 have non-retired navigation entries, 4 are hidden compatibility folds, and 3 are explicitly retired; some keys own multiple pages, and some UI routes are aliases or satellites. The generated permission mirror has 57 page keys. These are source ownership counts, not production-usage counts; no single distinct active-business-module total is asserted.

## 4. Source and documentation inventory

### Existing references reviewed

| File | Snapshot indicated by file | Phase 1 finding |
|---|---|---|
| `ERP_COMPLETE_DOCUMENTATION.md` | Repository-derived documentation marked inspected 2026-09-18 | The file has 9,560 lines consisting of eight byte-identical 1,195-line copies. Treat as historical input, not a clean current master. |
| `ERP_FINAL_HARDENING_REPORT.md` | 2026-09-18 | Reports development as NOT READY and lists remaining evidence gates. It predates the current daily stock-close implementation, so its FI-08 status is not current. |
| `ERP_RELEASE_GATE_REPORT.md` | — | Not present at repository root. |
| `docs/ERP_SYSTEM_AUDIT.md` | 2026-08-01 with August addenda | Historical audit. Its database summary says 69 tables and no triggers; the 2026-09-29 development-schema metadata shows 93 base tables and three trigger objects. |
| `SOURCE_OF_TRUTH.md` | Undated in inspected section | Contains statements that conflict with later documentation. The affected code paths must be checked before deciding which behavior is current. |

The older documents are useful as leads and historical evidence only. In particular, the August audit and the September 18 reports must not be copied forward as current status without source verification.

## 5. Source-backed findings added after Phase 1

### Accounting and reports

- `artifacts/api-server/src/routes/journal.ts:1064` exports `buildDerivedPostings()`. It derives normalized, location-stamped postings from source documents and stored journal lines. The current core statements call `buildBooks()` with this posting builder.
- `artifacts/api-server/src/lib/books.ts:1074-1490` builds period P&L and cumulative Balance Sheet views. Opening balances are outside the posting stream and are included cumulatively. Closing stock is dated to the report cutoff; historical positions can be marked unreliable when evidence is incomplete.
- Core P&L expressions in `lib/books.ts:1293-1316`:
  - `revenue = salesGroup + directIncome` after transfer-out account stripping.
  - `COGS = openingStock + purchases + directExpenses - closingStock` after transfer-in stripping.
  - `grossProfit = revenue - COGS`; margins are `part / revenue * 100`, or zero when the denominator magnitude is below ₹0.005.
  - `totalExpenses = openingStock + purchases + directExpenses + indirectExpenses`; `totalIncomes = sales + closingStock + directIncome + indirectIncome`, with internal transfer ledgers excluded.
  - `netProfit = totalIncomes - totalExpenses`.
- The Balance Sheet uses cumulative ledger balances. `retainedEarnings = cumulativeIncome + closingStock - cumulativeExpense`; assets include fixed assets, current assets and closing stock; liabilities include capital, loans, current liabilities and retained earnings. Current displayed difference is assets minus liabilities.
- Transfer P&L treatment is a specific exception to naive ledger summation: transfer-in/out ledgers are stripped from operating totals and dated stock-boundary values carry the goods value once. Transfer opening adjustment is `period transfer movements + closing in-transit - opening in-transit`.
- GST readers are not all one query. `buildDerivedPostings()` supplies the ledger side; `routes/gst.ts` separately builds invoice/return registers and reconciliation. GSTR-3B uses the code's explicit ITC set-off sequence; see formula register.
- The profitability report is a distinct per-item view (`routes/reports.ts:642-755`) using invoice line subtotal and batch cost. Its cost basis is not the P&L's periodic opening + purchases − closing formula; the source explicitly treats this as a separate definition.

### Sales, purchases, settlements and returns

- Sale pricing is owned by `routes/sales.ts` and shared by create/edit and quotation paths. Unit discounts and legacy line-total discounts are distinct; bill discount is allocated in integer paise by largest remainder. GST can be inclusive (legacy default) or exclusive; inclusive/exclusive formulas and the paise-exact intra-state split are recorded in the formula register.
- Sale coupons are post-tax, capped against goods subtotal + tax, and do not reduce taxable base. Other sale charges are separate no-GST income items, added to the customer total but not merchandise/GST totals.
- POS advances apply before the counter payment. Partial payment requires a registered customer; overpayment requires consent and a registered customer. Collection routes share receipt posting and derive payment method from the receive-into ledger. Counter payment history is not a second posting.
- `salePaymentPosition` is the shared customer-outstanding owner: invoice total less credit adjustments less received amount, cancellation → zero, with ₹0.005 tolerance. Cash refunds are not credit adjustments. As-of readers cap payments/returns by business date.
- Sales and purchase returns prorate stored line taxable/GST values by returned quantity, rounding each head to paise. Both intentionally exclude document-level other charges from return value; sale returns restore stock/batches and purchase returns reduce them.
- Purchase per-line price math is shared by API and web preview. Goods `total_amount` is rounded to whole rupees; other charges remain outside goods value and purchase stock cost but are added to the vendor payable. Vendor allocations can include goods + charges; unmatched amount remains vendor advance. Payables are ledger-authoritative, not a competing sum of bill rows.
- Current semantic exception: a full sale or purchase goods return does not itself refund/reverse the document-level charges. Purchase payables can therefore differ from the purchase row's goods-only total; these are current code policies, not declared defects.

### Cash, bank and ledger readers

- `ledgerBalances` builds current balances from derived postings plus opening balances; raw net is `Σ(Dr−Cr)`, vendor payable displays `−net`, customer receivable and cash/bank display `+net`. Chart-of-accounts tree is a hierarchy; `/accounts/chart` returns zero-valued balance fields and is not the balance source.
- Cash/Bank Book opening is pre-window `Σ(Dr−Cr)` and closing is opening plus in-window postings. Trial Balance shows positive net on debit, negative on credit, and considers the report balanced below ₹0.01 difference.
- Bank reconciliation is an internal posting review keyed by exact `(ledger_id, entry_id)`. It records matched/review status and computes selected gross less processing charge; it does not ingest an external bank statement ending balance or calculate outstanding statement items. Opening balances and cash accounts are excluded from eligible reconciliation entries.
- Outlet cash availability is `max(0, ledger balance)`; pending deposits are shown separately and not subtracted by this calculation. This distinction is a documented behavior, not a validated product definition of “available.”
- Opening balances are not presented identically on every location-filtered surface: the shared ledger index excludes company-level openings from location slices, financial report split filters openings by location, and Cash/Bank Book has a branch-only exception for authorized ledger openings. Treat these outputs as separate readers until parity is explicitly verified.
- Source test files assert trial-balance, location-slice, dashboard, ledger, settlement and cash/bank parity, but tests were not executed in this audit.

### Inventory and costing

- Canonical on-hand quantity comes from `stock_entries`, keyed by product kind, product ID and location. `stock_batches` is additive lot evidence, not a replacement for the quantity authority.
- Availability subtracts active reservations from on-hand quantity and clamps at zero. A `hold` reduces availability; `in_transit` is already deducted from the sender and remains sender-owned for valuation.
- `lib/valuation.ts:213-399` is the canonical valuation path. Current location cost prefers dated product/location checkpoints, then master weighted-average/manual cost where allowed. Historical valuation uses dated checkpoints and movements; missing evidence is excluded and surfaced, not replaced with a current master cost. On-hand value uses the unrounded cost for multiplication; in-transit value uses dispatch cost.
- FEFO batches are ordered by expiry ascending, NULL expiry last, then batch ID; each take is the lesser of available lot quantity and remaining request. Any remaining quantity without covered lot evidence is untracked.
- Physical stock verification sets location quantity to the counted value and writes a signed ledger row/checkpoint. Positive variance creates an adjustment lot; negative variance consumes available batches FEFO, but an uncovered residual does not block the quantity update, and the negative adjustment ledger unit cost is 0. No direct JV/P&L/GST write is visible in the handler. Intent and downstream parity are NOT VERIFIED; see F-033 and GAP-013.
- Opening-stock import is an additive finished-item transaction module, not an absolute correction. Generic import demo/approve/rollback routes run it; no dedicated opening-stock URL exists. Demo stock writes roll back, approve commits, and rollback is blocked when the imported OPN lot was consumed. It writes verification metadata, stock entries, an OPN batch, dated stock ledger and HO production mirror, with no direct accounting/GST posting. Its average-cost update uses global item quantity across locations; see F-034. Dedicated opening-stock test evidence was not identified; test result is NOT ESTABLISHED.
- Potential location-scope exception: `GET /stock/reorder-report` requires `page:/headoffice/inventory-reports` but has no visible authenticated-location predicate and returns qualifying rows across locations. A non-Head-Office hierarchy with the view grant can reach it; the page is administrator-grantable, and the legacy seed may have granted it to existing roles. New hierarchies default-deny. Current grants and actual exposure were not queried or tested; see GAP-012.
- `lib/productionCosting.ts:218-275` computes material cost, overhead, daily payroll labour allocation, total cost, unit cost and wastage value. Route-level producer coverage is still to be completed.
- Daily stock close is future-only. A baseline and completed daily snapshots support `FI-08`; the write guard rejects uncovered/backdated movements. Development schema includes four stock-close tables and a trigger. The baseline does not establish a reconstructed historical daily stock record.

### Payroll and fixed assets

- Attendance uses company-calendar days, closed punch-session hours, stored attendance and configured leave allowances. A full day is met at the configured threshold; half-day is met at the half threshold. Multi-punch work is total closed-session hours, not first-in to last-out span.
- Payroll applies LOP to the effective basic, then calculates configured allowances, employee/employer PF and ESI, other deductions, net pay (floored at zero), and employer cost. The rates are configurable; this audit does not certify statutory/legal applicability.
- Salary accrual is cumulative within the month and writes the change from the prior cumulative expected amount, avoiding daily rounding drift. The actual calendar-month day count is used; the legacy 26-day constant is not the pricing basis.
- Asset depreciation is monthly straight-line: `monthly = totalCost / usefulLifeMonths`, rounded to paise and capped by remaining cost. The inspected code does not implement salvage value or day-proration. Depreciation-specific automated tests were not identified in the test search.

### Known reader differences

- `/reports/profitability` uses per-item/batch cost and is not the periodic P&L COGS formula.
- `/reports/sales-by-salesperson` calculates outstanding with its own direct `max(0,total-paid-creditAdjustments)` expression instead of the shared payment-position helper; a rounding-edge parity risk remains.
- `/stock` list money fields use master average-cost values, while canonical valuation uses location checkpoints. Different locations can therefore display different value bases.
- Sale stock-ledger `unitCost` is populated from sale unit price in the sale write path. It must not be treated as canonical inventory cost or COGS.
- The legacy dashboard `totalSalesAmount` reader sums `sales.total_amount` after excluding cancelled and branch-transfer documents; this is a gross invoice measure including tax and charges, not P&L revenue net of GST. Dashboard BI's GP/NP/COGS still comes from the canonical books engine. Whether every user-facing dashboard surface labels or compares the gross measure correctly is NOT VERIFIED.

### Test evidence boundary

Source test families were identified, including accounting acceptance, GST reconciliation, historical stock dating/location cost, transfer receiving, payroll LOP/accrual, assets, permissions/LBAC, mobile, backup, import, reset, dispatch and daily stock closure. The API server has 70 `*.test.mjs`/`*.test.ts` files (68 MJS, 2 TS); 73 total files under `artifacts/api-server/tests` includes 3 helper/support files. Four test filenames match the case-insensitive terms `report|dashboard|export|pdf|xlsx|csv`: `books-drilldown-export.test.mjs`, `dashboard-parity.test.mjs`, `invoice-pdf.test.mjs`, and `sales-report-definition.test.mjs`. These are filename counts, not test-case counts or proof of content coverage. Tests were not run during this documentation pass. The asset test search did not identify a depreciation-specific suite, and a dedicated FEFO ordering test was not found by the search; those are coverage gaps, not proof of incorrect results.

### Authentication, authorization and location scope

- API-wide `requireAuth` covers `/api` except explicit health/schema, login and token/public-share/mobile-distribution paths. Authenticated requests re-resolve the active user. Tokens are HMAC-SHA256 v2, require `SESSION_SECRET`, reject legacy unsigned tokens, and have an eight-hour default maximum age. Login uses bcrypt and a username-normalized lockout (five failures, 15-minute lock), with login history/audit records.
- Canonical permission keys are `page:<sidebar href>` and the module registry feeds sidebar, permission administration and route ownership. The permission model is view/add/edit/delete/download. Server middleware is authoritative; missing permission rows deny, level 1 bypasses all actions, and any-of guards are supported. UI hiding is not enforcement.
- Permission migration merges duplicates by OR, establishes unique hierarchy/page rows, and seeds default-deny for roles created later. Permission checks and route guards have static scripts and focused tests; tests were not run.
- Location scope is derived from the authenticated branch identity, not client location headers. Head Office sees all; warehouses see themselves and their supplied outlets; outlets see themselves. Money scope is narrower: a warehouse does not inherit outlet wallet ownership. Writes validate ledger ownership, location, till membership and voucher stamp.
- Hierarchy reads are intentionally available to authenticated users for permission resolution; counts are restricted. Hierarchy writes validate page actions, reject a second root/cycles, serialize structure edits and recalculate descendant levels.
- Exceptions needing separate checks: public invoice/quotation/share/mobile paths bypass global auth and rely on route-specific controls. Invoice/quotation token and share handlers were source-reviewed, but negative token-lifecycle test coverage remains NOT VERIFIED; see `ERP_API_CONTRACT_MATRIX.md` and GAP-009. Other mobile-distribution/public behaviors and end-to-end reachability remain unverified. Unknown/unregistered web routes fall through the UI guard, while server authorization remains the enforcement boundary. Web permission hooks can temporarily report full access while loading; APIs still enforce permissions.

### Reports, exports and API contract

- API counts are reconciled in `ERP_API_INVENTORY.md`: 42 mounted routers, 410 unique normalized method/path declarations, 66 OpenAPI path keys and 110 OpenAPI operations. The static comparison matched all 110 OpenAPI operations and found 300 source-declared operations absent from the spec; no spec-only operation was found. `ERP_API_OPENAPI_CONTRACTS.md` lists spec-declared parameters and request/response shapes for the 110 documented operations, but those shapes are not runtime-verified. Route-level guards/effects were source-reviewed across all 410 declarations, with exceptions recorded; exact per-operation contracts, caller identity and end-to-end effects remain open. `ERP_API_CONTRACT_MATRIX.md` holds grouped source findings, not a row for every operation or a runtime certification.
- The selected report-oriented source set contains 34 route declarations: 12 Reports Center routes, 11 Financial Reports Center routes, and 11 adjacent/legacy report routes. This is a scoped count, not every report-like API.
- Reports Center has nine categories and 40 defined report slots under a shared reports permission; slots can share routes and overlap standalone pages. The financial report picker has 14 values; those values are not a count of API routes. Dashboard exposes eight GET routes and mixes derived postings with direct source-table readers.
- PDF and XLSX report output are server POST endpoints using preformatted UI rows, capped at 3,000 total rows (413 above the cap); CSV is browser-generated only where a report supplies its callback. A canonical report-export contract/parser exists, but the inspected PDF/XLSX path uses a different validator; month-wise mode is rejected by the canonical contract. End-to-end export parity is not verified.
- The report-focused filename search found 4 API test/spec files using the explicit terms above; this is not a test-case count or content-based coverage measure. Relevant parity tests exist, but none were run.
- `ERP_REPORT_INVENTORY.md` maps the current Reports Center slots, major standalone reports, API readers, the P&L/Balance Sheet calculation chain, export mechanisms, and known reader differences. It is not a passing export-parity certification.

### Boot, scheduled work, storage and imports

- API startup performs a large idempotent migration/repair pass before financial schedulers start. Core migration failure is non-fatal to process startup but can leave readiness false. The backup scheduler starts even if a migration/bootstrap error was recorded, after a delay; it is unknown whether this causes an incorrect backup in practice.
- Rent and salary accrual run immediately then hourly with per-entity advisory locks and locked/approved-period guards. Daily stock close runs immediately and every 60 seconds. Backups start after a 60-second delay and then hourly. These are in-process timers; multi-instance duplicate execution safety was not verified.
- Backup supports listing/history, create/download/delete, validation, throwaway restore verification, upload/finalize and restore gates. Downloads are server-streamed behind permissions; storage must be configured. Retention protects the newest pre-restore safety copy. Live archive restore and production storage behavior were not tested.
- Attachments are limited to PDF/image types and 10 MB; reads require uploader-before-attachment or record/location authorization and return 404 otherwise. Invoice/quotation share links are tokenized, expiring and revocable. Positive-path tests cover invoice public-token/share-link PDFs and quotation PDFs; negative expiry/revocation/tamper coverage remains NOT VERIFIED, and tests were not run.
- Imports use validate/map/demo/approve stages, persistent manual mappings, transaction rollback for demo, and shared manual-producer routines on commit. Transaction reset uses one child-first table list and a backup gate; exact factory-reset coverage remains pending.

### Employee app

- Employee app includes attendance with multi-punch and optional GPS, leave requests/cancellation, payslips, a location-scoped dispatch status queue, sale creation, and receipt/payment vouchers. Server remains authoritative; 401 clears the client session/cache. Role-aware navigation mirrors five-action permissions but does not replace API checks.
- Offline writes/sync were not identified in the inspected screens. Mobile permission/location tests and distribution-pipeline tests exist but were not run; outlet-role behavior is explicitly not verified while outlets are disabled.

### Module and page ownership map

The table reconciles the 55 `MODULE_REGISTRY` keys with current web pages and API router owners. `Active` means a registry navigation entry, App route and page key line up; it is not evidence that the module is used in production. Empty-navigation keys are compatibility folds. Satellite pages are attached to their owner and do not create a new registry key. API owners are router files, not an exhaustive list of each endpoint or table.

| Registry key | Purpose / current page | API router owner(s) | State / ownership note |
|---|---|---|---|
| Dashboard | KPI and financial overview; `/` and `/dashboard` → Dashboard | dashboard, sales, stock, accounts, financialReports | `page:/` active; `/dashboard` alias |
| Point of Sale | Branch sales/invoicing; `/sales/pos` | sales, payments, inventory, customers, returns, search, invoiceShareLinks, pdfGen | Active |
| Quotations | Offer documents/share links; `/sales/quotations` | quotations, quotationShareLinks, publicQuotations, search, pdfGen | Active; quotes do not affect stock/books by design |
| Location Stock | Compatibility permission for `/headoffice/stock` | inventory, stock | Hidden key; folded into Stock |
| HO Transfers | Inter-location transfer workflow; `/transfers` | stock, branches, inventory-batches, pdfGen | Active as `page:/transfers`; redirect/satellite aliases exist |
| Location Expenses | Retired expense entry/history page `/sales/expenses` | accounts, cash-in-outlet, branches, pdfGen | Retired; no App route, related APIs remain |
| Cash Balance | Outlet cash/deposits; `/accounts/cash-in-outlet` | cash-in-outlet, reconciliation | Active; `/sales/cash-balance` is a satellite |
| Receipt Voucher | Money-in voucher; `/operations/receipt-voucher` | accounts, journal, pdfGen | Active |
| Payment Voucher | Money-out voucher; `/operations/payment-voucher` | accounts, journal, pdfGen | Active |
| Dispatch | Billed-sale fulfillment queue; `/operations/dispatch` | dispatch, sales, pdfGen | Active; status layer, not a second sale posting |
| Units | Unit master; `/production/units` | inventory | Active UI; distinct API mapping NOT VERIFIED |
| Items | Item/raw-material/product master; `/production/item-master` | inventory, itemTracking, bom, search, branches | Active; `/production/items` satellite |
| Production | Manufacturing/BOM; `/production/production`; production reports at `/production/reports` | production, bom, inventory | Active; report page is a surface within the domain |
| Purchases | Purchase bills/receiving; `/production/purchase` and edit aliases | purchases, returns, inventory, accounts, branches, pdfGen, search | Active |
| Stock | Stock view/storage/tracking; `/headoffice/stock`, `/storage`, `/tracking` | stock, inventory, inventory-batches, storage, storageLocations, itemTracking, branches | Active; satellites and `/sales/stock` fold into this owner |
| Stock Ledger | Historical stock ledger; `/headoffice/stock-ledger` | stock | Retired UI route; guarded reads remain |
| Inventory Reports | Valuation/expiry/movement reports; `/headoffice/inventory-reports` | reports, financialReports, stock, inventory-batches, branches | Active legacy standalone; overlaps Reports Center |
| Stock Verification | Physical count verification; `/headoffice/stock-verification` | stock, inventory-batches, branches | Active; not a general stock-adjustment API |
| Warehouses | Warehouse master; `/headoffice/warehouses` | branches, rent | Active |
| Outlets | Outlet/location master; `/headoffice/outlets` | branches | Active but feature-gated |
| Item Prices | Item price lists/history; `/headoffice/item-price` | sales, inventory, branches | Active |
| Asset Purchases | Capital-asset acquisition; `/assets/purchases` | assets, inventory, branches | Active |
| Asset Register | Fixed-asset register; `/assets/register` | assets, inventory, branches | Active |
| Asset Categories | Asset category master; `/assets/categories` | assets | Active |
| Asset Transfers | Asset location transfers; `/assets/transfers` | assets, branches | Active |
| Asset Disposal | Disposal/write-off; `/assets/disposal` | assets | Active |
| Asset Reports | Asset/depreciation reports; `/assets/reports` | assets, branches | Active |
| Sales | Sales returns/credit notes; `/returns` | returns, sales, purchases, pdfGen | Active `page:/returns`; not the POS page |
| Customers | Customer master/collections; `/customers` | customers, payments, returns, journal, accounts, invoiceShareLinks, search | Active |
| Vendors | Vendor master/payables; `/vendors` | customers, returns, accounts, journal, search | Active |
| Coupons | Coupon master/discounts; `/coupons` | customers | Active |
| Employees | Employee master/access/pay components; `/hr/employees` | hr, branches | Active |
| Attendance | Punches, holidays, leave balances/requests; `/hr/attendance` | hr, branches | Active; `/hr/leave` is a satellite |
| Leave | Leave management surface `/hr/leave` | hr | Hidden legacy key; folded into Attendance |
| Payroll | Payroll/accrual/payment; `/hr/payroll`; advances surface `/hr/advances` | hr, accounts, financialReports, pdfGen | Active; Advances is a satellite, not a registry key |
| Rent Management | Warehouse rent/agreement/accrual; `/hr/rent` | rent, branches | Active |
| Hierarchy | Organization hierarchy; `/hr/hierarchy` | hr | Active |
| Chart of Accounts | Ledger tree/opening balances; `/accounts/chart` | accounts, integrity, branches | Active |
| Ledger | Ledger statements; `/accounts/ledger` | accounts, financialReports | Active |
| Payments | Payment transaction surface `/accounts/payments` | accounts | Hidden legacy key folded into Vouchers |
| Cash & Bank | Cash/bank ledger setup; `/accounts/cash-bank` | accounts, journal | Active |
| Vouchers | Journal/receipt/payment/contra/notes hub; `/accounts/vouchers` | journal, accounts, pdfGen | Active; related voucher pages are satellites |
| Books | Day/cash/bank books and trial balance; `/accounts/day-book`, `/accounts/cash-book`, `/accounts/bank-book`, `/accounts/trial-balance` | journal, reconciliation, financialReports, pdfGen | Grouped registry key; four page keys own the pages |
| Expenses | Accounts expense history; `/accounts/expenses` | accounts, pdfGen | Retired UI route; related API is still present |
| GST Summary | GST summary/documents; `/accounts/gst` | gst, accounts | Active |
| GST Returns | GSTR-1/GSTR-3B/HSN/reconciliation; `/accounts/gst-returns` | gst, accounts | Active; no filing/submission write path found |
| Reconciliation | Bank reconciliation; `/accounts/reconciliation` | reconciliation, cash-in-outlet | Active |
| Accounting Periods | Month locks; `/accounts/periods` | periods | Active; permission is admin-restricted |
| Accounts Cash Balance | Compatibility permission for `/accounts/cash-in-outlet` | cash-in-outlet | Hidden key folded into Cash Balance |
| Reports | Sales/purchase/inventory/financial report center; `/reports/:cat` | reports, financialReports, accounts, pdfGen | Active `page:/reports/sales`; shared Reports permission |
| Settings | Company configuration/profile/audit pages | company, audit, quotations | Grouped key; each active page has its own permission key |
| Permissions | Permission matrix; `/company/permissions` | company | Active |
| Login History | Login audit history; `/company/login-history` | company | Active |
| Backup & Restore | Backup/restore lifecycle; `/company/backup` | backup | Active |
| Import Data | Spreadsheet/import migration; `/company/import` | imports | Active |

The source-level map establishes principal UI/API ownership and key state. Exact database read/write relationships, five-action permission requirements, location policy, accounting/GST/inventory effects and export support are not yet complete for every registry key; the workflow, formula, API and report inventories below/linked above cover only traced paths.

### Selected persisted-data relationships

The following are the relationships that can be stated from the traced source paths. These are application-level relationships; not every link is a PostgreSQL foreign key. The development schema snapshot is 93 public base tables, while Drizzle is only a partial schema view. `ERP_DATABASE_RELATIONSHIP_MAP.md` adds a source-backed parent/child/key/FK-status map for the checklist’s nine core relationship families; it does not certify live database constraints.

| Domain | Persisted sources and relationships | Authority / limitation |
|---|---|---|
| Sales and collection | Sale headers carry location identity and line-item JSON; `sale_payments` associates receipts to sales; return documents carry sale references and returned quantities. Customer control and sales/return accounting are derived by `buildDerivedPostings()`. | Sale-linked receipt history is not a second posting source. Outstanding comes from the shared payment-position calculation, not simply the sale row. |
| Purchases and settlement | Purchase bills carry goods lines and separate other charges; receipt movements and batches record inventory effects; purchase-return documents refer to prior quantities; bill allocations and vendor advances are explicit settlement metadata. | Vendor payable is ledger-authoritative. The purchase goods total, stock cost and goods-plus-charges payable are distinct values. |
| Inventory quantity and lots | `stock_entries` is the quantity authority keyed by product kind, product ID and location. `stock_batches` is additive lot/expiry evidence; reservations affect availability; `stock_ledger` is the append-only movement audit. | Polymorphic product IDs can overlap between material kinds, so every join must include product kind. Batch quantity does not replace stock-entry quantity. |
| Transfers and locations | Location identity is an explicit type/id pair; transfer documents/movements reference source and destination locations, while in-transit stock remains sender-owned. | Do not infer location kind from an overlapping numeric ID or legacy nullable outlet link. Transfer documents and accounting treatment have dedicated workflow/formula traces. |
| Accounting | Chart-of-account rows define ledger hierarchy; `opening_balances` supplies opening positions; `journal_vouchers` and journal lines store manual/selected voucher postings; other source documents feed normalized postings through `buildDerivedPostings()`. | A single persisted universal journal is not the source for every transaction. The final ledger/report posting stream is derived from both stored lines and source documents. |
| Bank review | Reconciliation metadata points to exact `(ledger_id, entry_id)` posting identities and batch membership. | Matching/review status does not create a second accounting entry and is not an external bank-statement balance. |
| Payroll and attendance | Employees own pay components, attendance/punch and leave records; payroll runs snapshot calculated pay; employee advances and salary-payment vouchers have separate settlement links. | Approval rechecks attendance under lock; missing/NULL history is not assumed to mean zero. |
| Fixed assets | Asset acquisition/register records track capital items; transfer, disposal and month-scoped depreciation records extend the asset lifecycle. | The code separates fixed assets from inventory; capitalised GST, depreciation and disposal are handled by the assets flow. Exact FK-level ownership is not fully catalogued here. |
| Storage placements | Storage locations form a parent/child hierarchy; placement rows allocate stock to a location within that structure. | Unplaced quantity is derived from site stock minus placements; it is not a separately stored quantity authority. |
| Daily stock close | Baseline, run and entry snapshot tables support daily-close evidence and block uncovered/backdated stock writes. | The baseline is a future-only control, not a reconstruction of historical stock positions. |
| Audit and backup | `activity_log` stores audit events; backups have archive/manifest/history and restore-verification records. Import batches store mappings, demo/approval state and error artifacts. | Transactional audit helper errors propagate; best-effort helper errors are logged and swallowed. Call-site coverage and failure semantics are not yet exhaustive. |

### Audit logging and test evidence

- `activity_log` is the shared audit event table with action/module/entity identity, user, description, JSON metadata and creation time. Metadata is used for before/after snapshots and change summaries.
- `logActivityInTransaction` inserts through the caller's open transaction and propagates failure so the caller can roll back. `logActivity` is explicitly best-effort: it catches/logs failures and resolves.
- Transactional call sites were identified in sales, purchases, returns, payments, journal, stock, reconciliation, assets and sale-collection paths. Best-effort calls remain in HR, company/branches, production, backup and other non-critical flows. This is a source inventory, not proof every critical write is atomic with its audit event.
- Tests assert audit rows/metadata for employee changes, quotation MRP, leave, invoice conversion, import, attendance and employee lifecycle. A dedicated fault-injection test proving critical audit failure rolls back the business mutation was not identified; see GAP-011.
- The wider test inventory includes accounting/BS parity, import rollback and race handling, dated stock/valuation/reservations, transfer receiving, stock close, asset lifecycle, GST, five-action permissions/LBAC, payroll/attendance/leave, reset and distribution tests. Tests were not executed in this audit; no current pass rate is asserted.

### Partially mapped business flows

These are source-backed path sketches, not an exhaustive workflow catalogue. `ERP_WORKFLOW_MAP.md` adds high-level traces for twelve workflow groups and records missing links. Full UI permission, DB relationship, report/export and audit-event mapping remains pending.

| Flow | Current source trace | Status / limit |
|---|---|---|
| Sales / POS create and edit | `routes/sales.ts` → shared line/tax/discount builder → sale row, stock/batch effects and derived posting path | PARTIAL; UI route and every side-effect table not mapped |
| Sale receipt / later payment | POS advance first → receipt helper → `sale_payments` history and shared payment-position status | PARTIAL; all receive-into and account combinations not enumerated |
| Sales return / credit note | `routes/returns.ts` → quantity cap and stored-line proration → stock restore plus customer credit-note or cash-refund path | PARTIAL; frontend state and export surfaces not fully mapped |
| Purchase bill / vendor payable | shared purchase-pricing → goods total and separate charges → stock receipt, supplier control and payable amount | PARTIAL; purchase-order/request flow not established |
| Purchase return / debit note | `routes/returns.ts` → prior-return cap and line proration → stock reduction and vendor debit-note posting | PARTIAL; every reversal scenario/test not traced |
| Bill-wise settlement and advances | `routes/accounts.ts` allocations → vendor payment/receipt voucher → explicit allocation, advance and ledger effects | PARTIAL; all UI entry points and edit/delete paths remain |
| Cash/bank books and reconciliation | derived postings + openings → location-filtered Cash/Bank Book; review batch records exact posting identity | PARTIAL; external bank-statement comparison is not present in inspected flow |
| P&L / Balance Sheet and Month Wise statements | source documents/openings → `buildDerivedPostings()` → `buildBooks()` via `/accounts/financial-statements` → Reports Center and Chart of Accounts; Chart separately requests `/accounts/financial-statements/monthly` | PARTIAL; shared calculation path and consumers are source-mapped, but rendered rows, monthly columns, drilldowns, exports and parallel readers have no complete parity proof |
| Inventory valuation and lot issue | stock-entry quantity + location checkpoints/reservations → live valuation; historical stock report and historical P&L/BS use distinct evidence, fallback and transit rules; dated closing stock feeds COGS/BS; FEFO consumes eligible lots | PARTIAL; source paths mapped, but every writer/reader and numeric parity remain NOT VERIFIED |
| Production costing | production-cost helper combines goods, overhead and payroll labour pools | PARTIAL; all production route callers and finished-goods posting path not traced |
| Attendance, leave and payroll | employee punches/leave → attendance factors and LOP → payroll and cumulative salary accrual | PARTIAL; all HR approval/UI/report paths not mapped |
| Fixed assets | purchase/capitalized GST → monthly depreciation → disposal book value and posting path | PARTIAL; no depreciation-specific test identified |
| Transaction import and reset | import analyze/manual mapping/demo/approve; reset backs up, locks and deletes configured transaction tables transactionally | PARTIAL; full factory-reset gates and table coverage remain |
| Backup and restore | scheduled/manual archive → manifest/validation/verification and restore authorization gates | PARTIAL; live restore and production storage not tested |
| Employee mobile flows | attendance, leave, payslips, dispatch, sale and receipt/payment voucher screens call the API | PARTIAL; offline writes not identified, full per-screen endpoint map remains |
| GST registers and reconciliation | HSN/GSTR-1/GSTR-3B and reconciliation use dedicated readers in `routes/gst.ts`; ledger-side financial GST is a separate report reader | PARTIAL; no filing/submission write route found; UI/API/export parity remains |
| Asset lifecycle | purchase/capitalized GST → register and transfers → depreciation run → disposal and book value | PARTIAL; formula traced, producer/reader/test parity incomplete |
| Branch and warehouse lifecycle | create/update/disable → location-scoped transactions → delete summary/permanent-delete guard | PARTIAL; every dependent transaction writer and UI transition not mapped |
| Permission and location lifecycle | hierarchy + page action grants → authenticated user scope → route-specific location/ledger validation | PARTIAL; broad rules traced, 410 operations not classified individually |
| Audit events | transactional `logActivityInTransaction` and best-effort `logActivity` write `activity_log` | PARTIAL; call-site completeness and failure behavior for every critical mutation remain |
| Scheduled rent/salary/stock-close/backup | in-process startup timers with entity locks where implemented | PARTIAL; multi-instance behavior and every retry/lock path not verified |
| Public share and mobile distribution | HMAC share links/public document routes; configured public app download routes | PARTIAL; exhaustive handler/token/test coverage and production storage not verified |
| Company setup and reset | settings/profile → `company_settings`, permission/hierarchy rows, quotation terms; reset delegates transaction reset | PARTIAL; company state/GST affects tax, numbering and permissions; no dedicated company-setup suite found, reset test coverage is indirect |
| Location master lifecycle | warehouse/outlet create, update, disable and guarded permanent delete → location identity, linked ledgers and storage locations | PARTIAL; GST/state, stock, money scope, invoice numbering and LBAC effects; focused location/permission/storage suites found |
| Employee master lifecycle | employee/pay-component create/edit/delete/reset-password → hierarchy/location/access and payroll/attendance links | PARTIAL; payroll, accrual and employee-ledger effects; focused access/regression/payroll tests found |
| Customer/vendor master | party CRUD and ledger views → customer/vendor masters, control ledgers, sales/purchases and settlement metadata | PARTIAL; party GST/state drives tax classification; vendor payments post books and advances remain ledger-authoritative |
| Quotation and conversion | quotation CRUD/status/share → quotation lines/terms and optional converted sale | PARTIAL; quotations have no stock/books impact until conversion; conversion idempotency and one-sale constraints are source-backed |
| Manual journal voucher | balanced location-stamped lines → `journal_vouchers`, `journal_voucher_lines`, account ledgers and audit | PARTIAL; period/location/ledger guards traced; changes feed derived books, parties and GST where relevant |

### Route-search negatives (product intent NOT VERIFIED)

The scoped source scan did not find a purchase request/order workflow, a generic stock-adjustment API distinct from physical stock verification (`POST /stock/verifications` is present), a dedicated opening-stock URL (opening stock is an import module), a separate transfer edit/cancel route within the inspected `stock.ts` router, a GST return filing/submission write route, or a separate material-consumption API outside production create/edit. Transfer rejection is the in-transit terminal reversal; these are documented as **not found in the inspected routes**, not as confirmed defects or claims that the business does not need them.

## 6. Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Existing-document audit, architecture, code/module/API/table inventory baseline | **COMPLETE** |
| 2 | Accounting engine, source-of-truth functions, exact formula register, P&L and Balance Sheet | **IN PROGRESS** — core posting/P&L/BS/GST paths and the Reports Center/Chart statement consumer chain are source-mapped; report exceptions, monthly presentation and full consumer/export parity remain |
| 3 | Inventory, costing/valuation, batches, reservations, transfers, production, sales and purchases | **IN PROGRESS** — core stock/cost paths, physical verification, additive opening-stock imports, transfer lifecycle and the distinct historical stock-report/P&L readers are source-mapped; numeric parity and module-level end-to-end coverage remain NOT VERIFIED |
| 4 | GST, customer/vendor settlement, cash/bank, assets, payroll and HR | **IN PROGRESS** — GST, sale/purchase settlement, cash/bank readers, payroll and fixed-asset formulas traced; remaining flows pending |
| 5 | Permissions/location security, audit logging, background jobs, backup/restore, mobile and external services | **IN PROGRESS** — authz/LBAC, jobs, backup/import/reset and core mobile paths traced; exhaustive coverage pending |
| 6 | Full report/export/API inventory, tests, issue cross-check, final counts and verification | **IN PROGRESS** — API inventories, 110 OpenAPI contract rows, all 300 source-only operation identities, grouped route-level guards/effects, 134 per-operation high-risk records, 40 report-slot UI export/filter map and path/test-evidence classifications, ten-family DB relationship map, and twelve-group workflow map recorded; per-operation contracts remain incomplete, with report-result parity, test execution, and remaining issue cross-check pending |

**DOCUMENTATION PROGRESS:** Phase 1 complete; source-backed passes cover selected paths in Phases 2–6. Static API/report inventories, the 110-operation OpenAPI contract map, grouped route-level guard/effect review, 134 per-operation records for source-only high-risk financial and inventory/transfer operations, the P&L/Balance Sheet consumer chain, historical stock valuation distinction, stock verification/opening-stock formulas, source-mapped export/filter controls and slot-by-slot path/test-evidence classifications for all 40 Reports Center slots, and focused workflow/relationship maps are recorded. Per-operation API contracts and report-result parity remain incomplete.
**Completion estimate:** 83% — the 55 registry keys are mapped to principal pages/router owners; 410 API declarations have grouped route-level guard/effect review; all 300 source-only operation identities are enumerated; and the 110 OpenAPI operations have spec-declared contract summaries. Source inventories cover all 40 Reports Center slots and 34 formula groups, including current UI filter/export actions and source-based path/test-evidence classification. Ten key relationship families and twelve workflow groups now have source maps, but not exhaustive field/caller traces. Source-only request/response contracts, report-result parity, remaining workflow/table relationships, issue/test cross-checks and runtime verification remain open. This is not a 100% completion claim.

## 7. Inventory status and remaining counts

### Partial source counts recorded

- 43 API route files, 42 mounted routers and 410 unique normalized method/path declarations. See `ERP_API_INVENTORY.md`.
- OpenAPI: 66 path keys and 110 HTTP operation keys; 110 matched and 300 source operations were not represented in the current spec. This is a static-source comparison, not runtime.
- Source-only API progress: 134 per-operation high-risk records (73 mutations and 61 reads) in `ERP_HIGH_RISK_API_SCOPE_REGISTER.md`; fields remain partly NOT VERIFIED, so these are not fully established contracts. The source-only inventory remains 300 identities; 166 are not yet in this per-operation register.
- Reports: 34 declarations in the selected report-oriented source set (12 Reports Center, 11 Financial Reports Center and 11 adjacent/legacy routes); not an exhaustive report count.
- UI: nine Reports Center categories, 40 defined report slots, 14 financial report-picker values, and eight dashboard GET routes. These are different counting units; slots share API routes.
- 93 public development base tables and three trigger objects, read-only snapshot dated 2026-09-29; production remains unqueried.
- 70 API test/spec files (73 total files including helpers/support); 4 filename matches for report/dashboard/export/pdf/xlsx/csv; no tests were executed.
- The formula register contains 34 source-traced formula/algorithm groups; this is not an exhaustive formula total or test/accounting-policy certification.
- Four configured workflows, 55 module-registry keys and 57 generated permission page keys were inventoried; keys are not equivalent to distinct active business modules.

### Not yet established

- Active business modules and complete end-to-end workflows without double-counting shared components; `ERP_WORKFLOW_MAP.md` is a high-level partial trace, not exhaustive caller/effect coverage.
- Per-operation request/response contracts, route-local permission/action roles, location classification, caller mapping and business/database effects for all 410 API operations; 134 source-only high-risk operations have per-operation records, but many details remain NOT VERIFIED and the other 166 source-only operations have not yet been mapped per operation.
- Report result/format parity and exhaustive screen-to-route mapping; UI filter/export actions are documented in `ERP_REPORT_INVENTORY.md`, while slot classifications and direct test-source evidence are in `ERP_REPORT_PARITY_MATRIX.md`.
- Exhaustive table relationships and a full current data dictionary; nine core relationship families have a source/FK-status map in `ERP_DATABASE_RELATIONSHIP_MAP.md`.
- Exhaustive formula count and remaining per-module formula families.
- Full code issue inventory and final severity/release-readiness assessment.
- 57 permission keys reconciled to active, hidden, legacy/satellite and retired page/module surfaces with complete module ownership.
- Current test pass status, full route/export parity verification, and remaining payroll, GST, production, asset, transfer, import/reset and backup/restore edge cases.

Remaining items are **NOT VERIFIED** until their owning code paths and relevant consumers are inspected. Production database state is outside this audit.
# Frozen Fruits ERP — Report and Export Inventory

**Audit status:** PARTIAL — all 40 Reports Center slots have source-mapped filters and export actions; row-level parity is not fully verified  
**Snapshot date:** 2026-09-29  
**Production database:** NOT QUERIED  
**Functional changes:** none

## Counting rules

- `Reports Center` has **9 categories** in `ReportsCenter.tsx:28-40`. Categories are not API routes.
- The current category definitions contain **40 report/subreport slots**: Sales 6, Quotations 1, Purchases 3, Inventory 7, Branch Transfers 1, Production 4, Parties 4, Financial 12, Profitability 2.
- A report slot may share an API with other slots. Standalone pages and dashboard surfaces overlap those definitions and are listed separately; they are not added to the 40.
- The previous count of 34 report-oriented route declarations was a scoped source selection, not the number of reports.

## Reports Center — 40 report slots

All `/reports/:category` views share the permission `page:/reports/sales`. The shared `RangeBar` supports date filters; report-specific location controls narrow data only within server-authorized scope. Doc-based views expose generic XLSX/PDF/Print over preformatted UI rows; callback-only views expose CSV and, where supplied, a PDF callback; some views expose CSV only or PDF only. The generic PDF/XLSX endpoint rejects more than 3,000 total rows with HTTP 413. Share is not a generic report export. Exact filters and export actions below are source-mapped from the current row component; this is not a runtime verification. `ERP_REPORT_PARITY_MATRIX.md` adds the slot-by-slot path classification and direct test-source evidence; it is not a passed test or output-parity certification.

| Category / report | Frontend source | API and principal source | Filters / scope | Output |
|---|---|---|---|---|
| Sales — Sales Register | `reports/sections/SalesReports.tsx` | `GET /api/reports/sales-register`; sales, customers, shared sale payment-position helper | Date, location; excludes cancelled and branch-transfer invoices | Client CSV + callback PDF; no XLSX/Print |
| Sales — By Salesman | same | `GET /api/reports/sales-by-salesperson`; sales and salesperson snapshot | Date, location | Client CSV + callback PDF; no XLSX/Print; formula independently computes outstanding (see issues register) |
| Sales — By Item | same | `GET /api/reports/sales-by-item`; sales `line_items` JSON and item master | Date control only; no explicit location selector in this UI | Client CSV + callback PDF; no XLSX/Print |
| Sales — By Location | same | `GET /api/reports/sales-by-location`; sales location identity and warehouse/outlet names | Date, location context | Client CSV + callback PDF; no XLSX/Print |
| Sales — Discounts | same | `GET /api/reports/discounts`; sales/line-item discount fields and customer lookup | Date, location | Client CSV + callback PDF; no XLSX/Print |
| Sales — Sales & Stock Summary | same | `GET /api/reports/sales-stock-combined`; combined sales and stock reader | Date, location | PDF only; no CSV/XLSX/Print |
| Quotations — Register | `reports/sections/QuotationReports.tsx` | Paginated `GET /api/quotations`; quotations and related party/salesperson data | Status, customer, salesperson, location, date | Client CSV + doc-based XLSX/PDF/Print |
| Purchases — Register | `reports/sections/PurchasesReports.tsx` | `GET /api/reports/purchase-register`; purchases, vendors, line-item tax heads | Date/vendor/location; branch user response is Head Office restricted | Client CSV + callback PDF; no XLSX/Print |
| Purchases — By Vendor | same | `GET /api/reports/purchases-by-vendor`; purchases and vendors | Date/location; Head Office restriction | Client CSV + callback PDF; no XLSX/Print |
| Purchases — By Material | same | `GET /api/reports/purchases-by-material`; purchase lines and item/material/raw-material names | Date/location; Head Office restriction | Client CSV + callback PDF; no XLSX/Print |
| Inventory — Stock Valuation | `reports/sections/InventoryReports.tsx` | `GET /api/stock/valuation`; canonical location valuation/checkpoints | As-of, product and authorized location | Client CSV + doc-based XLSX/PDF/Print; cost permission required |
| Inventory — Near Expiry | same | `GET /api/stock/expiry-report`; batches and expiry dates | Date and location controls; no product selector | Client CSV + callback PDF; no XLSX/Print; cost permission required |
| Inventory — Expired Stock | same | `GET /api/stock/expiry-report`; batches and expiry dates | Date/status and location controls; no product selector | Client CSV + callback PDF; no XLSX/Print; cost permission required |
| Inventory — Slow / Dead Stock | same | `GET /api/stock/movement-analysis`; dated movement/stock inputs | Location and class controls; no date/as-of or product control | Client CSV + callback PDF; no XLSX/Print; cost permission required |
| Inventory — Reorder Alerts | same | `GET /api/stock/reorder-report`; stock entries and reorder levels | No visible UI filters; query has no authenticated-location predicate, see GAP-012 | Client CSV + callback PDF; no XLSX/Print; cost permission required |
| Inventory — Transfer Register | same | `GET /api/stock/transfers`; transfer lines, source/destination and status | Date and status controls; no source/destination/item controls in this UI | Client CSV + callback PDF; no XLSX/Print |
| Inventory — GST Transfers | same | `GET /api/reports/gst-transfers`; transfer invoices and GST classification | Date control; no explicit location selector in this UI | Client CSV + callback PDF; no XLSX/Print |
| Branch Transfers — Transfer Register | `reports/sections/TransfersReports.tsx` | `GET /api/reports/branch-transfers`; stock transfers and linked sale/purchase documents | Date, source/destination, item, status; server scope cannot be widened by filters | Client CSV + doc-based XLSX/PDF/Print |
| Production — Output by Item | `reports/sections/ProductionReports.tsx` | Shared `GET /api/productions/reports`; production records and item master | Date/location and endpoint LBAC | Client CSV |
| Production — Material Consumption | same | Same endpoint; production consumption details and material maps | Same | Client CSV |
| Production — Batch Costs | same | Same endpoint; production batch cost fields | Same | Client CSV |
| Production — Wastage | same | Same endpoint; production wastage fields | Same | Client CSV |
| Parties — Customer Statement | `reports/sections/PartiesReports.tsx` | `GET /api/customers/:id/ledger`; customer ledger/posting sources | Customer, date, authorized location | Client CSV + callback PDF; no XLSX/Print; share unknown |
| Parties — Vendor Statement | same | `GET /api/vendors/:id/ledger`; vendor ledger/posting sources | Vendor, date, authorized location | Client CSV + callback PDF; no XLSX/Print |
| Parties — Receivables Aging | same | `GET /api/outstanding/receivables`; sale payment position and customer data | As-of date/location | Client CSV + doc-based XLSX/PDF/Print |
| Parties — Payables Aging | same | `GET /api/outstanding/payables`; purchases, settlement and vendor-ledger data | As-of date/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Profit & Loss | `reports/sections/FinancialReports.tsx` | `GET /api/accounts/financial-statements`; `buildBooks(buildDerivedPostings)` plus opening balances and dated stock valuation | From/to; optional authorized location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Balance Sheet | same | Same endpoint and engine; cumulative balances plus closing stock | As-of/date window; UI disables location selection for this view | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Trial Balance | same | `GET /api/reports/fin/trial-balance`; derived postings, opening-balance postings and chart | From/to/location; branch response policy applies | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Ledgers | same | `GET /api/reports/fin/ledgers`; derived postings and chart | From/to/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Books & Registers | same | UI sub-views over financial reader data; ledger statement uses `/api/reports/fin/ledger-statement` and `/api/reports/fin/ledger-options` | Ledger/from/to/location as applicable | Client CSV + doc-based XLSX/PDF/Print for the inspected subviews |
| Financial — Day Book | same | `GET /api/reports/fin/day-book`; derived postings/openings | From/to/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Cash | same | `GET /api/reports/fin/cash`; cash-ledger postings/openings | From/to/ledger/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Bank | same | `GET /api/reports/fin/bank`; bank-ledger postings/openings | From/to/ledger/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Cash & Bank | same | `GET /api/reports/fin/cash-bank`; cash/bank subtrees and postings | From/to/ledger/location | Client CSV + doc-based XLSX/PDF/Print |
| Financial — GST | same | `GET /api/reports/fin/gst`; GST ledger postings and taxable sales/purchase subtrees | From/to/location | Client CSV + doc-based XLSX/PDF/Print; distinct from GST Returns pages |
| Financial — Expenses | same | `GET /api/reports/fin/expenses`; direct expenses, purchase other-charge rows, accounts/location maps | From/to/location; branch is forced to its own scope | Client CSV + doc-based XLSX/PDF/Print |
| Financial — Salary | same | `GET /api/reports/fin/salary`; payroll, employees and hierarchy | Payroll month/year range and employee location | Client CSV + doc-based XLSX/PDF/Print |
| Profitability — By Item | `reports/sections/ProfitabilityReports.tsx` | `GET /api/reports/profitability`; per-item/batch-cost calculation | From/to, item grouping, location behavior per route | Client CSV + callback PDF; no XLSX/Print |
| Profitability — By Location | same | Same endpoint with location grouping | From/to, `groupBy=location`, authorized location | Client CSV + callback PDF; no XLSX/Print |

### Export action snapshot

“Doc-based” means the report supplies prepared rows to the shared XLSX/PDF/Print controls; it does not mean those outputs independently fetch or recalculate the report. This capability inventory is source-based, not a product-requirements judgment.

| Category | Doc-based XLSX/PDF/Print | Callback CSV + PDF only | PDF-only | CSV-only | Total slots |
|---|---:|---:|---:|---:|---:|
| Sales | 0 | 5 | 1 | 0 | 6 |
| Quotations | 1 | 0 | 0 | 0 | 1 |
| Purchases | 0 | 3 | 0 | 0 | 3 |
| Inventory | 1 | 6 | 0 | 0 | 7 |
| Branch Transfers | 1 | 0 | 0 | 0 | 1 |
| Production | 0 | 0 | 0 | 4 | 4 |
| Parties | 2 | 2 | 0 | 0 | 4 |
| Financial | 12 | 0 | 0 | 0 | 12 |
| Profitability | 0 | 2 | 0 | 0 | 2 |
| **Total** | **17** | **18** | **1** | **4** | **40** |

### Source-verified filter and test evidence

- Sales — By Item has a date control but no explicit location selector in its UI (`SalesReports.tsx:519-527`). Server authorization and location scope are separate from visible filters.
- Inventory — Near Expiry and Expired expose date/location controls but no product selector (`InventoryReports.tsx:202-216,325-340`). Slow/Dead exposes location/class controls but no date/as-of or product control (`:432-444,458-489`). Reorder Alerts has no visible filters (`:569-577`). Transfer Register exposes date/status but no source/destination/item controls (`:638-650,669-676`); GST Transfers exposes date only (`:731-734,751-754`).
- Source tests contain direct assertions for sales-register/dashboard parity and location slices (`tests/dashboard-parity.test.mjs:115-165`), selected sales report definitions (`sales-report-definition.test.mjs:50-128`), branch-transfer report rows (`accounting.test.mjs:570-578`), stock valuation/location costing (`stock-valuation-location-cost.test.mjs`), ageing/control/Balance Sheet relationships (`balance-reconciliation.test.mjs:95-121,219-237,398-403`), cash/bank and day-book location behavior (`location-books.test.mjs:65-158`; `cash-bank-locations.test.mjs:68-94`), and financial PDF/XLSX rows (`books-drilldown-export.test.mjs:192-248`). These are source-presence findings only; no tests were run.
- No direct report-output assertion was identified in the inspected search for Sales By Location, Discounts, Sales & Stock Summary, production result shapes, Financial Ledgers/GST/Expenses/Salary, or Profitability. Related business-flow tests do not prove these report endpoints or exports are in parity. This search result does not prove that no such tests exist elsewhere.

### Reports Center calculation notes

- The main P&L and Balance Sheet use `buildBooks()` over `buildDerivedPostings()`. They are not client-computed from document totals.
- The profitability report is a separate per-item/batch-cost definition; it is not the periodic P&L opening-stock + purchases + direct-expense − closing-stock formula.
- The Reports Center's financial GST view is ledger based. GST Returns pages use separate register, tax-head, and reconciliation readers.
- The inventory-cost reports are hidden when the user lacks `page:/headoffice/inventory-reports`; showing the tabs without that right would return an unhelpful zero-valued view.

## Standalone report and dashboard surfaces

| Surface | UI route / source | API and source | Filters / scope | Exports |
|---|---|---|---|---|
| Dashboard BI | `/` and `/dashboard`, `pages/dashboard/Dashboard.tsx` | `GET /api/dashboard/bi`; combines direct source analytics with canonical `buildBooks` financial results | Date range and location scope; BI has multi-location selectors | Share is browser-side image/file capture via `navigator.share`, not a report API |
| Legacy dashboard summary | same page family | `GET /api/dashboard/summary`; today-anchored direct operational queries plus derived financial values | Today/location context | No separate report export verified |
| Other dashboard panels | same | `/api/dashboard/stock-alerts`, `/recent-activity`, `/sales-trend`, `/top-items`, `/sales-by-location`, `/production-trend` | Mix of today/range and authorized location inputs | No separate report export verified |
| General ledger | `/accounts/ledger` | `GET /api/reports/fin/ledger-statement` | Ledger/date/location | CSV plus shared PDF/XLSX/Print actions |
| Day Book | `/accounts/day-book` | Legacy `GET /api/accounts/day-book` | Date/location | CSV; server PDF/XLSX availability is page/permission-specific |
| Cash Book / Bank Book | `/accounts/cash-book`, `/accounts/bank-book` | `GET /api/accounts/cash-bank-book/ledgers`, `/api/accounts/cash-bank-book` | Date/ledger/location | CSV and shared PDF/XLSX/Print |
| Standalone Trial Balance | `/accounts/trial-balance` | Legacy `GET /api/accounts/trial-balance`; separate from Reports Center endpoint | From/to/location | CSV and shared PDF/XLSX |
| GST Summary | `/accounts/gst` | `GET /api/gst/summary` | Date/location/GST scope in route | Client CSV and shared PDF path; XLSX/Print/share not individually verified |
| GST Returns | `/accounts/gst-returns` | HSN, GSTR-1, GSTR-3B, reconciliation, filters and documents endpoints under `/api/gst/*` | Date, GSTIN and authorized location mapping | Client CSV and shared PDF/XLSX/Print; no generic share |
| Legacy Inventory Reports | `/headoffice/inventory-reports` | Valuation, expiry, movement, reorder endpoints under `/api/stock/*` | As-of/date/product/location | CSV/PDF/XLSX/Print in page; overlaps Reports Center inventory |
| Production Reports | `/production/reports` | `GET /api/productions/reports` | From/to/location/LBAC | CSV per table; PDF/XLSX/Print not verified |
| Asset Reports | `/assets/reports` | `/api/assets`, `/api/assets/purchases`, `/api/assets/transfers`, `/api/assets/disposals`, `/api/assets/summary` | Status/category/vendor/location/date filters | CSV/PDF/XLSX/Print verified in page |
| Asset Register | `/assets/register` | `GET /api/assets` | Current register filters | CSV; other formats not verified |
| Payroll Salary report | Reports Center Financial — Salary | `GET /api/reports/fin/salary` | Month/year and location | Generic exports |
| Operational Payroll / payslips | `/hr/payroll` | Payroll/employee/attendance/accrual/advance APIs; payslip renderer `POST /api/pdf/payslip` | Month/year and branch | Payslip PDF; payroll CSV/XLSX/print/share not verified |
| Outstanding | `/outstanding` | Receivables/payables/collections endpoints under `/api/outstanding/*` | As-of date/location | Export/share not verified |

## P&L and Balance Sheet trace

### P&L

`account_ledgers` plus source documents and journal lines are normalized into `buildDerivedPostings()` in `artifacts/api-server/src/routes/journal.ts:1064-1109`; `buildBooks()` in `artifacts/api-server/src/lib/books.ts:1074-1095,1155-1490` loads the chart, derives and location-filters postings, then assembles statement aggregates. `GET /api/accounts/financial-statements` calls that engine from `routes/accounts.ts:4664-4707`, applies the authenticated branch's own-location scope (Head Office uses the posting-location selector), and returns the books payload with scope/filter metadata. Both Reports Center `FinancialReports.tsx` and standalone `ChartOfAccounts.tsx` query this same endpoint (`:147-161` and `ChartOfAccounts.tsx:1491-1508`). Reports Center prepares the rendered statement sections and browser CSV rows from the response; generic PDF/XLSX/Print render the UI-prepared rows and do not re-run accounting. Chart of Accounts consumes the same payload but has its own statement presentation, including display-side Trading/P&L totals; shared API output does not prove parity between rendered surfaces.

| P&L value | Source and calculation |
|---|---|
| Revenue / gross sales | Sales derived postings in `journal.ts:1325-1457`; GST and sale other charges are separated from operational Sales. Branch-transfer sales go to Transfer-Out, not customer Sales. |
| Sales returns / net sales | Credit-note postings are attributed to Sales in `books.ts:1117-1151`; API exposes `grossSales`, `salesReturns`, and net `sales` (`:1443-1446`). Statement rows show gross sales less returns. |
| Opening / closing stock | Current close uses live `stockValuation` through `closingStockAt`; the live cost priority is exact product/location checkpoint, then product-master average cost, then manual cost (`valuation.ts:87-109`; `books.ts:585-607`). Historical P&L/BS uses `books.stockAsOf`: it rewinds current `stock_entries` quantity through business-dated `stock_ledger`, uses an as-of cost checkpoint when present, and otherwise uses current product-master unit cost while marking missing cost history unreliable (`books.ts:642-657,742-904`). Opening is prior-day stock plus the transfer boundary adjustment; closing is dated to the report cutoff (`books.ts:1182-1226`). |
| Purchases / purchase returns | Purchase postings from `journal.ts:1620-1693`; debit-note effect is split from the Purchases subtree in `books.ts:1117-1151`. Valid other charges are separate expenses, not stock cost. |
| Direct costs and COGS | `opening stock + net purchases + direct expenses − closing stock` after stripping transfer-in/out ledger effects (`books.ts:1293-1316`). |
| Gross profit | Net sales plus direct income less COGS (`books.ts:1293-1316`). |
| Other income / indirect expense | Direct/indirect income and expense account subtrees; production capitalisation overlay ledgers are excluded from operating group totals. |
| Depreciation | Included through depreciation journal postings in indirect expense; asset route creates monthly straight-line postings. |
| Net profit | Total incomes minus total expenses (`books.ts:1306-1316`); displayed summary also returns `netProfit` (`:1460-1469`). |

### Balance Sheet

The same `buildBooks()` posting stream feeds cumulative balances. Opening balances are loaded from `opening_balances` and folded into cumulative positions; they are not in the derived source posting stream. Assets are fixed-asset subtree + current-asset subtree + dated closing stock. Liabilities are capital + loans + current liabilities + retained earnings. Retained earnings is cumulative income + closing stock − cumulative expense. The displayed difference is assets minus liabilities; no balancing plug is applied (`books.ts:1155-1180,1318-1353,1417-1421`).

### Historical stock valuation reader boundary

The historical P&L/Balance Sheet path and the stock valuation report do not use identical as-of rules:

- `buildBooks()` uses `stockAsOf()` for a past cutoff. It starts from current quantity and rewinds movements; dated checkpoints provide historical quantity/value where present. If a product/location line has no checkpoint, the helper can compute a value from current product-master cost but records `noCostHistory` and marks the underlying position unreliable. Missing master identity or positive dispatch cost can leave a line out of the partial amount and is also reported (`books.ts:742-904`). The statement response sets `closingStockReliable` false for any historical close and appends a historical-close note, even if the helper itself has no other evidence issue (`books.ts:1423-1454`).
- The stock-valuation `asOf` reader builds historical keys from `stock_entries`, `stock_ledger` and `stock_cost_snapshots`, and excludes rows with incomplete evidence, negative quantity or missing cost instead of substituting current master cost. Its route passes `includeInTransit: !asOf`, so any dated stock-valuation request excludes transit (`inventory-batches.ts:288-316`; `valuation.ts:224-317`).
- By contrast, historical statement valuation adds sender-owned in-transit stock from the reservation lifecycle at evidenced dispatch cost and receipt date (`books.ts:642-657,772-785,839-855`). Current/no-cutoff statement closing uses the live valuation path, which includes transit.
- `inceptionDate()` includes purchases, sales, production, transfers, stock verifications, returns and ledger dates; before the earliest stock-affecting business date, `stockAsOf()` returns zero as a source-established pre-trading position (`books.ts:611-639,696-701`). A same-day statement ending today with no scoped stock-ledger movement uses the live closing valuation at both boundaries and skips the transfer adjustment (`books.ts:1206-1226`).
- Transfer boundary adjustment is separate from stock valuation: period transfer movements + closing in-transit value − opening in-transit value. It reconciles the statement boundary without changing the physical stock position; transfer account postings remain available for audit and do not create operating revenue or COGS (`books.ts:204-215,511-520`).

These are source-established reader differences, not proof of a numeric mismatch or defect. Historical report-to-statement parity, current database evidence, and test results remain NOT VERIFIED.

### Month Wise and consumer boundary

The standalone Chart of Accounts Month Wise toggle calls a separate `GET /api/accounts/financial-statements/monthly` route (`accounts.ts:4710-4813`; caller `ChartOfAccounts.tsx:1512-1528`). It validates supplied ISO dates, limits the range to 62 month columns, uses `buildPeriodicBuckets()` to identify the months, then runs the same `buildBooks(buildDerivedPostings)` engine sequentially for each month and flattens the results into a series. The source defines P&L values as each month's activity and Balance Sheet values as the month-end position; Chart renders these as added columns and supports ledger drilldowns. The route is not a separate accounting engine, but its aggregation and UI rows are an additional parity surface. No Reports Center Month Wise surface was identified.

The source maps the canonical API-to-consumer chain but does not establish that Reports Center, standalone Chart of Accounts, Month Wise columns, dashboard tiles/drilldowns, legacy book readers, or PDF/XLSX/CSV/Print outputs are numerically and visually equivalent. Referenced test assertions are source evidence only; tests were not run and no current DB values were queried.

Cash/bank use ledger subtrees and openings; receivables/payables use customer/vendor control ledgers; salary/rent payable are separate ledger subtrees in dashboard readers. A report location filter changes the posting slice and may exclude company-level openings; this is not equivalent to the company-wide Balance Sheet.

## Known reader differences and export limitations

- `GET /api/dashboard/summary` directly sums `sales.total_amount` after its query filters. This gross document total includes tax and is not the P&L net-of-GST operational revenue; the BI profit/GP/COGS values use the canonical books engine. Whether the legacy total-sales field is still shown to users is not fully verified.
- Dashboard BI exposes both ledger-control balances and document-based ageing/exposure; these are different calculation bases and must not be compared as though they were the same KPI.
- Sales-by-salesperson has its own outstanding expression rather than the shared payment-position helper; rounding-edge parity is not quantified.
- `/accounts/trial-balance`, `/accounts/day-book`, `/accounts/gst/summary`, Reports Center financial reports, and legacy inventory reports overlap concepts but are not the same route or data reader.
- Reports Center `/reports/fin/*` readers, standalone `/accounts/*` books, and the canonical P&L/Balance Sheet endpoint can overlap displayed concepts without sharing the same route; source mapping alone does not establish cross-reader parity.
- Where doc-based controls are present, generic XLSX/PDF accept section rows prepared by the UI and Print uses the prepared rows. They enforce permission/row-count limits where server-backed and render supplied data; they do not fetch canonical report data or independently check formula parity.
- The generic server XLSX/PDF endpoints cap combined rows at 3,000 and return 413 above the limit. Callback-only outputs are distinct; XLSX/Print are not available there. CSV is generated in the browser and appears only where a report supplies a callback.
- CSV generation is browser-side in the inspected pages. Generic share is absent; dashboard sharing is browser capture, while invoice and quotation token links are document-sharing flows rather than report exports.
- The canonical `reportExportContract` exists under `artifacts/api-server/src/services/`; the inspected PDF/XLSX routes use a different prepared-row validator. Month-wise canonical export is explicitly unsupported.

## Legacy and duplicate surfaces

- `/` and `/dashboard` render the same Dashboard page. `/reports` and `/accounts/reports` redirect to `/reports/sales`.
- `/headoffice/inventory-reports` is a legacy standalone page; `/reports/inventory` is the current Reports Center surface over overlapping stock endpoints.
- `/production/reports` and `/reports/production` are separate UI surfaces over `GET /api/productions/reports`.
- Reports Center financial reports use `/api/reports/fin/*`; standalone account pages retain `/api/accounts/*` routes for overlapping book concepts.
- `/headoffice/stock-ledger`, `/accounts/expenses`, and `/sales/expenses` are retired frontend routes, though related APIs or PDF permission references remain.
- `/sales/transfers` is a satellite path to the transfer surface; `/production/stock-transfer` and `/headoffice/transfers` redirect to `/transfers`.

## Source anchors

`artifacts/marlin-erp/src/App.tsx:188-423,430-469`; `pages/reports/ReportsCenter.tsx:28-119`; section files under `pages/reports/sections/`; `artifacts/api-server/src/routes/reports.ts`; `financialReports.ts`; `gst.ts`; `dashboard.ts`; `production.ts`; `inventory-batches.ts`; `assets.ts`; `pdfGen.ts`; `pages/reports/shared.tsx:468-569`.
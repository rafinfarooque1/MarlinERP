# Frozen Fruits ERP — Reports Center Path and Test Evidence Matrix

**Audit status:** PARTIAL — all 40 slots classified from source; output parity is not certified  
**Snapshot date:** 2026-09-29  
**Tests/runtime:** NOT RUN  
**Production database:** NOT QUERIED

## How to read this matrix

The 40 slot names, UI sources, filters and export actions are listed in `ERP_REPORT_INVENTORY.md`. This supplement classifies each selected path and records direct report-output test evidence found by source inspection. `CANONICAL PATH` means the current Reports Center slot's inspected reader; it does not mean every parallel screen/export has proven parity. `LEGACY PATH` means the slot uses an overlapping legacy reader/page path, not that the slot is retired. `DUPLICATE CALCULATION` is used only where a parallel formula was source-confirmed. `NOT VERIFIED` in the test column means no direct output assertion was identified in this inspection; it is not proof that no such test exists. No tests were executed.

| # | Reports Center slot | Path classification | Direct report-output test evidence | Alternate or parallel calculation / reader |
|---:|---|---|---|---|
| 1 | Sales — Sales Register | CANONICAL PATH | `tests/dashboard-parity.test.mjs:106-147,165-168`; `tests/sales-report-definition.test.mjs:52-84` | Shared sale-payment position; dashboard/register parity assertions. |
| 2 | Sales — By Salesman | DUPLICATE CALCULATION | NOT VERIFIED | Report computes outstanding independently (`routes/reports.ts:197-210`) instead of using `lib/salePaymentPosition.ts:69-104`; documented at `ERP_CURRENT_ISSUES_REGISTER.md:GAP-002`. |
| 3 | Sales — By Item | CANONICAL PATH | `tests/sales-report-definition.test.mjs:52-84,81-129` | Merchandise-line totals are distinct from invoice-level charges. |
| 4 | Sales — By Location | CANONICAL PATH | NOT VERIFIED | Dedicated location aggregation (`routes/reports.ts:281-335`); only related register/dashboard location assertions were found (`dashboard-parity.test.mjs:124-147`). |
| 5 | Sales — Discounts | CANONICAL PATH | NOT VERIFIED | Dedicated discount reader (`routes/reports.ts:337-443`). |
| 6 | Sales — Sales & Stock Summary | CANONICAL PATH | NOT VERIFIED | Dedicated combined sales/stock reader (`routes/reports.ts:762-895`). |
| 7 | Quotations — Register | CANONICAL PATH | NOT VERIFIED | Uses paginated `/api/quotations`; UI source `pages/reports/sections/QuotationReports.tsx:1-125`. |
| 8 | Purchases — Register | CANONICAL PATH | `tests/dashboard-parity.test.mjs:237-245` | Validated line tax-head/input-GST calculation (`routes/reports.ts:483-542`); Head Office restriction. |
| 9 | Purchases — By Vendor | CANONICAL PATH | NOT VERIFIED | Separate document aggregation (`routes/reports.ts:545-587`) uses stored `tax_total`, unlike the register's validated recoverable-GST calculation. This is a source difference, not a demonstrated defect. |
| 10 | Purchases — By Material | CANONICAL PATH | NOT VERIFIED | Separate line aggregation (`routes/reports.ts:589-640`) sums line tax/total independently. |
| 11 | Inventory — Stock Valuation | CANONICAL PATH | `tests/dashboard-parity.test.mjs:322-328`; `tests/stock-valuation-location-cost.test.mjs:102-140` | Shared `stockValuation` path is also consumed by dashboard/financial statements. |
| 12 | Inventory — Near Expiry | LEGACY PATH | NOT VERIFIED | Shared `/stock/expiry-report` reader with `status=near_expiry` (`routes/inventory-batches.ts:162-286`). |
| 13 | Inventory — Expired Stock | LEGACY PATH | NOT VERIFIED | Same expiry reader with `status=expired` (`routes/inventory-batches.ts:172-206,232-285`). |
| 14 | Inventory — Slow / Dead Stock | LEGACY PATH | NOT VERIFIED | Movement reader uses stock entries and last-outbound ledger data (`routes/inventory-batches.ts:362-481`). |
| 15 | Inventory — Reorder Alerts | LEGACY PATH | NOT VERIFIED | Legacy reorder query (`routes/inventory-batches.ts:484-510`); source-scope concern is recorded as GAP-012. |
| 16 | Inventory — Transfer Register | LEGACY PATH | `tests/permission-location-audit.test.mjs:290-310` (underlying transfer scope) | Uses `/stock/transfers`; the Branch Transfer Register uses the separate `/reports/branch-transfers` reader. |
| 17 | Inventory — GST Transfers | CANONICAL PATH | NOT VERIFIED | Dedicated cross-GSTIN transfer reader (`routes/reports.ts:897-1033`), distinct from GST Returns. |
| 18 | Branch Transfers — Transfer Register | CANONICAL PATH | `tests/accounting.test.mjs:570-579` | Line-level `/reports/branch-transfers` reader; linked sales/purchase documents and LBAC (`routes/reports.ts:1037-1140`). |
| 19 | Production — Output by Item | CANONICAL PATH | NOT VERIFIED | Shared `/productions/reports` reader; `/production/reports` is a parallel UI surface using the same endpoint (`routes/production.ts:198-288`). |
| 20 | Production — Material Consumption | CANONICAL PATH | NOT VERIFIED | Same endpoint; material-used/BOM aggregation (`routes/production.ts:289-307`). |
| 21 | Production — Batch Costs | CANONICAL PATH | NOT VERIFIED | Same endpoint and stored cost components (`routes/production.ts:225-276,325-333`). |
| 22 | Production — Wastage | CANONICAL PATH | NOT VERIFIED | Same endpoint; positive-wastage rows/totals (`routes/production.ts:260-276,309-323`). |
| 23 | Parties — Customer Statement | CANONICAL PATH | NOT VERIFIED | Parallel customer ledger, ageing, BI and trial-balance surfaces; related balance assertions `tests/balance-reconciliation.test.mjs:110-123`. |
| 24 | Parties — Vendor Statement | CANONICAL PATH | NOT VERIFIED | Parallel vendor ledger/payables/BI/TB surfaces; related balance assertions `tests/balance-reconciliation.test.mjs:94-107`. |
| 25 | Parties — Receivables Aging | CANONICAL PATH | `tests/dashboard-parity.test.mjs:230-235`; `tests/location-returns.test.mjs:107-128` | Same `/outstanding/receivables` reader is used by the standalone Outstanding surface. |
| 26 | Parties — Payables Aging | CANONICAL PATH | `tests/balance-reconciliation.test.mjs:94-107`; location invocation `tests/location-returns.test.mjs:107-128` | Same standalone Outstanding reader; settlement is a separate calculation path. |
| 27 | Financial — Profit & Loss | CANONICAL PATH | `tests/dashboard-parity.test.mjs:195-209` | `/accounts/financial-statements` → `buildBooks(buildDerivedPostings)`; Reports Center and Chart of Accounts query the same route. Chart's Month Wise mode uses a separate monthly endpoint. Rendered-row, drilldown, monthly and export parity are NOT VERIFIED. |
| 28 | Financial — Balance Sheet | CANONICAL PATH | `tests/stock-valuation-location-cost.test.mjs:122-140`; `tests/location-books.test.mjs:117-140` | Same engine and shared endpoint; standalone Chart adds Month Wise columns from a separate route. These source tests do not establish cross-surface presentation or export parity. |
| 29 | Financial — Trial Balance | CANONICAL PATH | `tests/location-books.test.mjs:63-97` | Reports Center uses `/reports/fin/trial-balance`; separate legacy `/accounts/trial-balance` cross-route parity is NOT VERIFIED. |
| 30 | Financial — Ledgers | CANONICAL PATH | NOT VERIFIED | Shared posting/opening split (`routes/financialReports.ts:91-144`); ledger statement is a separate subroute. |
| 31 | Financial — Books & Registers | CANONICAL PATH | NOT VERIFIED | Container/subviews use shared financial readers and `/reports/fin/ledger-statement`/`ledger-options` (`financialReports.ts:147-200`); standalone ledger is parallel. |
| 32 | Financial — Day Book | CANONICAL PATH | `tests/location-books.test.mjs:99-115` | Shared posting/opening reader; standalone `/accounts/day-book` is a separate legacy route. |
| 33 | Financial — Cash | CANONICAL PATH | `tests/dashboard-parity.test.mjs:211-228`; `tests/location-books.test.mjs:143-157` | Shared `bookReport('STD-CASH')`; standalone cash-book reader is parallel. |
| 34 | Financial — Bank | CANONICAL PATH | `tests/dashboard-parity.test.mjs:211-228`; `tests/location-books.test.mjs:143-157` | Shared `bookReport('STD-BANK')`; standalone bank-book reader is parallel. |
| 35 | Financial — Cash & Bank | CANONICAL PATH | `tests/dashboard-parity.test.mjs:302-319` | Shared book reader over both roots; union of Cash and Bank is asserted. |
| 36 | Financial — GST | CANONICAL PATH | NOT VERIFIED | Ledger-based `/reports/fin/gst` (`financialReports.ts:342-410`); GST Returns/Summary are distinct readers. |
| 37 | Financial — Expenses | CANONICAL PATH | NOT VERIFIED for this endpoint | Reads expense documents and purchase other-charge rows (`financialReports.ts:412-545`); dashboard/P&L expense parity does not directly assert this endpoint (`dashboard-parity.test.mjs:247-260`). |
| 38 | Financial — Salary | CANONICAL PATH | NOT VERIFIED | Payroll/month/location reader (`financialReports.ts:547+`); operational HR payroll/payslips are parallel surfaces. |
| 39 | Profitability — By Item | CANONICAL PATH | NOT VERIFIED | Perpetual per-item batch-cost calculation (`routes/reports.ts:642-757`), intentionally distinct from periodic P&L COGS. |
| 40 | Profitability — By Location | CANONICAL PATH | NOT VERIFIED | Same endpoint with `groupBy=location` (`routes/reports.ts:649-757`); no direct parity assertion identified. |

## Coverage limits

- “Direct test evidence” means an assertion exists in the cited test source; it does not mean the test passed. Tests were not run.
- Evidence is strongest for sales register/item, purchase register, stock valuation, branch-transfer rows, receivables/payables, P&L/BS, trial balance, day book and cash/bank. Many report slots still lack a direct endpoint-output assertion in the inspected evidence.
- Location/all-location output parity is established only for the specific tested surfaces cited here. Other report slots remain **NOT VERIFIED**; visible UI filters do not prove server authorization or all-location behavior.
- P&L/Balance Sheet source mapping identifies the shared endpoint and both primary UI consumers, but rendered statement rows, Chart Month Wise columns, drilldowns, dashboard/legacy-reader comparisons and PDF/XLSX/CSV/Print equality remain **NOT VERIFIED**. The cited tests were not run.
- Screen/export action, source service, visible filters and row preparation are mapped in `ERP_REPORT_INVENTORY.md`. This matrix does not establish PDF/XLSX/CSV/Print output parity or certify the underlying financial/inventory values.

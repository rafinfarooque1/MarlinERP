# Frozen Fruits ERP — Current System Master

**Audit status:** IN PROGRESS — Phases 1–6 partial
**Snapshot date:** 2026-09-29
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
| API route declarations | 410 | Explicit `router.get/post/put/patch/delete` expressions found in route files. Aliases and duplicate method/path pairs have not been deduplicated. |
| Frontend module registry entries | 55 | `MODULE_REGISTRY` entries; the registry also retains retired/compatibility surfaces. Not the final count of active user-facing modules. |
| Frontend page source files | 105 | `.ts`/`.tsx` files under `artifacts/marlin-erp/src/pages`; not equivalent to screens or modules. |
| Employee-app route source files | 20 | `.ts`/`.tsx` files under `artifacts/employee-app/app`; not a verified count of distinct workflows. |
| Configured Replit workflows | 4 | API, web, Expo employee app, component preview sandbox. |
| Public development database base tables | 93 | Read-only `information_schema` snapshot on 2026-09-29. Production count is NOT VERIFIED. |
| Public development database trigger objects | 3 | Two stock-master guards and one stock-ledger daily-close guard; the metadata query returned six event rows because each trigger handles two events. |

The current development schema includes the future-only stock-close tables: `stock_daily_close_baseline`, `stock_daily_close_baseline_entries`, `stock_daily_close_runs`, and `stock_daily_close_entries`. The stock-close implementation and its effects on FI-08 are present in current source; full operational behavior and report parity are deferred to the inventory/report phases.

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

### Test evidence boundary

Source test families were identified, including accounting acceptance, GST reconciliation, historical stock dating/location cost, transfer receiving, payroll LOP/accrual, assets, permissions/LBAC, mobile, backup, import, reset, dispatch and daily stock closure. There are 73 API test files; 37 filenames match the stated report/dashboard/export search rule. These are file counts, not test-case counts. Tests were not run during this documentation pass. The asset test search did not identify a depreciation-specific suite, and a dedicated FEFO ordering test was not found by the search; those are coverage gaps, not proof of incorrect results.

### Authentication, authorization and location scope

- API-wide `requireAuth` covers `/api` except explicit health/schema, login and token/public-share/mobile-distribution paths. Authenticated requests re-resolve the active user. Tokens are HMAC-SHA256 v2, require `SESSION_SECRET`, reject legacy unsigned tokens, and have an eight-hour default maximum age. Login uses bcrypt and a username-normalized lockout (five failures, 15-minute lock), with login history/audit records.
- Canonical permission keys are `page:<sidebar href>` and the module registry feeds sidebar, permission administration and route ownership. The permission model is view/add/edit/delete/download. Server middleware is authoritative; missing permission rows deny, level 1 bypasses all actions, and any-of guards are supported. UI hiding is not enforcement.
- Permission migration merges duplicates by OR, establishes unique hierarchy/page rows, and seeds default-deny for roles created later. Permission checks and route guards have static scripts and focused tests; tests were not run.
- Location scope is derived from the authenticated branch identity, not client location headers. Head Office sees all; warehouses see themselves and their supplied outlets; outlets see themselves. Money scope is narrower: a warehouse does not inherit outlet wallet ownership. Writes validate ledger ownership, location, till membership and voucher stamp.
- Hierarchy reads are intentionally available to authenticated users for permission resolution; counts are restricted. Hierarchy writes validate page actions, reject a second root/cycles, serialize structure edits and recalculate descendant levels.
- Exceptions needing separate checks: public invoice/quotation/share/mobile paths bypass the global auth middleware and rely on route-specific controls; every public handler was not re-audited. Unknown/unregistered web routes fall through the UI guard, while server authorization remains the enforcement boundary. Web permission hooks can temporarily report full access while loading; APIs still enforce permissions.

### Reports, exports and API contract

- API source counts remain 43 route files, 42 mounted routers and 410 explicit method/path declaration expressions, not deduplicated runtime endpoints. OpenAPI has 66 path keys and 110 HTTP operation keys; it is not runtime-derived or proven complete.
- The selected report-oriented source set contains 34 route declarations: 12 Reports Center routes, 11 Financial Reports Center routes, and 11 adjacent/legacy report routes. This is a scoped count, not every report-like API.
- Reports Center has nine categories under a shared reports permission. The financial report picker has 14 values; those values are not a count of API routes. Dashboard exposes eight GET routes and mixes derived postings with direct source-table readers.
- PDF and XLSX report output are server POST endpoints; CSV in the current Reports UI is browser-generated. A canonical report-export contract/parser exists, but the inspected PDF/XLSX path uses a different validator; month-wise mode is rejected by the canonical contract. End-to-end export parity is not verified.
- Source search found 73 API test files and 37 filenames matching the stated report/dashboard/export search terms. Counts are files/matches, not test cases. Relevant parity tests exist, but none were run.

### Boot, scheduled work, storage and imports

- API startup performs a large idempotent migration/repair pass before financial schedulers start. Core migration failure is non-fatal to process startup but can leave readiness false. The backup scheduler starts even if a migration/bootstrap error was recorded, after a delay; it is unknown whether this causes an incorrect backup in practice.
- Rent and salary accrual run immediately then hourly with per-entity advisory locks and locked/approved-period guards. Daily stock close runs immediately and every 60 seconds. Backups start after a 60-second delay and then hourly. These are in-process timers; multi-instance duplicate execution safety was not verified.
- Backup supports listing/history, create/download/delete, validation, throwaway restore verification, upload/finalize and restore gates. Downloads are server-streamed behind permissions; storage must be configured. Retention protects the newest pre-restore safety copy. Live archive restore and production storage behavior were not tested.
- Attachments are limited to PDF/image types and 10 MB; reads require uploader-before-attachment or record/location authorization and return 404 otherwise. Invoice/quotation share links are tokenized, expiring and revocable, but link-specific test coverage was not identified.
- Imports use validate/map/demo/approve stages, persistent manual mappings, transaction rollback for demo, and shared manual-producer routines on commit. Transaction reset uses one child-first table list and a backup gate; exact factory-reset coverage remains pending.

### Employee app

- Employee app includes attendance with multi-punch and optional GPS, leave requests/cancellation, payslips, a location-scoped dispatch status queue, sale creation, and receipt/payment vouchers. Server remains authoritative; 401 clears the client session/cache. Role-aware navigation mirrors five-action permissions but does not replace API checks.
- Offline writes/sync were not identified in the inspected screens. Mobile permission/location tests and distribution-pipeline tests exist but were not run; outlet-role behavior is explicitly not verified while outlets are disabled.

### Partially mapped business flows

These are source-backed path sketches, not an exhaustive workflow catalogue. Full UI permission, DB relationship, report/export and audit-event mapping remains pending.

| Flow | Current source trace | Status / limit |
|---|---|---|
| Sales / POS create and edit | `routes/sales.ts` → shared line/tax/discount builder → sale row, stock/batch effects and derived posting path | PARTIAL; UI route and every side-effect table not mapped |
| Sale receipt / later payment | POS advance first → receipt helper → `sale_payments` history and shared payment-position status | PARTIAL; all receive-into and account combinations not enumerated |
| Sales return / credit note | `routes/returns.ts` → quantity cap and stored-line proration → stock restore plus customer credit-note or cash-refund path | PARTIAL; frontend state and export surfaces not fully mapped |
| Purchase bill / vendor payable | shared purchase-pricing → goods total and separate charges → stock receipt, supplier control and payable amount | PARTIAL; purchase-order/request flow not established |
| Purchase return / debit note | `routes/returns.ts` → prior-return cap and line proration → stock reduction and vendor debit-note posting | PARTIAL; every reversal scenario/test not traced |
| Bill-wise settlement and advances | `routes/accounts.ts` allocations → vendor payment/receipt voucher → explicit allocation, advance and ledger effects | PARTIAL; all UI entry points and edit/delete paths remain |
| Cash/bank books and reconciliation | derived postings + openings → location-filtered Cash/Bank Book; review batch records exact posting identity | PARTIAL; external bank-statement comparison is not present in inspected flow |
| Inventory valuation and lot issue | stock-entry quantity + location checkpoints/reservations → valuation; FEFO consumes eligible lots | PARTIAL; every writer and adjustment route not mapped |
| Production costing | production-cost helper combines goods, overhead and payroll labour pools | PARTIAL; all production route callers and finished-goods posting path not traced |
| Attendance, leave and payroll | employee punches/leave → attendance factors and LOP → payroll and cumulative salary accrual | PARTIAL; all HR approval/UI/report paths not mapped |
| Fixed assets | purchase/capitalized GST → monthly depreciation → disposal book value and posting path | PARTIAL; no depreciation-specific test identified |
| Transaction import and reset | import analyze/manual mapping/demo/approve; reset backs up, locks and deletes configured transaction tables transactionally | PARTIAL; full factory-reset gates and table coverage remain |
| Backup and restore | scheduled/manual archive → manifest/validation/verification and restore authorization gates | PARTIAL; live restore and production storage not tested |
| Employee mobile flows | attendance, leave, payslips, dispatch, sale and receipt/payment voucher screens call the API | PARTIAL; offline writes not identified, full per-screen endpoint map remains |

## 6. Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Existing-document audit, architecture, code/module/API/table inventory baseline | **COMPLETE** |
| 2 | Accounting engine, source-of-truth functions, exact formula register, P&L and Balance Sheet | **IN PROGRESS** — core posting/P&L/BS/GST paths traced; report exceptions and full consumers remain |
| 3 | Inventory, costing/valuation, batches, reservations, transfers, production, sales and purchases | **IN PROGRESS** — core stock/cost paths traced; module-level end-to-end coverage remains |
| 4 | GST, customer/vendor settlement, cash/bank, assets, payroll and HR | **IN PROGRESS** — GST, sale/purchase settlement, cash/bank readers, payroll and fixed-asset formulas traced; remaining flows pending |
| 5 | Permissions/location security, audit logging, background jobs, backup/restore, mobile and external services | **IN PROGRESS** — authz/LBAC, jobs, backup/import/reset and core mobile paths traced; exhaustive coverage pending |
| 6 | Full report/export/API inventory, tests, issue cross-check, final counts and verification | **IN PROGRESS** — source counts and test inventories recorded; report parity and remaining issue cross-check pending |

**DOCUMENTATION PROGRESS:** Phase 1 complete; source-backed passes cover selected paths in Phases 2–6.
**Completion estimate:** 50% — broad source areas and inventories are documented, but end-to-end module, route, UI/export, security and test verification remain incomplete.

## 7. Inventory status and remaining counts

### Partial source counts recorded

- 43 API route files, 42 mounted routers and 410 explicit route declaration expressions. These are not deduplicated runtime API-operation counts.
- OpenAPI: 66 path keys and 110 HTTP operation keys; completeness is not established.
- Reports: 34 declarations in the selected report-oriented source set (12 Reports Center, 11 Financial Reports Center and 11 adjacent/legacy routes); not an exhaustive report count.
- UI: nine Reports Center categories under a shared permission, 14 financial report-picker values, and eight dashboard GET routes. These are different counting units.
- 93 public development base tables and three trigger objects, read-only snapshot dated 2026-09-29; production remains unqueried.
- 73 API test files and 37 filenames matching the stated report/dashboard/export search; no tests were executed.
- The formula register contains 30 verified formula/algorithm groups; this is not an exhaustive formula total.
- Four configured workflows and 55 frontend module-registry entries were inventoried in Phase 1; registry count includes retired/compatibility entries.

### Not yet established

- Active business modules and complete workflows without double-counting shared components.
- Distinct runtime API operations after alias/path deduplication, including auth and location-scope classification.
- Complete report, export and screen-to-route mapping, with output parity.
- Important table relationships and a full current data dictionary.
- Exhaustive formula count and remaining per-module formula families.
- Full code issue inventory and final severity/release-readiness assessment.

Remaining items are **NOT VERIFIED** until their owning code paths and relevant consumers are inspected. Production database state is outside this audit.
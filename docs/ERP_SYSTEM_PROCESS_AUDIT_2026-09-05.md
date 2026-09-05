# Frozen Fruits ERP — Current System & Process Audit

**Audit date:** 2026-09-05  
**Timezone:** Asia/Calcutta  
**Mode:** Read-only forensic review  
**Scope:** Current workspace source, running development workflows, live development database metadata/data, and unauthenticated health endpoints  
**Production scope:** Not verified. No production database, deployed commit, production object-storage listing, or production API was accessed.

## Scope and method

The audit followed the supplied read-only brief. No application code, database row, schema, migration, transaction, or configuration was changed during this audit. The database checks were `SELECT`-only. Existing integration-test data is present in the development database, so records with `zz...` usernames or test-probe descriptions are called out rather than treated as clean production evidence.

Evidence sources:

- Workspace source under `artifacts/api-server`, `artifacts/marlin-erp`, `artifacts/employee-app`, `lib`, and `docs`.
- Running workflows: API server, ERP web app, Expo employee app, and mockup sandbox.
- API health endpoints: `/api/healthz` and `/api/healthz/schema`.
- Development PostgreSQL database `heliumdb`, PostgreSQL 16.10.
- Read-only database census and reconciliation queries.
- Existing tests and source comments, used as implementation evidence but not treated as proof that every test has passed.

## Executive result

The ERP has a coherent shared-posting architecture and strong transaction-path controls. The most important confirmed limitations are:

1. **Historical inventory valuation is derived, not stored:** historical quantity is reconstructed by rewinding current `stock_entries` with `stock_ledger`, then valued using current weighted-average cost. Missing/legacy movements or deleted masters can make historical P&L/BS unreliable.
2. **Historical in-transit stock is not reconstructable:** the current historical close cannot reconstruct the in-transit position at a past date because transfer receipt timing is not retained as a historical state.
3. **Customer/vendor detail GETs lack party scope checks:** `GET /customers/:id` and `GET /vendors/:id` check page permission but retrieve by ID without `partyScopeCheck`; an authenticated user with page access can potentially enumerate another location’s party PII.
4. **Audit logging is best-effort:** `writeAudit()` catches and logs insert failures, so a business mutation can succeed while its audit event is lost.
5. **GST has two calculation/reporting streams:** `/gst/summary` reads sales/purchase documents while Reports Center GST reads posting-derived data; they can diverge for manual GST journals, returns, or rounding.
6. **Several delete paths are physical deletes:** purchases, quotations, ordinary vouchers, and masters can be removed after guards; reversal rows may remain without the original source document.
7. **Generic report exports accept client-prepared rows:** the generic PDF/XLSX path validates shape/size but does not recompute the report from source records.
8. **Operational boot performs data repair and cleanup:** startup is not only schema initialization; it also runs many raw migrations and cleanup/repair operations.

The live development checks performed during this audit found:

- No unbalanced journal vouchers.
- No orphan journal-voucher lines.
- No orphan stock-ledger material references.
- No negative `stock_entries` or negative `stock_batches`.
- No stale active reservations.
- Batch quantity currently equals stock-entry quantity: `41,952.500` for item stock.
- All current sales and purchases have location stamps.
- Two active reservations belong to transfers whose status is still `in_transit`.
- API health and date-column schema census both returned `200 / ok`.

## 1. System architecture

### Stack

| Layer | Current implementation | Evidence |
|---|---|---|
| Web frontend | React + Vite + TypeScript | `artifacts/marlin-erp`, `package.json`, `vite.config.ts` |
| Mobile frontend | Expo Router / React Native | `artifacts/employee-app/app`, `contexts/AuthContext.tsx`, `contexts/LocationContext.tsx` |
| API | Express 5, built with esbuild and run from `dist/index.mjs` | `artifacts/api-server/src/app.ts`, `package.json`, `build.mjs` |
| Database | PostgreSQL 16.10; raw `pg` queries plus Drizzle schema/client packages | `lib/db`, `artifacts/api-server/src`, live database |
| Validation | Zod, generated API Zod/OpenAPI types, route-level validation | `@workspace/api-zod`, route modules |
| Client API | Generated React Query hooks plus handwritten hooks | `lib/api-client-react`, frontend hooks |
| Authentication | Bearer token, bcrypt password verification, DB-backed lockout | `routes/auth.ts`, `middleware/auth.ts`, `lib/token.ts` |
| Authorization | Page permission plus five action permissions and route-specific guards | `middleware/permissions.ts`, `App.tsx` |
| Files | Object storage with presigned upload/download paths and ACL checks | `lib/objectStorage.ts`, `routes/storage.ts` |
| PDFs | Mostly server-rendered; invoice renderer is canonical and server-side | `services/invoicePdf.ts`, `routes/pdfGen.ts` |
| Exports | Server PDF/XLSX endpoints plus client Chart of Accounts PDF | `routes/pdfGen.ts`, `ChartOfAccountsPdf.ts` |

The API is mounted under `/api`; health is therefore `/api/healthz`, not `/healthz`. The running endpoint returned:

```json
{"status":"ok"}
```

The schema census returned all 16 expected date columns as `date`, with no pending or missing columns.

### Runtime/build parity

The API workflow performs:

```text
pnpm run build
node --enable-source-maps ./dist/index.mjs
```

The current running bundle contains the current `stockTransferOpeningAdjustment` marker, and the API workflow was restarted after the latest source build. This demonstrates current source-to-running-development parity for the inspected API path. It does **not** prove that a published deployment uses the same bundle or database.

## 2. Complete module map

| Business area | Frontend | API/source | Main storage |
|---|---|---|---|
| Login/session | `marlin-erp/src/App.tsx`, employee app auth context | `routes/auth.ts`, `middleware/auth.ts` | `employees`, `login_attempts`, `login_lockouts`, `activity_log` |
| Dashboard | dashboard pages/components | `routes/dashboard.ts`, `lib/dashboardFinancials.ts` | derived postings, sales, purchases, expenses, inventory |
| Customers/vendors | master pages/forms | `routes/customers.ts`, `lib/partyCreate.ts` | `customers`, `vendors`, party ledgers |
| Purchases | purchase pages/components | `routes/purchases.ts` | `purchases`, `stock_entries`, `stock_batches`, `stock_ledger`, postings |
| Sales/POS | `pages/headoffice/Sales.tsx`, POS components | `routes/sales.ts`, `routes/payments.ts` | `sales`, `sale_payments`, receipts, stock, ledger, postings |
| Quotations | `pages/headoffice/Quotations.tsx` | `routes/quotations.ts` | `quotations`, share links; no stock/books until conversion |
| Returns | returns pages | `routes/returns.ts` | `sales_returns`, `purchase_returns`, notes, stock, ledger |
| Transfers | stock/transfer pages | `routes/stock.ts`, transfer helpers | `stock_transfers`, `stock_reservations`, `stock_ledger` |
| Accounting | accounts pages | `routes/accounts.ts`, `routes/journal.ts`, `lib/books.ts` | ledgers, JVs, postings, opening balances |
| GST | GST pages | `routes/gst.ts`, accounts/financial reports | document tax JSON plus GST ledgers |
| HR/payroll | HR pages and employee app | `routes/hr.ts`, `salaryAccrual.ts` | employees, attendance, payroll, accruals, advances |
| Rent | rent pages | `rentAccrual.ts`, rent routes | agreements, periods, accruals, payments |
| Assets | asset pages | `routes/assets.ts`, `migrations/assetModule.ts` | assets, asset purchases, categories |
| Imports | import wizard | `routes/imports.ts`, import helpers | import batches/mappings/rows/migrations |
| Backup | backup pages | `routes/backup.ts`, `lib/backup/*` | `backup_meta` schema plus object storage |
| Audit | audit viewer | `routes/audit.ts`, `lib/audit.ts` | `activity_log` |
| Android distribution | employee release UI | `lib/apkRelease.ts`, release script | object storage manifest and APK |

## 3. Database map

The live public schema contains 69 migration records and the following major domains:

### Identity and security

- `employees`: username, password hash, hierarchy, branch type/id, active status, employment dates, UI location preference.
- `hierarchies`: role tree and levels.
- `permissions`: page/action permissions.
- `login_attempts`, `login_lockouts`: authentication abuse control.
- `activity_log`: audit events with action/module/entity and before/after metadata.

### Parties and operations

- `customers`, `vendors`: party masters and location association.
- `items`, `materials`, `raw_materials`: product/material masters.
- `warehouses`, `outlets`: operational locations.
- `purchases`, `sales`, `quotations`, returns, expenses, assets.

### Inventory

- `stock_entries`: current quantity truth keyed by `material_type`, item ID, branch type, branch ID.
- `stock_batches`: additive lot layer with batch number, dates, quantity, unit cost, source.
- `stock_ledger`: append-only dated movement history.
- `stock_reservations`: holds and in-transit ownership reservations.
- `stock_transfers`, `stock_verifications`, `storage_locations`, `storage_placements`.

### Accounting

- `account_ledgers`: chart nodes and postable ledgers.
- `journal_vouchers`, `journal_voucher_lines`: manual/system voucher source.
- `opening_balances`: initial ledger positions.
- `payments`, `receipts`, `sale_payments`, allocations and advance tables.
- `accounting_period_locks`, `period_lock_events`.

### HR/rent/reconciliation

- `attendance`, `attendance_punches`, `leaves`, `payroll`, `salary_accruals`, `employee_advances`, `pay_components`.
- `warehouse_rent_agreements`, `rent_periods`, `rent_accruals`, `rent_payments`.
- `reconciliation_batches`, `reconciliation_batch_items`.

### Backup and migrations

Backup metadata is in the separate `backup_meta` schema used by `lib/backup/*`. The public schema contains `migration_log`, `boot_status`, and reconciliation tables. The current `boot_status` shows successful development boots and all date-column conversions complete.

## 4. API map

The running router is mounted in `artifacts/api-server/src/routes/index.ts`. Important route families include:

```text
/api/healthz
/api/auth/*
/api/dashboard/*
/api/customers/*
/api/vendors/*
/api/purchases/*
/api/sales/*
/api/sales-returns/*
/api/purchase-returns/*
/api/stock/*
/api/stock/transfers/*
/api/accounts/*
/api/gst/*
/api/hr/*
/api/rent/*
/api/reports/*
/api/pdf/*
/api/storage/*
/api/backup/*
/api/imports/*
/api/audit/*
/api/public/invoices/*
/api/public/quotations/*
```

Global order is significant:

```text
security headers / CORS / body parsing
→ /api token middleware
→ router
→ page/action permission checks
→ route-specific LBAC and business validation
→ transaction and source writes
```

The API source generally uses the authenticated employee as write authority. Client-selected location headers are treated as narrowing/read preferences rather than write authority.

## 5. Login → dashboard flow

```text
User submits username/password
→ POST /api/auth/login
→ normalize username and check lockout
→ locate active employee
→ bcrypt compare
→ record login attempt/audit event
→ issue signed Bearer token
→ frontend stores identity/token
→ GET /api/auth/me and permission/bootstrap calls
→ frontend establishes location context
→ dashboard queries
→ server derives location-scoped financial/inventory data
→ dashboard renders KPI cards and drill-down links
```

Confirmed behavior:

- Wrong credentials use generic failure responses.
- Five-failure/15-minute lockout state is durable in the database.
- Each authenticated request re-checks the employee’s active status.
- Frontend location selectors do not replace backend LBAC.
- Mobile uses AsyncStorage bearer tokens and clears query/session state at session boundaries.

Security limitation: logout is not a server-side token revocation mechanism. A stolen token remains usable until expiry or employee deactivation.

## 6. Location and warehouse flow

### Authority model

The primary location authority is `employees.branch_type` plus `employees.branch_id`. `lib/dataScope.ts` resolves accessible locations from that identity. `lib/requestLocation.ts` and frontend session context provide narrowing preferences for reads; they are not authority for writes.

Typical rules:

- Head Office can select or report across locations subject to endpoint policy.
- Branch users are limited to their assigned location and approved mirror identities.
- Warehouse scope can include associated outlet identities where the route explicitly resolves the pair.
- The request body’s location is a request, not proof of authority.
- Effective location is resolved before write guards, including disabled-location checks.

### Confirmed gap

`GET /api/customers/:id` and `GET /api/vendors/:id` perform page permission plus an ID lookup, but do not call `partyScopeCheck`:

- `artifacts/api-server/src/routes/customers.ts:300-307`
- `artifacts/api-server/src/routes/customers.ts:527-533`

PATCH, DELETE, ledger, and related routes do call the party scope check. This means a user who has page view and can guess an ID may retrieve a party record outside their location even though they cannot edit it. **Severity: HIGH security/privacy finding, confirmed in source.**

### Reporting location caveat

`routes/financialReports.ts` has `headOfficeOnly()` behavior that returns empty structures for non-HO users on several Reports Center endpoints. This may be intentional policy, but it is a material UX/business risk if branch users are expected to see location reports. **Severity: MEDIUM, confirmed behavior; expected policy is not fully verified.**

## 7. Purchase flow

```text
Purchase page
→ POST /api/purchases
→ validate vendor, invoice date, location, month lock, lines, inactive status, GST, rates and charges
→ lock relevant stock/product rows
→ insert purchases row with stored posted totals/JSON lines
→ update stock_entries and stock_batches
→ write dated stock_ledger purchase rows
→ create/derive accounting posting
→ vendor payable and purchase/GST ledgers
→ reports, vendor statement, PDF
```

Other charges are stored in `purchases.other_charges`. New charges must use valid active postable direct-expense ledgers; historical stored charges are grandfathered to preserve old records. Charges increase vendor payable but are intentionally not inventory cost.

### Purchase edit

Edit reverses and reapplies affected stock lines, rechecks settlement and location rules, and preserves historical optional fields through edit-specific defaults. The edit is transaction-scoped and writes dated reversal/reapplication movements.

### Purchase delete

`DELETE /purchases/:id` physically deletes the source document after stock/batch reversal and writes `purchase_reversal` movements. It blocks allocated/settled cases but may release advance applications. It floors stock reversal at zero in some paths.

**Finding — HIGH historical integrity risk, confirmed:** a purchase document can disappear while reversal ledger rows remain. If stock was already consumed or adjusted, floor-at-zero reversal is not a mathematical inverse. This complicates source reconstruction, vendor history, and historical valuation.

## 8. Sale and POS flow

```text
Sale/POS page
→ POST /api/sales
→ validate location, disabled state, customer/credit, item active status, MRP, quantity, GST, discounts, coupon, charges, payment mode
→ lock stock_entries and check available = on-hand − active hold
→ consume FEFO batches
→ insert sale and line breakdown
→ write sale stock_ledger rows
→ create receipt only for supported immediate collection paths
→ derive sales/GST/customer/collection postings
→ reports, invoice PDF, customer ledger, dashboard
```

Bank/UPI/card-style deferred collection is represented separately from immediate cash collection. Sale location is authoritative for stock and books. Edits are blocked for transfer-generated invoices and locked periods. Cancel is soft via `cancelled_at`, restores stock and batches, writes cancellation movements, reverses customer effects, and removes the generated sale receipt when appropriate.

**Finding — MEDIUM audit semantics risk, confirmed:** sale cancellation is written to audit with a DELETE action even though the sale is soft-cancelled. Audit consumers may interpret it as physical deletion.

## 9. Quotation and other-charges flow

Quotation:

```text
Quotation page
→ POST /api/quotations
→ validate items, charges, customer, location and terms
→ insert quotations row/share-link data
→ no stock, receipt, GST posting, or accounting entry
→ PDF/share
→ conversion locks quotation
→ POST /api/sales creates the actual operational transaction
```

Quotation conversion uses a row lock and uniqueness constraints so one quotation cannot create multiple sales. Quotation stock check is advisory; the sale transaction performs the authoritative stock check.

Unconverted quotations can be physically deleted, including share links.

Other charges:

- Stored as JSONB on quotations, sales, and purchases.
- Server validates active/postable ledger classification.
- Sale charges use direct income semantics; purchase charges use direct expense/vendor-payable semantics.
- Historical malformed/zero charge entries can be filtered out by parsing, so corrupted JSONB may silently disappear from presented totals.

**Finding — MEDIUM data-integrity risk, possible/confirmed behavior:** malformed or stale historical charge JSON is not surfaced as a hard error; it can be omitted from screen/report calculations.

## 10. Payment, receipt, customer and vendor flow

Payment and receipt vouchers:

```text
Voucher form
→ POST /api/accounts/payments or /api/accounts/receipts
→ validate date/month lock, party, amount, distinct ledgers, effective location and money scope
→ write payment/receipt source row
→ allocation/advance/sale-payment rows where applicable
→ derived posting stream includes the voucher
→ cash/bank and party ledger balances change
```

Edits rewrite voucher fields in place and preserve audit before/after payloads. Deletes require Administrator-level gating and unwind sale allocations transactionally for receipt-backed sales.

Customer/vendor creation provisions a party ledger. Master deletes are blocked by operational dependencies and linked ledger activity.

Customer/vendor outstanding is ledger-derived through the posting index, not simply `total - paid`. The gross customer model includes sale debits, payment credits, returns/notes, and overpayment handling.

## 11. Inventory and stock engine

### Source of truth

`stock_entries` is the current quantity truth. `stock_batches` is an additive lot/FEFO layer. `stock_ledger` is the dated append-only movement/audit layer. Reservations do not add on-hand quantity:

```text
available = stock_entries quantity − active hold reservations
```

In-transit reservations are sender-owned after dispatch because source on-hand was already reduced.

### Purchase

Inbound quantity credits `stock_entries`, creates/updates batches, updates product/material mirrors, and writes a dated `purchase` movement.

### Sale

Sales lock the stock row, check availability, consume FEFO lots, store batch breakdown, decrement quantity, and write dated `sale` movement.

### Returns

Sales returns restore quantity and consumed lots, generally LIFO for consumed lot restoration. Purchase returns decrement stock and write `purchase_return` movements. Return edits write delta movements.

### Production

Production consumes material stock/lots, creates finished-goods stock/lots, and writes consumption/output movements. The production accounting pair is excluded from periodic P&L aggregation because closing inventory carries the value once.

### Physical adjustment

Verification compares counted quantity with `stock_entries`, adjusts the difference, writes an `adjustment` movement, and uses an adjustment batch for tracked stock.

### Current runtime checks

- `stock_entries`: 130 rows, 15 zero rows, 115 positive rows.
- No negative stock-entry quantities.
- No negative batch quantities.
- Batch quantity equals stock-entry quantity for item stock: `41,952.500` vs `41,952.500`.
- No orphaned `stock_ledger` item/material references.

## 12. Stock transfer flow

```text
Transfer Out
→ lock source stock
→ consume source FEFO lots
→ decrement source stock_entries
→ write transfer_out stock_ledger at transfer business date
→ create active sender-owned in_transit reservation

Transfer In
→ lock transfer and destination stock
→ release received reservation quantity
→ credit destination stock_entries/lots
→ write transfer_in stock_ledger at transfer business date
→ complete transfer

Short receipt
→ credit only actual received quantity
→ preserve unreceived quantity as active in_transit

Reject
→ restore source quantity/lots
→ write dated source-side return movement
→ do not credit destination
```

Batch number, quantity, expiry, and cost are carried through the transfer layer. The in-transit reservation uses weighted-average valuation for sender-owned closing valuation; the periodic opening adjustment uses the transfer movement’s traceable cost basis.

### Accounting impact

Internal transfers are not operational sales/purchases. The current periodic accounting correction represents them as:

```text
adjusted opening stock
= normal opening stock
  + dated transfer-in value
  − dated transfer-out value
```

Closing stock remains supplied by the shared valuation layer. This avoids adding the same transfer to both opening and closing stock.

Cross-GSTIN transfers have separate taxable document/accounting behavior, but the transfer clearing account is used instead of operational Sales/Purchases for the transfer value. Integration tests verify revenue, COGS, gross profit, net profit, opening/closing invariants for dispatch and receipt.

### Runtime state

The current database has 8 completed transfers and 2 in-transit transfers. Both active reservations correspond to transfers still marked `in_transit`; no stale active reservation was found.

## 13. Monthly stock and report calculation

For a requested period:

```text
Opening stock
  = stock as of the day before fromDate
  + transfer opening adjustment for the period

Purchases
  = posting/document activity in the period

Expenses/income
  = derived postings in the period

Closing stock
  = stock as of toDate, valued by the shared valuation layer

COGS
  = opening stock + purchases − closing stock
```

Monthly statements enumerate month buckets in `lib/periodicSummary.ts` and invoke the statement builder for each bucket. P&L cells are period activity; BS values are month-end positions.

### Transfer double-counting result

No normal transfer double-count was confirmed. The transfer regression verifies:

- source dispatch reduces source on-hand;
- receipt adds only the received destination quantity;
- active transit is counted once in sender-owned valuation;
- transfer values affect the opening adjustment, not closing stock;
- P&L remains neutral.

### Historical limitation

Historical close is not a stored snapshot. `stockAsOf()` rewinds today’s stock with dated ledger rows and marks reliability issues when the current stock/ledger baseline cannot be reconciled. Current code explicitly cannot reconstruct the past in-transit state because transfer receipt timing is not a historical close-state table.

**Finding — HIGH financial reporting limitation, confirmed:** historical P&L/BS can be unreliable when the movement trail is incomplete, masters were deleted, or an unreceived transfer straddled the historical period boundary. The API exposes reliability/integrity signals, but consumers must honor them.

## 14. FIFO / FEFO

FEFO selection is:

```text
expiry date ascending
→ NULL expiry last
→ oldest lot first
→ explicit owner-checked overrides when supplied
```

Partial consumption decrements the selected lots and records batch breakdown. Returns restore consumed lots using the return path’s restoration rule. Transfers consume the source lots and create destination lots/reservation metadata.

### Important limitation

The batch layer is additive. Legacy/untracked residual quantity can exist in `stock_entries` without equal tracked lots. The system preserves quantity truth but cannot prove lot-level cost for that residual.

Weighted-average reversal is exact only in favorable ordering. Reversing an older inbound after later inbounds is an approximation because the system does not replay a full historical cost ledger into the current master average.

**Severity:** MEDIUM; confirmed design limitation, with possible valuation drift after complex edits/deletes.

## 15. Accounting engine

```text
Operational source tables
→ buildDerivedPostings()
→ location-stamped Dr/Cr posting stream
→ buildBooks()
→ P&L / Balance Sheet / Trial Balance / ledger indexes
→ dashboard and report consumers
```

`buildDerivedPostings()` covers sales, GST, purchases, payments, receipts, expenses, payroll/rent, returns, journal vouchers, production overlays, and transfer-specific entries. `buildBooks()` loads the chart of accounts, groups descendants, separates P&L/BS roots, applies opening balances, computes integrity, and applies the transfer opening adjustment.

### Core posting patterns

| Transaction | Debit | Credit |
|---|---|---|
| Sale | cash/bank or customer; COGS as applicable | sales, output GST, inventory/COGS counterpart |
| Purchase | purchase/inventory and input GST | vendor/cash/bank |
| Receipt | cash/bank | customer/advance/income destination |
| Payment | vendor/expense/advance | cash/bank |
| Payroll accrual | salary expense/statutory/employee payable | salary payable/statutory payable |
| Journal voucher | user-selected valid ledger lines | user-selected valid ledger lines |
| Transfer clearing | branch debtor/clearing and GST where taxable | transfer clearing/output GST; operational revenue excluded |
| Production | finished goods inventory | production absorbed/consumption counterpart |

Journals require multiple lines, positive amount, postable ledgers, and equal debit/credit totals. Location ownership is checked against the voucher stamp and effective ledger scope.

## 16. Vendor/customer ledgers, cash/bank, P&L, Balance Sheet

### Party ledgers

The ledger index is built from the same derived posting stream used by reports. Vendor/customer natural-side signs are normalized in `lib/ledgerBalances.ts`. Current route-specific party statements use a corrected posting stream path, but the reusable `buildLedgerStatement()` has a date-window semantic risk: it calculates totals over all postings while only displaying entries after `fromDate`, and its opening seed is only from explicit opening balances.

**Severity:** MEDIUM, confirmed source behavior; impact depends on which caller uses `currentPartyStatement()` with a non-empty `fromDate`.

### Cash and bank

Cash/bank reports resolve ledger subtrees and calculate opening, in-period activity, and running balances from postings. Account availability is modeled through location junctions, not account ownership, with explicit membership guards on pickers/producers.

### P&L

```text
Revenue
− COGS
= Gross profit
+ other income
− expenses
= Net profit
```

Opening/closing stock are integrated into the P&L calculation. Returns use note-sourced postings. Transfer documents are excluded from operational revenue/COGS and handled by the transfer opening adjustment.

### Balance Sheet

The Balance Sheet is formed from cumulative balances by classified chart root, including cash, bank, receivables, payables, inventory, assets, capital, retained earnings, and calculated profit/loss. There is no balancing plug; integrity exposes the difference.

### GST divergence

`/gst/summary` aggregates document-level sales/purchase data. Reports Center `/reports/fin/gst` aggregates posting-derived GST. Manual GST JVs, document-vs-line rounding, returns, and non-standard sources can produce different totals.

**Finding — HIGH reconciliation risk, confirmed:** GST UI/report paths do not share one source of truth.

## 17. Chart of Accounts and valued filtering

The chart is a hierarchical ledger tree with parent/group handling and cycle/depth protection. Accounts can be expanded/collapsed in the UI.

“Show Valued Accounts Only” is presentation-only:

- unchecked: all accounts are shown;
- checked: zero-value leaf accounts are hidden;
- required ancestors remain visible so hierarchy remains navigable;
- totals and accounting payload are not changed;
- Chart PDF mirrors the selected statement, expansion, Month Wise state, and valued-only state.

**Finding — MEDIUM presentation risk, confirmed by design:** the Chart PDF is a WYSIWYG snapshot, not a complete audit export. Collapsed groups and hidden zero accounts are omitted, and displayed values use absolute formatting that can hide debit/credit sign context.

## 18. PDF, export, and share flow

### Canonical invoice PDFs

The server reads stored sale data and renders invoice PDFs from the stored row and resolved location letterhead. Public invoice links use short-lived signed access; separate revocable share-link paths exist.

### Other PDFs

Purchase, return, voucher, transfer, payslip, and report PDFs are route-specific. Some are server-assembled from stored records. The generic report PDF/XLSX endpoint accepts client-prepared section/row payloads and validates structure/count rather than rebuilding the report from source data.

**Finding — MEDIUM consistency risk, confirmed:** a stale or manipulated authorized client payload can export values that differ from a newly recomputed screen. Location/header selection is constrained, but the report rows themselves are client-supplied for the generic export path.

## 19. HR, payroll, and rent

### Payroll

```text
Employee
→ attendance/punches/leaves
→ salary accrual for open dates
→ payroll generation
→ statutory/advance deductions
→ approval gate
→ accrual true-up and salary JV
→ payable/payment
```

Bulk attendance correction is a single transaction with sorted employee locks, duplicate/ID/date validation, signed-off-month protection, and before/after audit payloads. The correction transaction commits before re-accrual is invoked asynchronously.

**Finding — MEDIUM accounting freshness risk, confirmed:** re-accrual is awaited through a helper that can swallow failure; bulk attendance can return success while salary accrual remains stale until the hourly sweep.

### Rent

Rent agreements, periods, daily accruals, and payments are stored separately. A scheduler catches up missing rent accrual days and uses warehouse-level locking. Source comments state approval requires full coverage because there is no post-approval true-up.

**Finding — MEDIUM operational control risk, confirmed source limitation:** rent approval does not itself true-up incomplete accrual coverage.

## 20. Audit logging and background processes

### Audit logging

`activity_log` stores user/action/module/entity/timestamp and before/after metadata for many mutations. Current development data contains 4,397 activity rows, including 1,717 permission-denied events. This confirms the audit writer is actively used.

`lib/audit.ts` catches insert failures and logs them rather than failing the business transaction.

**Finding — HIGH audit integrity risk, confirmed:** an audit insert/database failure can be lost without durable retry/outbox/completeness monitoring.

### Background processes

| Process | Trigger/frequency | Code | Side effects |
|---|---|---|---|
| Salary accrual | Immediate catch-up plus hourly interval | `lib/salaryAccrual.ts:806-821` | Writes daily accrual rows and true-ups open payroll periods |
| Rent accrual | Immediate catch-up plus hourly interval | `lib/rentAccrual.ts:488-505` | Writes rent period/daily accrual rows |
| Automatic backup | Starts after migrations; due-sweep interval | `lib/backup/scheduler.ts`, `index.ts:4987-4993` | Creates object-storage archive, updates backup metadata, prunes automatic backups |
| Startup migrations/repairs | Every API boot, guarded by migration/boot state | `index.ts` | DDL, backfills, cleanup, repairs, date-column census |
| APK publishing | Explicit release workflow, not recurring scheduler | `scripts/release-android-apk.ts`, `lib/apkRelease.ts` | Validates/publishes artifact and atomically updates manifest |

No external queue, cron service, or job worker was found in the workspace. Schedulers run inside the API process, so multiple API instances would require careful single-run coordination.

**Finding — MEDIUM scaling/operability risk, possible:** salary/rent schedulers use employee/day or agreement/day loops and per-day queries/upserts. No runtime timing, overlap metric, or distributed scheduler lock was verified.

## 21. Edit, cancel, delete behavior

| Transaction | Edit | Cancel/delete | Historical implication |
|---|---|---|---|
| Sale | Reverses/reapplies stock deltas and preserves identities | Soft cancel, restores stock and accounting effects | Source retained; audit action currently says DELETE |
| Purchase | Reverses/reapplies stock and rechecks settlement | Physical delete with reversal movements | Source can disappear while reversal history remains |
| Quotation | Edit until converted | Physical delete before conversion | Offer history can disappear |
| Sale return | PATCH delta replacement | No DELETE route | Erroneous return cannot be voided to zero |
| Purchase return | PATCH delta replacement | No DELETE route | Erroneous debit note remains unless corrected |
| Payment/receipt voucher | In-place update with allocation guards | Administrator-only physical delete with special unwind | Source/audit dependence |
| Stock transfer | Forward-only status transitions | Reject restores source | Active in-transit is preserved for short receipt |
| Attendance | Upsert/correction under locks | Re-accrues afterward | Freshness can lag after async failure |
| Payroll | Approval/pay status gates | Locked/approved states restrict mutation | Reversals/corrections are period-sensitive |

**Finding — HIGH governance gap, confirmed:** neither sales returns nor purchase returns has a DELETE/void route. PATCH requires positive non-empty lines, so a wrongly created note cannot be reversed to zero through the normal API.

## 22. Read-only reconciliation results

Database: `heliumdb`, PostgreSQL 16.10.

| Check | Result | Classification |
|---|---:|---|
| Unbalanced journal vouchers | 0 | Clean in current dev data |
| Orphan journal-voucher lines | 0 | Clean |
| Orphan stock-ledger material references | 0 | Clean |
| Sales without location stamp | 0 of 509 | Clean |
| Purchases without location stamp | 0 of 58 | Clean |
| Negative stock entries | 0 | Clean |
| Negative stock batches | 0 | Clean |
| Stale active reservations | 0 | Clean |
| Active transfer reservations | 2 | Expected; both transfers are `in_transit` |
| Batch vs stock quantity | 41,952.500 vs 41,952.500 | Reconciled for item stock |
| Unstamped journal vouchers | 9 of 197 | Confirmed legacy/test-era data-quality condition |
| Migration rows | 69 | Runtime migration history present |
| Latest boot status | migrations OK; all 16 date columns correct | Healthy development boot |

The nine unstamped vouchers are payroll/system rows. Seven are associated with recent `zz...` integration probes in the development database, and two older payroll rows predate this audit. They should not be extrapolated to production without a clean production query.

Repeated-looking stock-ledger signatures were investigated. The largest groups correspond to the same sale document with explicit `sale_reversal` and `sale` “re-applied after edit” notes and different timestamps. They are therefore expected edit history, not confirmed silent duplicate inserts.

## 23. Performance findings

| Finding | Severity | Status | Evidence / impact |
|---|---:|---|---|
| Monthly statements rebuild books sequentially per bucket | MEDIUM | Confirmed design risk | `routes/accounts.ts:3775-3841`; many months can trigger repeated full posting derivation |
| Salary accrual loops employees and dates with per-day writes | MEDIUM | Possible scaling risk | `lib/salaryAccrual.ts:261-322,388-425,475-595` |
| Rent accrual loops agreements/days and checks month totals | MEDIUM | Possible scaling risk | `lib/rentAccrual.ts:192-203,244-295` |
| Payroll ledger resolution walks account tree repeatedly | LOW/MEDIUM | Possible | `routes/hr.ts:94-120` |
| Report/API client may repeat derived posting work | MEDIUM | Possible | Helper comments warn not to call single-value wrappers in loops |
| `/api/healthz` does not perform a live DB query | MEDIUM | Confirmed design gap | `routes/health.ts:8-16`; it only checks `migrationsReady`. `/api/healthz/schema` does query date metadata. |

No EXPLAIN plans or production timing data were collected; these are source-based risks, not measured production incidents.

## 24. Security findings

| Finding | Severity | Status |
|---|---:|---|
| Customer/vendor detail GET lacks LBAC party scope | HIGH | Confirmed source |
| Audit failure is swallowed | HIGH | Confirmed source |
| Shared bootstrap/reset password literals exist in migration source | HIGH | Confirmed source; migration later hashes/forces change, but shared secret exposure remains a risk |
| Logout does not revoke tokens server-side | MEDIUM | Confirmed source behavior |
| Generic PDF/report data is client supplied | MEDIUM | Confirmed source behavior |
| Public invoice links are intentionally unauthenticated | INFO | By design; constrained by signed token/expiry |
| Hierarchy metadata endpoint is intentionally available to authenticated employees | MEDIUM | Confirmed source; role-name/level disclosure |
| Presigned upload cannot bind actual content type | LOW/MEDIUM | Confirmed limitation; download serving applies mitigations |

No exploit was attempted. These are code-review and runtime-observation findings only.

## 25. Data-integrity and schema findings

1. **Raw migration schema is ahead of Drizzle schema — MEDIUM, confirmed.** Several operational columns are created/used by raw migration/runtime code but absent from generated Drizzle definitions. This is intentional in places, but future Drizzle queries can silently omit or under-type those columns.
2. **Attendance uniqueness migration can continue after index failure — HIGH, possible.** The migration logs index-creation failure and continues. If the unique index is absent, correction conflict handling is weaker.
3. **Physical delete leaves audit/reversal dependence — HIGH, confirmed.**
4. **Historical stock is reliability-flagged but still consumable by reports — HIGH, confirmed.** Consumers must propagate the reliability signal.
5. **Party detail lookup lacks scope — HIGH, confirmed.**
6. **Unstamped legacy payroll vouchers exist — MEDIUM, confirmed data condition.**
7. **No current negative stock/batch or batch/entry quantity mismatch was found — positive evidence.**

## 26. Possible double-counting areas

No confirmed normal-path double count was found in:

- stock transfer on-hand plus in-transit ownership;
- production capitalization overlay;
- stock reservations;
- sale/purchase return stock plus accounting notes;
- current batch quantity vs item stock quantity.

Areas requiring continued guardrails:

- Payment-history rows must not be summed as a second posting stream.
- Transfer closing value and transfer opening adjustment must not both be applied.
- GST document summaries and posting-based GST reports must not be merged without a source policy.
- Generic exports must not be treated as independently recomputed statements.
- Repeated edit reversal/reapplication rows must be netted by source-document semantics, not counted as independent business events.

## 27. Possible missing-entry areas

The following are not confirmed missing entries in current data, but are code/process risks:

- audit event lost when `writeAudit()` insert fails;
- salary accrual stale after bulk attendance correction if asynchronous re-accrual fails;
- rent incomplete at approval because approval has no true-up;
- legacy/untracked stock without lot-level movement;
- manual GST journal not represented in `/gst/summary`;
- generic PDF/XLSX payload not refreshed from source;
- return cannot be voided through a dedicated reversal route;
- historical transfer in-transit state not available at an old as-of date;
- branch Reports Center endpoints intentionally return empty results.

## 28. Historical-data risks

Highest-risk historical processes:

1. Historical closing stock relies on today’s stock plus ledger rewind.
2. Historical cost is current weighted average rather than a replayed historical cost layer.
3. Deleted masters/documents can make historical movement reconciliation impossible.
4. Purchase deletion floors reversals and may not restore consumed stock mathematically.
5. Old charge JSON and legacy untracked batches are grandfathered rather than normalized.
6. Transfer receipt date/state is not sufficient for historical in-transit snapshots.
7. Raw migration columns are not visible to all generated ORM paths.
8. Unstamped legacy payroll vouchers remain outside location-stamped reporting semantics.

## 29. Live vs source-code differences

### Confirmed coherent

- API workflow rebuilt and restarted from current source.
- Running bundle contains the current transfer-opening-adjustment implementation.
- `/api/healthz` reports ready.
- `/api/healthz/schema` reports all 16 date columns correct.
- Latest `boot_status` row has `migrations_ok = true`.
- Current development source and running API route tree are aligned for inspected paths.

### Not proven

- Published production commit equals workspace source.
- Production database schema equals development schema.
- Production backup freshness and restore verifiability.
- Production scheduler execution and single-run coordination.
- Current APK object/manifest availability.
- Production audit-log completeness.
- Production reconciliation status.

## 30. Final conclusions

### A. Working correctly

- Shared derived-posting architecture.
- Balanced current journal vouchers.
- Location stamping on current sales and purchases.
- Stock quantity/batch reconciliation in current development data.
- FEFO batch consumption and explicit batch breakdown paths.
- Sale concurrency row locks and reservation-aware availability.
- Transfer dispatch/receipt/rejection and short-receipt semantics.
- Transfer P&L neutrality and opening-stock correction.
- Payroll bulk attendance atomic write transaction.
- Month locks and many effective-value write guards.
- Server-side invoice rendering and location-aware access checks on inspected paths.
- API health/date schema readiness.

### B. Not working or materially incomplete

- Customer/vendor detail GET does not enforce party location scope.
- No dedicated void/delete reversal for purchase and sales returns.
- `/gst/summary` and posting-based GST reporting can diverge.
- `/healthz` does not test database connectivity.
- Audit insert failure does not fail or durably queue the business mutation.
- Historical in-transit position cannot be reconstructed.

### C. Risky

- Physical deletion of source documents.
- Historical stock valuation from current state plus movement rewind.
- Shared bootstrap/reset passwords in source/migration logic.
- Client-payload-driven generic exports.
- In-process hourly schedulers without measured overlap/lock behavior.
- Raw migration schema drift from ORM definitions.

### D. Needs investigation

- Production source/database/deployment parity.
- Production backup metadata, archive freshness, and restore rehearsal.
- Production reconciliation batches and exception history.
- Clean production count of unstamped journal vouchers.
- Whether branch users are intentionally denied Reports Center.
- Whether any caller uses `currentPartyStatement()` with non-empty date windows.
- Historical transfer crossing a month boundary while still in transit.
- Attendance uniqueness index status in production.

### E. Fix first

1. Add `partyScopeCheck` to customer/vendor detail GETs.
2. Add a first-class immutable return void/reversal flow.
3. Make audit delivery durable or fail the mutation when audit is mandatory.
4. Unify GST summary/report calculations or clearly label their source boundaries.
5. Replace or tightly restrict physical deletes for accounting/inventory source documents.
6. Make generic exports server-recomputed or explicitly label them as client snapshots.
7. Add historical-stock reliability gates to financial report consumers.

### F. Top 10 most important issues

1. Party-detail IDOR/location privacy gap — **HIGH, confirmed**.
2. Historical stock/in-transit valuation limitations — **HIGH, confirmed**.
3. Best-effort audit logging — **HIGH, confirmed**.
4. Physical purchase/voucher/source deletion — **HIGH, confirmed**.
5. GST source-stream divergence — **HIGH, confirmed**.
6. Shared bootstrap/reset password material — **HIGH, confirmed source risk**.
7. No return void/reversal — **HIGH governance gap, confirmed**.
8. Generic client-payload-driven exports — **MEDIUM, confirmed**.
9. Async payroll re-accrual after bulk correction — **MEDIUM, confirmed**.
10. Startup repair/migration and in-process scheduler operational complexity — **MEDIUM/HIGH, confirmed design risk**.

### G. Text flow diagrams

#### Sale

```text
User → Sales/POS UI → POST /api/sales
→ validation + location/month-lock checks
→ stock row lock + availability
→ FEFO lot consumption
→ sales row + payments
→ stock_entries + stock_batches + stock_ledger
→ derived sales/GST/customer postings
→ P&L/BS/dashboard/customer statement/invoice PDF
```

#### Purchase

```text
User → Purchase UI → POST /api/purchases
→ vendor/date/location/GST/charge validation
→ transaction
→ purchase row
→ stock entries/batches/ledger
→ purchase/input-GST/vendor postings
→ vendor statement/reports/PDF
```

#### Transfer

```text
Source user → Transfer Out
→ source lock → FEFO consume → source stock decrement
→ transfer_out ledger → active in_transit reservation
→ destination user → Transfer In
→ reservation release → destination stock/batches increment
→ transfer_in ledger → completed
→ periodic opening adjustment, not duplicate closing adjustment
```

#### Accounting

```text
Source documents/JVs/payments/payroll/rent
→ buildDerivedPostings()
→ location-filtered posting stream
→ buildBooks()
→ opening balances + period activity + closing valuation
→ P&L + Balance Sheet + Trial Balance + ledgers + dashboards/reports
```

#### Authentication and location

```text
Login → bcrypt/lockout → signed Bearer token
→ employee active check → page/action permission
→ server-derived branch scope
→ optional read narrowing
→ route-specific LBAC → transaction
```

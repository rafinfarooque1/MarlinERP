# Marlin Frozen Fruits ERP — Complete Technical Documentation

**Document status:** repository-derived technical documentation
**Inspection basis:** current checked-out source tree and tracked configuration, inspected 18 September 2026
**Scope:** documentation only. No production database was queried, no business data was changed, no application behavior was changed, and no schema or accounting logic was modified while creating this file.

## Reading this document

The labels below are used throughout:

- **IMPLEMENTED** — behavior is present in the current source and is described from that source.
- **PARTIALLY IMPLEMENTED** — the feature exists, but has legacy paths, known scope limitations, or multiple implementations.
- **NOT IMPLEMENTED** — the requested behavior was not found in the inspected source.
- **TEST GAP** — source exists, but the repository does not establish that the behavior is covered or currently passing.
- **UNKNOWN** — **NOT DETERMINED FROM CURRENT CODE**. This is used instead of inferring behavior from names, comments, or intended design.

Source paths are relative to the repository root. The Drizzle schema is not the complete live schema: a substantial portion of the operational schema is created or altered by raw startup migrations in `artifacts/api-server/src/index.ts` and `artifacts/api-server/src/migrations/`.

---

## 1. System overview

### Product and architecture

**IMPLEMENTED.** The product is the Marlin Frozen Fruits ERP. It covers frozen-fruit production, inventory, purchases, sales/POS, quotations, customers and vendors, double-entry accounting, GST, HR/payroll, fixed assets, expenses, transfers, reconciliation, reports, backups, and a React Native employee application.

The repository is a pnpm workspace:

```text
Browser / mobile client
        |
        | JSON/CSV/PDF/XLSX HTTP API
        v
artifacts/api-server  (Express 5, TypeScript, raw pg + shared Drizzle DB package)
        |
        v
PostgreSQL

Shared packages:
  lib/db
  lib/api-spec
  lib/api-zod
  lib/api-client-react
  lib/pdf-kit
  lib/purchase-pricing
```

The browser application is a React + Vite app at `artifacts/marlin-erp`. The API is an Express 5 app at `artifacts/api-server`. The database is PostgreSQL, accessed with `pg` and selected Drizzle ORM helpers, but many business queries use parameterized raw SQL. `lib/api-spec` and `lib/api-zod` define the generated API contract; `lib/api-client-react` contains Orval/react-query hooks plus hand-written hooks.

The employee app at `artifacts/employee-app` is an Expo Router / React Native app. `artifacts/mockup-sandbox` is a separate component-preview artifact, not an ERP runtime.

### Authentication and authorization

**IMPLEMENTED.** API authentication is bearer-token based. `artifacts/api-server/src/app.ts` applies an API-wide authentication gate with explicit exceptions for health checks, login, public HMAC-tokenized documents, and narrowly scoped public share endpoints. Login is implemented in `artifacts/api-server/src/routes/auth.ts`; password hashing is in `src/lib/password.ts`; token creation and verification are in `src/lib/token.ts`.

Current source also contains:

- bcrypt-compatible password hashes and first-login password-change state;
- signed versioned session tokens with an eight-hour expiry policy;
- login lockout and attempt tracking;
- request rate limits;
- module/action permission middleware;
- location/data-scope authorization;
- public invoice and quotation links with separate signed, time-limited tokens.

The older note in `replit.md` saying that server authorization is auth-only is stale relative to the current route guards. The current routes use `requireModuleView`, `requireModuleAction`, `adminGate`, period locks, and location scope helpers.

### Location model

**IMPLEMENTED, WITH LEGACY OUTLET SUPPORT.** The current business model is Head Office plus warehouses. Outlet tables, outlet IDs, and compatibility code remain in the repository because older sales and stock records still use them. A migration named `outletToWarehouse` and the warehouse lifecycle code show that outlets are being phased out, not that every outlet table has been removed.

### Development and production

**IMPLEMENTED.** Development uses the configured Replit workflows and `PORT`. Production behavior is built from the API esbuild bundle and uses the same API source with production environment configuration. Development and production databases are separate environments, but this documentation task did not connect to either database.

The exact published production URL and deployment geography are **NOT DETERMINED FROM CURRENT CODE**. They are platform deployment metadata, not repository behavior.

---

## 2. Complete project structure

| Path | Responsibility |
|---|---|
| `artifacts/api-server/src/app.ts` | Express setup, CORS, body parsing, global API authentication boundary, error handling. |
| `artifacts/api-server/src/index.ts` | Server startup, raw schema migrations, repair/backfill steps, scheduled accrual and backup jobs, default system setup. |
| `artifacts/api-server/src/routes/index.ts` | Mounts API route modules. |
| `artifacts/api-server/src/routes/*.ts` | Business endpoints grouped by module. |
| `artifacts/api-server/src/lib/` | Accounting, valuation, scoping, locks, numbering, GST, audit, backup, storage, payroll, and shared business helpers. |
| `artifacts/api-server/src/migrations/` | Additive/repair migrations run at API boot. |
| `artifacts/api-server/src/services/` | PDF and document renderers and other service-level output logic. |
| `artifacts/api-server/tests/` | API/integration-style test suites, mostly `.mjs` with some TypeScript tests. |
| `artifacts/marlin-erp/src/App.tsx` | Browser route tree, auth guard, page permission guard, global providers. |
| `artifacts/marlin-erp/src/pages/` | ERP screens grouped by business area. |
| `artifacts/marlin-erp/src/components/app/` | Shared page shell and modernized page primitives. |
| `artifacts/marlin-erp/src/lib/` | Frontend fetch/download helpers, state, formatting, sorting, dialogs, and shared calculations. |
| `artifacts/marlin-erp/docs/UI_CONVENTIONS.md` | Binding current page and interaction conventions for the web UI. |
| `artifacts/employee-app/app/` | Expo Router screens for employee and mobile operational flows. |
| `lib/db/src/schema/` | Drizzle model subset and insert/select types. |
| `lib/db/drizzle/` | Drizzle-generated SQL snapshots. These are not the complete live-schema contract. |
| `lib/api-spec/` | OpenAPI source and Orval configuration. |
| `lib/api-zod/` | Shared request/response Zod definitions. |
| `lib/api-client-react/` | Generated and custom React Query API hooks. |
| `lib/pdf-kit/` | Shared PDF helpers and embedded font support. |
| `lib/purchase-pricing/` | Shared purchase pricing calculations. |
| `scripts/src/check-permissions.ts` | Permission-key/page matrix audit and optional writer. |
| `scripts/src/audit-route-guards.ts` | Static route guard audit. |

The API build is `artifacts/api-server/build.mjs`, which produces `dist/index.mjs`. The configured API workflow runs the package `dev` script, which builds before starting the bundle. The web workflow runs the Vite development server. The employee workflow starts Expo.

---

## 3. User and authentication system

### Login, logout, and sessions

**IMPLEMENTED.** `POST /api/auth/login` validates credentials, records login history/attempt state, and returns a bearer token. Browser and mobile clients store/use the token through their respective fetch layers. A 401 is treated by the clients as a dead session; the clients clear auth state rather than silently continuing with stale credentials.

Logout is client-side token/session clearing. A server-side token revocation list was not found; therefore server invalidation before token expiry is **NOT DETERMINED FROM CURRENT CODE**.

`x-refreshed-token` is exposed by CORS so the API can transparently return an upgraded token format to an authenticated client.

### Passwords

**IMPLEMENTED.** Passwords are stored as bcrypt-compatible hashes by `src/lib/password.ts`. Legacy plaintext rows are migrated at boot to a bcrypt hash and marked for password change. The login and change-password routes enforce the current password policy. The source contains a default-admin provisioning path, but this document intentionally does not reproduce any default credential or secret.

### Users, employees, and roles

**IMPLEMENTED.** The employee row is the login identity. It carries username, password hash, active/employment state, hierarchy link, branch/location information, and optional work data. The role tree is represented by `hierarchies`; the current restructure establishes a single Administrator root and a view-oriented Management level. Employees may be linked to a location or Head Office.

### Permission enforcement

**IMPLEMENTED.** The permission system is page-keyed, primarily as `page:<href>`, with five actions represented by the permission model and legacy print/approve/share columns treated as write mirrors rather than authoritative read permissions. The browser uses `RoutePermissionGuard`; the API uses `requireModuleView` and `requireModuleAction`. `scripts/src/check-permissions.ts` checks the page matrix and `scripts/src/audit-route-guards.ts` statically audits privileged writes.

Page authorization precedes location authorization. Having access to a page does not grant access to every location.

### Location authorization

**IMPLEMENTED.** `src/lib/dataScope.ts`, `requestLocation.ts`, `moneyScope.ts`, and `postingLocation.ts` derive the effective user scope and validate request locations. The display location selected in the UI is not trusted as authority. The backend derives or checks the effective location from the user, record, ledger, or document.

Head Office can access broader data where the route permits it. Warehouse users are restricted to their permitted warehouse scope. Exact access for every hierarchy/location combination is defined by seeded permission rows and route-specific rules; when a route does not define broader access, the concrete combination is **NOT DETERMINED FROM CURRENT CODE**.

---

## 4. Location and branch architecture

### Location records

**IMPLEMENTED.** `warehouses` and legacy `outlets` are the physical/legal location records. Warehouses carry operational and invoice identity fields, including GST/billing-profile fields, address data, bank details, invoice footer, signatory, and logo fields where configured. Sales and several operational tables use a polymorphic `location_type` + `location_id` pair.

The current model supports:

- `headoffice` as a logical company location;
- `warehouse` as the active physical operating location;
- legacy `outlet` records and compatibility paths.

The placeholder ID used for Head Office is not globally uniform. Some voucher/location tables use `0`, while sales/stock compatibility paths use another placeholder. Code matches Head Office by location type in the affected paths; callers must not infer it from an ID alone.

### User/location relationship

**IMPLEMENTED.** Employee fields and location assignment are combined with the scope helpers. Shared cash/bank accounts have a separate `cash_bank_account_locations` membership layer. Customers, vendors, sales, purchases, stock, transfers, money vouchers, expenses, and reports each have route-specific location handling.

### UI behavior

**IMPLEMENTED.** The unified sidebar is shared across users. Sales pages use an explicit location context/picker. In a fresh session, `/sales/*` may render no content until a location is selected at `/sales`; this is an intentional location-context gate, not a server crash. The dashboard and reports expose all-location or scoped views according to the logged-in scope.

### Inconsistencies and compatibility

**PARTIALLY IMPLEMENTED.**

- `outlets` still exist in the schema and route/UI inventory even as warehouses are the active model.
- `sale_payments.outlet_id` is nullable and legacy; warehouse sales do not populate it.
- Some tables use direct `outlet_id` or `warehouse_id`, while newer tables use `location_type` and `location_id`.
- Head Office identity differs by table, so generic `id = 0` assumptions are unsafe.
- Materials and some stock paths historically lacked a location dimension; material-location migrations add coverage but the old model remains visible.

---

## 5. Database

### Schema boundary

**IMPORTANT.** `lib/db/src/schema/` is a partial Drizzle view. Startup SQL in `artifacts/api-server/src/index.ts` creates or alters many tables/columns not represented by the generated Drizzle types. Raw-migration columns can be invisible to `db.select()` and must be read with raw SQL. `drizzle-kit push` is not a safe complete-schema operation for this repository; the live logical schema is maintained by boot migrations.

### Core master and organization tables

| Table | Important columns / purpose | Relationships and location/accounting role |
|---|---|---|
| `employees` | Login identity, username, password hash, hierarchy, `branch_type`, `branch_id`, active/employment state, LWD, password-change state. | Links users to `hierarchies` and operational location scope. |
| `hierarchies` | Role name, hierarchy level, description. | Parent/role authorization source; single-root restructuring is enforced by migration helpers. |
| `permissions` | Page key, hierarchy/user permission actions, update metadata. | Controls page/module access; keyed by page href. |
| `warehouses` | Name, status/lifecycle, GST/billing profile, invoice identity, ledger links. | Active physical location and seller identity. |
| `outlets` | Legacy branch/outlet identity and ledger links. | Compatibility source for older records. |
| `company_settings` | Company/GST/timezone/settings including production overhead percent. | Global configuration; does not replace location identity. |
| `activity_log` | Actor, event, entity, timestamps, location/context, details. | Audit trail. |
| `login_attempts`, `login_lockouts` | Login attempt and lockout state. | Security audit; lockout key is normalized username. |

Primary keys are serial/integer IDs unless noted. Exact foreign-key coverage is mixed because some legacy relationships are soft links; do not infer an FK merely from a column name.

### Parties and commerce

| Table | Purpose and important columns | Relationships |
|---|---|---|
| `customers` | Customer master, GST number, contact fields, optional `location_type`/`location_id`. | Sales, customer control ledger, receipts, allocations, returns. |
| `vendors` | Vendor master, GST number, contact fields, optional location scope. | Purchases, vendor control ledger, payments, advances, returns. |
| `items` | Sellable product master, MRP/rate, cost/avg-cost compatibility fields, stock flags. | `sales`/`sale_lines`, stock, prices, batches, reservations. |
| `materials` | Production/raw material master, HSN, tax, cost/avg cost, stock. | Production and material stock. |
| `raw_materials` | Separate raw-material master with similar costing/tax fields. | Production and polymorphic stock. |
| `item_prices` | Date/location-aware item rate history and validity range. | Used by sales/price history; raw date columns are boot-added. |
| `coupons` | Customer coupon/discount master and usage state. | Sale discount flow. |
| `sales` | Invoice header, invoice number, date, customer, polymorphic location, tax/discount/charges, payment state, cancellation, salesperson. | Sale lines, payments/receipts, stock, journals, dispatch. |
| sale line storage | Line item data, quantity, unit price, tax and discount snapshots. | Stored with/alongside the sale in current routes; exact table name is handled by the current migration/schema set. |
| `sale_payments` | Historical/electronic collection rows: sale, date, method, amount, reference, reconciliation state, optional outlet. | Settlement/reconciliation workflow; not automatically a second customer receipt. |
| `sales_returns` | Invoice-anchored return/note records and lines. | Reverses stock and sale accounting. |
| `payment_bill_allocations` | Receipt/payment-to-bill settlement metadata. | Does not create an extra financial posting. |
| `payments`, `receipts` | Money voucher headers with from/to ledger IDs, amount, date, narration. | Account postings and customer/vendor settlement. |
| `purchase_advance_applications`, `advance_consumptions` | Advance settlement metadata. | Vendor/customer advance settlement proof. |

### Purchases, production, and inventory

| Table | Purpose and important columns | Relationships |
|---|---|---|
| `purchases` | Purchase bill header, vendor, date, location, tax, discount, round-off, total, invoice metadata. | Purchase lines, stock, GST input, vendor payable. |
| purchase line storage | Product/material, quantity, rate, batch, tax and taxable-value snapshots. | Stock entries and purchase reversal/costing. |
| `purchase_returns` | Purchase return header/lines. | Reverses stock, input GST, and vendor payable. |
| `productions` | Production batch, output, location, material/overhead/total cost, cost per unit, wastage JSON. | BOM, material stock, finished item stock. |
| `bom_templates` | Per-unit material recipe. | Production planning and comparison reports. |
| `stock_entries` | Authoritative quantity movements, product kind/key, quantity, location, source metadata. | Quantity truth for items/materials/raw materials. |
| `stock_ledger` | Append-only business-date audit movements and running-balance source. | Stock movement audit; does not replace source-document derivation. |
| `stock_batches` | Lot/batch, expiry, quantity/cost metadata. | Additive FEFO/expiry layer over stock entries. |
| `stock_cost_snapshots` | Historical cost checkpoints by product/location/date. | Historical valuation and location cost stability. |
| `stock_transfers` | Transfer document, source/destination, status, GST classification, approval/rejection/received data. | Transfer items, reservations, stock, journals. |
| transfer item storage | Product, quantity, batch, movement cost and received quantity. | Source/destination/in-transit stock. |
| `stock_reservations` | Product/document reservation kind (`hold` or `in_transit`), quantity. | Available-stock calculation for sales, production, transfers. |
| `stock_verifications` | Physical verification records. | Stock verification UI/reporting. |
| `storage_locations` | Hierarchical freezer/rack/shelf locations. | Placement metadata only. |
| `storage_placements` | Product/batch placement quantities. | Derived unplaced quantity; does not replace stock quantity. |

### Accounting and money

| Table | Purpose and important columns | Relationships |
|---|---|---|
| `account_ledgers` | Ledger name/type/code/section, group/parent, system-group flag, bank details. | Chart of Accounts and every journal line. |
| `journal_vouchers` | Voucher number/type/date/narration, origin, location, audit metadata. | Has many `journal_voucher_lines`. |
| `journal_voucher_lines` | Ledger ID, debit/credit, amount, location/provenance. | Double-entry postings. |
| `cash_bank_accounts` | Cash/bank account master and linked ledger. | Availability is controlled by location junction membership. |
| `cash_bank_account_locations` | Account-to-location membership. | Shared accounts can be usable at multiple locations. |
| `cash_deposits` | Cash-to-bank deposit workflow and linked transit/payment/receipt IDs. | Collection and bank movement. |
| `reconciliation_batches`, `reconciliation_batch_items` | Electronic collection settlement batch and sale-payment membership. | Creates settlement accounting in the electronic-collection flow. |
| `bank_reconciliation_entries` | Generic bank-book review state by ledger and derived entry ID. | Metadata-only reconciliation state. |
| `bank_reconciliation_batches`, `_items` | Account-based review batches and selected entries. | Does not alter source books. |
| `bank_reconciliation_reset_audits` | Immutable reset snapshot/reason/count. | Preserves evidence when review state is reset. |
| `opening_balances` | Opening balance data/adjustment records. | Opening/period reporting; exact migration history varies. |
| `accounting_period_locks`, `period_lock_events` | Locked business-date/month state and audit events. | Write-path guards. |
| `voucher_sequences`, `sales_number_formats`, `invoice_renumber_log` | Number allocation, format override, renumber trail. | Invoice/voucher identity. |

### Assets, HR, expenses, backup/import

| Table | Purpose |
|---|---|
| `asset_categories`, `assets`, `asset_purchases`, `asset_transfers`, `asset_disposals`, `asset_depreciation_runs` | Fixed-asset register, acquisition, location transfer, disposal, and depreciation evidence. |
| `attendance`, `attendance_punches`, `leaves` | Attendance days/sessions, punches, leave workflow and approval state. |
| `pay_components`, `payroll`, `employee_advances` | Salary components, payroll runs, advances and recovery. |
| `salary_accral_config`, `salary_accruals` | Derived salary accrual schedule and run history. |
| `expenses` | Expense entry, ledger/category, amount, location, payment mode. |
| `warehouse_rent_agreements`, `rent_periods`, `rent_accruals`, `rent_payments` | Warehouse rent accrual and payment tracking. |
| `quotations`, quotation item storage, `quotation_payment_terms`, `quotation_share_links` | Quotation document store, terms, public links. |
| `invoice_share_links` | Public invoice-link identity, expiry and access state. |
| `dispatch` status storage (`sale_dispatch_status`) | Additive sale dispatch state; no books change. |
| `import_batches`, `import_rows`, `import_mappings`, `import_migrations` | Mapping-first data import and rollback/audit state. |
| `migration_log`, `boot_status`, `location_migration_map` | Boot migration idempotency/observability and location migration support. |

Exact foreign keys and indexes are defined partly in `lib/db/src/schema` and partly in raw migrations. Important indexes include sale-payment lookup/status indexes, bank reconciliation status/entry indexes, batch item uniqueness, and unique ledger/entry reconciliation identity.

---

## 6. Accounting engine

### Chart of Accounts

**IMPLEMENTED.** `account_ledgers` forms a parent/child chart. Boot setup creates system groups for capital, liabilities, assets, opening/closing stock, purchase, direct/indirect expense, sales, and direct/indirect income. Standard ledgers include Sales, Purchases, Bank, Cash, Duty & Tax, Sundry Debtors, and Sundry Creditors. System group codes and protected ledger identity are server-controlled.

Group containers can be postable in some cases, especially Cash/Bank compatibility heads. A parent balance is not automatically the arithmetic sum of every child for every report; statements use the ledger presentation rules in `lib/books.ts`, `ledgerBalances.ts`, and financial reports.

### Journal vouchers and postings

**IMPLEMENTED.** A journal voucher has balanced debit and credit lines. `lib/journalCreate.ts` creates validated vouchers. Operational routes either create source-specific vouchers or are represented by `buildDerivedPostings` in `routes/journal.ts`. The derived-posting path reads source transactions and emits the accounting view used by core reports.

`buildDerivedPostings` is the central accounting derivation used by trial balance, ledger/report services, dashboard financials, period summaries, and several reconciliation checks. There are also source-specific/legacy report paths; those differences are documented in Sections 21–23.

### Operational transaction flow

| Source transaction | Accounting posting / ledger effect | Report effect |
|---|---|---|
| Sale invoice | Revenue, output GST, customer control or received-money legs, and stock/COGS effects are derived from the sale and its lines. Customer invoices use the gross customer-control model. | Sales, GST output, customer ageing, stock/COGS, P&L, dashboard. |
| Sale collection | One receipt credits the customer control for the full money received and debits the effective cash/bank ledger. Bill allocations identify settlement only. | Customer ledger, cash/bank books, receipts, reconciliation. |
| Sale return/credit note | Reverses the invoice-linked sale/tax/stock effects according to return lines. | Returns, GST reconciliation, customer outstanding, stock. |
| Purchase bill | Debits taxable goods/cost and input GST as applicable and credits vendor payable. Stock is valued from taxable value, not tax-inclusive value. | Purchase register, vendor ageing, stock, input GST, P&L/BS. |
| Purchase return | Reverses the purchase-side stock, GST, and vendor payable effects. | Purchase returns, vendor balance, GST. |
| Payment voucher | Debits the payable/expense/target ledger and credits the effective cash/bank ledger. | Payment register, vendor ledger, cash/bank books. |
| Receipt voucher | Debits effective cash/bank and credits customer/other source ledger. | Receipt register, customer ledger, cash/bank books. |
| Journal voucher | User-selected balanced debit/credit lines, with validated location for manual vouchers. | Day Book, GL, Trial Balance, P&L/BS where account sections classify them. |
| Expense | Debits expense ledger and credits selected cash/bank or payable path. | Expense report, P&L, cash/bank. |
| Payroll accrual | Debits salary expense and credits salary payable/employee-related payable ledgers. | P&L, salary report, payroll ledger. |
| Payroll payment | Debits payable and credits effective cash/bank; employee legs are tracked separately where applicable. | Cash/bank, payroll, employee books. |
| Asset purchase | Capitalizes the asset acquisition to asset register/accounting path; GST is capitalized in the asset module and is not treated as an ITC posting by that path. | Fixed asset register, BS, asset reports. |
| Depreciation | Creates depreciation expense and accumulated depreciation effects, with run evidence. | P&L and BS asset carrying value. |
| Stock transfer | Moves stock/cost between locations or through in-transit state; transfer accounting/GST classification is separate from sales. | Stock, transfer report, GST transfer report; intended P&L neutrality. |

### Control accounts and advances

**IMPLEMENTED.** Customer balances are ledger-authoritative. The current customer model uses the customer ledger/gross invoice and payment legs rather than a competing document-only balance. Customer advances are folded into the customer control credit balance in the current model. Vendor advances retain a distinct vendor-advance path and are applied with proof in `purchase_advance_applications`/advance helpers.

Credit notes and returns are included in the owning module’s outstanding calculation. Reports should use the exported owning calculation rather than independently computing `total - paid`.

### Opening, closing, and periods

**PARTIALLY IMPLEMENTED.** Opening balance and opening-stock workflows exist, and dated opening adjustments are used for transfer neutrality and report presentation. Core statements derive balances over business-date ranges. Period locks are enforced on write paths through `lib/periodLock.ts`; absence of a lock row means the period is open.

There is no single stored daily closing snapshot that every report reads. The exact universal persistence of Closing(D) as a row is **NOT DETERMINED FROM CURRENT CODE**. The continuity rule is treated as a derivation/report invariant where the relevant source data is complete, not as a blanket assertion that every account has a stored next-day opening row.

---

## 7. Opening and closing balance logic

### General rule

The intended/derived relationship is:

```text
Opening(D) = balance carried into business date D
Closing(D) = Opening(D) + dated postings/movements for D
```

For a continuous, correctly dated account:

```text
Closing(D) = Opening(D + 1)
```

**PARTIALLY IMPLEMENTED.** The code derives balances from postings, document dates, stock movements, and opening adjustments. It does not universally materialize one closing row and one next-day opening row for every account/product/location.

### By balance type

- **Cash/bank:** derived from ledger postings and cash/bank book ranges. Reconciliation state is metadata and does not replace the accounting balance.
- **Customers:** derived from customer-control postings and the owning outstanding calculation. Receipt allocations settle bills but do not make multiple financial receipts.
- **Vendors:** derived from vendor-control postings, payments, advances, and returns.
- **GL accounts:** derived from journal lines and opening adjustments using statement-side sign rules.
- **Inventory quantity:** derived from `stock_entries` and source-document movement rules; batches, placements, reservations, and snapshots are additive.
- **Inventory value:** derived by the valuation service using dated/location-aware cost data and cost snapshots where available.

### Business dates, timezone, and backdating

**IMPLEMENTED.** Business dates are calendar dates, not UTC ISO conversions. Attendance day boundaries use the company timezone. Stock ledger `txn_date` represents the business date; `created_at` is insertion time and is not a substitute for the business date. Backdated document behavior is therefore dependent on the document route and its source records; it is not safe to reconstruct a historical stock statement solely from insertion timestamps.

### Period locks

**IMPLEMENTED.** Accounting-period locks are checked by shared helpers on write paths. Locked business dates return the route’s lock error (the code uses HTTP 423 for the locked-period contract). A locked month blocks applicable accounting/stock writes while allowing explicitly designed exceptions, such as allowed settlement of an open credit sale. Approval paths re-check under their transaction/row locks.

---

## 8. Inventory engine

### Quantity authority

**IMPLEMENTED.** `stock_entries` is the authoritative quantity movement layer. Item/material master stock columns exist for compatibility and display but are not the universal source of truth. The polymorphic product key requires the product kind (`item`, `material`, or `raw_material`) to be carried through every lookup; overlapping IDs across masters are expected.

`stock_ledger` is an append-only audit/movement view with a business date. Source documents remain necessary for lifecycle/item-tracking views.

### Costing and valuation

**IMPLEMENTED, WITH HISTORICAL LIMITATIONS.** Purchase stock is valued at taxable goods value after GST and discounts. Average cost updates use the costing helpers, with paise-exact input handling. Location cost checkpoints prevent a global product-cost change from revaluing unchanged branch stock. `lib/valuation.ts` supplies current/as-of valuation rows and summary data; `stock_cost_snapshots` supplies historical checkpoint data.

The stock valuation layers include:

- product/location quantity from stock movements;
- at-cost valuation for items, materials, raw materials, and in-transit stock;
- batch metadata for expiry/FEFO;
- reservation-adjusted available quantity;
- storage placement metadata;
- movement classification and ageing.

### Batches and FEFO

**PARTIALLY IMPLEMENTED.** Batches are additive over stock entries. Consumption uses FEFO ordering when batch data is present and clamps consumption to available tracked batch quantity. Any remaining untracked quantity is represented as `Untracked`; legacy stock is not magically assigned to a batch.

### Reservations

**IMPLEMENTED.** `stock_reservations` supports `hold` and `in_transit`. A hold reduces available stock. In-transit reservations do not reduce available stock again because the source movement has already deducted it. The reservation producer set is incomplete for `hold`; no producer was found for every possible hold scenario.

### Historical valuation

**PARTIALLY IMPLEMENTED.** The system uses dated document/movement information and cost snapshots rather than blindly reading a mutable current master cost. However, the historical stock record is not fully derivable for all old data because `stock_ledger.created_at` is insert time and older movements may lack reliable business dates or cost checkpoints. Historical results outside covered checkpoints are **NOT DETERMINED FROM CURRENT CODE** rather than guaranteed exact.

### Negative stock

**IMPLEMENTED IN KEY WRITE PATHS.** Deducting transactions lock the stock row inside the transaction and check availability. Purchase, sale, production, transfer, reservation, and edit/reversal paths have route-specific checks. Complete behavior for every legacy writer is a **TEST GAP**; route guard and concurrency audits are the authoritative static checks.

---

## 9. Stock transfers

**IMPLEMENTED.** Transfers are two-step documents. A transfer is created with source/destination and lines, dispatched into an in-transit state, then received by the destination. Creation/dispatch/receive/cancel/reject transitions are checked under row locks and are forward-only where the dispatch board/status layer applies.

The flow is:

```text
source available stock
  -> dispatch: source deduction + in-transit/reservation state
  -> receive: destination credit at precise movement cost
  -> complete
```

Current behavior includes:

- source and destination location validation;
- transfer reservations;
- batch/line quantity movement where batch data exists;
- precise receiving cost rather than recomputing from a mutable current master cost;
- rejection/cancellation state and reason;
- transfer-linked document cleanup protections;
- GST classification based on explicit GST identity/state resolution;
- transfer accounting intended to be P&L neutral.

Same-GST and different-GST transfers are classified separately. GST transfer postings exist in the transfer/GST helpers; the exact tax document treatment is route-specific and should be read from `lib/gstTransfer.ts` and the transfer route rather than inferred from sales logic.

Ghost transfer documents are guarded: a deleted transfer must not leave a branch-transfer invoice with a null twin link, because that can leak into lists/books and leave reservations. The source audit and tests cover this class.

---

## 10. Sales and POS

### POS flow

**IMPLEMENTED.**

```text
customer/location
  -> item and price selection
  -> per-unit rate and MRP floor validation
  -> line discount and bill discount
  -> validated other charges
  -> tax calculation
  -> total/rounding
  -> payment collection
  -> one receipt/ledger effect
  -> stock deduction and cost effect
  -> sale invoice, reports, customer ledger
```

Sales are created by `POST /api/sales` and edited by `PUT /api/sales/:id`; the main implementation is `artifacts/api-server/src/routes/sales.ts`, with shared pricing, GST, collection, numbering, and stock helpers.

### Pricing and totals

**IMPLEMENTED.**

- User-facing terminology is Rate, while internal `mrp`/`masterMrp` compatibility fields remain.
- The MRP/rate floor is enforced on create and edit for actual sales. Existing stored lines are grandfathered for edit checks.
- Quote pricing is a separate path and is not forced through the sale line builder.
- Sale other charges are included in the sale total and do not receive GST in the current implementation.
- The discount model includes per-unit item discount, pre-tax bill discount, and post-tax coupon behavior according to the sale discount helpers.
- Money input is normalized from decimal strings and values over two decimal places are rejected.

### Payments and receipts

**IMPLEMENTED, WITH TWO DISTINCT RECORDING LAYERS.** `sale_payments` can preserve sale-level payment history and is used by electronic-collection reconciliation. The shared receipt engine creates the actual accounting receipt in `receipts`/journal-derived postings. A sale payment row must not be treated as an additional customer ledger credit automatically.

The current rule is:

> One customer payment creates one financial receipt for the full amount received. Bill allocations are settlement metadata.

`payment_bill_allocations` records how that receipt is allocated across bills. It is used by POS/outstanding screens to settle invoices, but it does not post one credit per allocation. Split payments are represented by the collection input and/or multiple payment components while the accounting engine still records the actual money exactly once per receipt event.

The effective received-in ledger determines the payment mode from the sale location’s available cash/bank ledger set. Legacy mode labels remain readable.

Overpayment remains a customer-control credit rather than being silently discarded. Credit-controlled sales are the only sales subject to credit control; dues are total minus paid under the owning settlement calculation.

### Returns, cancellation, numbering, and location

**IMPLEMENTED.** Returns are invoice-anchored, not item-master-only. Cancellation is terminal; payment and return writers lock and refuse cancelled sales. Every invoice producer uses the allocator and stamps the four identity dimensions required by the numbering module: series/format, location identity, financial year, and allocated number. Renumbering is a one-time, trailed operation.

Sale PDFs render on the server in `src/services/invoicePdf.ts` and can be exposed through HMAC-tokenized 30-day links. Client-side invoice PDF generation is not the current design.

---

## 11. Quotations

**IMPLEMENTED.** Quotations are a parallel document store in `routes/quotations.ts`, with items, rates, discounts, tax, other charges, totals, notes, salesperson/terms, editing, and share links. They do not enter the books by construction.

Quotation PDFs and public links use the quotation-specific share/signing path. The PDF renderer is server-side. Conversion to a sale is guarded so one quotation can produce at most one sale; the quotation row is locked and partial unique constraints prevent duplicate conversion races. The converted sale receives normal sale numbering, stock, tax, payment, and accounting behavior.

Quotation MRP/rate behavior is intentionally separate from the sale MRP floor. A quote may be below the sale floor until it is converted and validated as a sale.

---

## 12. Customer management

**IMPLEMENTED.** Customer masters are in `customers`, with location scope and normalized GST number storage (`NULL`, not empty string, means blank). Customers participate in:

- sales and sale returns;
- customer control ledgers;
- one-receipt collection;
- bill allocations;
- advances/credit balances;
- outstanding and ageing;
- statements and ledger drill-down;
- customer-facing invoice links where authorized.

Customer outstanding is owned by the settlement/accounting logic and must include invoices, receipts, returns/credit notes, and customer credit balances. Ageing groups dated open items; exact bucket labels are report/UI configuration and are not duplicated here.

The list/detail casing boundary matters: list rows may be raw snake_case while detail responses are mapped camelCase. Edit forms must normalize the response shape before submitting or a cleared GST field can be written accidentally.

---

## 13. Vendor management

**IMPLEMENTED.** Vendor masters are in `vendors` and participate in purchases, purchase returns, payments, vendor advances, settlement/application rows, outstanding, ageing, and vendor ledger reports. Vendor GST numbers are normalized to `NULL` when blank, while stored historical typos are grandfathered by the validation policy.

Vendor payment settlement is ledger-authoritative. Vendor advances retain a distinct advance path and are applied with per-row proof; consumers fail closed when required advance links are missing. The vendor bill settlement path uses FIFO allocation where the source audit identifies a bill-level settlement, bounded by the vendor.

---

## 14. Purchases

### Lifecycle

**IMPLEMENTED.**

```text
purchase bill
  -> vendor/date/location validation
  -> taxable goods, discount, GST and charges calculation
  -> stock receipt and cost update
  -> input GST/vendor payable posting
  -> later vendor payment/advance application
  -> purchase register, stock, GST and ledger reports
```

`routes/purchases.ts` and `lib/purchase-pricing` implement creation and editing. Vendor invoice date is required on create. On PATCH, omitted means keep, explicit null means clear, and legacy nulls are not invented/backfilled.

### Cost and accounting

**IMPLEMENTED.** Stock uses taxable value net of GST and discount. The purchase bill’s vendor owed amount can include configured other charges even though goods-only figures remain goods-only. Purchase tax is represented in input GST ledgers where applicable; vendor payable is credited for the owed amount.

Purchase edits pair lines using product kind + ID + batch and touch only changed stock. Reversal/costing is checked under row locks. Once goods have moved, an edit that would require inventing stock through a floor-at-zero reversal is refused rather than silently creating quantity.

Purchase returns reverse the associated stock/GST/vendor effects. Asset purchases use the fixed-asset path when the row is an asset rather than ordinary resale inventory.

---

## 15. Cash and bank

**IMPLEMENTED.** Cash and bank accounts are represented by account master records and ledger links. Availability is not inferred from ledger ownership alone. `cash_bank_account_locations` is a membership junction so a shared Head Office/warehouse account can be explicitly usable at more than one location.

Receipts, payments, cash deposits, payroll payments, expenses, and sales collections select an effective cash/bank ledger through shared helpers. Every producer must validate location membership and stamp the effective location; a display-location selection cannot authorize an otherwise unavailable account.

Cash book and bank book are ledger-derived. The report routes provide:

- `/api/reports/fin/cash`;
- `/api/reports/fin/bank`;
- `/api/reports/fin/cash-bank`.

The bank-book reconciliation layer is metadata-only. Marking a row reconciled does not post another accounting entry.

The current implementation does **not** establish that every cash/bank account belongs to exactly one location. That single-location rule would be incorrect for accounts with explicit shared membership.

---

## 16. Bank reconciliation

There are two deliberately separate reconciliation workflows.

### Electronic collection settlement

**IMPLEMENTED.** `sale_payments`, `reconciliation_batches`, and `reconciliation_batch_items` support settlement of electronic collections. Eligible sale payments are grouped into a settlement batch with gross amount, processing charges, net amount, destination bank ledger, and external reference. The source sale-payment rows remain available and are linked to the settlement result.

### Account-based bank-book reconciliation

**IMPLEMENTED.** `bank_reconciliation_entries` represents eligible bank-book rows by exact `(ledger_id, entry_id)` identity. `bank_reconciliation_batches` and `_items` store review batches, selected entries, dates, processing charges, and status. This workflow preserves source transactions and does not change the underlying books.

Admin reset clears review state through the route but stores an immutable snapshot in `bank_reconciliation_reset_audits`. Location and bank-account filtering are validated server-side. The reconciliation page and routes expose pending/reconciled/batch/match/unmatch operations and export paths.

Exact external bank statement import format is **NOT DETERMINED FROM CURRENT CODE**.

---

## 17. GST

### Calculation and ledgers

**IMPLEMENTED.** `src/lib/gst.ts` contains slab rules and `lineTaxHeads()`. CGST/SGST and IGST are split according to the shared paise-exact helper; the half/remainder rule avoids losing an odd paise. Output GST is used for sales and input GST for purchases where applicable.

Supply classification is code-first and state-aware. Sales compare the selling location state with the customer’s validated GST/state identity through one `isInterStateSupply` path. Transfer classification uses a separate resolver and does not incorrectly fall back to the company GSTIN when a location identity is absent.

### Returns and reconciliation

**IMPLEMENTED.** `routes/gst.ts` provides GST report/return paths including HSN summary, GSTR-1, GSTR-3B with ITC set-off, ledger/register reconciliation, filters, and CSV exports. Returns and credit notes are attributed back to source documents. Transfer GST is classified separately from sale GST.

### Multiple streams

**PARTIALLY IMPLEMENTED.** There are multiple representations:

1. line-level tax calculation for source documents;
2. ledger-derived GST postings;
3. GST register/return report queries;
4. reconciliation attribution by source document/JV.

These are designed to reconcile but are not the same query. Differences should be treated as a reconciliation result, not silently normalized in a UI.

---

## 18. Fixed assets

**IMPLEMENTED.** The asset module is in `routes/assets.ts` and the boot migrations `fixedAssets.ts`, `assetModule.ts`, `assetDepreciation.ts`, and `assetPurchaseAccountingRepair.ts`.

The purchase row is the register entry for an acquired asset. The asset record carries current location/status; asset transfers change that state. Asset categories, purchases, register, transfers, disposals, depreciation runs, and reports have UI and API routes.

Current accounting behavior includes:

- capitalized GST in the asset acquisition value;
- no separate input-tax-credit posting from the asset module;
- depreciation expense and accumulated depreciation posting;
- disposal accounting, including disposal loss where proceeds are below carrying value;
- journal linkage and idempotent depreciation run evidence.

The asset report supports register and summary/as-of views. Exact historical reconstruction for an asset before its first stored movement is **NOT DETERMINED FROM CURRENT CODE**.

---

## 19. HR and payroll

### Employees and attendance

**IMPLEMENTED.** Employee administration, hierarchy, pay components, attendance, punches, leave, advances, payroll, payslips, and rent management are exposed by `routes/hr.ts` and related frontend pages.

Attendance with punch rows is paid from total closed-session hours, not from the span between first-in and last-out. The day boundary is the company timezone. Attendance corrections and approvals re-check relevant state under locks.

### Leave and payroll

**IMPLEMENTED.** Pending leave contributes zero pay until approved. Approval stamps the approved state under the attendance lock; rejection does not take attendance. Reverting approved leave deletes/reverses the approval state rather than converting it to an absence.

Payroll drafts refresh from current attendance on GET. Generation is blocked by unclassified absences unless the caller explicitly confirms the LOP path. Advances are automatically deducted at generation. Payroll approval re-checks attendance under lock.

Working days for LOP are calendar days in the month. The old payroll-working-days concept is retired/ignored by the current policy. A missing leave snapshot means omitted data, not zero.

### Accrual and payment

**IMPLEMENTED.** Salary accrual is derived and scheduled. Rates are snapshotted per payroll run; corrections are reversals. Salary and advance payment can use any scoped till/cash-bank ledger, and the effective mode is derived from the ledger tree. Journal voucher location is stamped from the effective payment context.

PF/ESI fields and statutory payroll calculations are present to the extent implemented in pay components/payroll routes. A complete statutory compliance certification or integration with government filing systems is **NOT DETERMINED FROM CURRENT CODE**.

---

## 20. Expenses

**IMPLEMENTED.** Expenses are entered through the company/operations expense paths and stored in `expenses` with category/ledger, amount, date, location, narration, and payment-mode information. The selected cash/bank source is location-authorized and becomes the accounting credit side; the expense ledger is debited.

Expenses appear in expense reports, cash/bank books, and P&L through the accounting/report paths. Daily expense accrual/rent logic is separate from manually entered expense vouchers and must not be double-counted.

---

## 21. Reports Center

The web Reports Center is `artifacts/marlin-erp/src/pages/reports/ReportsCenter.tsx`, with section components under `src/pages/reports/sections/`. Most report screens share `src/pages/reports/shared.tsx` for filters, table output, PDF, XLSX, CSV, and print controls.

| Report family | Screen/API source | Main filters and behavior | Output |
|---|---|---|---|
| Day Book | Reports Center → `/api/reports/fin/day-book` | Date range, location/scope; journal/day-book source rules. | Screen, server PDF/XLSX/CSV/print paths where enabled. |
| Cash Book | Financial Reports → `/api/reports/fin/cash` | Ledger/location/date. | Screen and shared report exports. |
| Bank Book | Financial Reports → `/api/reports/fin/bank` | Bank ledger/location/date. | Screen and shared report exports. |
| Cash & Bank | `/api/reports/fin/cash-bank` | Combined location/date. | Screen/export. |
| Trial Balance | `/api/reports/fin/trial-balance` | As-of/range and scope. | Screen/export. |
| General Ledger | `/api/reports/fin/ledgers`, `/ledger-statement` | Ledger, date, location. | Screen/export/drill-down. |
| P&L / Trading | Financial report service and derived postings | Date range, month-wise statement mode, location. | Screen/PDF/XLSX. |
| Balance Sheet | Financial report service | As-of date, location; balanced-status presentation. | Screen/PDF/XLSX. |
| GST | `/api/reports/fin/gst` and GST routes | Date, GSTIN/location, document/type filters. | Screen/CSV and report exports. |
| Sales Register | `/api/reports/sales-register` | Date, location, customer, salesperson, status. | Screen/PDF/XLSX/CSV. |
| Sales by Salesperson | `/api/reports/sales-by-salesperson` | Date/location/salesperson. | Screen/exports. |
| Sales by Item | `/api/reports/sales-by-item` | Date/location/item. Merchandise lines only by definition. | Screen/exports. |
| Sales by Location | `/api/reports/sales-by-location` | Date/location grouping. | Screen/exports. |
| Discounts | `/api/reports/discounts` | Date/location/discount data. | Screen/exports. |
| Purchase Register | `/api/reports/purchase-register` | Date/vendor/location. | Screen/exports. |
| Purchases by Vendor/Material | `/api/reports/purchases-by-vendor`, `/purchases-by-material` | Date/location/vendor/material. | Screen/exports. |
| Receivables / Payables | Parties report sections and outstanding routes | As-of/date, location, party. | Screen/XLSX/CSV/PDF where enabled. |
| Stock Valuation | `src/pages/headoffice/InventoryReports.tsx` and valuation endpoints | As-of/date, product kind, location. | Screen/CSV/XLSX. |
| Expiry / Near expiry | Inventory report endpoints | Cutoff/date/location. | Screen/CSV. |
| Reorder / Movement | Inventory report endpoints | Location/item and movement range. | Screen/CSV. |
| Sales & Stock Summary | `/reports/sales-stock-combined` | Date/location. | Screen/exports. |
| Profitability | `/reports/profitability` | Date/location/item/sales grouping. | Screen/exports. |
| Production | Production report endpoints/section | Date/location, output/consumption/batch-cost/wastage. | Screen/CSV/PDF/XLSX. |
| Transfers | Transfer report section and transfer routes. | Date, source/destination/status. | Screen/exports. |
| Fixed Assets | Asset summary/register/report endpoints. | Location, asset/category/as-of. | Screen/exports. |
| Bank Reconciliation | Reconciliation screen/routes. | Bank ledger, location, status/date/batch. | Screen/export. |
| Quotations | Quotation pages and routes. | Date/status/customer/salesperson. | Screen/PDF/share. |

Permissions are applied by the route and are not granted merely because a report component is visible. The principal report permission key is the reports page key; source routes specify the exact accepted keys.

---

## 22. Report data flow

### Financial reports

```text
ReportsCenter / financial section
  -> lib/api-client-react hook
  -> /api/reports/fin/*
  -> financialReports.ts
  -> buildDerivedPostings / books / ledgerBalances / report queries
  -> journal_vouchers, journal_voucher_lines, source tables, account_ledgers
  -> normalized statement payload
  -> screen and export payload
```

**IMPLEMENTED, WITH PARALLEL LEGACY PATHS.** Trial balance, GL, P&L, balance sheet, cash/bank, and day book primarily use derived postings and accounting helpers. Some report families such as sales/purchase registers, inventory, GST registers, production, and reconciliation query source tables directly because their business detail is not solely a journal view.

### Operational reports

```text
screen filter
  -> generated/custom hook
  -> reports.ts / gst.ts / assets.ts / reconciliation.ts / dashboard.ts
  -> source document + scope query
  -> module transformation
  -> table
  -> shared PDF/XLSX/CSV/print helper
```

The screen and export payload are intended to share the same rows for Reports Center reports. PDFs/XLSX generated by the common report helper are not proof that every unrelated legacy export uses the same authoritative payload. Known differences include:

- Sales Register includes invoice-level charges; Sales by Item is merchandise-line-only.
- `dashboard/summary` is a legacy today-anchored path; `dashboard/bi` is the authoritative located BI path for current dashboard tiles.
- GST registers, GST ledger reconciliation, and derived GST postings are distinct streams.
- Bank reconciliation is review metadata and must not be interpreted as a replacement bank ledger.
- Historical stock valuation can be less certain outside dated cost checkpoints.

---

## 23. PDF and XLSX export engine

**IMPLEMENTED.** Server-side report PDF/XLSX routes are mounted in the API. The browser report helper in `src/pages/reports/shared.tsx` posts a report document/payload to `/api/pdf/report` and `/api/xlsx/report`; the same helper supports print through the PDF endpoint. `exceljs` is used for workbook creation and `jsPDF`/`lib/pdf-kit` for PDFs.

Server-rendered documents include:

- invoice PDFs in `services/invoicePdf.ts`;
- quotation PDFs;
- money/expense voucher PDFs;
- generic report PDFs;
- XLSX workbooks with numeric cells and totals;
- module CSV downloads.

Location, date range, title, totals, and report-specific metadata are passed from the report document model. Export permissions are gated by the endpoint/page guard and the same scope as the on-screen report. Large exports must remain streamed/chunked; production autoscale has a response-size constraint documented by the source audit.

Unicode currency output requires an embedded TrueType font; jsPDF built-ins are WinAnsi and cannot render the rupee symbol correctly. The shared PDF kit embeds the needed font where that renderer is used.

The exact retention period for generated report files is **NOT DETERMINED FROM CURRENT CODE**; most report exports are generated for immediate download rather than stored as durable files.

---

## 24. Dashboard

### Dashboard endpoints

`routes/dashboard.ts` provides:

- `/api/dashboard/summary`;
- `/api/dashboard/stock-alerts`;
- `/api/dashboard/recent-activity`;
- `/api/dashboard/sales-trend`;
- `/api/dashboard/top-items`;
- `/api/dashboard/sales-by-location`;
- `/api/dashboard/bi`;
- `/api/dashboard/production-trend`.

### KPI sources

**IMPLEMENTED, WITH TWO GENERATION PATHS.**

| KPI/group | Current source/behavior |
|---|---|
| Sales, collected, due | Sale/source collection data and the owning settlement calculation; location-aware in BI. |
| Gross profit / net profit | Dashboard financial helpers consume the P&L summary rather than re-summing expense subtrees in the UI. |
| Cash/bank/current balances | Located posting slices and cash/bank ledger data. |
| Inventory value | Shared at-cost valuation, including in-transit sender-owned value where applicable. |
| Low stock/expiry | Stock alert and batch/expiry queries. |
| Sales trend/top items/location split | Sales source rows with date/location filters. |
| Transfers/production | Transfer and production source queries with location/date behavior. |
| Recent activity | Activity log. |

`dashboard/bi` accepts the modern location/date context and uses cached derived postings within a request. The old summary endpoint remains for compatibility and is not the source of truth for every located tile. The frontend dashboard must not use a display location to broaden access.

Exact formula for every visual tile is in `dashboard.ts` and `dashboardFinancials.ts`; this document records the source family rather than duplicating long SQL expressions.

---

## 25. Permissions, RBAC, and LBAC

The effective decision is:

```text
authenticated session
  -> page permission / action permission
  -> hierarchy/admin gate
  -> effective location/data scope
  -> record/ledger/source ownership
  -> operation
```

| Module | Head Office | Warehouse | Location restriction | Backend enforcement | Frontend enforcement |
|---|---|---|---|---|---|
| Dashboard | Broad view subject to permission | Scoped view | Effective data scope | `requireModuleView`, dashboard scope | Route/page guard |
| Customers | View/manage permitted party scope | Own permitted scope | Customer location fields and route scope | Customer route guards + data scope | Customer page guard |
| Vendors | Same pattern | Own permitted scope | Vendor location scope | Vendor route guards + data scope | Customer/vendor page guard |
| Sales/POS | Broad or selected location if authorized | Own warehouse/location | Sale location and sales context | Sale view/action guards, location resolver, period/cancel guards | Sales route guard + location picker |
| Purchases | Broad or selected location | Own warehouse | Purchase location | Purchase guards, period and stock locks | Purchase page guard |
| Stock/materials | Broad where authorized | Own location/material scope | Product kind + location | Stock scope and master-key checks | Stock page guard |
| Transfers | Cross-location operations where allowed | Source/destination validation | Both ends must be authorized | Transfer scope and status locks | Transfer page guard |
| Cash/bank | Accounts in permitted membership/scope | Shared membership required | Account-location junction | `moneyScope`, posting location | Finance page guard |
| Journals/accounts | Authorized accounting role | Limited by page/location rules | Manual JV location and ledger legs | Journal/action guards, effective location | Accounts page guard |
| Payroll/HR | HR/administrator scope | Employee/location rules | Employee and payroll scope | HR route guards, approval locks | HR page guard |
| Reports/exports | Report permission plus scope | Same | Report query scope | Report route permission and scope | Reports page guard |
| Assets | Asset permission and scope | Asset location scope | Asset current location | Asset guards | Asset page guard |
| Reconciliation | Reconciliation permission | Bank/location membership | Bank ledger/location | Reconciliation guards | Reconciliation page guard |
| Backup/import/reset | Administrator/adminGate as defined | Not generally available | Company-wide or selected location | Admin/action guards | Company/settings guard |

**IMPLEMENTED.** Page rights precede location scope. A user with no page right must be denied even if the row is in their location. A user with a page right must still be denied rows outside their permitted scope.

**TEST GAP.** The static guard audit and permission checker exist, but a full current pass result was not generated during this documentation-only task.

---

## 26. Audit logging

**IMPLEMENTED.** `src/lib/audit.ts` writes activity events used by the company audit log and recent activity. Login history is tracked separately. Events carry actor identity, action/entity information, timestamp, and details; location is included where the caller supplies or derives it.

Important audited areas include authentication/lockout, permissions and hierarchy changes, payroll approval, voucher operations, period locks, backup operations, bank reconciliation reset, invoice renumbering, and administrative changes. Dedicated reset-audit tables preserve immutable evidence for sensitive state resets.

Audit writes are not a universal replacement for database transactions. Whether a particular event is transaction-bound depends on whether the route passes the same transaction client to the audit writer. A guarantee that every activity-log row commits/rolls back atomically with every business write is **NOT DETERMINED FROM CURRENT CODE**.

---

## 27. Backup and restore

**IMPLEMENTED.** The backup module is mounted at `/api/backup/*` and has dashboard/list/history/create/validate/verify/settings routes. `src/lib/backup/` and `src/migrations/backupRestore.ts` implement the archive format and validation workflow.

The current backup design includes:

- database dump content;
- application/file assets where configured;
- archive packaging;
- manifest metadata and version;
- checksums/fingerprints;
- signed manifest/evidence rather than assuming encryption;
- object-storage-backed file handling;
- list/history and validation;
- restore verification steps.

Restore is an administrator-controlled operation with validation gates. The exact retention policy, object-storage lifecycle policy, and production restore drill frequency are **NOT DETERMINED FROM CURRENT CODE**. This documentation task did not create, download, restore, or validate a production backup.

Required storage environment names are documented without values: `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, and `PUBLIC_OBJECT_SEARCH_PATHS`. No secret value is reproduced here.

---

## 28. Mobile app

**IMPLEMENTED.** `artifacts/employee-app` is an Expo SDK 54 / React Native app using Expo Router, React Query, AsyncStorage, and the shared API client/fetch conventions. `_layout.tsx` establishes the authenticated stack and tab navigation.

Current screens include:

- login and profile;
- dashboard/home;
- attendance check-in/out and history;
- leave requests/history;
- payslips;
- sales list, new sale, sale detail and invoice sharing;
- stock list and stock-item detail;
- dispatch;
- receipt vouchers, payment vouchers, and new voucher;
- employee “more”/settings surfaces.

The mobile client uses the same bearer API and respects 401 as a dead-session boundary. Mobile page/tab gating is deny-first; payroll and leave-balance endpoints remain restricted for non-HR hierarchies.

### Build and distribution

**IMPLEMENTED.** The employee app has `dev`, `build`, `serve`, and `typecheck` scripts. Android release support is coordinated by the API package’s release scripts and the configured EAS pipeline. `EXPO_TOKEN` is an environment secret name; its value is not documented here.

The current distribution decision is no app-store upload from this application. Android delivery uses the automated EAS pipeline and an object-storage manifest with an atomic swap/grace-copy strategy. The upload UI/URL proxy path was removed, and raw `.ipa` input is rejected by the release tool.

Exact iOS distribution functionality is **NOT DETERMINED FROM CURRENT CODE**.

---

## 29. Current known issues

The list below contains only evidence-backed limitations found in the current source/audit. It is not a general backlog.

### CRITICAL

No new critical production issue was established by this documentation inspection.

### HIGH

1. **Live schema is split between Drizzle and boot SQL.**
   **Module:** database/migrations.
   **Evidence:** `index.ts` creates many tables/columns absent from `lib/db/src/schema`; raw-migration columns can be invisible to Drizzle selects.
   **Status:** current architecture/known constraint. Do not use schema push as a complete live-schema migration.

2. **Historical stock cannot be guaranteed for all legacy dates.**
   **Module:** inventory valuation/reports.
   **Evidence:** stock ledger insertion time differs from business date; old records lack complete dated cost checkpoints.
   **Status:** partially mitigated by location cost snapshots/checkpoints; historical results outside supported anchors are not guaranteed exact.

### MEDIUM

1. **Legacy outlet and polymorphic location paths remain.**
   **Module:** locations, sales, payments, stock.
   **Evidence:** `outlets`, nullable `sale_payments.outlet_id`, direct branch columns, and `location_type`/`location_id` coexist.
   **Status:** compatibility required; new code must resolve explicit type/id.

2. **Multiple report/accounting representations require reconciliation.**
   **Module:** reports/GST/dashboard/reconciliation.
   **Evidence:** derived postings, source registers, GST register, and dashboard legacy/BI paths coexist.
   **Status:** intentional in part; parity is tested for selected tiles/reports, not every report pair.

3. **Batch tracking is additive, not universal historical truth.**
   **Module:** inventory batches/FEFO.
   **Evidence:** untracked shortfall is represented as `Untracked`, and old stock is not backfilled into lots.
   **Status:** implemented for tracked/new flows; legacy lot completeness is not guaranteed.

### LOW

1. **Client/generated API shapes can become stale.**
   **Module:** API spec/client.
   **Evidence:** OpenAPI codegen controls fields and hooks; Zod strips undeclared fields; custom hooks need declaration generation.
   **Status:** process constraint; run the documented codegen/type steps after API contract changes.

2. **Some legacy UI/report paths remain alongside the modernized page kit.**
   **Module:** browser UI.
   **Evidence:** `UI_CONVENTIONS.md`, shared page kit, and older page components coexist.
   **Status:** modernization in progress; exact remaining count is not maintained in code.

### TEST GAPS

- No full repository test run was performed as part of this documentation-only task.
- Static permission/route guard scripts exist, but current pass output was not recorded here.
- Exact production data parity is not established because production was not queried.
- Every report’s PDF/XLSX/CSV parity is not covered by one universal test.
- Historical valuation for all pre-checkpoint data lacks a universal proof test.

### NON-BLOCKING WARNINGS

- `replit.md` contains historical statements that no longer describe the current authorization implementation.
- The repository contains generated `dist` output; source changes must still be built before relying on runtime behavior.
- The current dev database is treated by tests as mutable business data in some suites; test fixtures must pin and restore the relevant rows rather than assuming an empty database.

---

## 30. Recent hardening and fix history

The following capabilities are present in current source and tests. No commit IDs are asserted because this documentation does not claim a specific git-history mapping.

- Historical stock cost checkpoints and location-authoritative valuation.
- Precise transfer receiving cost.
- Transfer reservations and two-step dispatch/receive semantics.
- Depreciation run idempotency and disposal accounting.
- Separation of customer receipt accounting from bill-allocation metadata.
- One financial receipt for one customer payment.
- Report export fixes for stock valuation, receivables/payables, bank reconciliation, and shared report PDF/XLSX output.
- Day Book cache/304 handling that avoids treating a missing cached response body as a usable report.
- Location isolation, money-voucher ownership, shared cash/bank membership checks, and effective-location stamping.
- Balance Sheet balanced-status and drill-down/provenance work.
- Sale cancellation write-path guards.
- Invoice allocator/per-location numbering and renumber audit trail.
- Customer/vendor GST persistence normalization and place-of-supply classification.
- Payroll accrual, attendance punch-hours, LOP calendar-day policy, leave approval locks, and employee payment ledger handling.
- Role-tree restructuring with fail-closed migration behavior.
- Route guard audit and permission matrix checks.
- Backup archive validation/signature/fingerprint support.
- Attachment/object ACL checks beyond merely being signed in.
- Warehouse lifecycle disable/delete guards.

These are current implementation facts, not a claim that every historical defect is absent from every legacy data row.

---

## 31. Test suites

### Commands

Repository-level commands are defined in the root `package.json` and package manifests:

```bash
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/employee-app run typecheck
pnpm --filter @workspace/employee-app run build
pnpm --filter @workspace/scripts run permissions
pnpm --filter @workspace/scripts run audit:guards
```

The API test files are executed by the project’s existing test harness/configuration. A single canonical `pnpm test` script was not found in the inspected package manifests; the exact invocation for all `.test.mjs` files is **NOT DETERMINED FROM CURRENT CODE**.

### Test coverage inventory

| Area | Representative suites | Important assertions |
|---|---|---|
| Accounting/books | `accounting.test.mjs`, `accounting-audit-acceptance.test.mjs`, `balance-reconciliation.test.mjs` | Double entry, balances, report/accounting acceptance. |
| Sales/settlement | `bill-settlement`, `pos-create-collection`, `pos-partial-overpay-idempotency`, `sale-discounts`, `sales-received-ledger`, `sale-edit-stock` | One receipt, allocations, discounts, overpayment, stock edit. |
| Purchases | `purchase-bills`, `purchase-reversal-ledger-names`, `purchase-vendor-invoice-date` | Costing, reversal, vendor date requirements. |
| GST | `gst`, `gst-filters`, `gst-recon-b2c`, `gst-transfer-classification`, `party-gst`, `b2c-b2b-conversion` | Tax splits, filters, reconciliation, identity/reclassification. |
| Inventory/transfers | `stock-dating`, `stock-transfer-receiving`, `stock-valuation-location-cost`, `item-tracking`, `storage-locations`, `dispatch-board` | Dates, movement cost, valuation, lot/placement, lifecycle. |
| Permissions/security | `auth-lockout`, `mobile-rbac-lbac`, `permission-location-audit`, `permissions-five-action`, `org-restructure-migration`, static scripts | Lockout, scope, action matrix, hierarchy migration. |
| HR/payroll | `attendance-punches`, `bulk-attendance`, `leave-approval`, `lop-payroll`, `payroll-autocalc`, `salary-accrual`, `advances-salary-payable` | Punch hours, leave, LOP, accrual, advances. |
| Assets | `assets` | Register, depreciation/disposal behavior. |
| Reports/exports/dashboard | `dashboard-parity`, `books-drilldown-export`, `sales-report-definition`, `invoice-pdf` | Tile/report parity, provenance, definitions, PDF output. |
| Import/backup/mobile | `backup-archive`, import suites, `mobile-apk-pipeline` | Archive validation, mapping/rollback, release pipeline. |

Some suites use the development database and may be sensitive to mutable business fixtures. Current pass/fail totals were not generated during this documentation task.

---

## 32. Build and deployment

### Development workflows

Configured workflows are:

```text
API Server:
  pnpm --filter @workspace/api-server run dev

Frozen Fruits ERP web:
  pnpm --filter @workspace/marlin-erp run dev

Frozen Fruits Employee App:
  pnpm --filter @workspace/employee-app run dev

Component Preview Server:
  pnpm --filter @workspace/mockup-sandbox run dev
```

The API binds to `PORT`. The web artifact is Vite-based and must allow the Replit proxied host. The employee app uses Expo’s configured development domain/port variables. The artifact manifests under each `.replit-artifact/artifact.toml` define the preview routing metadata.

### Build

```bash
pnpm run typecheck
pnpm run build
```

The API package builds with esbuild into `artifacts/api-server/dist/index.mjs`. `pnpm run build` performs typechecking before package builds. The API `dev` script builds before starting; after backend source changes, rebuilding/restarting the API workflow is required.

### Environment

The source refers to environment configuration including:

- `PORT`;
- `DATABASE_URL`;
- `NODE_ENV`;
- `ALLOWED_ORIGINS`;
- object-storage configuration names;
- Expo development and release names including `EXPO_TOKEN`.

Values are intentionally omitted. Secrets are managed by the workspace secret/environment system and are not part of this document.

### Deployment/publishing

**IMPLEMENTED IN SOURCE, PLATFORM DETAILS UNKNOWN.** The repository has deployable API/web/mobile build paths. The actual deployment target, published URL, region, autoscale settings, and release history are **NOT DETERMINED FROM CURRENT CODE**. This task did not publish or deploy anything.

---

## 33. Accounting invariants

The following are hard invariants or intended guarded conditions in the current implementation. “Verified” below means the source has an enforcing path or a dedicated test family; it does not mean every historical row is correct.

| Invariant | Current status |
|---|---|
| Total debits equal total credits for a journal voucher | **IMPLEMENTED/VERIFIED** by journal creation and accounting tests. |
| Assets = liabilities + equity in a balanced statement | **IMPLEMENTED** as report presentation/check; historical orphan postings can still make a logically incomplete data set misleading. |
| Closing(D) = Opening(D+1) | **PARTIALLY IMPLEMENTED** as derived continuity; not universally stored as daily rows. |
| Closing stock(D) = Opening stock(D+1) | **PARTIALLY IMPLEMENTED** through dated movement/valuation; legacy historical dates can lack exact anchors. |
| One customer payment is one financial receipt for the actual amount | **IMPLEMENTED** by shared collection engine. |
| Bill allocations do not create duplicate financial postings | **IMPLEMENTED/TESTED** in settlement/receipt suites. |
| Transfers are P&L neutral where applicable | **IMPLEMENTED BY DESIGN**, with GST/classification exceptions handled separately. |
| Historical valuation does not read only mutable current master cost | **IMPLEMENTED** through checkpoints/location-cost valuation; old uncovered dates remain limited. |
| Cash/bank books reconcile to accounting books | **IMPLEMENTED AS LEDGER SOURCE**, while bank reconciliation itself is metadata-only. |
| Inventory quantity agrees with authoritative stock records | **IMPLEMENTED FOR CURRENT WRITE PATHS** with `stock_entries` as authority; legacy/orphan data is a repair concern. |
| Location display selection cannot grant authority | **IMPLEMENTED** through backend effective-scope checks. |
| Cancelled sales cannot receive later payments or returns | **IMPLEMENTED** under row-locking write guards. |
| Locked periods reject applicable writes | **IMPLEMENTED** through shared period-lock checks. |

---

## 34. Source-of-truth map

| Business concept | Authoritative table/service | Secondary views | Reports using it |
|---|---|---|---|
| Sales | `sales` + sale lines; `routes/sales.ts` | `sale_payments`, dispatch status, dashboards | Sales register, by item/person/location, profitability, P&L |
| Purchases | `purchases` + purchase lines; `routes/purchases.ts` | stock entries, vendor settlement | Purchase register, by vendor/material, P&L |
| Receipts | Shared receipt engine, `receipts`, journal/derived postings | allocations, sale-payment history | Receipt/customer ledger, cash/bank, day book |
| Payments | `payments`, journal/derived postings | vendor allocations, cash deposits | Payment/vendor ledger, cash/bank, day book |
| Customer balance | Customer control ledger + owning outstanding calculation | allocation rows, ageing projections | Receivables, customer statement, dashboard due |
| Vendor balance | Vendor control ledger + vendor settlement calculation | advance applications, ageing | Payables, vendor ledger |
| Inventory quantity | `stock_entries` and source-document movement | stock ledger, batches, reservations, placements | Stock, movement, valuation, item tracking |
| Inventory valuation | `lib/valuation.ts`, cost snapshots/checkpoints | product masters, batches, in-transit state | Stock valuation, dashboard, P&L/closing stock |
| GST | `lineTaxHeads`, GST source/register queries, derived GST postings | GSTIN/state identity, reconciliation attribution | GST returns, GST report, sales/purchase registers |
| P&L | `buildDerivedPostings` + financial report summary | source registers, dashboard BI | P&L, trading, dashboard |
| Balance Sheet | derived postings + ledger balances + closing valuation | account hierarchy, opening adjustments | Balance Sheet, dashboard |
| Trial Balance | derived journal/posting set | account ledgers, opening balances | Trial Balance, audit checks |
| Cash | effective cash ledger and ledger postings | cash account membership, deposits | Cash Book, dashboard |
| Bank | effective bank ledger and ledger postings | reconciliation entry state/batches | Bank Book, reconciliation |
| Fixed assets | asset register/purchase/disposal tables + asset routes | depreciation runs, journals | Asset register/reports, BS |
| Depreciation | depreciation service/run records and journals | asset carrying value | Asset reports, P&L, BS |
| Stock transfers | `stock_transfers` + transfer lines and status | reservations, dispatch state, transfer documents | Transfer report, stock, GST transfer |

When a report disagrees with a secondary view, inspect the owning source/service and the report’s explicit definition before changing accounting logic.

---

## 35. Do not document assumptions

The following are intentionally not asserted because the current source does not provide enough evidence:

- exact production database row counts or balances;
- exact published URL, deployment region, retention settings, or platform release history;
- an always-on server-side token revocation list;
- a single universal daily closing-balance table;
- exact historical stock valuation for every pre-checkpoint transaction;
- complete government filing/compliance certification for PF, ESI, GST, or banking;
- a single canonical test command for every API `.test.mjs` file;
- complete parity of every report screen and every export format;
- exact external bank-statement import format;
- exact foreign keys for every legacy soft-linked table;
- any behavior that exists only in comments, stale README text, or intended product requirements.

Where a coding change depends on one of these, inspect the relevant current route/service and live environment under the appropriate operational process rather than treating this document as a substitute for evidence.

---

## 36. Final document quality and maintenance guidance

This file is intended as an orientation document for a future coding agent. Before changing a business-critical flow, the agent should:

1. read the relevant source path named here;
2. check whether the behavior is derived from a source document, journal, or report-specific query;
3. check both the Drizzle schema and raw boot migrations;
4. check location scope and period-lock guards;
5. check generated API schemas/hooks when the request/response shape changes;
6. run the smallest relevant test/static audit, then the package build/typecheck;
7. avoid `drizzle-kit push` unless the schema workflow is explicitly changed and reviewed;
8. preserve the one-receipt/metadata-allocation distinction;
9. verify report UI, PDF, XLSX, and CSV behavior separately where applicable.

This document should be updated when a module’s source-of-truth, location model, accounting derivation, schema migration strategy, export contract, or security boundary changes.

---

## 37. Documentation-only validation record

The validation required for this task was limited to the document and repository diff:

- **File exists:** `ERP_COMPLETE_DOCUMENTATION.md` was created at repository root.
- **Markdown readability:** file is UTF-8 Markdown with numbered headings and tables; it can be read as plain text without application runtime support.
- **Secret scan:** no secret values, passwords, tokens, connection strings, or private key material were included. Environment variable names are listed without values.
- **Production connection:** no production database query or production connection was performed for this task.
- **Database changes:** no database migration, schema push, data mutation, or restore was performed for this task.
- **Application behavior:** no application source, generated client, schema, migration, workflow, or configuration file was modified for this task.
- **Git whitespace validation:** `git diff --check` is the required final command; its result is recorded in the task completion response after execution.

### Files/modules inspected

The audit included, at minimum:

- `artifacts/api-server/src/app.ts`
- `artifacts/api-server/src/index.ts`
- `artifacts/api-server/src/routes/`
- `artifacts/api-server/src/lib/`
- `artifacts/api-server/src/services/`
- `artifacts/api-server/src/migrations/`
- `artifacts/api-server/tests/`
- `artifacts/marlin-erp/src/App.tsx`
- `artifacts/marlin-erp/src/pages/`
- `artifacts/marlin-erp/src/components/`
- `artifacts/marlin-erp/docs/UI_CONVENTIONS.md`
- `artifacts/employee-app/app/`
- `lib/db/src/schema/`
- `lib/db/drizzle/`
- `lib/api-spec/`
- `lib/api-zod/`
- `lib/api-client-react/`
- `lib/pdf-kit/`
- `scripts/src/check-permissions.ts`
- `scripts/src/audit-route-guards.ts`
- workspace manifests and artifact workflow manifests.

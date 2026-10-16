# Frozen Fruits ERP — Current System Structure

**Current as of:** 16 October 2026  
**Purpose:** Describe the implemented ERP architecture, active modules, shared data, workflows, and controls.  
**Scope note:** This document intentionally omits the Reconciliation and Chart of Accounts modules. It documents the rest of the ERP.

> This file is the current structure guide. `ERP_STRUCTURE.md` is an older, much more detailed snapshot and may contain retired pages and outdated implementation details.

## 1. Product overview

Frozen Fruits ERP is a multi-location business system for frozen-fruit production, purchasing, inventory, sales, assets, finance operations, HR, reporting, and company administration. Its main user experiences are:

- **ERP web application:** management, operations, finance, HR, and company administration.
- **Employee mobile application:** employee self-service and field workflows.
- **API server:** shared business rules, authorization, persistence, reports, documents, and integrations.
- **Public document links:** narrowly scoped invoice and quotation sharing endpoints; they do not expose the authenticated ERP.
- **User access surfaces:** login, forced password change, and the signed-in user's profile.

The web and mobile applications use the same API and PostgreSQL business data. The web app has one unified permission-filtered navigation model rather than separate branch and head-office sidebars.

## 2. Workspace and source layout

```text
/
├── artifacts/
│   ├── marlin-erp/          React/Vite web ERP
│   ├── api-server/          Express API and business services
│   ├── employee-app/        Expo/React Native employee app
│   └── mockup-sandbox/      Isolated live component previews
├── lib/
│   ├── db/                  PostgreSQL pool and Drizzle schema
│   ├── api-spec/            OpenAPI contract and code generation
│   ├── api-zod/             Shared request/response validation
│   ├── api-client-react/    Generated and custom React Query hooks
│   ├── pdf-kit/             Shared PDF helpers
│   └── purchase-pricing/    Shared purchase pricing calculations
├── scripts/                 Type checks, audits, generation, and maintenance
└── docs/                    Product, architecture, process, and audit documents
```

### Web app

`artifacts/marlin-erp/src/App.tsx` owns route registration and authentication gates. `src/lib/moduleRegistry.ts` is the central source for sidebar links and page-permission keys. Page components are organized by domain under `src/pages/`; shared navigation, forms, dialogs, tables, and design primitives live under `src/components/`.

The web stack is React, TypeScript, Vite, Wouter, TanStack Query, Tailwind CSS, Radix UI/shadcn components, and Recharts. Server data is accessed through the shared API client rather than page-local network conventions.

### API server

`artifacts/api-server/src/app.ts` configures the Express application. `src/index.ts` starts the server and applies boot-time migrations and data checks. `src/routes/index.ts` mounts domain routers under `/api`; route names do not always match the final URL prefix, so callers should use the registered route definitions or OpenAPI contract rather than infer paths from filenames.

The API uses TypeScript, Express, PostgreSQL through the shared `pg` pool, Drizzle for the schema portions represented in code, raw SQL for many business transactions, and an esbuild production bundle. Domain-specific logic is split across `routes/`, `lib/`, `services/`, and `migrations/`.

### Employee mobile app

`artifacts/employee-app` is an Expo Router / React Native app. It shares the API and authentication model, and presents mobile-focused screens for attendance, leave, payslips, sales, stock, dispatch, and voucher tasks. It is not a separate database or business-rule implementation.

### Shared packages

- `@workspace/db`: database pool, Drizzle schema, and shared database exports.
- `@workspace/api-spec`: OpenAPI source contract and client-generation configuration.
- `@workspace/api-zod`: shared Zod schemas.
- `@workspace/api-client-react`: generated API hooks plus custom hooks for app-specific endpoints.
- `@workspace/pdf-kit`: shared PDF utilities.
- `@workspace/purchase-pricing`: common purchase-price calculations used across flows.

## 3. Web navigation and active modules

The sidebar and permissions UI are derived from `moduleRegistry.ts`. Links can be satellites of a parent permission page, and some screens are reached as tabs or embedded workflows rather than independent sidebar entries.

### Dashboard

- **Dashboard** (`/`): business KPIs, location-aware summaries, alerts, and activity links. Metrics are sourced from domain reports rather than acting as a separate system of record.

### Operations

- **Point of Sale** (`/sales/pos`): location-based invoice entry, customer and salesman assignment, item pricing, discounts/coupons, tax calculation, optional other charges, collections, invoice output, and an item-wise sales view.
- **Quotations** (`/sales/quotations`): customer offers and shareable quote documents. Quotes do not post stock or financial transactions; converting a quote creates a sale through the normal sales flow.
- **Stock Transfer** (`/transfers`): two-step dispatch and receipt between locations, with rejection/reversal handling.
- **Customer management** (`/customers`): customer identity and tax details used by sales, returns, receipts, and receivables.
- **Receipt Voucher / Payment Voucher** (`/operations/receipt-voucher`, `/operations/payment-voucher`): operational entry surfaces over the shared voucher engine.
- **Dispatch** (`/operations/dispatch`): fulfillment status for billed sales, progressing through pending, ready, and dispatched states. This is a status layer and does not itself change stock or books.
- **Cash Balance**: location cash visibility and deposit workflow, accessible through the location/finance context.
  The cash-in-outlet view is available at `/accounts/cash-in-outlet`; the sales-context alias is `/sales/cash-balance`.

### Stock, production, and purchasing

- **Units** (`/production/units`): measurement units used by products, materials, and transaction quantities.
- **Item Master** (`/production/item-master`): unified management of finished goods, materials, and raw materials, including classification and tax/product attributes.
- **Purchases** (`/production/purchase`): vendor bills, received goods, prices, discounts, taxes, and incidental vendor charges.
- **Production batches** (`/production/production`): BOM-guided manufacturing, material consumption, output, and batch costing.
- **Production Reports** (`/production/reports`): manufacturing activity and production-derived measures.
- **Stock** (`/headoffice/stock`): location-aware on-hand and available stock, with item tracking and storage placement views.
- **Stock Transfer** (`/transfers`): transfers remain a two-stage process; dispatch reduces sender stock and receipt credits destination stock.
- **Inventory Reports** (`/headoffice/inventory-reports`): quantity, valuation, ageing, and related stock reporting.
- **Stock Verification** (`/headoffice/stock-verification`): counted-versus-system comparison and controlled adjustments.
- **Warehouses / Outlets** (`/headoffice/warehouses`, `/headoffice/outlets`): location masters, operational scope, tax identity, and billing profiles.
- **Item Prices** (`/headoffice/item-price`): effective-dated selling prices.
- **Vendors** (`/vendors`): supplier identity, tax information, purchases, and payables.

### Sales and customer account workflows

- **Returns** (`/returns`): sales and purchase return documents, stock effects, and financial/tax attribution.
- **Outstanding** (`/outstanding`): receivable/payable ageing and customer/vendor balance views.
- **Coupons** (`/coupons`): discount rules consumed by the sales/POS flow.
- **Customer management** (`/customers`): customer records and supporting details.

### Asset management

- **Asset Purchases** (`/assets/purchases`): capital asset acquisition, separate from stock purchases.
- **Asset Categories** (`/assets/categories`): classification for the fixed-asset register.
- **Asset Transfers** (`/assets/transfers`): movement of asset custody/location.
- **Asset Disposal** (`/assets/disposal`): disposal events and their accounting trail.
- **Asset Reports** (`/assets/reports`): asset register and movement summaries.

### HR and workforce

- **Employees** (`/hr/employees`): workforce records, employment status, location, and employee-linked settings.
- **Attendance** (`/hr/attendance`): attendance summaries and punch sessions; leave administration is reached from this HR surface.
- **Payroll** (`/hr/payroll`): period-based payroll preparation, review, approval, and payslip support.
- **Rent Management** (`/hr/rent`): location rent agreements, periods, and payment tracking.
- **Hierarchy** (`/hr/hierarchy`): role tree and permission-group assignment.

### Finance and statutory reporting (excluding the two out-of-scope modules)

- **Ledger Statement** (`/accounts/ledger`): activity and balances for a selected financial ledger.
- **Cash & Bank** (`/accounts/cash-bank`): cash/bank account setup, account ownership/location, and balance views.
- **Vouchers** (`/accounts/vouchers`): the common surface for receipts, payments, journal entries, contra entries, and credit/debit notes; operational voucher pages use the same underlying engine.
- **Day Book** (`/accounts/day-book`): date-ordered financial activity.
- **Cash Book** (`/accounts/cash-book`): cash movements and balances.
- **Bank Book** (`/accounts/bank-book`): bank-side ledger activity.
- **Trial Balance** (`/accounts/trial-balance`): debit/credit balances over a period.
- **Profit & Loss / Balance Sheet**: financial statements available through the financial reports surfaces.
- **GST Summary** (`/accounts/gst`): output/input tax and supporting tax summaries.
- **GST Returns** (`/accounts/gst-returns`): GSTR-1, GSTR-3B, and HSN-oriented filing views.
- **Accounting Periods** (`/accounts/periods`): period lock and unlock controls for financial write operations.
- **Reports** (`/reports/*`): sales, purchases, inventory, production, parties, and financial reports.

### Company administration

- **Settings** (`/company/settings`): company-wide preferences used by operational modules.
- **Company Profile** (`/company/profile`): legal/business identity, tax, and document branding data.
- **Permissions** (`/company/permissions`): page-level actions granted to hierarchy roles.
- **Audit Log** (`/company/audit`): recorded user and system actions.
- **Login History** (`/company/login-history`): sign-in and access history.
- **Backup & Restore** (`/company/backup`): controlled database backup and restore operations.
- **Import Data** (`/company/import`): master and transaction import flows, validation, migration wizard, comparison, commit, and rollback.
- **Company reset**: administrator-controlled reset actions for full or transactional data, with separate reset boundaries and transactional safeguards.
- **Global search**: cross-domain search surface available from the app shell.

### Retired web surfaces

Some historical pages are intentionally hidden and are not active navigation modules. Retired surfaces include standalone expense entry pages, the standalone stock-ledger page, Asset Register, and Advances. Their historical data and any owning payroll/accounting dependencies remain available to supported reports and workflows. The current UI registry and route table, not old screenshots or old documentation, determine whether a page is active.

## 4. Core business domains and data

The database is PostgreSQL. The Drizzle schema is not a complete inventory of the live schema: boot migrations add tables, indexes, columns, and data transformations not all represented in Drizzle. Business writes use transactions and raw SQL where required.

### Master and configuration data

- **Company:** company settings and profile.
- **Locations:** warehouses and outlets, location-specific billing/tax identity, and location relationships.
- **Products:** items, materials, raw materials, units, BOM templates, price history, and coupons.
- **Parties:** customers and vendors.
- **People:** employees, employment status, hierarchy, pay components, and role permissions.
- **Assets:** categories and asset records.
- **Finance references:** account ledgers, cash/bank accounts, voucher sequences, and opening-balance records.

### Operational documents

- Sales, sale payments/collections, sales returns, and quotations.
- Purchases, purchase returns, vendor settlement records, and purchase charges.
- Production batches, material consumption, and finished output.
- Stock transfers, stock entries, batches/lots, reservations, stock verification, and storage placements.
- Receipt/payment vouchers, journal vouchers, cash deposits, and rent payments.
- Payroll runs, attendance sessions, leaves, advances, and accrual records.
- Asset purchases, transfers, disposals, and register history.
- Import batches, import rows, invoice-share records, dispatch statuses, and audit events.

### Audit and infrastructure data

The system maintains authentication/login history, activity logs, migration records, boot status, import state, and append-only stock movement history. These records are used for traceability, migration safety, access monitoring, and operational recovery.

### Important data relationships

- Transactions refer to product/customer/vendor/employee/location masters using database foreign keys where available and validated application-level identity where polymorphic relationships are required.
- A location is represented explicitly by a type plus ID; do not infer location type from a nullable foreign key or ledger name.
- Stock is polymorphic across finished goods, materials, and raw materials. The material type must be included wherever a stock identity is read or written.
- Cash/bank balances and financial statements are derived from the relevant posted transaction streams and opening balances; transaction documents remain the source records.
- Historical import and migration state is preserved so that imported records can be traced and, where supported, rolled back safely.

## 5. Shared architecture and controls

### Authentication and permissions

- Authenticated API requests pass through shared authentication middleware. Public routes are narrowly scoped to health checks, authentication entry points, and signed document-sharing flows.
- Page permissions use stable `page:<href>` keys. The module registry supplies navigation and permission-page structure from a shared source.
- Each page permission supports view/add/edit/delete/download actions. The API enforces access independently of frontend visibility.
- Role hierarchy and server-side location/data-scope checks constrain what records a user can access.
- Default-deny behavior applies to newly introduced permission rows; administrators explicitly grant access.

### Location and data scope

- The selected location is a UI context and filter, not authorization by itself.
- The server derives the user's permitted data scope from the authenticated employee and role.
- Operational records carry explicit location identity where needed. Queries, writes, reports, document headers, and financial visibility must respect that scope.
- Head Office, warehouse, and outlet workflows use shared services but can have different permitted actions and source ledgers.

### API and validation

- The OpenAPI contract is the client-generation source for declared operations. Generated React Query hooks are kept separate from hand-written custom hooks.
- Zod validation is used for typed request paths; some rich document payloads are intentionally processed from raw request bodies to preserve JSON fields.
- Server-side validation remains authoritative for amounts, dates, state transitions, permissions, and effective values.
- Mutating endpoints should write the business record, dependent stock/financial effects, and audit event within one database transaction.

### Financial posting and reporting

- Operational documents are the source of truth for derived postings. Shared posting builders project the event stream into ledger activity, books, trial balance, and financial statements.
- A receipt or payment may be created from a domain workflow; provenance identifies its owner and determines whether it is editable or deletable.
- Customer and vendor balances are derived from their ledger activity and settlement/advance rules, rather than from a competing manually maintained balance.
- Financial reports use explicit dates, location scope, and period-lock rules.

### Stock and valuation

- `stock_entries` is the authoritative on-hand quantity by material and location.
- `stock_batches` adds lot data such as expiry and unit cost; FEFO consumes earliest-expiring eligible lots first, with tracked shortfalls represented as untracked stock.
- `stock_ledger` records business-dated stock movements as an audit history.
- Reservations distinguish stock held for an order from stock already deducted and in transit.
- A shared valuation engine feeds the relevant stock, dashboard, and financial reporting surfaces so those views use a consistent valuation basis.

### Tax, documents, storage, and audit

- Shared GST helpers calculate tax heads and classify inter-/intra-state supplies using the selling location and validated party identity.
- Server-side PDF services generate invoices, returns/supporting documents, challans, payslips, and reports. The web/mobile clients request documents rather than independently calculating official print totals.
- Object storage supports uploaded business documents and attachments. Access is checked against the uploader and the visibility of the linked business record.
- Mutations are written to the activity log; migration outcomes are recorded at startup for operational visibility.

## 6. End-to-end business flows

### Procurement and vendor settlement

1. Maintain vendor, material/product, tax, and location data.
2. Create a purchase document with lines, discounts, taxes, and permitted incidental charges.
3. The server validates the document and, in one transaction, updates stock, lot records, average cost, vendor obligation, and applicable postings.
4. A purchase return references the purchase and reverses the eligible quantities and financial/tax effects.
5. Vendor payment and bill allocation use the shared payment/voucher workflows and update the supplier's derived balance.

### Manufacturing

1. Maintain units, item masters, and BOM templates.
2. Create a production batch for the producing location and date.
3. The server validates material availability, consumes lots according to FEFO, applies production cost components, and credits finished output.
4. Batch reports and inventory valuation read the resulting production and stock records.
5. Reversals or deletions use the owning transaction rules and restore dependent stock/cost effects atomically where permitted.

### Inventory and inter-location transfer

1. Receipts from purchases and production increase on-hand stock and create/update lot data.
2. Sales and production consume stock; reservations reduce availability according to their state.
3. Dispatch moves stock out of the sender and into transit.
4. Receipt completes the transfer and credits the destination; rejection reverses the applicable movement.
5. Stock verification records a count and applies a guarded adjustment; reports show movement, valuation, ageing, and location context.

### Sales and fulfillment

1. Select the selling location and customer; use active items, effective prices, applicable coupon/discount rules, tax details, and allowed charge rows.
2. The server validates the final state, calculates totals, allocates stock lots, and creates the sale and settlement records in one transaction.
3. Credit and partial-payment rules are enforced against the customer and outstanding amount.
4. Sales return documents reference the source sale and restore eligible stock/financial amounts.
5. The dispatch board tracks fulfillment after billing without creating a second sales or stock posting.
6. Quotations remain non-posting offers until converted through the normal sale flow.

### Workforce and payroll

1. Employee and hierarchy records control login, role access, location, and employment state.
2. Attendance sessions and approved leave feed payroll preparation.
3. Payroll drafts are refreshed from current attendance/leave inputs; unresolved attendance conditions can block approval.
4. Approval snapshots rates and records the payroll result; subsequent corrections use reversals or the owning adjustment flow.
5. Employee advances and rent workflows are managed independently but feed their related settlement and reporting views.

### Assets

1. Define categories and record an asset purchase separately from merchandise/stock procurement.
2. Maintain the asset register and location/custodian details.
3. Use asset transfer and disposal workflows to preserve movement and retirement history.
4. Asset reports read the register and its source documents; asset purchases do not increase sellable stock.

### Finance, GST, and management reporting

1. Operational documents and approved vouchers create financial activity.
2. Ledger statements and day/cash/bank books present that activity by period and scope.
3. Trial balance and financial statements aggregate the derived postings with supported opening-balance treatment.
4. GST summaries and return views classify taxable documents using shared tax logic and location/party tax identities.
5. The reports center, dashboards, and exports read from their owning domain/report builders and carry the selected period and location context.

### Imports and company administration

1. Import files are uploaded and normalized into preview rows.
2. Validation resolves identities, tax/amount rules, and location choices before commit.
3. Transaction imports reuse the regular business creation rules rather than bypassing stock and settlement behavior.
4. Commit is transactional; rollback is permitted only when downstream use does not make reversal unsafe.
5. Settings, access permissions, audit history, backup/restore, and company profile are managed through the company surfaces.

## 7. API domain map

The API server mounts business routers centrally. The principal domains (excluding the two modules outside this document's scope) are:

| Domain | Responsibilities |
|---|---|
| Authentication / health | Login, profile, password changes, token/session checks, service health |
| Dashboard | Location-aware KPI, alerts, trends, and activity summaries |
| Inventory / branches | Product masters, materials, stock, warehouses, outlets, storage locations, and item tracking |
| Purchases / production / BOM | Supplier documents, manufacturing, materials, and production templates |
| Sales / payments / returns / quotations | Sales creation, collections, returns, discounts, quotes, and share links |
| Customers / vendors | Party masters, statements, and related balance views |
| HR / rent | Employees, hierarchy, attendance, leave, payroll, advances, and rent |
| Accounts / journal / periods | Voucher, ledger, book, financial-period, and balance/reporting operations |
| Assets | Asset purchases, register, categories, transfers, disposals, and reporting |
| GST / reports / financial reports | Tax summaries/returns and cross-domain reports |
| Company / audit / backup / imports | Configuration, permissions, audit, data migration, and database recovery |
| Documents / search | PDF generation, signed public documents, attachments, and global search |
| Dispatch / integrity | Fulfillment status and system integrity diagnostics |

Router filenames live in `artifacts/api-server/src/routes/`. Routers are mounted centrally; use the OpenAPI spec and route definitions for exact paths and HTTP methods.

## 8. Report and document surfaces

- **Operational reports:** sales register/by item/location, purchase register/by vendor/material, discounts, returns, stock, inventory valuation/ageing, production, dispatch, and party balances.
- **Financial reports:** ledger statements, day book, cash book, bank book, trial balance, profit and loss, balance sheet, and GST reporting.
- **Dashboard:** summarizes selected operational and financial measures, links users to owning reports, and supports permission-gated Excel export of the displayed KPI report.
- **Exports:** CSV/XLSX/PDF exports should use the same filters, date range, scope, and total definitions as their rendered report.
- **Business documents:** invoice, quotation, challan, voucher, payslip, return, and location-profile output are generated through owning server-side services.

## 9. Deployment and development constraints

- The web app and API are separate artifacts; mobile is its own Expo artifact. All use the shared workspace packages and database.
- The API development workflow builds the server bundle before starting it; restart the API workflow after backend code changes.
- Startup migrations are the supported path for database DDL and one-time conversions. The Drizzle schema is partial; do not use `drizzle-kit push` as a substitute for reviewed boot migrations.
- Shared generated API types may need regeneration when the OpenAPI contract changes; rebuild or typecheck affected workspace packages afterward.
- Production and development data are distinct environments. Never test a financial/stock workflow against business data by creating throwaway records; use isolated fixtures or a safe test database.
- Treat financial posting, stock movement, payroll approval, import commit, reset, and restore as high-impact writes. Their reversals and authorization requirements must be reviewed with the same care as the original action.

## 10. Source-of-truth map

| Question | Primary source |
|---|---|
| Active sidebar links and page-permission keys | `artifacts/marlin-erp/src/lib/moduleRegistry.ts` |
| Web routes and page-to-route mapping | `artifacts/marlin-erp/src/App.tsx` |
| API router registration | `artifacts/api-server/src/routes/index.ts` |
| API contract and generated client operations | `lib/api-spec/` and `lib/api-client-react/src/generated/` |
| Database schema represented in Drizzle | `lib/db/src/schema/` |
| Additional DDL, raw columns, and data migrations | `artifacts/api-server/src/index.ts` and `artifacts/api-server/src/migrations/` |
| Business workflows and derived financial/stock calculations | Domain routes and reusable helpers under `artifacts/api-server/src/lib/` |
| Employee mobile screens | `artifacts/employee-app/app/` |

When this document and the code disagree, the current code and registered routes are authoritative. Update this document when a module, major workflow, data boundary, or workspace ownership changes.

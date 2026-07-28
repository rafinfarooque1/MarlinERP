# Marlin Frozen Fruits ERP — Complete Structure Documentation

> **Analysis date:** July 2026  
> **Scope:** Documents the codebase exactly as it exists today. No modifications, no recommendations.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Folder Structure](#2-folder-structure)
3. [Frontend Structure](#3-frontend-structure)
4. [Backend Structure](#4-backend-structure)
5. [Database Structure](#5-database-structure)
6. [ERP Modules](#6-erp-modules)
7. [Business Flow](#7-business-flow)
8. [Permission Structure](#8-permission-structure)
9. [Accounting Structure](#9-accounting-structure)
10. [Inventory Structure](#10-inventory-structure)
11. [Complete Page List](#11-complete-page-list)
12. [Complete API List](#12-complete-api-list)
13. [Summary](#13-summary)

---

## 1. Project Overview

| Property | Value |
|---|---|
| **ERP Name** | Marlin Frozen Fruits ERP |
| **Purpose** | End-to-end business management for a frozen fruits manufacturing and distribution company — covering production, inventory, sales, accounts, HR, and company administration |
| **Technology Stack** | TypeScript monorepo (pnpm workspaces) |
| **Frontend Framework** | React 18 + Vite + TypeScript + shadcn/ui (Radix UI) + Tailwind CSS + Wouter (routing) + React Query (TanStack) |
| **Backend Framework** | Node.js + Express + TypeScript + Drizzle ORM + Zod validation |
| **Database** | PostgreSQL (Neon managed, accessed via `pg` pool) |
| **Authentication** | JWT tokens stored in `localStorage` (8-hour expiry) + bcrypt password hashing + `mustChangePassword` flow |
| **Deployment Architecture** | Replit Autoscale — web frontend and API server deployed as separate artifacts; shared PostgreSQL database |

---

## 2. Folder Structure

```
/ (monorepo root)
├── pnpm-workspace.yaml          — workspace package declarations
├── tsconfig.json                — base TypeScript config (project references)
├── docs/                        — architecture and business process documentation
├── scripts/                     — internal build and automation tools
├── attached_assets/             — design mockups, requirements, reference media
│
├── artifacts/
│   ├── api-server/              — Node.js/Express backend (central API)
│   │   ├── src/
│   │   │   ├── app.ts           — Express app factory (middleware, CORS, body limits)
│   │   │   ├── index.ts         — Server entry point; startup migrations; admin seed
│   │   │   ├── routes/          — Route handlers (one file per domain)
│   │   │   ├── services/        — Business logic, PDF generation (invoices, payslips)
│   │   │   ├── middleware/       — requireAuth, requireModuleAction, requireModuleView
│   │   │   └── lib/             — Shared utilities (logger, password, token)
│   │   ├── dist/                — Compiled production output
│   │   └── package.json
│   │
│   ├── marlin-erp/              — Web ERP dashboard (React, managers & accountants)
│   │   ├── src/
│   │   │   ├── App.tsx          — Root: providers, AuthGuard, all route definitions (wouter)
│   │   │   ├── main.tsx         — React entry point
│   │   │   ├── pages/           — Page components organised by domain folder
│   │   │   │   ├── accounts/    — Accounting pages (ledger, vouchers, GST, etc.)
│   │   │   │   ├── auth/        — Login, Change Password
│   │   │   │   ├── company/     — Settings, Permissions, Audit, Login History
│   │   │   │   ├── customers/   — Customers, Vendors, Coupons
│   │   │   │   ├── dashboard/   — Dashboard
│   │   │   │   ├── finance/     — Reconciliation, Cash in Outlet
│   │   │   │   ├── headoffice/  — HO-level Stock, Transfers, Sales, Item Prices, Outlets, Warehouses
│   │   │   │   ├── hr/          — Employees, Attendance, Leave, Payroll, Advances, Hierarchy
│   │   │   │   ├── outstanding/ — Outstanding balances
│   │   │   │   ├── production/  — Units, Item Master, Items, Production, Purchases, Stock Transfers
│   │   │   │   ├── profile/     — Personal profile
│   │   │   │   ├── reports/     — Reports centre (7 report sections)
│   │   │   │   ├── returns/     — Sales and purchase returns
│   │   │   │   └── sales/       — Location-gated POS, expenses, cash balance, stock
│   │   │   ├── components/
│   │   │   │   ├── layout/      — AppLayout, Sidebar, UserMenu, ThemeToggle
│   │   │   │   └── ui/          — shadcn/ui primitives + ERP-specific components
│   │   │   ├── hooks/           — use-mobile, use-toast
│   │   │   └── lib/
│   │   │       ├── moduleRegistry.ts  — Single source of truth for sidebar + permissions
│   │   │       ├── usePermission.ts   — RBAC hook (canView/canAdd/canEdit/canDelete/canDownload)
│   │   │       ├── locationContext.tsx — Current branch context (outlet/warehouse)
│   │   │       ├── download.ts        — CSV export helper
│   │   │       └── utils.ts           — Shared utilities
│   │   └── package.json
│   │
│   └── employee-app/            — Expo/React Native mobile app for staff
│       ├── app/                 — Expo Router screens (attendance, leaves, payslips)
│       └── components/          — Mobile-optimised UI components
│
└── lib/                         — Shared workspace packages
    ├── db/                      — @workspace/db — Drizzle ORM schema + pg pool
    │   └── src/schema.ts        — All table definitions
    ├── api-spec/                — @workspace/api-spec — OpenAPI 3.1 YAML contract
    ├── api-zod/                 — @workspace/api-zod — Shared Zod validation schemas
    └── api-client-react/        — @workspace/api-client-react — Auto-generated React Query hooks
```

---

## 3. Frontend Structure

### 3.1 Layout

**`AppLayout.tsx`** wraps every authenticated page. It:
- Renders the collapsible sidebar generated from `getNavGroups()` (moduleRegistry)
- Applies permission filtering — links whose module has `canView = false` are hidden
- Provides the top header bar (UserMenu, ThemeToggle, breadcrumb)
- Handles responsive mobile drawer behaviour

### 3.2 Sidebar

The sidebar is built dynamically from `moduleRegistry.ts`. It has:

| Section | Icon | Contents |
|---|---|---|
| *(standalone)* | LayoutDashboard | Dashboard |
| **Operations** | Store | Point of Sale · Stock Transfer · Expenses · Cash Balance · Customers · Stock |
| **Production** | Factory | Batches · Reports · Purchases · Vendors |
| **Inventory** | Building2 | Item Master · Units · Stock · Stock Ledger · Reports · Verification · Warehouses · Outlets · Item Prices |
| **Sales** | Calculator | Returns · Outstanding · Coupons |
| **HR** | Users | Employees · Attendance · Payroll · Advances · Hierarchy |
| **Accounts** | UsersRound | Chart of Accounts · Ledger · Cash & Bank · Vouchers · Day Book · Cash Book · Bank Book · Trial Balance · Expenses · GST Summary · GST Returns · Reconciliation · Reports |
| **Company** | Settings | Settings · Company Profile · Audit Log · Permissions · Login History |

### 3.3 Navigation & Routing

Routing uses **Wouter** (lightweight React router). All routes are defined in `App.tsx`. Route protection is handled by an `AuthGuard` component:

```
AuthGuard checks:
  1. localStorage.getItem('marlin_auth_token') — redirect to /login if missing
  2. user.mustChangePassword — redirect to /change-password if true
```

### 3.4 Authentication Flow (Frontend)

1. User submits credentials on `/login`
2. POST `/api/auth/login` → returns `{ token, user }`
3. Token stored in `localStorage` as `marlin_auth_token`
4. User object stored in `localStorage` as `marlin_user`
5. If `mustChangePassword = true`, all routes redirect to `/change-password`
6. Every API request includes `Authorization: Bearer <token>` header
7. Logout clears both localStorage keys and redirects to `/login`

### 3.5 State Management

| Layer | Mechanism |
|---|---|
| Server data | React Query (`@workspace/api-client-react` hooks) |
| Global UI state | React Context (`LocationProvider`, `ThemeProvider`) |
| Persistent client state | `localStorage` (auth token, selected location) |
| Local component state | `useState` / `useReducer` |

**React Query config** (`App.tsx`):
- `staleTime: 0` — always refetch on mount / after invalidation
- `gcTime: 5 minutes` — keep unused cache in memory for 5 min
- `retry: 1`
- `refetchOnWindowFocus: false`
- `refetchOnReconnect: false`

### 3.6 Context Providers

**`LocationProvider`** (`lib/locationContext.tsx`):
- Stores the currently selected branch: `{ id, type: 'outlet'|'warehouse', name }`
- Persisted in `localStorage` — survives page reload
- Required before accessing any `/sales/*` page (enforced by `LocationPicker`)

**`ThemeProvider`** (`lib/theme.tsx`):
- Light / dark mode toggle
- Defaults to light mode on fresh session (sessionStorage)

### 3.7 API Client

Auto-generated hooks from `@workspace/api-client-react` (generated from OpenAPI spec via orval). Each endpoint produces a typed hook, e.g.:
- `useListSales()`, `useGetSale(id)`, `useCreateSale()`
- `useListEmployees()`, `useGetMe()`
- `useApproveStockTransfer()`, `useListItemPrices()`

Custom hand-written hooks live in `lib/api-client-react/src/` for endpoints not covered by codegen.

### 3.8 Permissions (Frontend)

`usePermission(moduleKey)` returns:
```ts
{ canView, canAdd, canEdit, canDelete, canDownload, isLoading }
```
- **Level 1 hierarchy** → always returns full access (`true` for all)
- **Other levels** → fetches from `GET /api/company/permissions`, matches `hierarchyId + moduleKey`
- **No row found** → all flags `false` (default deny)

Used in every page to:
- Hide sidebar links the user cannot view
- Disable add/edit/delete buttons
- Hide export (download) buttons

### 3.9 Search & Filters

Each page implements local state-based filtering:
- Text search inputs filter displayed rows client-side
- Date range pickers filter server-fetched data via query params
- Dropdown selects filter by category (outlet, payment mode, status, etc.)
- Global search: `GET /api/search?q=` — searches across sales, customers, vendors, items, employees, productions

### 3.10 Export

Pages with `canDownload` permission expose a CSV export button implemented via `lib/download.ts` → `downloadCSV()`. No server-side export endpoints — CSV is generated client-side from fetched data.

---

## 4. Backend Structure

### 4.1 Server Startup (`index.ts`)

On every startup, `index.ts`:
1. Runs idempotent `ALTER TABLE` migrations (add missing columns)
2. Creates tables that are not managed by Drizzle (`payments`, `receipts`, `sale_payments`, `reconciliation_batches`, `reconciliation_batch_items`, `cash_deposits`, `migration_log`)
3. Seeds Tally-standard Chart of Accounts system groups and standard ledgers (idempotent by code lookup)
4. Seeds the default `admin` user (level-1 hierarchy)
5. Migrates any plaintext passwords to bcrypt
6. Runs one-time backfill migrations tracked in `migration_log`
7. Creates performance indexes
8. Starts the HTTP server on `$PORT`

### 4.2 Express App (`app.ts`)

Middleware stack (in order):
1. `cors` — configured for the Replit dev domain; `allowedHosts: true`
2. `express.json({ limit: '10mb' })`
3. `express.urlencoded({ extended: true })`
4. `pino-http` logger
5. All routes mounted via `routes/index.ts` under `/api`
6. Public invoice routes (`/public/invoice/:token`) — exempt from auth
7. 404 handler → `{ error: 'Not found' }`
8. Global error handler → `{ error: message }` with appropriate status

### 4.3 Route Organisation

Routes are split into one file per domain and mounted in `routes/index.ts`:

| File | Domain |
|---|---|
| `auth.ts` | Login, logout, /me, profile, change password |
| `dashboard.ts` | KPI summary, stock alerts, activity, sales trend, top items |
| `sales.ts` | Sales CRUD, item prices, summary |
| `payments.ts` | Sale payment recording |
| `returns.ts` | Sales returns, purchase returns, outstanding |
| `customers.ts` | Customers, vendors, coupons, ledgers, vendor payments |
| `purchases.ts` | Purchase orders, GRN |
| `production.ts` | Production batches, reports |
| `bom.ts` | Bill of Materials templates |
| `inventory.ts` | Materials, raw materials |
| `branches.ts` | Warehouses, outlets |
| `stock.ts` | Stock view, stock ledger, stock transfers (dispatch/approve/reject) |
| `inventory-batches.ts` | Batch-level stock (FEFO, lot numbers, expiry) |
| `accounts.ts` | Receipts, payments, expenses, location expenses, financial statements, ledger statements, GST summary, opening balances |
| `journal.ts` | Journal vouchers, day book, cash-bank book, trial balance |
| `payments.ts` | Sale payment records |
| `reconciliation.ts` | Bank reconciliation batches |
| `cash-in-outlet.ts` | Cash balance view, cash deposits |
| `hr.ts` | Employees, hierarchies, attendance, payroll, advances, leaves |
| `gst.ts` | HSN summary, GSTR-1, GSTR-3B, GST reconciliation |
| `company.ts` | Company settings, permissions, login history, reset |
| `audit.ts` | Audit log |
| `reports.ts` | Sales register, purchase register, profitability, and more |
| `pdfGen.ts` | Invoice PDF generation |
| `publicInvoices.ts` | HMAC-signed public invoice links |
| `search.ts` | Global search |
| `health.ts` | Health check |

### 4.4 Middleware

**`requireAuth`** (global on all `/api/*` routes except `/api/health` and `/api/public/*`):
- Reads `Authorization: Bearer <token>` header
- Verifies JWT signature and expiry (8-hour tokens)
- Attaches `req.user = { id, username, hierarchyId, hierarchyLevel, branchType, branchId }` to the request
- Returns `401` if token is missing, invalid, or expired

**`requireModuleView(module | module[])`**:
- Checks `canView` permission for the given module key(s)
- Level-1 users bypass (always allowed)
- Returns `403` if no view permission

**`requireModuleAction(module | module[], action)`**:
- Checks `canAdd` / `canEdit` / `canDelete` for the given module key(s)
- Level-1 users bypass (always allowed)
- Returns `403` if permission is denied

### 4.5 Authentication

- **Algorithm:** JWT signed with `SESSION_SECRET` (env var)
- **Expiry:** 8 hours
- **Password hashing:** `bcryptjs` (10 salt rounds)
- **Rate limiting:** Login endpoint rate-limited (5 attempts per 15 minutes per IP)
- **mustChangePassword:** Set `true` on first-login or admin reset; all non-auth routes return `403` with `{ mustChangePassword: true }` until resolved
- **Login history:** Every login attempt (success/fail) recorded with IP, user-agent, timestamp

### 4.6 RBAC

Role-based access is implemented through the `permissions` table:

```
permissions (hierarchyId, module, canView, canAdd, canEdit, canDelete, canDownload)
```

- **Level 1 hierarchy** → full access hardcoded in middleware (no DB lookup)
- **All other levels** → permission row fetched; defaults to `false` if no row exists (default deny)
- **Multi-module guards** → `requireModuleAction(['Sales', 'Point of Sale'], 'add')` — passes if user has action permission in ANY of the listed modules

### 4.7 Data Scope

The backend does not enforce branch-level row filtering on most GET routes — that is handled by the frontend's `LocationProvider`. However:
- Stock endpoints filter by `branchType` / `branchId` query params
- Sales can be scoped to `location_type` + `location_id`
- HR attendance is scoped to `employeeId`
- Payroll is scoped to `employeeId`

### 4.8 Validation

All request bodies are validated with **Zod** schemas. Schemas are shared via `@workspace/api-zod`. Validation failures return `400 { error: "<message>" }`.

### 4.9 Error Handling

- Route-level try/catch → explicit status + `{ error: message }`
- Global error handler catches anything uncaught → `500 { error: "Internal server error" }`
- Zod parse failures → `400`
- Auth failures → `401`
- Permission failures → `403`
- Not found → `404`

### 4.10 Audit Logging

Every mutating API call (POST, PUT, PATCH, DELETE) is logged to the `activity_log` table with:
- `action` (create/update/delete)
- `entity` (module name)
- `entity_id`
- `user` (username)
- `details` (JSON diff of changed data)
- `created_at`

### 4.11 Database Access

- Drizzle ORM for schema-defined tables (type-safe queries)
- Raw `pool.query()` for startup-migration tables (payments, receipts, sale_payments, etc.) — Drizzle cannot see columns added via `ALTER TABLE`
- Transactions used for multi-table atomic operations (stock transfer approve/reject, payroll posting to COA)

---

## 5. Database Structure

### Drizzle-Managed Tables

---

#### `company_settings`
**Purpose:** Single-row company configuration  
**Key columns:** `company_name`, `address`, `state`, `gst_number`, `pan_number`, `bank_name`, `bank_account`, `ifsc_code`, `logo_url`, `invoice_prefix`, `invoice_sequence`, `fy_start_month`, `voucher_prefixes (jsonb)`, `production_overhead_percent`  
**Used by:** Settings, invoice PDFs, GST calculations, payroll COA

---

#### `warehouses`
**Purpose:** Warehouse (secondary distribution centre) master  
**Key columns:** `id`, `name`, `state`, `gst_number`, `address`, `upi_id`, `cash_ledger_id`, `sales_ledger_id`, `purchase_ledger_id`  
**Relationships:** `outlets.warehouse_id → warehouses.id`  
**Used by:** Branches, stock entries, stock transfers, sales, cash deposits

---

#### `outlets`
**Purpose:** Retail outlet master  
**Key columns:** `id`, `name`, `warehouse_id`, `address`, `phone`, `upi_id`, `cash_ledger_id`, `sales_ledger_id`  
**Relationships:** `outlets.warehouse_id → warehouses.id`  
**Used by:** Sales, stock entries, item prices, cash in outlet

---

#### `vendors`
**Purpose:** Supplier / vendor master  
**Key columns:** `id`, `name`, `phone`, `email`, `gst_number`, `state`, `bank_name`, `account_number`  
**Relationships:** `purchases.vendor_id → vendors.id`; auto-creates `account_ledgers` row (`VEND-{id}`)  
**Used by:** Purchases, accounts (Sundry Creditors), vendor payments

---

#### `customers`
**Purpose:** Customer master  
**Key columns:** `id`, `name`, `phone`, `email`, `gst_number`, `state`, `total_purchases`, `location_type`, `location_id`  
**Relationships:** Auto-creates `account_ledgers` row (`CUST-{id}`)  
**Used by:** Sales, outstanding receivables, credit limit enforcement

---

#### `materials`
**Purpose:** Packaging and processing material master (used in production)  
**Key columns:** `id`, `name`, `unit`, `current_stock`, `hsn_code`, `tax_rate`, `cost`, `avg_cost`  
**Used by:** Production (material consumption), purchases, BOM templates

---

#### `raw_materials`
**Purpose:** Raw ingredient master  
**Key columns:** `id`, `name`, `unit`, `current_stock`, `hsn_code`, `tax_rate`, `cost`, `avg_cost`  
**Used by:** Production, purchases, BOM templates

---

#### `items`
**Purpose:** Finished goods item master  
**Key columns:** `id`, `name`, `hsn_code`, `tax_rate`, `unit`, `production_stock`, `mrp`, `cost`  
**Relationships:** `stock_entries.item_id`, `item_prices.item_id`, `productions.item_id`, `sales.line_items` (embedded JSON)  
**Used by:** Production, sales, stock, item prices

---

#### `stock_entries`
**Purpose:** Current stock quantity per item per branch (truth table for stock levels)  
**Key columns:** `id`, `item_id`, `branch_type` ('outlet'|'warehouse'|'headoffice'), `branch_id`, `quantity`, `cost_price`  
**Relationships:** `item_id → items.id`  
**Used by:** Stock view, sales (deduction), stock transfers, production

---

#### `item_prices`
**Purpose:** Location-specific selling prices with optional validity period  
**Key columns:** `id`, `item_id`, `outlet_id` (generic location ID), `location_type` ('outlet'|'warehouse'|'headoffice'), `price`, `valid_from`, `valid_to`  
**Note:** `valid_from`, `valid_to`, `location_type` are startup-migration columns — read/written via raw SQL  
**Used by:** Item Prices page, POS

---

#### `purchases`
**Purpose:** Purchase orders from vendors  
**Key columns:** `id`, `vendor_id`, `purchase_date`, `invoice_number`, `line_items (jsonb)`, `total_amount`, `tax_total`, `discount_total`, `round_off`, `notes`  
**Relationships:** `vendor_id → vendors.id`  
**Used by:** Purchases, inventory replenishment, GST input credit

---

#### `productions`
**Purpose:** Production batch records  
**Key columns:** `id`, `item_id`, `produced_quantity`, `production_date`, `material_used (jsonb)`, `material_cost`, `overhead_percent`, `overhead_amount`, `total_cost`, `cost_per_unit`, `wastage (jsonb)`, `wastage_qty`, `wastage_value`  
**Relationships:** `item_id → items.id`  
**Used by:** Production module, inventory (stock credit), production reports

---

#### `sales`
**Purpose:** Sales invoices  
**Key columns:** `id`, `invoice_number`, `outlet_id` (nullable), `location_type`, `location_id`, `customer_id`, `sale_date`, `line_items (jsonb)`, `subtotal`, `tax_total`, `discount_total`, `total_amount`, `payment_mode`, `coupon_code`, `payment_status` ('unpaid'|'partially_paid'|'paid'), `amount_paid`  
**Relationships:** `customer_id → customers.id`, `outlet_id → outlets.id`  
**Used by:** Sales, POS, outstanding, GST, reconciliation, financial statements

---

#### `stock_transfers`
**Purpose:** Inter-branch stock transfer challan  
**Key columns:** `id`, `challan_number`, `from_type`, `from_id`, `to_type`, `to_id`, `transfer_date`, `line_items (jsonb)`, `is_interstate`, `status` ('in_transit'|'approved'|'rejected'), `approved_by`, `approved_at`, `received_line_items (jsonb)`, `rejection_reason`  
**Used by:** Stock Transfer module (dispatch, approve, reject)

---

#### `employees`
**Purpose:** Employee master (also used for ERP login)  
**Key columns:** `id`, `name`, `username`, `password_hash`, `email`, `phone`, `hierarchy_id`, `branch_type`, `branch_id`, `salary`, `join_date`, `photo_url`, `is_active`, `must_change_password`, `work_experience (jsonb)`  
**Relationships:** `hierarchy_id → hierarchies.id`  
**Used by:** Auth, HR, payroll, attendance, permissions

---

#### `hierarchies`
**Purpose:** Role/level definitions  
**Key columns:** `id`, `name`, `level`, `description`  
**Note:** Level 1 = super-admin with full access  
**Used by:** Employees, permissions, RBAC middleware

---

#### `permissions`
**Purpose:** RBAC — module-level permission flags per hierarchy level  
**Key columns:** `id`, `hierarchy_id`, `module` (key from moduleRegistry), `can_view`, `can_add`, `can_edit`, `can_delete`, `can_download`  
**Relationships:** `hierarchy_id → hierarchies.id`  
**Used by:** All pages (usePermission hook), all write endpoints (requireModuleAction)

---

#### `account_ledgers`
**Purpose:** Chart of Accounts — hierarchical double-entry ledger tree  
**Key columns:** `id`, `name`, `type` ('asset'|'liability'|'income'|'expense'|'equity'), `parent_id`, `code`, `section` ('balance_sheet'|'profit_loss'), `is_system_group`, `is_group`, `bank_details (jsonb)`, `description`  
**Standard system codes:** SYS-CAP, SYS-LOAN, SYS-CURL, SYS-FIXD, SYS-CURA, SYS-SAL, SYS-PUR, SYS-DIREXP, SYS-INDEXP, SYS-DIRINC, SYS-INDINC  
**Standard ledger codes:** STD-SALES, STD-PUR, STD-BANK, STD-CASH, STD-DTX, SYS-DEBTORS, SYS-CREDITORS  
**Used by:** All accounting modules

---

#### `expenses`
**Purpose:** Direct expense entries (linked to a ledger account)  
**Key columns:** `id`, `ledger_account_id`, `payment_account_id`, `amount`, `expense_date`, `description`  
**Used by:** Accounts Expenses, Location Expenses

---

#### `payroll` *(HR-managed)*
**Key columns:** `id`, `employee_id`, `month`, `year`, `base_salary`, `working_days`, `present_days`, `lop_days`, `lop_deduction`, `gross_pay`, `allowances_total`, `allowances_breakdown (jsonb)`, `deductions (jsonb)`, `net_pay`, `bonus`, `total_amount`, `is_paid`, `paid_date`

---

#### `pay_components` *(HR-managed)*
**Key columns:** `id`, `employee_id`, `working_days_per_month`, `allowances (jsonb)`, `deductions (jsonb)`

---

#### `attendance` *(HR-managed)*
**Key columns:** `id`, `employee_id`, `date`, `check_in`, `check_out`, `check_in_lat`, `check_in_lng`, `check_out_lat`, `check_out_lng`, `status`

---

#### `leaves` *(HR-managed)*
**Key columns:** `id`, `employee_id`, `from_date`, `to_date`, `leave_type`, `reason`, `status` ('pending'|'approved'|'rejected'), `approved_by`, `approval_note`

---

#### `stock_batches` *(inventory batches)*
**Purpose:** Lot-level stock tracking with expiry dates (FEFO allocation)  
**Key columns:** `id`, `item_id`, `branch_type`, `branch_id`, `batch_number`, `mfg_date`, `expiry_date`, `quantity`, `unit_cost`, `source`, `source_id`

---

#### `stock_verifications`
**Purpose:** Physical stock count records  
**Key columns:** `id`, `branch_type`, `branch_id`, `verify_date`, `notes`, `created_by`

---

#### `bom_templates`
**Purpose:** Bill of Materials per finished good item  
**Key columns:** `id`, `item_id`, `lines (jsonb)`, `notes`

---

### Startup-Migration Tables (not in Drizzle schema)

| Table | Purpose |
|---|---|
| `payments` | Payment vouchers (Dr/Cr between ledgers) |
| `receipts` | Receipt vouchers (Dr/Cr between ledgers) |
| `sale_payments` | Individual payment receipts against a sale (cash/UPI/card/credit) |
| `reconciliation_batches` | Bank settlement batches for digital payments |
| `reconciliation_batch_items` | Individual sale payments within a reconciliation batch |
| `cash_deposits` | Cash physically deposited from outlet/warehouse to bank |
| `migration_log` | One-time migration guard (prevents re-run on restart) |

---

## 6. ERP Modules

### 6.1 Dashboard

**Purpose:** Executive overview of business health  
**Features:** Revenue KPIs, sales trend chart, production activity, stock alerts, recent activity feed, sales by location, top-selling items  
**Pages:** `/`  
**APIs:** `GET /api/dashboard/summary`, `/sales-trend`, `/stock-alerts`, `/recent-activity`, `/top-items`, `/sales-by-location`, `/production-trend`  
**Tables:** `sales`, `productions`, `stock_entries`, `activity_log`

---

### 6.2 Point of Sale (Operations)

**Purpose:** Location-gated sales creation at outlet or warehouse  
**Features:** Item selection, GST-inclusive pricing, coupon discount, payment mode selection (cash/UPI/card/credit), credit limit enforcement for credit customers, invoice PDF, WhatsApp share  
**Pages:** `/sales/pos` (location picker at `/sales`), `/sales/dashboard`, `/sales/stock`  
**APIs:** `POST /api/sales`, `GET /api/sales`, `PUT /api/sales/:id`, `GET /api/sales/:id/payments`, `POST /api/sales/:id/payments`  
**Tables:** `sales`, `sale_payments`, `stock_entries`, `customers`, `item_prices`, `coupons`

---

### 6.3 Sales (Head Office)

**Purpose:** Head-office view of all sales across locations  
**Features:** Full sales list with invoice view, PDF download, WhatsApp share, payment status tracking  
**Pages:** `/headoffice/sales` (with slide-out detail sheet)  
**APIs:** `GET /api/sales`, `GET /api/sales/:id`, `POST /api/sales/:id/share-token`  
**Tables:** `sales`, `sale_payments`, `customers`, `outlets`

---

### 6.4 Returns

**Purpose:** Credit notes (sales returns) and debit notes (purchase returns)  
**Features:** Sales return recording, purchase return recording, notes listed by type  
**Pages:** `/returns`  
**APIs:** `POST /api/sales-returns`, `GET /api/sales-returns`, `POST /api/purchase-returns`, `GET /api/purchase-returns`  
**Tables:** `sales`, `purchases`, `account_ledgers` (credit/debit note postings)

---

### 6.5 Outstanding

**Purpose:** Receivables and payables tracking  
**Features:** Outstanding receivables per customer, outstanding payables per vendor, collections register  
**Pages:** `/outstanding`  
**APIs:** `GET /api/outstanding/receivables`, `/payables`, `/collections`  
**Tables:** `sales`, `sale_payments`, `customers`, `vendors`, `purchases`

---

### 6.6 Customers

**Purpose:** Customer master management  
**Features:** Add/edit/delete customers, view individual customer ledger statement  
**Pages:** `/customers`  
**APIs:** `GET/POST /api/customers`, `PATCH/DELETE /api/customers/:id`, `GET /api/customers/:id/ledger`  
**Tables:** `customers`, `account_ledgers` (CUST-{id}), `sales`

---

### 6.7 Vendors

**Purpose:** Supplier master management  
**Features:** Add/edit/delete vendors, view vendor ledger, record vendor payment  
**Pages:** `/vendors`  
**APIs:** `GET/POST /api/vendors`, `PATCH/DELETE /api/vendors/:id`, `GET /api/vendors/:id/ledger`, `POST /api/vendors/:id/payment`  
**Tables:** `vendors`, `account_ledgers` (VEND-{id}), `purchases`

---

### 6.8 Coupons

**Purpose:** Discount coupon management  
**Features:** Create coupons (fixed ₹ or % discount), set validity period, track usage count  
**Pages:** `/coupons`  
**APIs:** `GET/POST /api/coupons`, `PATCH/DELETE /api/coupons/:id`  
**Tables:** `coupons`

---

### 6.9 Item Master

**Purpose:** Finished goods catalogue  
**Features:** Add/edit items with HSN code, GST rate, unit of measure, MRP, cost  
**Pages:** `/production/item-master`  
**APIs:** `GET/POST /api/items`, `PATCH/DELETE /api/items/:id`  
**Tables:** `items`

---

### 6.10 Units

**Purpose:** Unit of measure master  
**Features:** Add/edit units (kg, litre, piece, etc.)  
**Pages:** `/production/units`  
**APIs:** `GET/POST /api/units`, `PATCH /api/units/:id`  
**Tables:** `units` (within Drizzle schema)

---

### 6.11 Item Prices

**Purpose:** Location-specific retail price configuration  
**Features:** Set prices per Head Office / Warehouse / Outlet; optional validity date range (valid from / valid to); three-step location selector (type → location → price); Active/Inactive badge based on date  
**Pages:** `/headoffice/item-price`  
**APIs:** `GET /api/item-prices`, `POST /api/item-prices`  
**Tables:** `item_prices` (with startup-migration columns: `valid_from`, `valid_to`, `location_type`)

---

### 6.12 Production (Batches)

**Purpose:** Recording finished goods production  
**Features:** Create production batches (item, quantity, production date, materials used, wastage), cost calculation (material cost + overhead %), BOM template comparison  
**Pages:** `/production/production`, `/production/reports`  
**APIs:** `GET/POST /api/productions`, `GET/PATCH/DELETE /api/productions/:id`, `GET /api/productions/reports`  
**Tables:** `productions`, `items`, `materials`, `raw_materials`, `stock_entries`

---

### 6.13 Bill of Materials (BOM)

**Purpose:** Material recipe templates per finished good  
**Features:** Define expected material quantities per unit of production; used as a reference during batch creation  
**APIs:** `GET /api/bom-templates`, `GET /api/bom-templates/item/:itemId`, `POST /api/bom-templates`, `PUT /api/bom-templates/:id`, `DELETE /api/bom-templates/:id`  
**Tables:** `bom_templates`, `items`, `materials`, `raw_materials`

---

### 6.14 Purchases

**Purpose:** Purchase order management from vendors  
**Features:** Create POs with line items, GST amounts, discount, round-off; PDF generation; stock credit on purchase  
**Pages:** `/production/purchase`  
**APIs:** `GET/POST /api/purchases`, `GET/PATCH/DELETE /api/purchases/:id`, `GET /api/purchases/:id` (PDF)  
**Tables:** `purchases`, `vendors`, `materials`, `raw_materials`, `stock_entries`

---

### 6.15 Material Master

**Purpose:** Packaging/processing material master  
**Features:** Add/edit materials with unit, HSN, tax rate, cost, average cost, current stock  
**APIs:** `GET/POST /api/materials`, `GET/PATCH/DELETE /api/materials/:id`  
**Tables:** `materials`

---

### 6.16 Raw Material Master

**Purpose:** Raw ingredient master  
**Features:** Add/edit raw materials with unit, HSN, tax rate, cost, current stock  
**APIs:** `GET/POST /api/raw-materials`, `GET/PATCH/DELETE /api/raw-materials/:id`  
**Tables:** `raw_materials`

---

### 6.17 Stock

**Purpose:** Current stock view per outlet/warehouse  
**Features:** View stock levels per item per branch, filter by location  
**Pages:** `/headoffice/stock` (also accessible as `/sales/stock` in Operations context)  
**APIs:** `GET /api/stock?branchType=&branchId=`  
**Tables:** `stock_entries`, `items`, `outlets`, `warehouses`

---

### 6.18 Stock Transfer

**Purpose:** Inter-branch stock movement (challan-based)  
**Features:** Dispatch stock from one branch to another (deducts source immediately), receiving branch approves with actual received quantities, reject option restores source stock; interstate/intrastate classification; GST journal entries auto-created on approve  
**Pages:** `/transfers` (Operations), `/production/stock-transfers` (Production)  
**APIs:** `GET/POST /api/stock/transfers`, `PATCH /api/stock/transfers/:id/approve`, `PATCH /api/stock/transfers/:id/reject`, `GET /api/stock/transfers/:id`  
**Tables:** `stock_transfers`, `stock_entries`, `account_ledgers` (GST/branch debtor/creditor JVs)

---

### 6.19 Stock Ledger

**Purpose:** Append-only audit trail of all stock movements  
**Features:** View every stock entry (sale, purchase, transfer in/out, adjustment) per item per branch  
**Pages:** `/headoffice/stock-ledger`  
**APIs:** `GET /api/stock/ledger`  
**Tables:** `stock_ledger` (append-only audit table)

---

### 6.20 Stock Verification

**Purpose:** Physical stock count recording  
**Features:** Record a verification event per branch with notes  
**Pages:** `/headoffice/stock-verification`  
**Tables:** `stock_verifications`

---

### 6.21 Inventory Reports

**Purpose:** Cross-branch inventory reporting  
**Features:** Stock summary across all outlets and warehouses, batch expiry view  
**Pages:** `/headoffice/inventory-reports`  
**APIs:** `GET /api/stock`, `GET /api/stock/batches`  
**Tables:** `stock_entries`, `stock_batches`, `items`

---

### 6.22 Warehouses

**Purpose:** Warehouse master management  
**Features:** Add/edit/delete warehouses; auto-provisions cash/sales/purchase ledgers per warehouse  
**Pages:** `/headoffice/warehouses`  
**APIs:** `GET/POST /api/warehouses`, `PATCH/DELETE /api/warehouses/:id`  
**Tables:** `warehouses`, `account_ledgers`

---

### 6.23 Outlets

**Purpose:** Retail outlet master management  
**Features:** Add/edit/delete outlets; auto-provisions cash and sales ledgers per outlet  
**Pages:** `/headoffice/outlets`  
**APIs:** `GET/POST /api/outlets`, `PATCH/DELETE /api/outlets/:id`  
**Tables:** `outlets`, `account_ledgers`

---

### 6.24 Location Expenses

**Purpose:** Branch-level expense recording  
**Features:** Record expenses at outlet/warehouse level; categorised by expense ledger; summary and detail views  
**Pages:** `/sales/expenses`  
**APIs:** `GET/POST /api/accounts/location-expenses`, `GET /api/accounts/location-expenses/summary`, `GET /api/accounts/location-expenses/all`, `DELETE /api/accounts/location-expenses/:id`  
**Tables:** `expenses`, `account_ledgers`

---

### 6.25 Cash Balance

**Purpose:** Cash in hand across outlets and warehouses  
**Features:** View cash balance per location, record cash deposit to bank, deposit status tracking  
**Pages:** `/accounts/cash-in-outlet` (Operations), `/sales/cash-balance` (POS view)  
**APIs:** `GET /api/cash-in-outlet`, `GET/POST /api/cash-in-outlet/deposits`, `POST /api/cash-in-outlet/deposits/:id/reconcile`  
**Tables:** `cash_deposits`, `account_ledgers`, `outlets`, `warehouses`

---

### 6.26 Employees

**Purpose:** Employee master for HR and ERP login  
**Features:** Add/edit/delete employees, assign hierarchy level and branch, set pay components, upload photo, record work experience  
**Pages:** `/hr/employees`  
**APIs:** `GET/POST /api/hr/employees`, `GET/PATCH/DELETE /api/hr/employees/:id`  
**Tables:** `employees`, `hierarchies`, `pay_components`

---

### 6.27 Hierarchy

**Purpose:** Organisational level definitions  
**Features:** Add/edit/delete hierarchy levels (e.g., Management, Supervisor, Staff); Level 1 is always super-admin  
**Pages:** `/hr/hierarchy`  
**APIs:** `GET/POST /api/hr/hierarchies`, `PATCH/DELETE /api/hr/hierarchies/:id`  
**Tables:** `hierarchies`

---

### 6.28 Attendance

**Purpose:** Employee attendance tracking  
**Features:** Check-in / check-out with GPS coordinates, attendance history, status flags  
**Pages:** `/hr/attendance`  
**APIs:** `GET /api/hr/attendance`, `POST /api/hr/attendance/check-in`, `POST /api/hr/attendance/check-out`  
**Tables:** `attendance`, `employees`

---

### 6.29 Leave

**Purpose:** Leave request management  
**Features:** Employees submit leave requests; managers approve or reject with notes; accessed from Attendance page  
**APIs:** `GET /api/hr/leaves`, `POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve`  
**Tables:** `leaves`, `employees`

---

### 6.30 Payroll

**Purpose:** Monthly payroll processing  
**Features:** Generate payroll per employee (working days × salary ÷ month days, LOP deductions, allowances, deductions, bonus); draft → approved → paid workflow; auto-posts to salary expense ledger in COA; auto-deducts outstanding advances  
**Pages:** `/hr/payroll`  
**APIs:** `GET /api/hr/payroll`, `POST /api/hr/payroll/generate`, `PATCH /api/hr/payroll/:id`, `POST /api/hr/payroll/:id/approve`, `POST /api/hr/payroll/:id/pay`  
**Tables:** `payroll`, `pay_components`, `attendance`, `employees`, `account_ledgers` (salary expense + salary payable + advance)

---

### 6.31 Advances

**Purpose:** Employee salary advance management  
**Features:** Record advances; advances auto-deducted when next payroll is generated  
**Pages:** `/hr/advances`  
**APIs:** `GET /api/hr/advances`, `POST /api/hr/advances`  
**Tables:** `advances` (HR module), `employees`

---

### 6.32 Chart of Accounts

**Purpose:** Hierarchical double-entry ledger tree  
**Features:** View and manage the full account hierarchy; Tally-standard groups seeded automatically; add sub-ledgers; set opening balances  
**Pages:** `/accounts/chart`  
**APIs:** `GET /api/accounts/financial-statements`, `GET/POST /api/accounts/opening-balances`, `DELETE /api/accounts/opening-balances/:id`  
**Tables:** `account_ledgers`, `opening_balances`

---

### 6.33 Ledger

**Purpose:** Individual account ledger statement  
**Features:** Date-range ledger statement per account with Dr/Cr/balance columns  
**Pages:** `/accounts/ledger`  
**APIs:** `GET /api/accounts/ledger-statement`, `GET /api/accounts/ledger/:id/statement`  
**Tables:** `account_ledgers`, derived from all voucher tables

---

### 6.34 Vouchers

**Purpose:** Manual double-entry journal vouchers  
**Features:** Create journal vouchers (debit/credit pairs), list all vouchers, delete  
**Pages:** `/accounts/vouchers`  
**APIs:** `GET/POST /api/accounts/journal-vouchers`, `DELETE /api/accounts/journal-vouchers/:id`  
**Tables:** `journal_entries`, `journal_entry_lines`, `account_ledgers`

---

### 6.35 Books

**Purpose:** Accounting books  
**Features:**  
- **Day Book** — all transactions in date order  
- **Cash Book** — cash account movements  
- **Bank Book** — bank account movements  
- **Trial Balance** — debit/credit totals per account  
**Pages:** `/accounts/day-book`, `/accounts/cash-book`, `/accounts/bank-book`, `/accounts/trial-balance`  
**APIs:** `GET /api/accounts/day-book`, `GET /api/accounts/cash-bank-book`, `GET /api/accounts/trial-balance`

---

### 6.36 Payments & Receipts

**Purpose:** Payment and receipt vouchers  
**Features:** Record payments (bank/cash out), receipts (bank/cash in); linked to COA ledgers  
**APIs:** `GET/POST /api/accounts/receipts`, `DELETE /api/accounts/receipts/:id`, `GET/POST /api/accounts/cash-bank`  
**Tables:** `receipts`, `payments`, `account_ledgers`

---

### 6.37 Expenses (Accounts)

**Purpose:** Head-office level expense recording  
**Pages:** `/accounts/expenses`  
**APIs:** `GET /api/expenses`, `POST /api/expenses`, `GET /api/accounts/expense-ledgers`  
**Tables:** `expenses`, `account_ledgers`

---

### 6.38 GST

**Purpose:** GST compliance reporting  
**Features:**  
- **GST Summary** — output/input GST by rate slab  
- **GST Returns** — GSTR-1 (sales) and GSTR-3B (summary return)  
- **HSN Summary** — turnover and tax by HSN code  
**Pages:** `/accounts/gst`, `/accounts/gst-returns`  
**APIs:** `GET /api/gst/summary`, `GET /api/gst/hsn-summary`, `GET /api/gst/gstr1`, `GET /api/gst/gstr3b`, `GET /api/gst/reconciliation`  
**Tables:** `sales`, `purchases`, `account_ledgers` (GST ledgers)

---

### 6.39 Reconciliation

**Purpose:** Bank reconciliation for digital payments (UPI, card)  
**Features:** View pending unreconciled payments, create settlement batch, mark individual payments as reconciled  
**Pages:** `/accounts/reconciliation`  
**APIs:** `GET /api/reconciliation/bank-ledgers`, `GET /api/reconciliation/pending`, `GET/POST /api/reconciliation/batches`, `GET /api/reconciliation/batches/:id`  
**Tables:** `reconciliation_batches`, `reconciliation_batch_items`, `sale_payments`

---

### 6.40 Reports

**Purpose:** Analytical reports centre  
**Features:** 7 report sections, each with date-range filters and CSV export  
**Pages:** `/reports/sales` (and sub-sections)  
**Report sections:**  
- **Sales Reports** — sales register, sales by item, sales by location, discounts report, combined stock-sales  
- **Purchase Reports** — purchase register, purchases by vendor, purchases by material  
- **Financial Reports** — financial statements (P&L, Balance Sheet)  
- **Inventory Reports** — stock summary  
- **Production Reports** — production batches  
- **Profitability Reports** — item-level profitability  
- **Parties Reports** — customer and vendor summaries  
**APIs:** `GET /api/reports/sales-register`, `/sales-by-item`, `/sales-by-location`, `/discounts`, `/purchase-register`, `/purchases-by-vendor`, `/purchases-by-material`, `/profitability`, `/sales-stock-combined`

---

### 6.41 Company Settings

**Purpose:** Company profile and ERP configuration  
**Features:** Edit company name, address, GST/PAN, bank details, logo, invoice prefix, financial year start  
**Pages:** `/company/settings`, `/company/profile`  
**APIs:** `GET/PATCH /api/company/settings`  
**Tables:** `company_settings`

---

### 6.42 Permissions

**Purpose:** Role-based access control configuration  
**Features:** Set canView/canAdd/canEdit/canDelete/canDownload per module per hierarchy level  
**Pages:** `/company/permissions`  
**APIs:** `GET /api/company/permissions`, `POST /api/company/permissions`  
**Tables:** `permissions`, `hierarchies`

---

### 6.43 Audit Log

**Purpose:** Full mutation audit trail  
**Features:** View all create/update/delete actions with user, timestamp, entity, and data diff  
**Pages:** `/company/audit`  
**APIs:** `GET /api/audit/logs`, `GET /api/audit/logs/:id`  
**Tables:** `activity_log`

---

### 6.44 Login History

**Purpose:** Security audit of login events  
**Features:** View all login attempts (success/fail) with IP address, user-agent, timestamp  
**Pages:** `/company/login-history`  
**APIs:** `GET /api/company/login-history`  
**Tables:** `login_history`

---

## 7. Business Flow

### Purchase → Production → Sales Flow

```
Vendor ──► PURCHASE ORDER ──► Goods received
                                    │
                            Stock credit to inventory
                            (materials / raw materials)
                                    │
                            PRODUCTION BATCH
                            ├── Materials consumed (stock deducted)
                            ├── Wastage recorded
                            ├── Cost calculated (material + overhead %)
                            └── Finished goods stock credited
                                    │
                            ITEM PRICES set per location
                                    │
                    STOCK TRANSFER (if outlet/warehouse needs stock)
                    ├── Source stock deducted immediately (dispatch)
                    ├── Status: in_transit
                    └── Destination approves → stock credited
                            │
                    POINT OF SALE (outlet or warehouse)
                    ├── Item selected → price fetched from item_prices
                    ├── Coupon applied (if any)
                    ├── GST calculated (line-level)
                    ├── Payment: cash/UPI/card → settled immediately
                    │         credit → outstanding created
                    ├── Stock deducted from branch stock_entries
                    └── Invoice PDF generated / WhatsApp shared
```

### Payment & Reconciliation Flow

```
SALE (credit) ──► OUTSTANDING RECEIVABLE
                        │
                    Receipt recorded ──► Ledger updated
                                              │
SALE (UPI/card) ──► SALE PAYMENT ──────► Reconciliation batch
                                          (pending)
                                              │
                                    Bank settlement received
                                    RECONCILIATION BATCH created
                                    ├── Gross amount
                                    ├── Charges deducted
                                    ├── Net to bank account
                                    └── Payments marked reconciled
```

### Payroll Flow

```
ATTENDANCE records (check-in/check-out)
        │
    PAYROLL GENERATE
    ├── Count present days from attendance
    ├── Calculate LOP (Leave without Pay)
    ├── Apply pay components (allowances/deductions)
    ├── Deduct pending advances
    └── Create payroll entry (draft)
            │
        APPROVE ──► COA posting:
                    Dr. Salary Expense ledger
                    Cr. Salary Payable ledger
                    Dr. Salary Payable (for advances already paid)
                            │
                        PAY ──► Mark payroll as paid; record paid date
```

### Module Data Interdependencies

| Writes to | Read by |
|---|---|
| `sales` | Outstanding, Reconciliation, GST, Reports, Dashboard, Financial Statements |
| `stock_entries` | Stock view, POS (availability), Transfers, Dashboard alerts |
| `productions` | Production Reports, Inventory (finished goods credit), Dashboard |
| `purchases` | Inventory (material credit), GST (input credit), Vendor ledger |
| `payments` / `receipts` | Day Book, Cash Book, Bank Book, Trial Balance, Ledger |
| `account_ledgers` | All accounting pages, Trial Balance, Financial Statements |
| `attendance` | Payroll generation, HR reports |

---

## 8. Permission Structure

### 8.1 Roles (Hierarchies)

Roles are user-defined via the Hierarchy module. The only hardcoded rule is:

| Level | Behaviour |
|---|---|
| **Level 1** | Super-admin — full access to everything, no permission row needed |
| **Level 2+** | Access controlled by `permissions` table rows; default deny if no row exists |

### 8.2 Permission Model

Each permission row covers one `module` key for one `hierarchy_id`:

```
permissions {
  hierarchy_id   → which role
  module         → which feature (matches moduleRegistry key exactly)
  can_view       → see the page and data
  can_add        → create new records
  can_edit       → modify existing records
  can_delete     → delete records
  can_download   → export/download data
}
```

### 8.3 Permission Groups (as shown on Permissions page)

| Group | Modules |
|---|---|
| **Operations** | Point of Sale · Location Stock · Location Expenses · Cash Balance |
| **Production** | Units · Items · Production · Purchases · Vendors |
| **Inventory** | HO Transfers · Stock · Stock Ledger · Inventory Reports · Stock Verification · Warehouses · Outlets · Item Prices |
| **Sales** | Sales · Customers · Coupons |
| **HR** | Employees · Attendance · Leave · Payroll · Hierarchy |
| **Accounts** | Chart of Accounts · Ledger · Payments · Cash & Bank · Vouchers · Books · Expenses · GST Summary · GST Returns · Reconciliation · Accounts Cash Balance · Reports |
| **Dashboard** | Dashboard |
| **Company** | Settings · Permissions · Login History |

### 8.4 Branch Access

Employees are assigned a `branch_type` ('headoffice'|'outlet'|'warehouse') and `branch_id` at creation. The backend uses these in:
- `GET /api/stock` — filters by `branchType` + `branchId` from query params
- Attendance — scoped to `employee_id`
- Cash in outlet — outlet/warehouse scope from query params

Most list endpoints are **not** server-filtered by branch — scoping is done client-side via the `LocationProvider` context which stores the selected branch in localStorage.

### 8.5 Frontend Enforcement

`usePermission(moduleKey)` drives UI visibility:
- Sidebar links hidden if `canView = false`
- Add buttons disabled/hidden if `canAdd = false`
- Edit buttons disabled/hidden if `canEdit = false`
- Delete buttons disabled/hidden if `canDelete = false`
- Export buttons hidden if `canDownload = false`

### 8.6 Backend Enforcement

- Write routes guarded by `requireModuleAction(module, action)`
- Some read routes guarded by `requireModuleView(module)`
- Many GET routes are **unguarded** (rely on frontend permission hiding)
- Level-1 users bypass all checks

---

## 9. Accounting Structure

### 9.1 Chart of Accounts

Tally-standard double-entry structure, seeded automatically:

```
Balance Sheet
├── Capital Accounts (SYS-CAP)
├── Loans (Liability) (SYS-LOAN)
├── Current Liabilities (SYS-CURL)
│   ├── Duty & Tax (STD-DTX)
│   │   ├── Output CGST (STD-OUT-CGST)
│   │   ├── Output SGST (STD-OUT-SGST)
│   │   ├── Output IGST (STD-OUT-IGST)
│   │   ├── Input CGST (STD-INP-CGST)
│   │   ├── Input SGST (STD-INP-SGST)
│   │   └── Input IGST (STD-INP-IGST)
│   └── Sundry Creditors (SYS-CREDITORS)
│       └── VEND-{id} per vendor
├── Fixed Asset (SYS-FIXD)
└── Current Asset (SYS-CURA)
    ├── Opening Stock (SYS-OPSTOCK)
    ├── Closing Stock (SYS-CLSTOCK)
    ├── Sundry Debtors (SYS-DEBTORS)
    │   └── CUST-{id} per customer
    ├── Bank (STD-BANK)
    │   └── Sub-ledgers per bank account
    ├── Cash (STD-CASH)
    │   ├── OUTLET-CASH-{id} per outlet
    │   └── WH-CASH-{id} per warehouse
    ├── Electronic Payment Clearing (STD-ELEC-CLR)
    └── Cash in Transit (STD-CIT)

Profit & Loss
├── Sales (SYS-SAL)
│   ├── STD-SALES (auto-linked to invoices)
│   ├── OUTLET-SAL-{id} per outlet
│   └── WH-SAL-{id} per warehouse
├── Direct Income (SYS-DIRINC)
├── Indirect Income (SYS-INDINC)
├── Purchase (SYS-PUR)
│   └── STD-PUR (auto-linked to purchases)
├── Direct Expense (SYS-DIREXP)
└── Indirect Expense (SYS-INDEXP)
    └── Bank & Processor Charges (STD-PROC-CHG)
```

### 9.2 Voucher Types

| Type | Route | Dr | Cr |
|---|---|---|---|
| **Payment** | `POST /api/accounts/cash-bank` | Expense/liability ledger | Cash or Bank |
| **Receipt** | `POST /api/accounts/receipts` | Cash or Bank | Income/asset ledger |
| **Journal** | `POST /api/accounts/journal-vouchers` | Any ledger | Any ledger |
| **Sale invoice** | `POST /api/sales` | Customer / Cash / Bank | Sales + GST ledgers |
| **Purchase invoice** | `POST /api/purchases` | Purchase + Input GST | Vendor ledger |
| **Payroll** | approve | Salary Expense | Salary Payable |

### 9.3 GST

- **Output GST** collected on sales — posted to Output CGST / SGST / IGST ledgers
- **Input GST** paid on purchases — posted to Input CGST / SGST / IGST ledgers
- **GST computation:** `lineTaxHeads()` function splits line-item tax into CGST+SGST (intrastate) or IGST (interstate) based on GSTIN comparison
- **GSTR-1:** B2B and B2C invoice register
- **GSTR-3B:** Output tax − input credit = net tax payable
- **HSN Summary:** Turnover grouped by HSN code

### 9.4 Financial Statements

- **Trial Balance** — debit/credit totals per ledger, derived from all voucher tables
- **Balance Sheet** — assets, liabilities, equity from `balance_sheet` section ledgers
- **Profit & Loss** — income and expenses from `profit_loss` section ledgers
- Derived via `buildDerivedPostings()` function — aggregates all transaction tables into ledger movements

---

## 10. Inventory Structure

### 10.1 Stock Levels

**Table:** `stock_entries`  
- One row per `(item_id, branch_type, branch_id)` combination
- `quantity` = current on-hand quantity
- Updated by: purchases (credit), sales (debit), stock transfers (debit source / credit dest), production (credit)

### 10.2 Batch-Level Stock

**Table:** `stock_batches`  
- Lot-number tracking with manufacturing date and expiry date
- FEFO (First Expired First Out) allocation — oldest expiry consumed first on sales/transfers
- Source tracked: 'production' | 'purchase' | 'transfer'
- Shortfall quantity labelled as "Untracked" if batch data is incomplete

### 10.3 Stock Ledger

**Table:** `stock_ledger` (append-only)  
- Every stock movement creates a ledger entry: `doc_type` ('sale'|'purchase'|'transfer_in'|'transfer_out'|'production'|'adjustment')
- Running balance calculated via SQL window function at query time
- Used for audit trail — never modified after write

### 10.4 Stock Transfers

Three-state challan workflow:
1. **Dispatch** (`status = 'in_transit'`): Source stock immediately deducted; challan number auto-generated
2. **Approve** (`status = 'approved'`): Destination stock credited with actual received quantities; GST journal entries created (inter-state: IGST; intra-state: CGST+SGST; internal headoffice: branch debtor/creditor ledgers); `received_line_items` stored
3. **Reject** (`status = 'rejected'`): Source stock restored; `rejection_reason` stored

### 10.5 Item Prices

- Prices set per location (Head Office / Warehouse / Outlet) with optional validity window
- `location_type` column determines which location table to resolve display name from
- One price per `(item_id, outlet_id, location_type)` combination (upserted on POST)

### 10.6 Stock Verification

- Manual physical count events recorded per branch
- No automatic adjustment — informational record only

---

## 11. Complete Page List

| URL | Page Name | Module | Purpose |
|---|---|---|---|
| `/login` | Login | Auth | Credential entry + JWT issuance |
| `/change-password` | Change Password | Auth | Forced password change on first login |
| `/` | Dashboard | Dashboard | KPI overview, charts, alerts |
| `/sales` | Location Picker | Operations | Select outlet or warehouse context before POS |
| `/sales/pos` | Point of Sale | Operations | Create sales invoices at branch |
| `/sales/dashboard` | Sales Dashboard | Operations | Branch-level sales KPIs |
| `/sales/expenses` | Location Expenses | Operations | Record branch expenses |
| `/sales/cash-balance` | Sales Cash Balance | Operations | Branch cash in hand view |
| `/sales/stock` | Sales Stock | Operations | Branch stock levels |
| `/sales/transfers` | Sales Transfers | Operations | Branch-context transfer list |
| `/transfers` | Stock Transfer | Operations | Inter-branch stock transfer management |
| `/customers` | Customers | Sales | Customer master (add/edit/delete/ledger) |
| `/vendors` | Vendors | Production | Vendor master (add/edit/delete/ledger/payment) |
| `/coupons` | Coupons | Sales | Discount coupon management |
| `/returns` | Returns | Sales | Sales returns (credit notes) + purchase returns (debit notes) |
| `/outstanding` | Outstanding | Sales | Receivables and payables |
| `/production/units` | Units | Inventory | Unit of measure master |
| `/production/item-master` | Item Master | Inventory | Finished goods item catalogue |
| `/production/production` | Production Batches | Production | Batch production recording |
| `/production/reports` | Production Reports | Production | Production analytics |
| `/production/purchase` | Purchases | Production | Purchase order management |
| `/production/stock-transfers` | Stock Transfers | Production | Stock transfer management (production context) |
| `/headoffice/stock` | Stock | Inventory | Stock levels across all branches |
| `/headoffice/stock-ledger` | Stock Ledger | Inventory | Append-only stock movement audit trail |
| `/headoffice/stock-verification` | Stock Verification | Inventory | Physical stock count recording |
| `/headoffice/inventory-reports` | Inventory Reports | Inventory | Cross-branch inventory analytics |
| `/headoffice/warehouses` | Warehouses | Inventory | Warehouse master management |
| `/headoffice/outlets` | Outlets | Inventory | Outlet master management |
| `/headoffice/item-price` | Item Prices | Inventory | Location-specific item pricing |
| `/headoffice/sales` | HO Sales | Inventory | Head-office view of all sales |
| `/headoffice/payments` | HO Payments | Finance | Head-office payment management |
| `/accounts/chart` | Chart of Accounts | Accounts | Full COA tree with opening balances |
| `/accounts/ledger` | Ledger Statement | Accounts | Individual account statement |
| `/accounts/cash-bank` | Cash & Bank | Accounts | Cash and bank account management |
| `/accounts/vouchers` | Vouchers | Accounts | Manual journal vouchers |
| `/accounts/day-book` | Day Book | Accounts | All transactions in date order |
| `/accounts/cash-book` | Cash Book | Accounts | Cash account movements |
| `/accounts/bank-book` | Bank Book | Accounts | Bank account movements |
| `/accounts/trial-balance` | Trial Balance | Accounts | Debit/credit totals per account |
| `/accounts/expenses` | Expenses | Accounts | Head-office expense recording |
| `/accounts/gst` | GST Summary | Accounts | GST output/input summary |
| `/accounts/gst-returns` | GST Returns | Accounts | GSTR-1 and GSTR-3B |
| `/accounts/reconciliation` | Reconciliation | Accounts | Bank reconciliation for digital payments |
| `/accounts/cash-in-outlet` | Cash in Outlet | Accounts | Aggregate cash view + cash deposits |
| `/accounts/notes` | Credit/Debit Notes | Accounts | View issued credit and debit notes |
| `/reports/sales` | Reports Centre | Accounts | 7-section analytical reports hub |
| `/hr/employees` | Employees | HR | Employee master management |
| `/hr/hierarchy` | Hierarchy | HR | Organisational level management |
| `/hr/attendance` | Attendance | HR | Check-in/out records + leave management |
| `/hr/payroll` | Payroll | HR | Monthly payroll generation and approval |
| `/hr/advances` | Advances | HR | Employee advance management |
| `/company/settings` | Settings | Company | ERP and company configuration |
| `/company/profile` | Company Profile | Company | Company identity and branding |
| `/company/audit` | Audit Log | Company | Full mutation audit trail |
| `/company/permissions` | Permissions | Company | Role-based access control configuration |
| `/company/login-history` | Login History | Company | Security login event log |
| `/profile` | My Profile | — | Logged-in user's personal profile |

---

## 12. Complete API List

All endpoints are prefixed with `/api`. All require `Authorization: Bearer <token>` unless marked *(public)*.

### Auth
| Method | Path | Guard | Description |
|---|---|---|---|
| POST | `/auth/login` | none (rate-limited) | Authenticate, receive JWT |
| POST | `/auth/logout` | requireAuth | Invalidate session |
| GET | `/auth/me` | requireAuth | Current user + permissions |
| POST | `/auth/change-password` | requireAuth | Change own password |
| PATCH | `/auth/profile` | requireAuth | Update own profile |

### Dashboard
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard/summary` | Revenue, sales count, production, stock KPIs |
| GET | `/dashboard/sales-trend` | Daily sales over date range |
| GET | `/dashboard/stock-alerts` | Low-stock items |
| GET | `/dashboard/recent-activity` | Latest mutations across modules |
| GET | `/dashboard/top-items` | Best-selling items |
| GET | `/dashboard/sales-by-location` | Sales split by outlet/warehouse |
| GET | `/dashboard/production-trend` | Production volume over time |

### Sales
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/sales` | requireAuth | List sales (filterable) |
| POST | `/sales` | Sales/Point of Sale — add | Create sale invoice |
| GET | `/sales/summary` | requireAuth | Sales aggregates |
| GET | `/sales/:id` | requireAuth | Single sale detail |
| PUT | `/sales/:id` | Sales/Point of Sale — edit | Update sale |
| POST | `/sales/:id/share-token` | requireAuth | Generate HMAC public link |
| GET | `/sales/:id/payments` | requireAuth | Payments on a sale |
| POST | `/sales/:id/payments` | Sales/POS/Payments — add | Record payment on sale |
| GET | `/public/invoice/:token` | *(public)* | Public invoice view |

### Item Prices
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/item-prices` | requireAuth | List all item prices |
| POST | `/item-prices` | Item Prices — add | Upsert item price (by item+location+type) |

### Returns & Outstanding
| Method | Path | Guard | Description |
|---|---|---|---|
| POST | `/sales-returns` | Sales/Point of Sale — add | Create credit note |
| GET | `/sales-returns` | requireAuth | List credit notes |
| POST | `/purchase-returns` | Sales/Purchases — add | Create debit note |
| GET | `/purchase-returns` | requireAuth | List debit notes |
| GET | `/outstanding/receivables` | Customers/Sales — view | Customer outstanding |
| GET | `/outstanding/payables` | Vendors/Sales — view | Vendor outstanding |
| GET | `/outstanding/collections` | requireAuth | Collections register |

### Customers & Vendors
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/customers` | requireAuth | List customers |
| POST | `/customers` | Customers — add | Create customer |
| GET | `/customers/:id` | requireAuth | Customer detail |
| PATCH | `/customers/:id` | Customers — edit | Update customer |
| DELETE | `/customers/:id` | Customers — delete | Delete customer |
| GET | `/customers/:id/ledger` | Customers — view | Customer ledger statement |
| GET | `/vendors` | requireAuth | List vendors |
| POST | `/vendors` | Vendors — add | Create vendor |
| GET | `/vendors/:id` | requireAuth | Vendor detail |
| PATCH | `/vendors/:id` | Vendors — edit | Update vendor |
| DELETE | `/vendors/:id` | Vendors — delete | Delete vendor |
| GET | `/vendors/:id/ledger` | Vendors — view | Vendor ledger statement |
| POST | `/vendors/:id/payment` | Vendors/Payments — add | Record vendor payment |
| GET | `/coupons` | requireAuth | List coupons |
| POST | `/coupons` | Coupons — add | Create coupon |
| PATCH | `/coupons/:id` | Coupons — edit | Update coupon |
| DELETE | `/coupons/:id` | Coupons — delete | Delete coupon |

### Items & Units
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/items` | requireAuth | List finished goods |
| POST | `/items` | Items — add | Create item |
| PATCH | `/items/:id` | Items — edit | Update item |
| DELETE | `/items/:id` | Items — delete | Delete item |
| GET | `/units` | requireAuth | List units |
| POST | `/units` | Units — add | Create unit |
| PATCH | `/units/:id` | Units — edit | Update unit |
| GET | `/materials` | requireAuth | List materials |
| POST | `/materials` | Materials — add | Create material |
| GET | `/materials/:id` | requireAuth | Material detail |
| PATCH | `/materials/:id` | Materials — edit | Update material |
| DELETE | `/materials/:id` | Materials — delete | Delete material |
| GET | `/raw-materials` | requireAuth | List raw materials |
| POST | `/raw-materials` | requireAuth | Create raw material |
| PATCH | `/raw-materials/:id` | requireAuth | Update raw material |
| DELETE | `/raw-materials/:id` | requireAuth | Delete raw material |

### Production & BOM
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/productions` | requireAuth | List production batches |
| POST | `/productions` | Production — add | Create production batch |
| GET | `/productions/reports` | Production — view | Production analytics |
| GET | `/productions/:id` | requireAuth | Batch detail |
| PATCH | `/productions/:id` | Production — edit | Update batch |
| DELETE | `/productions/:id` | Production — delete | Delete batch |
| GET | `/bom-templates` | requireAuth | List BOM templates |
| GET | `/bom-templates/item/:itemId` | requireAuth | BOM for specific item |
| POST | `/bom-templates` | Production — add | Create BOM template |
| PUT | `/bom-templates/:id` | Production — edit | Update BOM template |
| DELETE | `/bom-templates/:id` | Production — delete | Delete BOM template |

### Purchases
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/purchases` | requireAuth | List purchase orders |
| POST | `/purchases` | Purchases — add | Create purchase order |
| GET | `/purchases/:id` | requireAuth | Purchase detail (+ PDF) |
| PATCH | `/purchases/:id` | Purchases — edit | Update purchase order |
| DELETE | `/purchases/:id` | Purchases — delete | Delete purchase order |

### Stock & Transfers
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/stock` | requireAuth | Stock levels by branch |
| GET | `/stock/ledger` | Stock/Inventory Reports — view | Stock audit trail |
| GET | `/stock/transfers` | HO Transfers — view | List stock transfers |
| POST | `/stock/transfers` | HO Transfers — add | Create transfer (dispatch) |
| GET | `/stock/transfers/:id` | requireAuth | Transfer detail |
| PATCH | `/stock/transfers/:id/approve` | HO Transfers — edit | Approve transfer (credit dest) |
| PATCH | `/stock/transfers/:id/reject` | HO Transfers — edit | Reject transfer (restore source) |
| GET | `/stock/batches` | requireAuth | Batch-level stock |
| POST | `/stock/batches` | requireAuth | Create stock batch |

### Accounts & Books
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/accounts/receipts` | Payments — view | List receipts |
| POST | `/accounts/receipts` | Payments — add | Create receipt |
| DELETE | `/accounts/receipts/:id` | Payments — delete | Delete receipt |
| GET | `/accounts/cash-bank` | Cash & Bank — view | Cash & bank accounts |
| POST | `/accounts/cash-bank` | Cash & Bank — add | Record cash/bank transaction |
| GET | `/accounts/ledger-statement` | Ledger — view | Ledger statement (date range) |
| GET | `/accounts/ledger/:id/statement` | requireAuth | Specific ledger statement |
| GET | `/accounts/financial-statements` | Chart of Accounts — view | Balance Sheet + P&L |
| GET | `/accounts/opening-balances` | Chart of Accounts — view | Opening balances |
| POST | `/accounts/opening-balances` | Chart of Accounts — add | Set opening balance |
| DELETE | `/accounts/opening-balances/:id` | Chart of Accounts — delete | Remove opening balance |
| GET | `/accounts/journal-vouchers` | requireAuth | List journal vouchers |
| POST | `/accounts/journal-vouchers` | Vouchers — add | Create journal voucher |
| GET | `/accounts/journal-vouchers/:id` | requireAuth | Journal voucher detail |
| DELETE | `/accounts/journal-vouchers/:id` | Vouchers — delete | Delete journal voucher |
| GET | `/accounts/day-book` | Books — view | Day book entries |
| GET | `/accounts/cash-bank-book` | Cash & Bank — view | Cash/bank book entries |
| GET | `/accounts/cash-bank-book/ledgers` | Cash & Bank — view | Cash/bank ledger list |
| GET | `/accounts/trial-balance` | Books — view | Trial balance |
| GET | `/expenses` | requireAuth | List expenses |
| POST | `/expenses` | Expenses — add | Create expense |
| GET | `/accounts/expense-ledgers` | requireAuth | Expense ledger list |
| GET | `/accounts/location-expenses` | requireAuth | Branch expenses |
| GET | `/accounts/location-expenses/summary` | requireAuth | Branch expense summary |
| GET | `/accounts/location-expenses/all` | requireAuth | All branch expenses |
| POST | `/accounts/location-expenses` | Location Expenses — add | Create branch expense |
| DELETE | `/accounts/location-expenses/:id` | Location Expenses — delete | Delete branch expense |
| GET | `/gst/summary` | GST Summary/Returns — view | GST summary |

### GST
| Method | Path | Description |
|---|---|---|
| GET | `/gst/hsn-summary` | HSN-wise tax summary |
| GET | `/gst/gstr1` | GSTR-1 (sales invoice register) |
| GET | `/gst/gstr3b` | GSTR-3B (summary return) |
| GET | `/gst/reconciliation` | GST reconciliation report |

### HR
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/hr/hierarchies` | requireAuth | List hierarchy levels |
| POST | `/hr/hierarchies` | Hierarchy — add | Create level |
| PATCH | `/hr/hierarchies/:id` | Hierarchy — edit | Update level |
| DELETE | `/hr/hierarchies/:id` | Hierarchy — delete | Delete level |
| GET | `/hr/employees` | Employees — view | List employees |
| POST | `/hr/employees` | Employees — add | Create employee |
| GET | `/hr/employees/:id` | Employees — view | Employee detail |
| PATCH | `/hr/employees/:id` | Employees — edit | Update employee |
| DELETE | `/hr/employees/:id` | Employees — delete | Deactivate employee |
| GET | `/hr/attendance` | requireAuth | Attendance records |
| POST | `/hr/attendance/check-in` | requireAuth | Record check-in |
| POST | `/hr/attendance/check-out` | requireAuth | Record check-out |
| GET | `/hr/leaves` | Leave — view | List leave requests |
| POST | `/hr/leaves` | requireAuth | Submit leave request |
| POST | `/hr/leaves/:id/approve` | Leave — edit | Approve/reject leave |
| GET | `/hr/payroll` | Payroll — view | List payroll records |
| POST | `/hr/payroll/generate` | Payroll — add | Generate payroll for month |
| PATCH | `/hr/payroll/:id` | Payroll — edit | Update payroll entry |
| POST | `/hr/payroll/:id/approve` | Payroll — edit | Approve payroll |
| POST | `/hr/payroll/:id/pay` | Payroll — edit | Mark payroll as paid |
| GET | `/hr/advances` | Payroll — view | List advances |
| POST | `/hr/advances` | Payroll — add | Record advance |

### Branches
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/warehouses` | requireAuth | List warehouses |
| POST | `/warehouses` | Warehouses — add | Create warehouse |
| GET | `/warehouses/:id` | requireAuth | Warehouse detail |
| PATCH | `/warehouses/:id` | Warehouses — edit | Update warehouse |
| DELETE | `/warehouses/:id` | Warehouses — delete | Delete warehouse |
| GET | `/outlets` | requireAuth | List outlets |
| POST | `/outlets` | Outlets — add | Create outlet |
| GET | `/outlets/:id` | requireAuth | Outlet detail |
| PATCH | `/outlets/:id` | Outlets — edit | Update outlet |
| DELETE | `/outlets/:id` | Outlets — delete | Delete outlet |

### Reconciliation & Cash
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/reconciliation/bank-ledgers` | requireAuth | Bank ledger list |
| GET | `/reconciliation/pending` | requireAuth | Pending unreconciled payments |
| GET | `/reconciliation/batches` | requireAuth | Reconciliation batches |
| GET | `/reconciliation/batches/:id` | requireAuth | Batch detail |
| POST | `/reconciliation/batches` | Reconciliation — add | Create settlement batch |
| GET | `/cash-in-outlet` | requireAuth | Cash balance by branch |
| GET | `/cash-in-outlet/deposits` | requireAuth | Cash deposit records |
| POST | `/cash-in-outlet/deposits` | Cash Balance — add | Record cash deposit |
| POST | `/cash-in-outlet/deposits/:id/reconcile` | Cash Balance/Reconciliation — edit | Reconcile deposit |

### Company & Admin
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/company/settings` | requireAuth | Company settings |
| PATCH | `/company/settings` | Settings — edit | Update settings |
| GET | `/company/login-history` | Login History/Settings — view | Login events |
| GET | `/company/permissions` | requireAuth | All permission rows |
| POST | `/company/permissions` | Permissions — edit | Upsert permission row |
| POST | `/company/reset` | Settings — delete | Factory reset |
| GET | `/audit/logs` | requireAuth | Audit log list |
| GET | `/audit/logs/:id` | requireAuth | Audit log detail |

### Reports
| Method | Path | Guard | Description |
|---|---|---|---|
| GET | `/reports/sales-register` | Sales — view | Full sales register |
| GET | `/reports/sales-by-item` | Sales — view | Sales grouped by item |
| GET | `/reports/sales-by-location` | Sales — view | Sales grouped by location |
| GET | `/reports/discounts` | Sales — view | Discount analysis |
| GET | `/reports/sales-stock-combined` | Sales — view | Sales + stock combined |
| GET | `/reports/purchase-register` | Purchases — view | Full purchase register |
| GET | `/reports/purchases-by-vendor` | Purchases — view | Purchases by vendor |
| GET | `/reports/purchases-by-material` | Purchases — view | Purchases by material |
| GET | `/reports/profitability` | Chart of Accounts — view | Item-level profitability |

### Search & Health
| Method | Path | Description |
|---|---|---|
| GET | `/search?q=` | Global search across entities |
| GET | `/health` | Health check (no auth required) |

---

## 13. Summary

Marlin Frozen Fruits ERP is a **full-stack, TypeScript monorepo** built on:

- **React + Vite** frontend with shadcn/ui design system and React Query for server state
- **Express + Drizzle ORM** backend with PostgreSQL (Neon)
- **JWT authentication** with bcrypt passwords, 8-hour token expiry, and a forced password-change flow
- **Module-registry-driven** sidebar and RBAC — `moduleRegistry.ts` is the single source of truth for every permission key, sidebar entry, and section

**As of July 2026, the ERP contains:**

| Category | Count |
|---|---|
| Frontend pages | 58 |
| Backend route files | 27 |
| Total API endpoints | ~110 |
| Database tables (Drizzle) | ~25 |
| Database tables (startup migrations) | 7 |
| ERP modules (permission keys) | 41 |
| Sidebar sections | 8 |
| Report sections | 7 |

**The system covers the complete operational lifecycle:**

1. **Procurement** — Purchase orders from vendors, material receipt, GST input credit
2. **Production** — Batch manufacturing with BOM comparison, costing, and wastage tracking
3. **Inventory** — Multi-branch stock management with FEFO batch allocation, inter-branch transfers, and stock ledger audit trail
4. **Sales** — Location-gated POS, credit limit enforcement, invoice PDF/WhatsApp, payment tracking, credit notes
5. **Finance** — Double-entry accounting (Tally-standard COA), bank reconciliation, cash deposit management, GST returns
6. **HR** — Employee onboarding, attendance (GPS check-in/out), leave management, payroll with COA auto-posting
7. **Reporting** — 7-section reports centre with date-range filters and CSV export
8. **Administration** — Role-based permissions per module per hierarchy level, full audit log, login history

---

*End of documentation — describes the ERP exactly as implemented on the analysis date. No modifications, no recommendations.*

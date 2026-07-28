# Marlin Frozen Fruits ERP — Official Structure Documentation

> **Analysis date:** July 2026  
> **Scope:** Describes the current implementation exactly as it exists. No modifications, redesigns, or recommendations.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Folder Structure](#2-folder-structure)
3. [Frontend Architecture](#3-frontend-architecture)
4. [Backend Architecture](#4-backend-architecture)
5. [Database Documentation](#5-database-documentation)
6. [ERP Modules](#6-erp-modules)
7. [Business Workflows](#7-business-workflows)
8. [Permission Structure](#8-permission-structure)
9. [Accounting Structure](#9-accounting-structure)
10. [Inventory Structure](#10-inventory-structure)
11. [Complete Page Documentation](#11-complete-page-documentation)
12. [Complete API Documentation](#12-complete-api-documentation)
13. [Current Sidebar Documentation](#13-current-sidebar-documentation)
14. [Current Navigation Flow](#14-current-navigation-flow)
15. [Current Business Architecture](#15-current-business-architecture)
16. [Module Dependency Diagram](#16-module-dependency-diagram)
17. [Complete Summary](#17-complete-summary)

---

## 1. Project Overview

| Property | Value |
|---|---|
| **ERP Name** | Marlin Frozen Fruits ERP |
| **Industry** | Frozen fruits manufacturing and distribution |
| **Purpose** | End-to-end business management — production, inventory, sales, accounting, HR, and company administration |
| **Frontend** | React 18 + Vite + TypeScript + shadcn/ui (Radix UI) + Tailwind CSS + Wouter + TanStack React Query |
| **Backend** | Node.js + Express + TypeScript + Drizzle ORM + Zod |
| **Database** | PostgreSQL (Neon managed cloud), accessed via `pg` connection pool |
| **Authentication** | JWT (8-hour expiry) stored in `localStorage` + bcrypt (10 salt rounds) + forced password-change flow |
| **Monorepo** | pnpm workspaces — frontend, backend, and shared libraries co-located |
| **Deployment** | Replit Autoscale — ERP web app and API server as separate artifacts sharing one PostgreSQL database |
| **Mobile App** | Expo/React Native (separate artifact) for employee attendance, leaves, and payslips |

---

## 2. Folder Structure

```
/ (monorepo root)
├── pnpm-workspace.yaml          — workspace package declarations
├── tsconfig.json                — base TypeScript config (project references)
├── artifact.toml                — Replit artifact configuration
├── docs/                        — architecture and business process documentation
│   └── ERP_STRUCTURE.md         — this file
├── scripts/                     — internal build and automation scripts
├── attached_assets/             — design mockups, requirements, reference media
│
├── artifacts/
│   │
│   ├── api-server/              — Node.js/Express REST API (central backend)
│   │   ├── src/
│   │   │   ├── app.ts           — Express app factory; middleware stack; global error handler
│   │   │   ├── index.ts         — Server entry point; startup SQL migrations; COA seeding; admin user seed
│   │   │   ├── routes/          — One route file per business domain
│   │   │   │   ├── index.ts     — Mounts all domain routers under /api
│   │   │   │   ├── auth.ts      — Login, logout, /me, profile, change-password
│   │   │   │   ├── dashboard.ts — KPI summary, stock alerts, trends, activity
│   │   │   │   ├── sales.ts     — Sales invoices, item prices
│   │   │   │   ├── payments.ts  — Sale payment records
│   │   │   │   ├── returns.ts   — Sales/purchase returns, outstanding
│   │   │   │   ├── customers.ts — Customers, vendors, coupons, ledgers
│   │   │   │   ├── purchases.ts — Purchase orders / GRN
│   │   │   │   ├── production.ts — Production batches, reports
│   │   │   │   ├── bom.ts       — Bill of Materials templates
│   │   │   │   ├── inventory.ts — Materials, raw materials, items
│   │   │   │   ├── branches.ts  — Warehouses, outlets
│   │   │   │   ├── stock.ts     — Stock view, ledger, transfers
│   │   │   │   ├── inventory-batches.ts — Batch/FEFO stock management
│   │   │   │   ├── accounts.ts  — Receipts, payments, expenses, COA, opening balances
│   │   │   │   ├── journal.ts   — Journal vouchers, day book, cash-bank book, trial balance
│   │   │   │   ├── reconciliation.ts — Bank reconciliation batches
│   │   │   │   ├── cash-in-outlet.ts — Cash balance view, cash deposits
│   │   │   │   ├── hr.ts        — Employees, hierarchy, attendance, payroll, advances, leaves
│   │   │   │   ├── gst.ts       — HSN summary, GSTR-1, GSTR-3B, GST reconciliation
│   │   │   │   ├── company.ts   — Company settings, permissions, login history, reset
│   │   │   │   ├── audit.ts     — Audit log
│   │   │   │   ├── reports.ts   — Analytics report endpoints
│   │   │   │   ├── pdfGen.ts    — Challan, payslip, report PDF generation
│   │   │   │   ├── publicInvoices.ts — HMAC-signed public invoice access
│   │   │   │   ├── search.ts    — Global quick search
│   │   │   │   └── health.ts    — Health check (unauthenticated)
│   │   │   ├── services/        — PDF rendering services (invoice, payslip)
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts      — requireAuth, requireModuleAction, requireModuleView
│   │   │   └── lib/
│   │   │       ├── logger.ts    — pino logger instance
│   │   │       ├── password.ts  — PasswordService (bcrypt hash/compare)
│   │   │       └── token.ts     — JWT sign/verify helpers
│   │   ├── dist/                — Compiled production JS output
│   │   └── package.json
│   │
│   ├── marlin-erp/              — React ERP web dashboard (managers, accountants, admin)
│   │   ├── src/
│   │   │   ├── App.tsx          — Root component: providers, AuthGuard, all Wouter route definitions
│   │   │   ├── main.tsx         — React entry point; Vite bootstrap
│   │   │   ├── pages/
│   │   │   │   ├── accounts/    — ChartOfAccounts, Ledger, CashBank, Expenses, Vouchers, Payment,
│   │   │   │   │                  Receipt, Journal, Contra, Notes, DayBook, CashBankBook,
│   │   │   │   │                  TrialBalance, GstSummary, GstReturns
│   │   │   │   ├── auth/        — Login, ChangePassword
│   │   │   │   ├── company/     — Settings, Permissions, Profile, AuditLog, LoginHistory
│   │   │   │   ├── customers/   — Customers, Vendors, Coupons
│   │   │   │   ├── dashboard/   — Dashboard
│   │   │   │   ├── finance/     — Reconciliation, CashInOutlet
│   │   │   │   ├── headoffice/  — Stock, StockLedger, StockVerification, InventoryReports,
│   │   │   │   │                  ItemPrices, Warehouses, Outlets, Sales
│   │   │   │   ├── hr/          — Hierarchy, Employees, Payroll, Attendance, Leave, Advances
│   │   │   │   ├── outstanding/ — Outstanding
│   │   │   │   ├── production/  — Units, Items, ItemMaster, Purchases, Production, ProductionReports
│   │   │   │   ├── profile/     — ProfileMe
│   │   │   │   ├── reports/     — ReportsCenter + 6 section components (Sales, Purchases,
│   │   │   │   │                  Inventory, Production, Parties, Financial)
│   │   │   │   ├── returns/     — Returns
│   │   │   │   └── sales/       — LocationPicker, SalesDashboard, SalesStock, SalesPOS,
│   │   │   │                      SalesExpenses, SalesCashBalance
│   │   │   ├── components/
│   │   │   │   ├── layout/      — AppLayout, Sidebar, UserMenu, ThemeToggle
│   │   │   │   └── ui/          — shadcn/ui primitives + ERP-specific compound components
│   │   │   ├── hooks/
│   │   │   │   ├── use-mobile.ts — viewport breakpoint detection
│   │   │   │   └── use-toast.ts  — Sonner toast wrapper
│   │   │   └── lib/
│   │   │       ├── moduleRegistry.ts   — Single source of truth: sidebar + permissions
│   │   │       ├── usePermission.ts    — RBAC hook (canView/canAdd/canEdit/canDelete/canDownload)
│   │   │       ├── locationContext.tsx — LocationProvider (selected branch: outlet/warehouse)
│   │   │       ├── download.ts         — Client-side CSV export helper
│   │   │       ├── theme.tsx           — ThemeProvider (light/dark)
│   │   │       └── utils.ts            — Shared formatting/utility functions
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── employee-app/            — Expo/React Native mobile app (staff-facing)
│   │   ├── app/                 — Expo Router screen files
│   │   │   ├── index.tsx        — App entry / splash
│   │   │   ├── (auth)/          — Login screen
│   │   │   └── (tabs)/          — Attendance, Leaves, Payslips, Profile tabs
│   │   ├── components/          — Mobile-optimised UI components
│   │   └── package.json
│   │
│   └── mockup-sandbox/          — Vite dev server for Canvas component previews
│
└── lib/                         — Shared pnpm workspace packages
    ├── db/                      — @workspace/db
    │   ├── src/
    │   │   ├── schema.ts        — All Drizzle ORM table definitions
    │   │   └── index.ts         — pg pool export
    │   └── package.json
    ├── api-spec/                — @workspace/api-spec — OpenAPI 3.1 YAML contract
    ├── api-zod/                 — @workspace/api-zod — Shared Zod validation schemas (generated)
    └── api-client-react/        — @workspace/api-client-react — orval-generated React Query hooks
        └── src/
            ├── generated/       — Auto-generated hook files (from OpenAPI spec)
            └── *.ts             — Hand-written custom hooks for non-spec endpoints
```

---

## 3. Frontend Architecture

### 3.1 Application Bootstrap

`main.tsx` → `App.tsx`:

```
App
└── QueryClientProvider (React Query)
    └── TooltipProvider (Radix Tooltip)
        └── LocationProvider (selected branch context)
            └── WouterRouter (base = import.meta.env.BASE_URL)
                └── Router (Switch — all route definitions)
                    └── AuthGuard → page component
            └── Toaster (Sonner notifications, top-right, richColors)
```

### 3.2 Routing

Routing is implemented with **Wouter** (`useLocation`, `Switch`, `Route`, `Redirect`). All routes are defined in `App.tsx` within the `Router()` function:

| URL Pattern | Component | Notes |
|---|---|---|
| `/login` | `Login` | No AuthGuard |
| `/` | `Dashboard` | AuthGuard |
| `/dashboard` | `Dashboard` | Alias for `/` |
| `/change-password` | `ChangePassword` | `allowMustChange = true` |
| `/production/units` | `Units` | AuthGuard |
| `/production/items` | `Items` | AuthGuard |
| `/production/purchase` | `Purchases` | AuthGuard |
| `/production/production` | `ProductionList` | AuthGuard |
| `/production/reports` | `ProductionReports` | AuthGuard |
| `/transfers` | `Transfers` | AuthGuard |
| `/production/stock-transfer` | → `/transfers` | Legacy redirect |
| `/headoffice/transfers` | → `/transfers` | Legacy redirect |
| `/sales/transfers` | `Transfers` | AuthGuard (alias) |
| `/headoffice/warehouses` | `Warehouses` | AuthGuard |
| `/headoffice/outlets` | `Outlets` | AuthGuard |
| `/headoffice/stock` | `Stock` | AuthGuard |
| `/headoffice/inventory-reports` | `InventoryReports` | AuthGuard |
| `/headoffice/stock-verification` | `StockVerification` | AuthGuard |
| `/headoffice/stock-ledger` | `StockLedger` | AuthGuard |
| `/headoffice/item-price` | `ItemPrices` | AuthGuard |
| `/headoffice/sales` | `Sales` | AuthGuard |
| `/hr/hierarchy` | `Hierarchy` | AuthGuard |
| `/hr/employees` | `Employees` | AuthGuard |
| `/hr/payroll` | `Payroll` | AuthGuard |
| `/hr/attendance` | `Attendance` | AuthGuard |
| `/hr/leave` | `Leave` | AuthGuard |
| `/hr/advances` | `Advances` | AuthGuard |
| `/customers` | `Customers` | AuthGuard |
| `/vendors` | `Vendors` | AuthGuard |
| `/coupons` | `Coupons` | AuthGuard |
| `/returns` | `Returns` | AuthGuard |
| `/outstanding` | `Outstanding` | AuthGuard |
| `/accounts/chart` | `ChartOfAccounts` | AuthGuard |
| `/accounts/ledger` | `Ledger` | AuthGuard |
| `/accounts/cash-bank` | `CashBank` | AuthGuard |
| `/accounts/expenses` | `Expenses` | AuthGuard |
| `/accounts/vouchers` | `Vouchers` | AuthGuard |
| `/accounts/payments` | `Payment` | AuthGuard |
| `/accounts/receipts` | `ReceiptPage` | AuthGuard |
| `/accounts/journal` | `Journal` | AuthGuard |
| `/accounts/contra` | `Contra` | AuthGuard |
| `/accounts/notes` | `Notes` | AuthGuard |
| `/accounts/day-book` | `DayBook` | AuthGuard |
| `/accounts/cash-book` | `CashBankBook` (kind="cash") | AuthGuard |
| `/accounts/bank-book` | `CashBankBook` (kind="bank") | AuthGuard |
| `/accounts/trial-balance` | `TrialBalance` | AuthGuard |
| `/accounts/gst` | `GstSummary` | AuthGuard |
| `/accounts/gst-returns` | `GstReturns` | AuthGuard |
| `/production/item-master` | `ItemMaster` | AuthGuard |
| `/company/settings` | `CompanySettings` | AuthGuard |
| `/company/permissions` | `Permissions` | AuthGuard |
| `/company/profile` | `Profile` | AuthGuard |
| `/company/audit` | `AuditLog` | AuthGuard |
| `/company/login-history` | `LoginHistory` | AuthGuard |
| `/accounts/reconciliation` | `Reconciliation` | AuthGuard |
| `/accounts/cash-in-outlet` | `CashInOutlet` | AuthGuard |
| `/accounts/reports` | → `/reports/sales` | Redirect |
| `/reports` | → `/reports/sales` | Redirect |
| `/reports/:cat` | `ReportsCenter` | AuthGuard |
| `/profile/me` | `ProfileMe` | AuthGuard |
| `/sales` | `LocationPicker` | AuthGuard |
| `/sales/dashboard` | `SalesDashboard` | AuthGuard |
| `/sales/stock` | `SalesStock` | AuthGuard |
| `/sales/pos` | `SalesPOS` | AuthGuard |
| `/sales/expenses` | `SalesExpenses` | AuthGuard |
| `/sales/cash-balance` | `SalesCashBalance` | AuthGuard |
| `*` (catch-all) | `NotFound` | 404 page |

### 3.3 AuthGuard

```typescript
function AuthGuard({ children, allowMustChange = false }) {
  const token = localStorage.getItem('marlin_auth_token');
  if (!token) return <Redirect to="/login" />;
  if (!allowMustChange) {
    const user = JSON.parse(localStorage.getItem('marlin_user') ?? '{}');
    if (user.mustChangePassword) return <Redirect to="/change-password" />;
  }
  return <>{children}</>;
}
```

Two checks on every render:
1. Token present in `localStorage` — redirects to `/login` if missing
2. `mustChangePassword` flag — redirects to `/change-password` if true (except on the change-password route itself)

### 3.4 Authentication Flow

1. User submits credentials on `/login`
2. `POST /api/auth/login` → returns `{ token, user }`
3. Token stored in `localStorage` as `marlin_auth_token`
4. User object stored in `localStorage` as `marlin_user`
5. If `user.mustChangePassword = true`, AuthGuard redirects every route to `/change-password`
6. Every API request adds `Authorization: Bearer <token>` header
7. On logout: both localStorage keys are cleared → redirect to `/login`

### 3.5 Layout

**`AppLayout`** wraps every authenticated page and provides:
- Collapsible sidebar generated dynamically from `getNavGroups()` (moduleRegistry)
- Permission filtering: sidebar links with `canView = false` are hidden
- Top header bar: breadcrumb, `UserMenu` (profile/logout), `ThemeToggle`
- Mobile-responsive: sidebar collapses to a drawer on small screens
- Profile link in the sidebar footer → `/profile/me`

### 3.6 State Management

| Concern | Mechanism |
|---|---|
| Server data / cache | React Query (`@workspace/api-client-react` hooks) |
| Global UI (branch context) | `LocationProvider` (React Context + localStorage) |
| Global UI (theme) | `ThemeProvider` (React Context + sessionStorage) |
| Auth credentials | `localStorage` (`marlin_auth_token`, `marlin_user`) |
| Local component state | `useState` / `useReducer` |

**React Query global config** (`App.tsx`):
```typescript
{
  retry: 1,
  staleTime: 0,               // always refetch on mount/invalidation
  gcTime: 5 * 60_000,         // keep unused cache 5 min then GC
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
}
```

### 3.7 Context Providers

**`LocationProvider`** (`lib/locationContext.tsx`):
- Maintains `{ id: number, type: 'outlet'|'warehouse', name: string } | null`
- Persisted to `localStorage` — survives page reload
- Consumed by every `/sales/*` page for branch-scoped data fetching
- `LocationPicker` at `/sales` sets this value before any POS/expense/stock access

**`ThemeProvider`** (`lib/theme.tsx`):
- Toggles light/dark mode on `<html>` element class
- Default: light mode on fresh session
- Persists via sessionStorage

### 3.8 API Client

Generated React Query hooks from `@workspace/api-client-react`:
- Auto-generated by **orval** from the OpenAPI 3.1 spec in `@workspace/api-spec`
- One query hook per GET endpoint, one mutation hook per POST/PUT/PATCH/DELETE
- Examples: `useListSales()`, `useCreateSale()`, `useApproveStockTransfer()`, `useListItemPrices()`
- Hand-written custom hooks in `lib/api-client-react/src/*.ts` for endpoints not in the spec (e.g., cash-in-outlet deposits, reconciliation batch detail)
- All hooks include `Authorization: Bearer <token>` via a shared axios/fetch interceptor

### 3.9 Permission Handling (Frontend)

`usePermission(moduleKey: string)` returns:
```typescript
{ canView: boolean, canAdd: boolean, canEdit: boolean, canDelete: boolean, canDownload: boolean, isLoading: boolean }
```

Behaviour:
- **Level 1 hierarchy** → always returns all `true` without a DB lookup
- **Other levels** → calls `GET /api/company/permissions` (cached by React Query), matches `hierarchyId + moduleKey`
- **No matching row found** → all flags return `false` (default deny)

Usage pattern in every page:
```typescript
const { canAdd, canEdit, canDelete, canDownload } = usePermission('Sales');
// Hide/disable buttons based on flags
```

### 3.10 Location Handling

The `LocationProvider` stores the selected branch. Pages in `/sales/*` access it with `useLocation()`. The `LocationPicker` at `/sales` must be visited before any branch-scoped page:
- If no location is selected and user visits `/sales/pos`, the page renders blank (no crash)
- Location data drives: `location_type`, `location_id` params on API calls, item price lookup, stock deduction target

### 3.11 UI Components

- **shadcn/ui** (Radix UI + Tailwind): Button, Dialog, Sheet, Table, Select, Input, Badge, Tabs, Card, Tooltip, Popover, Calendar, DropdownMenu, Sonner (Toaster)
- **ERP-specific compound components**: DataTable, DateRangePicker, StatusBadge, AmountDisplay, LocationSelector, PrintLayout

### 3.12 Hooks

| Hook | Location | Purpose |
|---|---|---|
| `usePermission(key)` | `lib/usePermission.ts` | RBAC flags for a module |
| `useMobile()` | `hooks/use-mobile.ts` | Boolean: viewport ≤ 768px |
| `useToast()` | `hooks/use-toast.ts` | Sonner toast trigger |

### 3.13 Utilities

| File | Purpose |
|---|---|
| `lib/utils.ts` | `cn()` class merger, currency formatting, date helpers |
| `lib/download.ts` | `downloadCSV(filename, rows)` — client-side CSV export |
| `lib/moduleRegistry.ts` | `getNavGroups()`, `getPermissionGroups()`, `ALL_MODULE_KEYS` |

### 3.14 Search & Filters

- **Global search**: `GET /api/search?q=` — returns sales, customers, vendors, items, employees, productions (permission-scoped)
- **Page-level filtering**: Local `useState` for text search, date range pickers for server-side date params, dropdowns for categorical filters (outlet, payment mode, status)
- **Export**: `downloadCSV()` from `lib/download.ts` — client-side from fetched data, gated on `canDownload`

---

## 4. Backend Architecture

### 4.1 Server Startup Sequence (`index.ts`)

On every cold start, before accepting traffic:

1. **Run `ALTER TABLE` migrations** (idempotent column additions to existing tables)
2. **Create runtime-managed tables** via `CREATE TABLE IF NOT EXISTS`: `payments`, `receipts`, `sale_payments`, `reconciliation_batches`, `reconciliation_batch_items`, `cash_deposits`, `migration_log`
3. **Seed level-1 hierarchy row** (`Management`) if none exists
4. **Seed admin user** (username: `admin`) if not present
5. **Migrate plaintext passwords → bcrypt** for all employees whose `password_hash` does not start with `$2`
6. **Add Tally-standard COA system groups** (13 groups, idempotent by `code` lookup)
7. **Add standard ledgers**: `STD-SALES`, `STD-PUR`, `STD-BANK`, `STD-CASH`, `STD-DTX`, `SYS-DEBTORS`, `SYS-CREDITORS`
8. **Add clearing ledgers**: `STD-ELEC-CLR`, `STD-CIT`, `STD-PROC-CHG`
9. **Add GST ledgers**: `STD-OUT-CGST`, `STD-OUT-SGST`, `STD-OUT-IGST`, `STD-INP-CGST`, `STD-INP-SGST`, `STD-INP-IGST`
10. **Provision per-outlet cash ledgers** (`OUTLET-CASH-{id}`) for all existing outlets
11. **Run one-time guarded migrations** tracked in `migration_log`: sales payment backfill, settled-sales paid backfill, customer/vendor ledger backfill, warehouse/outlet ledger ID backfill
12. **Create performance indexes**
13. **Start HTTP server** on `$PORT`

### 4.2 Express App (`app.ts`)

Middleware stack in application order:

| Order | Middleware | Purpose |
|---|---|---|
| 1 | `pino-http` | Structured request/response logging (method, URL, status) |
| 2 | `cors` | Origin allowlist from `ALLOWED_ORIGINS` env var; all origins in dev |
| 3 | `express.json({ limit: '1mb' })` | JSON body parsing, max 1 MB |
| 4 | `express.urlencoded({ extended: true, limit: '1mb' })` | Form body parsing |
| 5 | Auth bypass check | Skips `requireAuth` for: `GET /api/health`, `POST /api/auth/login`, `GET /api/public/invoices/*` |
| 6 | `requireAuth` | Validates Bearer JWT on all other `/api/*` requests |
| 7 | Domain routers | All route handlers via `routes/index.ts` |
| 8 | 404 handler | `{ error: 'Not found' }` for unknown routes |
| 9 | Global error handler | Handles CORS errors (403), oversized bodies (413), malformed JSON (400), all others (500) |

### 4.3 Authentication (`middleware/auth.ts`)

**`requireAuth(req, res, next)`**:
- Reads `Authorization: Bearer <token>` header
- Verifies JWT with `SESSION_SECRET` env var
- Rejects expired tokens (8-hour TTL)
- Attaches `req.user = { id, username, hierarchyId, hierarchyLevel, branchType, branchId }` to the request
- Returns `401 { error: 'Unauthorized' }` on any failure

**Login rate limiting**: 5 attempts per 15 minutes per IP (express-rate-limit on `/api/auth/login`)

**Login history**: Every login attempt (success or failure) is recorded with IP address, user-agent, and timestamp in `login_history` table

### 4.4 Authorization Middleware

**`requireModuleView(module | module[])`**:
- Level-1 users: pass through (no DB lookup)
- Others: queries `permissions` table for `hierarchyId + module`
- Returns `403` if `canView = false` or no row found

**`requireModuleAction(module | module[], action: 'add'|'edit'|'delete')`**:
- Level-1 users: pass through
- Others: queries `permissions` for any of the listed modules
- Returns `403` if no matching row grants the action
- Multi-module form: `requireModuleAction(['Sales', 'Point of Sale'], 'add')` — passes if the user has the action in ANY listed module

### 4.5 Route Organisation

All routes mount under `/api` via `routes/index.ts`. Route files:

| File | Mounted paths |
|---|---|
| `health.ts` | `/api/health`, `/api/healthz` |
| `auth.ts` | `/api/auth/*` |
| `dashboard.ts` | `/api/dashboard/*` |
| `sales.ts` | `/api/sales/*`, `/api/item-prices/*` |
| `payments.ts` | `/api/sales/:id/payments` |
| `returns.ts` | `/api/sales-returns`, `/api/purchase-returns`, `/api/outstanding/*` |
| `customers.ts` | `/api/customers/*`, `/api/vendors/*`, `/api/coupons/*` |
| `purchases.ts` | `/api/purchases/*` |
| `production.ts` | `/api/productions/*` |
| `bom.ts` | `/api/bom-templates/*` |
| `inventory.ts` | `/api/materials/*`, `/api/raw-materials/*`, `/api/items/*`, `/api/units/*` |
| `branches.ts` | `/api/warehouses/*`, `/api/outlets/*` |
| `stock.ts` | `/api/stock/*` (excluding batches) |
| `inventory-batches.ts` | `/api/stock/batches/*`, `/api/stock/expiry-report`, `/api/stock/valuation`, `/api/stock/verifications` |
| `accounts.ts` | `/api/accounts/*`, `/api/expenses` |
| `journal.ts` | `/api/accounts/journal-vouchers`, `/api/accounts/day-book`, `/api/accounts/cash-bank-book`, `/api/accounts/trial-balance` |
| `reconciliation.ts` | `/api/reconciliation/*` |
| `cash-in-outlet.ts` | `/api/cash-in-outlet/*` |
| `hr.ts` | `/api/hr/*` |
| `gst.ts` | `/api/gst/*` |
| `company.ts` | `/api/company/*` |
| `audit.ts` | `/api/audit/*` |
| `reports.ts` | `/api/reports/*` |
| `pdfGen.ts` | `/api/pdf/*` |
| `publicInvoices.ts` | `/api/public/invoices/*` |
| `search.ts` | `/api/search` |

### 4.6 Validation

All request bodies validated with **Zod** schemas from `@workspace/api-zod`. The validation middleware:
- Calls `.parse()` or `.safeParse()` on the request body
- Returns `400 { error: "<Zod message>" }` on schema mismatch
- Strips unknown fields by default

### 4.7 Error Handling

| Condition | Status | Response |
|---|---|---|
| Zod validation failure | 400 | `{ error: "<field>: <message>" }` |
| Auth token missing/invalid | 401 | `{ error: "Unauthorized" }` |
| Permission denied | 403 | `{ error: "Forbidden" }` |
| Resource not found | 404 | `{ error: "Not found" }` |
| Business rule violation | 409 | `{ error: "<description>" }` |
| Body too large | 413 | `{ error: "Request body too large (max 1 MB)" }` |
| Unhandled exception | 500 | `{ error: "An unexpected server error occurred" }` |

### 4.8 Audit Logging

Every mutating operation (create/update/delete) writes to the `activity_log` table:
- `action`: `'create'` | `'update'` | `'delete'`
- `entity`: module name (e.g., `'Sale'`, `'Employee'`)
- `entity_id`: record ID
- `user`: username of the acting user
- `details`: JSON object with the changed data or diff
- `created_at`: timestamp

### 4.9 Database Access Pattern

- **Drizzle ORM** for all tables defined in `lib/db/src/schema.ts` — type-safe queries
- **Raw `pool.query()`** for:
  - Startup-migration tables (`payments`, `receipts`, `sale_payments`, etc.) — Drizzle cannot see these
  - Startup-migration columns (`location_type`, `valid_from`, `valid_to` on `item_prices`; costing columns on `productions`) — Drizzle silently drops these in `db.select()` so they must be read/written via raw SQL
- **Transactions** (`pool.query('BEGIN')` / `COMMIT` / `ROLLBACK`) for:
  - Stock transfer dispatch, approve, reject
  - Payroll approval COA posting
  - Reconciliation batch creation

### 4.10 Logging

`pino` structured logger (`lib/logger.ts`). Request logging via `pino-http` (method, URL without query string, status code). Startup events logged with `console.log` for migration steps.

### 4.11 PDF Generation

`pdfGen.ts` uses **jsPDF** server-side:
- `POST /api/pdf/challan` — delivery challan PDF from client-supplied JSON
- `POST /api/pdf/report` — tabular report PDF (up to 3,000 rows) with company header injected from `company_settings`
- `POST /api/pdf/payslip` — employee payslip PDF

Invoice PDFs for sales are generated client-side or via HMAC-signed public links (`publicInvoices.ts`).

---

## 5. Database Documentation

### 5.1 Tables Managed by Drizzle ORM (`lib/db/src/schema.ts`)

---

#### `company_settings`

**Purpose:** Single-row company master configuration. Always exactly one row.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | Always = 1 |
| `company_name` | text | Display name |
| `address` | text | Full address |
| `state` | text | State name (for GSTIN intra/interstate logic) |
| `gst_number` | text | GSTIN |
| `pan_number` | text | PAN |
| `bank_name` | text | Primary bank name |
| `bank_account` | text | Account number |
| `ifsc_code` | text | IFSC code |
| `logo_url` | text | Logo image URL |
| `invoice_prefix` | text | e.g. `INV` |
| `invoice_sequence` | integer | Auto-incremented for invoice numbers |
| `fy_start_month` | integer | Financial year start month (1–12) |
| `voucher_prefixes` | jsonb | `{ payment, receipt, journal, contra }` prefix strings |
| `production_overhead_percent` | numeric(5,2) | Default overhead % for production costing |

**Relationships:** Read by invoice PDF, GST calculations, payroll COA posting, all report headers.

---

#### `warehouses`

**Purpose:** Secondary distribution centre master.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Warehouse name |
| `state` | text | State (for GST) |
| `gst_number` | text | Warehouse GSTIN |
| `address` | text | |
| `upi_id` | text | UPI ID for invoices *(startup-migration column)* |
| `cash_ledger_id` | integer | FK → `account_ledgers.id` (WH-CASH-{id}) *(startup-migration column)* |
| `sales_ledger_id` | integer | FK → `account_ledgers.id` (WH-SAL-{id}) *(startup-migration column)* |
| `purchase_ledger_id` | integer | FK → `account_ledgers.id` (WH-PUR-{id}) *(startup-migration column)* |

**Relationships:** `outlets.warehouse_id → warehouses.id`; `stock_entries.branch_type = 'warehouse'`; `stock_transfers.from/to_type = 'warehouse'`

---

#### `outlets`

**Purpose:** Retail outlet (sales point) master.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Outlet name |
| `warehouse_id` | integer | FK → `warehouses.id` |
| `address` | text | |
| `phone` | text | |
| `upi_id` | text | UPI ID for invoices *(startup-migration column)* |
| `cash_ledger_id` | integer | FK → `account_ledgers.id` (OUTLET-CASH-{id}) *(startup-migration column)* |
| `sales_ledger_id` | integer | FK → `account_ledgers.id` (OUTLET-SAL-{id}) *(startup-migration column)* |

**Relationships:** `sales.outlet_id`; `item_prices.outlet_id`; `stock_entries.branch_type = 'outlet'`

---

#### `vendors`

**Purpose:** Supplier / vendor master.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Vendor name |
| `phone` | text | |
| `email` | text | |
| `gst_number` | text | Vendor GSTIN |
| `state` | text | State (for interstate GST) |
| `bank_name` | text | |
| `account_number` | text | |
| `address` | text | |

**Relationships:** `purchases.vendor_id → vendors.id`; on create → auto-inserts `VEND-{id}` ledger under `SYS-CREDITORS`

---

#### `customers`

**Purpose:** Customer master (walk-in and account customers).

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | |
| `phone` | text | |
| `email` | text | |
| `gst_number` | text | Customer GSTIN |
| `state` | text | State (interstate GST) |
| `total_purchases` | numeric | Running total purchases value |
| `credit_limit` | numeric | Maximum credit allowed (0 = unlimited) |
| `credit_days` | integer | Payment due days for credit sales |
| `location_type` | text | `'outlet'` | `'warehouse'` *(startup-migration column)* |
| `location_id` | integer | Branch ID *(startup-migration column)* |
| `notes` | text | |

**Relationships:** `sales.customer_id → customers.id`; on create → auto-inserts `CUST-{id}` ledger under `SYS-DEBTORS`

---

#### `materials`

**Purpose:** Packaging and processing material master.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | |
| `unit` | text | e.g. `kg`, `piece` |
| `current_stock` | numeric | Current quantity on hand |
| `hsn_code` | text | *(startup-migration column)* |
| `tax_rate` | numeric(5,2) | GST rate % *(startup-migration column)* |
| `cost` | numeric(10,2) | Last purchase cost *(startup-migration column)* |
| `avg_cost` | numeric(12,4) | Weighted average cost *(startup-migration column)* |

**Relationships:** Used in `productions.material_used (jsonb)`; `purchases.line_items (jsonb)`; `bom_templates.lines (jsonb)`

---

#### `raw_materials`

**Purpose:** Raw ingredient master (distinct from packaging materials).

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | |
| `unit` | text | |
| `current_stock` | numeric | |
| `hsn_code` | text | *(startup-migration column)* |
| `tax_rate` | numeric(5,2) | *(startup-migration column)* |
| `cost` | numeric(10,2) | *(startup-migration column)* |
| `avg_cost` | numeric(12,4) | *(startup-migration column)* |

**Relationships:** Same patterns as `materials`

---

#### `items`

**Purpose:** Finished goods item master.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | |
| `hsn_code` | text | |
| `tax_rate` | numeric(5,2) | GST rate % |
| `unit` | text | Unit of measure |
| `production_stock` | numeric | Quantity produced (headoffice stock level) |
| `mrp` | numeric(10,2) | Maximum Retail Price *(startup-migration column)* |
| `cost` | numeric(10,2) | Current average cost *(startup-migration column)* |

**Relationships:** `stock_entries.item_id`; `item_prices.item_id`; `productions.item_id`; `sales.line_items[].itemId`

---

#### `stock_entries`

**Purpose:** Current on-hand quantity per item per branch. The truth table for stock levels.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `item_id` | integer | FK → `items.id` |
| `branch_type` | text | `'outlet'` \| `'warehouse'` \| `'headoffice'` |
| `branch_id` | integer | ID of the outlet/warehouse (0 for headoffice) |
| `quantity` | numeric | Current stock quantity |
| `cost_price` | numeric | Average cost at this location |

**Relationships:** Updated by sales (deduct), purchases (credit), productions (credit to headoffice), stock transfers (deduct source / credit dest)

---

#### `item_prices`

**Purpose:** Location-specific selling prices with optional validity window.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `item_id` | integer | FK → `items.id` |
| `outlet_id` | integer | Generic location ID (outlet or warehouse ID) |
| `price` | numeric | Selling price |
| `location_type` | text | `'outlet'` \| `'warehouse'` \| `'headoffice'` *(startup-migration)* |
| `valid_from` | text | ISO date string, optional *(startup-migration)* |
| `valid_to` | text | ISO date string, optional *(startup-migration)* |

**Note:** `location_type`, `valid_from`, `valid_to` are startup-migration columns — invisible to Drizzle; always read/written via raw SQL.

---

#### `purchases`

**Purpose:** Purchase orders received from vendors.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `vendor_id` | integer | FK → `vendors.id` |
| `purchase_date` | text | ISO date |
| `invoice_number` | text | Vendor's invoice number |
| `line_items` | jsonb | `[{ materialType, materialId, name, unit, quantity, unitCost, taxRate, taxAmount, batchNumber?, mfgDate?, expiryDate? }]` |
| `total_amount` | numeric(12,2) | Grand total including tax |
| `tax_total` | numeric(12,2) | Total input GST *(startup-migration)* |
| `discount_total` | numeric(12,2) | Bill-level discount *(startup-migration)* |
| `round_off` | numeric(12,2) | Rounding adjustment *(startup-migration)* |
| `notes` | text | |

---

#### `productions`

**Purpose:** Production batch records.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `item_id` | integer | FK → `items.id` |
| `produced_quantity` | numeric | Finished goods produced |
| `production_date` | text | ISO date |
| `material_used` | jsonb | `[{ materialType, materialId, name, unit, quantity, cost }]` |
| `material_cost` | numeric(12,2) | Total material cost *(startup-migration)* |
| `overhead_percent` | numeric(5,2) | Applied overhead % *(startup-migration)* |
| `overhead_amount` | numeric(12,2) | materialCost × overheadPercent / 100 *(startup-migration)* |
| `total_cost` | numeric(12,2) | materialCost + overheadAmount *(startup-migration)* |
| `cost_per_unit` | numeric(12,4) | totalCost / producedQuantity *(startup-migration)* |
| `wastage` | jsonb | `[{ materialType, materialId, name, quantity, value }]` *(startup-migration)* |
| `wastage_qty` | numeric(10,3) | Total wastage quantity *(startup-migration)* |
| `wastage_value` | numeric(12,2) | Total wastage value *(startup-migration)* |

---

#### `sales`

**Purpose:** Sales invoices.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `invoice_number` | text | Auto-generated (prefix + sequence) |
| `outlet_id` | integer | FK → `outlets.id` (nullable) |
| `location_type` | text | `'outlet'` \| `'warehouse'` \| `'headoffice'` *(startup-migration)* |
| `location_id` | integer | Branch ID *(startup-migration)* |
| `customer_id` | integer | FK → `customers.id` (nullable = walk-in) |
| `sale_date` | text | ISO date |
| `line_items` | jsonb | `[{ itemId, name, quantity, unitPrice, taxRate, taxAmount, discount, subtotal }]` |
| `subtotal` | numeric(12,2) | Pre-tax total |
| `tax_total` | numeric(12,2) | Total output GST |
| `discount_total` | numeric(12,2) | Bill-level coupon discount (post-tax) |
| `total_amount` | numeric(12,2) | Final invoice amount |
| `payment_mode` | text | `'cash'` \| `'upi'` \| `'card'` \| `'credit'` |
| `coupon_code` | text | Applied coupon (nullable) |
| `payment_status` | text | `'unpaid'` \| `'partially_paid'` \| `'paid'` *(startup-migration)* |
| `amount_paid` | numeric(12,2) | Running total collected *(startup-migration)* |
| `created_at` | timestamptz | |

---

#### `stock_transfers`

**Purpose:** Inter-branch stock movement challan.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `challan_number` | text | Auto-generated |
| `from_type` | text | `'outlet'` \| `'warehouse'` \| `'headoffice'` |
| `from_id` | integer | Source branch ID |
| `to_type` | text | Destination branch type |
| `to_id` | integer | Destination branch ID |
| `transfer_date` | text | ISO date |
| `line_items` | jsonb | Dispatched: `[{ itemId, quantity, batchBreakdown }]` |
| `is_interstate` | boolean | Inter-state GST flag |
| `status` | text | `'in_transit'` \| `'approved'` \| `'rejected'` |
| `approved_by` | text | Username *(startup-migration)* |
| `approved_at` | timestamptz | *(startup-migration)* |
| `received_line_items` | jsonb | Actual received quantities on approval *(startup-migration)* |
| `rejection_reason` | text | *(startup-migration)* |

---

#### `employees`

**Purpose:** Employee master — also the ERP login user.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Display name |
| `username` | text | UNIQUE — used for login |
| `password_hash` | text | bcrypt hash |
| `email` | text | |
| `phone` | text | |
| `hierarchy_id` | integer | FK → `hierarchies.id` |
| `branch_type` | text | `'headoffice'` \| `'outlet'` \| `'warehouse'` |
| `branch_id` | integer | Branch ID (0 for headoffice) |
| `salary` | numeric | Monthly salary |
| `join_date` | text | ISO date |
| `photo_url` | text | Profile photo URL |
| `is_active` | boolean | |
| `must_change_password` | boolean | *(startup-migration)* |
| `work_experience` | jsonb | `[{ company, role, from, to, description }]` *(startup-migration)* |

---

#### `hierarchies`

**Purpose:** Organisational role/level definitions.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | e.g. `Management`, `Supervisor` |
| `level` | integer | 1 = super-admin; higher = lower access |
| `description` | text | |

**Note:** Level 1 bypasses all permission checks in middleware.

---

#### `permissions`

**Purpose:** RBAC — module-level permission flags per hierarchy level.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `hierarchy_id` | integer | FK → `hierarchies.id` |
| `module` | text | Module key from `moduleRegistry.ts` |
| `can_view` | boolean | See the page/data |
| `can_add` | boolean | Create records |
| `can_edit` | boolean | Modify records |
| `can_delete` | boolean | Delete records |
| `can_download` | boolean | Export/download data |

**UNIQUE constraint:** `(hierarchy_id, module)`

---

#### `account_ledgers`

**Purpose:** Hierarchical double-entry Chart of Accounts.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `name` | text | Display name |
| `type` | text | `'asset'` \| `'liability'` \| `'income'` \| `'expense'` \| `'equity'` |
| `parent_id` | integer | Self-referential FK — `null` for top-level groups |
| `code` | text | System code (e.g. `SYS-DEBTORS`, `CUST-42`) *(startup-migration)* |
| `section` | text | `'balance_sheet'` \| `'profit_loss'` *(startup-migration)* |
| `is_system_group` | boolean | Seeded by startup; protected from deletion *(startup-migration)* |
| `is_group` | boolean | `true` = group container; `false` = leaf ledger *(startup-migration)* |
| `bank_details` | jsonb | For bank ledgers: `{ bankName, accountNumber, ifscCode }` *(startup-migration)* |
| `description` | text | *(startup-migration)* |

---

#### `expenses`

**Purpose:** Direct expense entries linked to COA ledgers.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `ledger_account_id` | integer | FK → `account_ledgers.id` (expense category ledger) |
| `payment_account_id` | integer | FK → `account_ledgers.id` (cash/bank paid from) |
| `amount` | numeric(12,2) | |
| `expense_date` | text | ISO date |
| `description` | text | |
| `branch_type` | text | Optional: scopes to outlet/warehouse *(startup-migration)* |
| `branch_id` | integer | Optional *(startup-migration)* |

---

#### `payroll`

**Purpose:** Monthly payroll records per employee.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `employee_id` | integer | FK → `employees.id` |
| `month` | integer | 1–12 |
| `year` | integer | |
| `base_salary` | numeric(12,2) | Monthly salary at time of generation |
| `working_days` | integer | Days in the month |
| `present_days` | numeric | From attendance records |
| `lop_days` | numeric | Leave without pay days |
| `lop_deduction` | numeric(12,2) | salary / working_days × lop_days |
| `gross_pay` | numeric(12,2) | base_salary × present_days / working_days |
| `allowances_total` | numeric(12,2) | |
| `allowances_breakdown` | jsonb | `[{ name, amount }]` |
| `deductions` | jsonb | `[{ name, amount }]` |
| `net_pay` | numeric(12,2) | gross_pay + allowances − deductions − advance_deduction |
| `bonus` | numeric(12,2) | |
| `total_amount` | numeric(12,2) | Final disbursement amount |
| `is_paid` | boolean | |
| `paid_date` | text | ISO date |
| `advance_deduction` | numeric(12,2) | Auto-deducted advance amount *(startup-migration)* |
| `status` | text | `'draft'` \| `'approved'` \| `'paid'` |

---

#### `pay_components`

**Purpose:** Standing pay structure per employee.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `employee_id` | integer | FK → `employees.id` |
| `working_days_per_month` | integer | Default working days |
| `allowances` | jsonb | `[{ name, amount, type: 'fixed'|'percent' }]` |
| `deductions` | jsonb | `[{ name, amount, type: 'fixed'|'percent' }]` |

---

#### `attendance`

**Purpose:** Daily employee check-in/check-out records.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `employee_id` | integer | FK → `employees.id` |
| `date` | text | ISO date |
| `check_in` | text | Timestamp |
| `check_out` | text | Timestamp |
| `check_in_lat` | numeric | GPS latitude *(startup-migration)* |
| `check_in_lng` | numeric | GPS longitude *(startup-migration)* |
| `check_out_lat` | numeric | *(startup-migration)* |
| `check_out_lng` | numeric | *(startup-migration)* |
| `status` | text | `'present'` \| `'absent'` \| `'half_day'` \| `'leave'` |

---

#### `leaves`

**Purpose:** Employee leave requests.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `employee_id` | integer | FK → `employees.id` |
| `from_date` | text | ISO date |
| `to_date` | text | ISO date |
| `leave_type` | text | `'sick'` \| `'casual'` \| `'annual'` \| etc. |
| `reason` | text | |
| `status` | text | `'pending'` \| `'approved'` \| `'rejected'` |
| `approved_by` | integer | FK → `employees.id` |
| `approval_note` | text | |

---

#### `stock_batches`

**Purpose:** Lot-level stock tracking with expiry dates.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `item_id` | integer | FK → `items.id` |
| `branch_type` | text | Branch type |
| `branch_id` | integer | Branch ID |
| `batch_number` | text | Lot/batch identifier |
| `mfg_date` | text | Manufacturing date |
| `expiry_date` | text | Expiry date (null = no expiry) |
| `quantity` | numeric | Remaining quantity in this lot |
| `unit_cost` | numeric | Cost at time of receipt |
| `source` | text | `'production'` \| `'purchase'` \| `'transfer'` |
| `source_id` | integer | FK to the source record |

---

#### `stock_verifications`

**Purpose:** Physical stock count audit records.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `branch_type` | text | |
| `branch_id` | integer | |
| `verify_date` | text | ISO date |
| `notes` | text | |
| `created_by` | text | Username |

---

#### `bom_templates`

**Purpose:** Bill of Materials recipe per finished goods item.

| Column | Type | Description |
|---|---|---|
| `id` | serial PK | |
| `item_id` | integer | FK → `items.id` |
| `lines` | jsonb | `[{ materialType: 'material'|'raw_material', materialId, quantity }]` |
| `notes` | text | |

---

### 5.2 Startup-Migration Tables (not in Drizzle schema)

These tables are created via `CREATE TABLE IF NOT EXISTS` in `index.ts`. Drizzle has no knowledge of them — all queries use raw `pool.query()`.

| Table | Purpose |
|---|---|
| `payments` | Payment vouchers: `id`, `voucher_number`, `payment_date`, `paid_from_ledger_id`, `paid_to_ledger_id`, `amount`, `narration`, `created_at` |
| `receipts` | Receipt vouchers: `id`, `voucher_number`, `receipt_date`, `received_from_ledger_id`, `received_in_ledger_id`, `amount`, `narration`, `created_at` |
| `sale_payments` | Individual payments against a sale: `id`, `sale_id`, `payment_date`, `method`, `amount`, `reference_number`, `notes`, `reconciliation_status`, `clearing_receipt_id`, `outlet_id`, `created_by`, `created_at` |
| `reconciliation_batches` | Bank settlement batches: `id`, `batch_reference`, `settlement_date`, `gross_amount`, `charges`, `net_amount`, `destination_bank_ledger_id`, `external_reference`, `notes`, `created_by`, `created_at`, `status` |
| `reconciliation_batch_items` | Items in a batch: `id`, `batch_id`, `sale_payment_id`, `amount` (UNIQUE on `sale_payment_id`) |
| `cash_deposits` | Cash-to-bank transit records: `id`, `outlet_id`, `warehouse_id`, `source_cash_ledger_id`, `amount`, `deposit_date`, `deposit_reference`, `destination_bank_ledger_id`, `notes`, `created_by`, `created_at`, `status`, `transit_payment_id`, `bank_receipt_id` |
| `migration_log` | One-time migration guard: `name` (PK), `applied_at` |

---

## 6. ERP Modules

Each module corresponds to one permission key in `moduleRegistry.ts`. Below, every module is documented with its full context.

---

### Point of Sale
**Permission key:** `Point of Sale` | **Permission group:** Operations | **Sidebar section:** Operations

**Purpose:** Branch-level sales invoice creation at outlets and warehouses.

**Features:**
- Item selection with live price lookup from `item_prices`
- Line-level GST calculation (CGST+SGST for intrastate; IGST for interstate)
- Coupon discount application (post-tax, bill level)
- Payment mode: cash / UPI / card (settled immediately); credit (outstanding created)
- Credit limit check for credit customers (blocks if exceeded, override requires extra permission)
- Stock deduction from selected branch on creation
- Invoice PDF generation and WhatsApp share link (HMAC token)
- Sales editing (reverses old stock → re-applies new stock)

**Pages:** `/sales/pos` (requires `/sales` location selection first)  
**APIs used:** `POST /api/sales`, `PUT /api/sales/:id`, `GET /api/item-prices`, `GET /api/items`, `GET /api/customers`, `GET /api/coupons`  
**Tables:** `sales`, `sale_payments`, `stock_entries`, `stock_batches`, `item_prices`, `customers`, `items`, `outlets`, `warehouses`, `account_ledgers` (receipts), `company_settings`  
**Related modules:** Sales, Customers, Coupons, Stock, Cash Balance

---

### HO Transfers
**Permission key:** `HO Transfers` | **Permission group:** Inventory | **Sidebar section:** Operations

**Purpose:** Inter-branch stock movement via a challan-based approval workflow.

**Features:**
- Dispatch stock from any branch (source stock deducted immediately)
- Three-state workflow: `in_transit` → `approved` (with received quantities) or `rejected` (source restored)
- Received quantities can differ from dispatched quantities
- FEFO batch breakdown captured at dispatch; restored on rejection
- GST journal entries auto-created on approval (interstate = IGST; intrastate = CGST+SGST; internal headoffice = branch debtor/creditor)
- Interstate/intrastate auto-detected from GSTIN comparison

**Pages:** `/transfers`  
**APIs used:** `GET/POST /api/stock/transfers`, `PATCH /api/stock/transfers/:id/approve`, `PATCH /api/stock/transfers/:id/reject`  
**Tables:** `stock_transfers`, `stock_entries`, `stock_batches`, `stock_ledger`, `account_ledgers`, `outlets`, `warehouses`, `items`  
**Related modules:** Stock, Inventory Reports, Production

---

### Location Expenses
**Permission key:** `Location Expenses` | **Permission group:** Operations | **Sidebar section:** Operations

**Purpose:** Recording operational expenses at branch (outlet/warehouse) level.

**Features:** Create expenses with category ledger, payment account, amount, date, description; view all branch expenses; delete erroneously entered expenses; summary view grouped by category

**Pages:** `/sales/expenses`  
**APIs used:** `GET/POST /api/accounts/location-expenses`, `GET /api/accounts/location-expenses/summary`, `GET /api/accounts/location-expenses/all`, `DELETE /api/accounts/location-expenses/:id`  
**Tables:** `expenses`, `account_ledgers`  
**Related modules:** Accounts Expenses, Cash Balance

---

### Cash Balance
**Permission key:** `Cash Balance` | **Permission group:** Operations | **Sidebar section:** Operations

**Purpose:** Cash-in-hand visibility and cash-to-bank deposit management for all branches.

**Features:** View cash balance per outlet and warehouse; record cash deposit to bank (creates a transit entry); reconcile deposit when bank credits the account; aggregate view for HO at `/accounts/cash-in-outlet`

**Pages:** `/accounts/cash-in-outlet` (HO), `/sales/cash-balance` (branch view)  
**APIs used:** `GET /api/cash-in-outlet`, `GET/POST /api/cash-in-outlet/deposits`, `POST /api/cash-in-outlet/deposits/:id/reconcile`  
**Tables:** `cash_deposits`, `payments`, `receipts`, `account_ledgers`, `outlets`, `warehouses`  
**Related modules:** Reconciliation, Accounts Cash Balance

---

### Units
**Permission key:** `Units` | **Permission group:** Production | **Sidebar section:** Inventory

**Purpose:** Unit of measure master (kg, litre, piece, box, etc.) used across materials, raw materials, and items.

**Pages:** `/production/units`  
**APIs used:** `GET/POST /api/units`, `PATCH /api/units/:id`  
**Tables:** `units`  
**Related modules:** Items, Materials

---

### Items
**Permission key:** `Items` | **Permission group:** Production | **Sidebar section:** Inventory

**Purpose:** Finished goods item master — the central catalogue of saleable products.

**Features:** Add/edit items with name, HSN code, GST rate (locked to valid slabs), unit, MRP, cost; view current production stock

**Pages:** `/production/item-master` (hub), `/production/items` (list)  
**APIs used:** `GET/POST /api/items`, `PATCH/DELETE /api/items/:id`  
**Tables:** `items`, `units`  
**Related modules:** Production, Stock, Item Prices, Point of Sale, BOM

---

### Production
**Permission key:** `Production` | **Permission group:** Production | **Sidebar section:** Production

**Purpose:** Recording finished goods production batches.

**Features:**
- Record production with item, quantity, date, materials consumed, wastage
- BOM template comparison (actual vs expected material usage)
- Cost calculation: `materialCost + (materialCost × overheadPercent / 100) = totalCost`; `costPerUnit = totalCost / producedQuantity`
- Overhead percent from `company_settings.production_overhead_percent`
- Stock credit to headoffice branch on creation; full reversal on delete
- Batch creation in `stock_batches` for FEFO tracking
- Production analytics and reports

**Pages:** `/production/production` (batches), `/production/reports`  
**APIs used:** `GET/POST /api/productions`, `GET/PATCH/DELETE /api/productions/:id`, `GET /api/productions/reports`, `GET /api/bom-templates/item/:itemId`  
**Tables:** `productions`, `items`, `materials`, `raw_materials`, `stock_entries`, `stock_batches`, `bom_templates`, `company_settings`  
**Related modules:** Items, Materials (Raw Materials), BOM, Stock, Inventory Reports

---

### Purchases
**Permission key:** `Purchases` | **Permission group:** Production | **Sidebar section:** Production

**Purpose:** Purchase order (GRN) management from vendors.

**Features:** Create purchase orders with vendor, date, invoice number, line items (material/raw material/item), per-line GST, discount, round-off; stock credited on creation; PATCH/DELETE reverses and re-applies stock; PDF generation

**Pages:** `/production/purchase`  
**APIs used:** `GET/POST /api/purchases`, `GET/PATCH/DELETE /api/purchases/:id`  
**Tables:** `purchases`, `vendors`, `materials`, `raw_materials`, `items`, `stock_entries`, `stock_batches`  
**Related modules:** Vendors, Stock, GST (input credit), Accounts (Sundry Creditors)

---

### Stock
**Permission key:** `Stock` | **Permission group:** Inventory | **Sidebar section:** Operations (via navGroup override)

**Purpose:** Current stock level view across all branches.

**Features:** View stock per item per branch (outlet/warehouse/headoffice); filter by location; see quantity and cost; also available in Operations context as `/sales/stock` for branch staff

**Pages:** `/headoffice/stock`, `/sales/stock`  
**APIs used:** `GET /api/stock?branchType=&branchId=`  
**Tables:** `stock_entries`, `items`, `outlets`, `warehouses`  
**Related modules:** Production, Purchases, HO Transfers, Point of Sale

---

### Stock Ledger
**Permission key:** `Stock Ledger` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Append-only audit trail of every stock movement.

**Features:** View all stock entries (sale, purchase, production, transfer in/out, adjustment) per item per branch; running balance via SQL window function; non-modifiable after write

**Pages:** `/headoffice/stock-ledger`  
**APIs used:** `GET /api/stock/ledger`  
**Tables:** `stock_ledger` (append-only)  
**Related modules:** Stock, Inventory Reports

---

### Inventory Reports
**Permission key:** `Inventory Reports` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Cross-branch inventory analytics including batch expiry.

**Features:** Stock summary across all outlets and warehouses; batch expiry report (items expiring soon/already expired); stock valuation (weighted average)

**Pages:** `/headoffice/inventory-reports`  
**APIs used:** `GET /api/stock`, `GET /api/stock/batches`, `GET /api/stock/expiry-report`, `GET /api/stock/valuation`  
**Tables:** `stock_entries`, `stock_batches`, `items`, `outlets`, `warehouses`  
**Related modules:** Stock, Stock Ledger, Production

---

### Stock Verification
**Permission key:** `Stock Verification` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Physical stock count recording and adjustment.

**Features:** Record a physical stock verification event; post adjustments; non-destructive audit records

**Pages:** `/headoffice/stock-verification`  
**APIs used:** `POST /api/stock/verifications`, `GET /api/stock`  
**Tables:** `stock_verifications`, `stock_entries`, `stock_batches`  
**Related modules:** Stock, Stock Ledger

---

### Warehouses
**Permission key:** `Warehouses` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Warehouse master management.

**Features:** Add/edit/delete warehouses; auto-provisions Cash, Sales, and Purchase ledgers per warehouse on creation; ledger IDs stored back on the warehouse row

**Pages:** `/headoffice/warehouses`  
**APIs used:** `GET/POST /api/warehouses`, `PATCH/DELETE /api/warehouses/:id`  
**Tables:** `warehouses`, `account_ledgers`  
**Related modules:** Outlets, HO Transfers, Cash Balance, Sales

---

### Outlets
**Permission key:** `Outlets` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Retail outlet master management.

**Features:** Add/edit/delete outlets; auto-provisions Cash and Sales ledgers per outlet on creation; linked to a parent warehouse

**Pages:** `/headoffice/outlets`  
**APIs used:** `GET/POST /api/outlets`, `PATCH/DELETE /api/outlets/:id`  
**Tables:** `outlets`, `account_ledgers`, `warehouses`  
**Related modules:** Warehouses, Point of Sale, Cash Balance

---

### Item Prices
**Permission key:** `Item Prices` | **Permission group:** Inventory | **Sidebar section:** Inventory

**Purpose:** Location-specific selling price management.

**Features:** Set prices per Head Office / Warehouse / Outlet; optional validity window (valid from / valid to dates); Active/Inactive badge from date comparison; one price per (item, location, locationType) combination — POST upserts

**Pages:** `/headoffice/item-price`  
**APIs used:** `GET /api/item-prices`, `POST /api/item-prices`  
**Tables:** `item_prices` (raw SQL — startup-migration columns)  
**Related modules:** Items, Point of Sale

---

### Sales
**Permission key:** `Sales` | **Permission group:** Sales | **Sidebar section:** Sales

**Purpose:** Head-office level sales management — returns and outstanding.

**Features:** Sales Returns (credit notes), Purchase Returns (debit notes), Outstanding receivables/payables

**Pages:** `/returns`, `/outstanding`, `/headoffice/sales`  
**APIs used:** `GET /api/sales`, `POST /api/sales-returns`, `GET /api/sales-returns`, `POST /api/purchase-returns`, `GET /api/outstanding/receivables`, `GET /api/outstanding/payables`  
**Tables:** `sales`, `customers`, `vendors`, `purchases`, `journal_vouchers`, `payments`  
**Related modules:** Point of Sale, Customers, Vendors, GST Returns

---

### Customers
**Permission key:** `Customers` | **Permission group:** Sales | **Sidebar section:** Operations

**Purpose:** Customer master management.

**Features:** Add/edit/delete customers; credit limit and credit days configuration; customer ledger statement; auto-creates `CUST-{id}` ledger under Sundry Debtors; delete blocked if linked sales exist

**Pages:** `/customers`  
**APIs used:** `GET/POST /api/customers`, `PATCH/DELETE /api/customers/:id`, `GET /api/customers/:id/ledger`  
**Tables:** `customers`, `account_ledgers`, `sales`  
**Related modules:** Point of Sale, Outstanding, Sales

---

### Vendors
**Permission key:** `Vendors` | **Permission group:** Production | **Sidebar section:** Production

**Purpose:** Supplier/vendor master management.

**Features:** Add/edit/delete vendors; vendor ledger statement; record vendor payment; auto-creates `VEND-{id}` ledger under Sundry Creditors; delete blocked if linked purchases exist

**Pages:** `/vendors`  
**APIs used:** `GET/POST /api/vendors`, `PATCH/DELETE /api/vendors/:id`, `GET /api/vendors/:id/ledger`, `POST /api/vendors/:id/payment`  
**Tables:** `vendors`, `account_ledgers`, `purchases`, `payments`  
**Related modules:** Purchases, Outstanding, Accounts

---

### Coupons
**Permission key:** `Coupons` | **Permission group:** Sales | **Sidebar section:** Sales

**Purpose:** Discount coupon management.

**Features:** Create coupons with fixed ₹ or % discount; set validity period and usage limit; track usage count; applied at POS bill level (post-tax)

**Pages:** `/coupons`  
**APIs used:** `GET/POST /api/coupons`, `PATCH/DELETE /api/coupons/:id`  
**Tables:** `coupons`  
**Related modules:** Point of Sale

---

### Employees
**Permission key:** `Employees` | **Permission group:** HR | **Sidebar section:** HR

**Purpose:** Employee master — HR record and ERP login account.

**Features:** Add/edit/deactivate employees; assign hierarchy and branch; set salary and join date; upload photo; record work experience; configure pay components (allowances/deductions); auto-forces password change on first login

**Pages:** `/hr/employees`  
**APIs used:** `GET/POST /api/hr/employees`, `GET/PATCH/DELETE /api/hr/employees/:id`  
**Tables:** `employees`, `hierarchies`, `pay_components`  
**Related modules:** Hierarchy, Payroll, Attendance, Permissions

---

### Attendance
**Permission key:** `Attendance` | **Permission group:** HR | **Sidebar section:** HR

**Purpose:** Employee attendance tracking via GPS check-in/check-out.

**Features:** View attendance records per employee and date; check-in/check-out with GPS coordinates; access leave management from this page (Leave module has no separate sidebar link)

**Pages:** `/hr/attendance`  
**APIs used:** `GET /api/hr/attendance`, `POST /api/hr/attendance/check-in`, `POST /api/hr/attendance/check-out`, `GET/POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve`  
**Tables:** `attendance`, `leaves`, `employees`  
**Related modules:** Leave, Payroll

---

### Leave
**Permission key:** `Leave` | **Permission group:** HR | **Sidebar section:** HR (no sidebar link — accessed via Attendance page)

**Purpose:** Employee leave request management.

**Features:** Submit leave requests (type, date range, reason); managers approve or reject with notes; approved leaves feed into payroll LOP calculation

**Pages:** Accessed within `/hr/attendance` and `/hr/leave`  
**APIs used:** `GET/POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve`  
**Tables:** `leaves`, `employees`  
**Related modules:** Attendance, Payroll

---

### Payroll
**Permission key:** `Payroll` | **Permission group:** HR | **Sidebar section:** HR

**Purpose:** Monthly payroll generation, approval, and payment.

**Features:**
- Generate payroll per employee for a month (reads attendance for present/LOP days)
- Applies pay components from `pay_components`
- Auto-deducts pending advances
- Draft → Approve (posts to COA: Dr Salary Expense / Cr Salary Payable) → Paid
- Payslip PDF generation

**Pages:** `/hr/payroll`, `/hr/advances`  
**APIs used:** `GET /api/hr/payroll`, `POST /api/hr/payroll/generate`, `PATCH/POST /api/hr/payroll/:id`, `POST /api/hr/payroll/:id/approve`, `POST /api/hr/payroll/:id/pay`, `GET/POST /api/hr/advances`  
**Tables:** `payroll`, `pay_components`, `attendance`, `employees`, `account_ledgers`, `payments`, `receipts`  
**Related modules:** Attendance, Employees, Chart of Accounts

---

### Hierarchy
**Permission key:** `Hierarchy` | **Permission group:** HR | **Sidebar section:** HR

**Purpose:** Organisational role/level definitions.

**Features:** Add/edit/delete hierarchy levels; Level 1 is always super-admin and cannot be restricted

**Pages:** `/hr/hierarchy`  
**APIs used:** `GET/POST /api/hr/hierarchies`, `PATCH/DELETE /api/hr/hierarchies/:id`  
**Tables:** `hierarchies`, `employees`, `permissions`  
**Related modules:** Employees, Permissions

---

### Chart of Accounts
**Permission key:** `Chart of Accounts` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Hierarchical double-entry Chart of Accounts management.

**Features:** View full ledger tree; add sub-ledgers and groups; set opening balances; system groups protected from deletion; bank ledger bank details management; financial statements (Balance Sheet, P&L) derived from COA

**Pages:** `/accounts/chart`  
**APIs used:** `GET/POST/PATCH/DELETE /api/accounts/chart`, `GET/POST /api/accounts/opening-balances`, `DELETE /api/accounts/opening-balances/:id`, `GET /api/accounts/financial-statements`  
**Tables:** `account_ledgers`, `opening_balances`  
**Related modules:** Ledger, Vouchers, All accounting modules

---

### Ledger
**Permission key:** `Ledger` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Individual account ledger statement with full transaction history.

**Features:** Select any ledger account; date-range statement with Dr/Cr/Balance columns; all voucher types included (sales receipts, vendor payments, journal vouchers, manual payments/receipts, expenses)

**Pages:** `/accounts/ledger`  
**APIs used:** `GET /api/accounts/ledger-statement`, `GET /api/accounts/ledger/:id/statement`  
**Tables:** Derived from `sales`, `receipts`, `payments`, `journal_vouchers`, `expenses`, `account_ledgers`  
**Related modules:** Chart of Accounts, Vouchers, Books

---

### Payments
**Permission key:** `Payments` | **Permission group:** Accounts | **Sidebar section:** Accounts (no sidebar link — accessed via Cash & Bank or Vouchers)

**Purpose:** Payment and receipt voucher management (accessed via `Cash & Bank` and `Receipts` pages).

**APIs used:** `GET/POST /api/accounts/payments`, `GET/POST /api/accounts/receipts`, `DELETE /api/accounts/receipts/:id`  
**Tables:** `payments`, `receipts`, `account_ledgers`  
**Related modules:** Cash & Bank, Vouchers, Ledger

---

### Cash & Bank
**Permission key:** `Cash & Bank` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Cash and bank account management — view balances and record transactions.

**Pages:** `/accounts/cash-bank`  
**APIs used:** `GET /api/accounts/cash-bank`, `POST /api/accounts/cash-bank`, `GET /api/accounts/cash-bank-book/ledgers`  
**Tables:** `account_ledgers`, `payments`, `receipts`  
**Related modules:** Reconciliation, Cash Balance, Books

---

### Vouchers
**Permission key:** `Vouchers` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** All accounting voucher types — Journal, Contra, Credit/Debit Notes.

**Features:**
- **Journal voucher**: Free-form debit/credit line pairs
- **Contra voucher**: Cash↔Bank transfer (Dr To / Cr From)
- **Credit Note**: Dr Sales ledger / Cr Customer ledger (sales return)
- **Debit Note**: Dr Vendor ledger / Cr Purchase ledger (purchase return)

**Pages:** `/accounts/vouchers`, `/accounts/journal`, `/accounts/contra`, `/accounts/notes`  
**APIs used:** `GET/POST /api/accounts/journal-vouchers`, `DELETE /api/accounts/journal-vouchers/:id`  
**Tables:** `journal_vouchers`, `journal_voucher_lines`, `account_ledgers`  
**Related modules:** Chart of Accounts, Ledger, Books

---

### Books
**Permission key:** `Books` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Accounting books — Day Book, Cash Book, Bank Book, Trial Balance.

**Features:**
- **Day Book**: All transactions in date order across all voucher types
- **Cash Book**: Cash account Dr/Cr entries with running balance
- **Bank Book**: Bank account Dr/Cr entries with running balance
- **Trial Balance**: Debit/credit totals per ledger account

**Pages:** `/accounts/day-book`, `/accounts/cash-book`, `/accounts/bank-book`, `/accounts/trial-balance`  
**APIs used:** `GET /api/accounts/day-book`, `GET /api/accounts/cash-bank-book`, `GET /api/accounts/trial-balance`  
**Tables:** Derived from `sales`, `receipts`, `payments`, `journal_vouchers`, `expenses`, `account_ledgers`  
**Related modules:** Ledger, Vouchers, Chart of Accounts

---

### Expenses
**Permission key:** `Expenses` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Head-office level expense recording.

**Features:** Record expenses against any expense category ledger; payment from cash or bank account; date and description

**Pages:** `/accounts/expenses`  
**APIs used:** `GET/POST /api/expenses`, `GET /api/accounts/expense-ledgers`  
**Tables:** `expenses`, `account_ledgers`  
**Related modules:** Location Expenses, Chart of Accounts, Ledger

---

### GST Summary
**Permission key:** `GST Summary` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** GST output/input tax summary by rate slab and period.

**Features:** Output GST collected on sales; input GST paid on purchases; net GST payable; breakdowns by CGST/SGST/IGST and by rate slab

**Pages:** `/accounts/gst`  
**APIs used:** `GET /api/gst/summary`, `GET /api/gst/hsn-summary`  
**Tables:** Derived from `sales`, `purchases`, `account_ledgers`  
**Related modules:** GST Returns, Sales, Purchases

---

### GST Returns
**Permission key:** `GST Returns` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** GSTR-1 and GSTR-3B return preparation.

**Features:** GSTR-1 (B2B and B2C invoice register); GSTR-3B (monthly summary — output tax, ITC, net payable); GST reconciliation (ledger vs register comparison); HSN summary; date-range filtering

**Pages:** `/accounts/gst-returns`  
**APIs used:** `GET /api/gst/gstr1`, `GET /api/gst/gstr3b`, `GET /api/gst/reconciliation`, `GET /api/gst/hsn-summary`  
**Tables:** `sales`, `purchases`, `customers`, `company_settings`, `account_ledgers`  
**Related modules:** GST Summary, Sales, Purchases, Accounts

---

### Reconciliation
**Permission key:** `Reconciliation` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Bank reconciliation for digital payments (UPI, card).

**Features:** List pending unreconciled electronic sale payments; create settlement batch with gross/charges/net; batch marks individual payments reconciled; posts Receipt and Payment JVs; also reconciles cash deposits from Cash Balance module

**Pages:** `/accounts/reconciliation`  
**APIs used:** `GET /api/reconciliation/bank-ledgers`, `GET /api/reconciliation/pending`, `GET/POST /api/reconciliation/batches`, `GET /api/reconciliation/batches/:id`  
**Tables:** `reconciliation_batches`, `reconciliation_batch_items`, `sale_payments`, `receipts`, `payments`, `account_ledgers`  
**Related modules:** Cash Balance, Cash & Bank, Sales

---

### Reports
**Permission key:** `Reports` | **Permission group:** Accounts | **Sidebar section:** Accounts

**Purpose:** Analytical reports centre — 6 report sections.

**Report sections:**
- **Sales Reports**: Sales register, sales by item, sales by location, discounts report, combined stock-sales
- **Purchase Reports**: Purchase register, purchases by vendor, purchases by material
- **Financial Reports**: Balance Sheet, Profit & Loss
- **Inventory Reports**: Stock summary across branches
- **Production Reports**: Batch production analytics
- **Parties Reports**: Customer and vendor summaries

**Pages:** `/reports/:cat` (ReportsCenter component with section tabs)  
**APIs used:** `GET /api/reports/sales-register`, `/sales-by-item`, `/sales-by-location`, `/discounts`, `/sales-stock-combined`, `/purchase-register`, `/purchases-by-vendor`, `/purchases-by-material`, `/profitability`, `GET /api/accounts/financial-statements`  
**Tables:** `sales`, `purchases`, `stock_entries`, `items`, `customers`, `vendors`, `account_ledgers`  
**Related modules:** Sales, Purchases, Chart of Accounts, Inventory Reports

---

### Dashboard
**Permission key:** `Dashboard` | **Permission group:** Dashboard | **Sidebar section:** Standalone (top of sidebar)

**Purpose:** Executive business overview.

**Features:** Revenue KPIs, sales count, production volume, stock value; daily sales trend chart; stock alerts (low stock); recent activity feed; sales by location breakdown; top-selling items; production trend

**Pages:** `/`, `/dashboard`  
**APIs used:** `GET /api/dashboard/summary`, `/sales-trend`, `/stock-alerts`, `/recent-activity`, `/top-items`, `/sales-by-location`, `/production-trend`  
**Tables:** `sales`, `productions`, `stock_entries`, `items`, `outlets`, `warehouses`, `activity_log`  
**Related modules:** All modules (read-only aggregates)

---

### Settings
**Permission key:** `Settings` | **Permission group:** Company | **Sidebar section:** Company

**Purpose:** Company configuration and ERP settings.

**Features:** Edit company name, address, GST/PAN, bank details, logo, invoice prefix, financial year start month, production overhead %, voucher prefix configuration

**Pages:** `/company/settings`, `/company/profile`, `/company/audit`  
**APIs used:** `GET/PATCH /api/company/settings`, `GET /api/audit/logs`, `GET /api/audit/logs/:id`  
**Tables:** `company_settings`, `activity_log`  
**Related modules:** All modules (company info used everywhere)

---

### Permissions
**Permission key:** `Permissions` | **Permission group:** Company | **Sidebar section:** Company

**Purpose:** Role-based access control configuration.

**Features:** Set canView/canAdd/canEdit/canDelete/canDownload per module per hierarchy level; grouped view matching sidebar sections

**Pages:** `/company/permissions`  
**APIs used:** `GET /api/company/permissions`, `POST /api/company/permissions`  
**Tables:** `permissions`, `hierarchies`  
**Related modules:** Hierarchy, all modules

---

### Login History
**Permission key:** `Login History` | **Permission group:** Company | **Sidebar section:** Company

**Purpose:** Security audit of login events.

**Features:** View all login attempts (success and failure) with IP address, user-agent, and timestamp

**Pages:** `/company/login-history`  
**APIs used:** `GET /api/company/login-history`  
**Tables:** `login_history`  
**Related modules:** Employees, Settings

---

## 7. Business Workflows

### 7.1 Purchase Workflow

```
Manager identifies material/raw material need
         │
         ▼
PURCHASE ORDER CREATION (POST /api/purchases)
  - Select vendor
  - Add line items: material type, ID, quantity, unit cost
  - Input invoice number, date, notes
  - GST auto-calculated per line (tax_rate from material master)
  - discount_total and round_off applied
  │
  ▼
Stock credited immediately on creation:
  - materials / raw_materials: current_stock += quantity
  - stock_entries: quantity += quantity (headoffice branch)
  - stock_batches: new lot created (batchNumber, mfgDate, expiryDate if provided)
  - avg_cost updated (weighted average)
  │
  ▼
Accounting (derived posting via buildDerivedPostings):
  - Dr STD-PUR (Purchase ledger) for taxable amount
  - Dr STD-INP-CGST/SGST or STD-INP-IGST for input GST
  - Cr VEND-{vendorId} (Sundry Creditors) for total amount
  │
  ▼
Vendor payment when due (POST /api/vendors/:id/payment):
  - Dr VEND-{vendorId} (reduces outstanding)
  - Cr Cash or Bank ledger
```

**Edit/Delete:** PATCH reverses old stock impact and applies new; DELETE fully reverses all stock changes.

---

### 7.2 Production Workflow

```
Production batch initiated
         │
         ▼
PRODUCTION BATCH CREATION (POST /api/productions)
  - Select finished goods item
  - Enter produced quantity, production date
  - List materials consumed (materialType, materialId, quantity)
  - List wastage items if any
  │
  ▼
Cost calculation (automatic):
  materialCost = Σ (quantity × material.cost)
  overheadAmount = materialCost × overheadPercent / 100
  totalCost = materialCost + overheadAmount
  costPerUnit = totalCost / producedQuantity
  │
  ▼
Stock effects (atomic):
  - materials: current_stock -= consumed qty
  - raw_materials: current_stock -= consumed qty
  - items: production_stock += producedQuantity
  - stock_entries (headoffice): quantity += producedQuantity
  - stock_batches: new lot created for this batch
  - items.cost updated (weighted average with new costPerUnit)
  │
  ▼
BOM comparison available on Production Reports:
  - Actual material usage vs expected (from bom_templates)
  - Variance flagged for manager review
```

**Delete:** Fully reverses all stock impacts (production_stock decremented, materials/raw_materials restored).

---

### 7.3 Inventory / Stock Transfer Workflow

```
Source branch manager initiates transfer
         │
         ▼
DISPATCH (POST /api/stock/transfers)
  - Select from_branch and to_branch
  - Add line items (itemId, quantity)
  - System allocates batches via FEFO, captures batchBreakdown
  - is_interstate auto-detected from GSTIN comparison
  - Source stock_entries: quantity -= dispatched quantity (IMMEDIATE)
  - Source stock_batches: lots decremented in FEFO order
  - status = 'in_transit'
  - challan_number auto-generated
  │
  ▼
Destination manager reviews the challan
         │
    ┌────┴────┐
    │         │
 APPROVE    REJECT
    │         │
    ▼         ▼
APPROVE      Source stock restored:
  - Enter received quantities per line   stock_entries += dispatched qty
  - Destination stock_entries += received qty   stock_batches restored via
  - Destination stock_batches credited         batchBreakdown
  - status = 'approved'                status = 'rejected'
  - approved_by, approved_at recorded  rejection_reason stored
  │
  ▼
GST Journal Entries auto-created on approval:
  If internal (same company, headoffice↔branch):
    - Dr STD-BRANCH-DEBTOR (destination side)
    - Cr STD-BRANCH-CREDITOR (source side)
  If intrastate (different GSTIN, same state):
    - Dr CGST + SGST ledgers
    - Cr corresponding output ledgers
  If interstate (different states):
    - Dr IGST ledger
    - Cr output IGST ledger
```

---

### 7.4 Sales Workflow (Point of Sale)

```
Branch staff selects location at /sales → LocationPicker
         │
         ▼
POINT OF SALE (/sales/pos)
  1. Select items → price fetched from item_prices (active for today's date)
  2. Enter quantities
  3. Select customer (optional; required for credit)
  4. Apply coupon code (optional) → discount_total deducted post-tax
  5. Select payment mode: cash | upi | card | credit
         │
         ▼
Credit limit check (if payment_mode = 'credit'):
  - existing_outstanding = customer's current dues
  - new_invoice_total + existing_outstanding ≤ credit_limit (or credit_limit = 0)
  - Blocked if exceeded (override requires elevated permission)
         │
         ▼
SALE CREATION (POST /api/sales)
  - Invoice number = company_settings.invoice_prefix + sequence (auto-incremented)
  - Line GST split: intrastate → CGST + SGST; interstate → IGST
  - discount_total stored as bill-level coupon value
  - Stock deduction: stock_entries (location branch) -= each line quantity
  - Batch FEFO allocation: stock_batches decremented in expiry order
         │
         ▼
Accounting postings (at creation):
  If cash:    Dr OUTLET-CASH-{id} or WH-CASH-{id}     Cr OUTLET-SAL-{id} or WH-SAL-{id}
  If upi/card: Dr STD-ELEC-CLR (clearing account)     Cr Location Sales ledger
  If credit:   Dr CUST-{customerId} (Sundry Debtors)  Cr Location Sales ledger
  GST split (derived):
    Intrastate: Cr STD-OUT-CGST + STD-OUT-SGST
    Interstate: Cr STD-OUT-IGST
         │
         ▼
Invoice PDF generated (client-side or HMAC public link)
WhatsApp share → POST /api/sales/:id/share-token → time-limited HMAC URL
```

**Sale Edit:** PUT `/api/sales/:id` reverses old stock → applies new stock; reverses old accounting → applies new.

---

### 7.5 Payment Collection Workflow (Credit Sales)

```
Credit sale created → payment_status = 'unpaid', amount_paid = 0
         │
         ▼
Customer makes partial or full payment
         │
         ▼
PAYMENT RECORDING (POST /api/sales/:id/payments)
  - method: cash | upi | card
  - amount, reference_number, notes
  - sale.amount_paid += amount
  - payment_status updated: amount_paid >= total_amount → 'paid'
                             amount_paid > 0 → 'partially_paid'
         │
         ▼
Accounting:
  Dr Cash/Bank ledger (or ELEC-CLR for digital)
  Cr CUST-{customerId} (Sundry Debtors)
```

---

### 7.6 Bank Reconciliation Workflow

```
Digital sale payments (UPI/card) accumulate in sale_payments
  with reconciliation_status = 'pending'
         │
         ▼
Bank settlement received from payment processor
         │
         ▼
RECONCILIATION BATCH CREATION (POST /api/reconciliation/batches)
  - Select pending sale payment IDs
  - Enter gross_amount, charges, net_amount
  - Select destination bank ledger
  - Settlement date and external reference
         │
         ▼
System actions:
  - reconciliation_batch created
  - reconciliation_batch_items created (one per sale_payment)
  - sale_payments.reconciliation_status = 'reconciled'
  - Receipt JV posted: Dr destination_bank_ledger, Cr STD-ELEC-CLR (gross)
  - Payment JV posted: Dr STD-PROC-CHG (charges), Cr destination_bank_ledger
         │
         ▼
Net amount now sits in the bank account ledger
```

---

### 7.7 Accounts Workflow (Manual Vouchers)

```
Journal Voucher:
  Create lines with ledgerId, debit amount, credit amount
  Sum of debits must equal sum of credits
  Posted to journal_vouchers + journal_voucher_lines
  Feeds into: Ledger Statement, Day Book, Trial Balance

Contra Voucher:
  Select from_ledger (cash/bank) and to_ledger (cash/bank)
  Enter amount
  Dr to_ledger, Cr from_ledger
  Used for: cash↔bank transfers, cash deposits

Payment Voucher:
  Select paid_from_ledger (cash/bank) and paid_to_ledger (expense/vendor)
  Dr paid_to_ledger, Cr paid_from_ledger

Receipt Voucher:
  Select received_from_ledger (customer/other) and received_in_ledger (cash/bank)
  Dr received_in_ledger, Cr received_from_ledger
```

---

### 7.8 GST Workflow

```
Sales created → Output GST posted to STD-OUT-CGST/SGST/IGST (per line tax)
         │
         ▼
Purchases created → Input GST posted to STD-INP-CGST/SGST/IGST
         │
         ▼
GST Summary (GET /api/gst/summary):
  - Output GST by period and rate slab
  - Input GST by period and rate slab
  - Net GST payable = Output − Input
         │
         ▼
GSTR-1 (GET /api/gst/gstr1):
  - B2B invoices: customer GSTIN, invoice number, taxable value, tax
  - B2C invoices: aggregate by rate slab
         │
         ▼
GSTR-3B (GET /api/gst/gstr3b):
  - Outward supplies summary
  - ITC available
  - Net tax payable
         │
         ▼
GST Reconciliation (GET /api/gst/reconciliation):
  - Compares GST per ledger (buildDerivedPostings) vs GST per invoice register
  - Flags mismatches for accountant review
```

---

### 7.9 Payroll Workflow

```
Attendance records exist for the month (check_in/check_out)
         │
         ▼
PAYROLL GENERATION (POST /api/hr/payroll/generate)
  - employee_id, month, year
  - Counts present_days from attendance where status = 'present'
  - lop_days = working_days − present_days − approved_leave_days
  - lop_deduction = (salary / working_days) × lop_days
  - gross_pay = (salary / working_days) × present_days
  - Applies pay_components (allowances + deductions)
  - advance_deduction = sum of unpaid advances (auto-deducted)
  - net_pay = gross_pay + allowances − deductions − lop_deduction − advance_deduction
  - status = 'draft'
         │
         ▼
Manager reviews and APPROVES (POST /api/hr/payroll/:id/approve)
  - status = 'approved'
  - COA posting:
    Dr Salary Expense ledger (under Direct Expense)
    Cr Salary Payable ledger (under Current Liabilities)
  - If advance_deduction > 0:
    Dr Salary Payable (offset)
    Cr Advance ledger (ADV-EMP-{id})
         │
         ▼
Payment disbursed → MARK PAID (POST /api/hr/payroll/:id/pay)
  - status = 'paid', paid_date = today
  - Payment voucher:
    Dr Salary Payable
    Cr Cash or Bank ledger
         │
         ▼
Payslip PDF available (POST /api/pdf/payslip)
Employees can view payslip in mobile app
```

---

### 7.10 HR Workflow

```
HIERARCHY setup:
  Management (Level 1) → Supervisor (Level 2) → Staff (Level 3)
         │
         ▼
EMPLOYEE CREATION:
  Assign hierarchy level → determines ERP access
  Assign branch (headoffice/outlet/warehouse)
  Set salary, join date, pay components
  Username + password created → must_change_password = true on first login
         │
         ▼
ATTENDANCE (daily):
  Employee checks in (POST /api/hr/attendance/check-in) with GPS
  Employee checks out (POST /api/hr/attendance/check-out) with GPS
  Status: present / half_day / absent / leave
         │
         ▼
LEAVE REQUEST:
  Employee submits leave (POST /api/hr/leaves)
  Manager approves/rejects (POST /api/hr/leaves/:id/approve)
  Approved leaves credited to attendance as leave days (not LOP)
         │
         ▼
ADVANCE REQUEST:
  Manager records advance (POST /api/hr/advances)
  Auto-deducted from next payroll generation
         │
         ▼
PAYROLL (monthly — see Payroll Workflow above)
```

---

## 8. Permission Structure

### 8.1 Hierarchy Levels

| Level | Name | Behaviour |
|---|---|---|
| **1** | Management (default) | Full access to everything — bypasses all middleware checks |
| **2+** | User-defined | Access controlled by `permissions` table; default deny if no row |

Level 1 is hardcoded in both middleware and frontend hook — no permission rows are needed for level-1 users.

### 8.2 Permission Model

One `permissions` row per `(hierarchy_id, module)` combination:

```
permissions {
  hierarchy_id  → role
  module        → permission key (exact string from moduleRegistry.ts)
  can_view      → see the page/data
  can_add       → create records
  can_edit      → modify existing records
  can_delete    → delete/deactivate records
  can_download  → export data as CSV/PDF
}
```

If no row exists for a `(hierarchy_id, module)` combination → all flags default to `false`.

### 8.3 Module Keys (41 total)

All valid module keys (must match exactly — case-sensitive):

| Key | Permission Group |
|---|---|
| `Point of Sale` | Operations |
| `Location Stock` | Operations |
| `HO Transfers` | Inventory |
| `Location Expenses` | Operations |
| `Cash Balance` | Operations |
| `Units` | Production |
| `Items` | Production |
| `Production` | Production |
| `Purchases` | Production |
| `Stock` | Inventory |
| `Stock Ledger` | Inventory |
| `Inventory Reports` | Inventory |
| `Stock Verification` | Inventory |
| `Warehouses` | Inventory |
| `Outlets` | Inventory |
| `Item Prices` | Inventory |
| `Sales` | Sales |
| `Customers` | Sales |
| `Vendors` | Production |
| `Coupons` | Sales |
| `Employees` | HR |
| `Attendance` | HR |
| `Leave` | HR |
| `Payroll` | HR |
| `Hierarchy` | HR |
| `Chart of Accounts` | Accounts |
| `Ledger` | Accounts |
| `Payments` | Accounts |
| `Cash & Bank` | Accounts |
| `Vouchers` | Accounts |
| `Books` | Accounts |
| `Expenses` | Accounts |
| `GST Summary` | Accounts |
| `GST Returns` | Accounts |
| `Reconciliation` | Accounts |
| `Accounts Cash Balance` | Accounts |
| `Reports` | Accounts |
| `Dashboard` | Dashboard |
| `Settings` | Company |
| `Permissions` | Company |
| `Login History` | Company |

### 8.4 Permissions Page Grouping

The Permissions page (`/company/permissions`) shows modules in this order (`PERM_GROUP_ORDER`):

| Group (Permissions Page) | Modules |
|---|---|
| **Operations** | Point of Sale · Location Stock · Location Expenses · Cash Balance |
| **Production** | Units · Items · Production · Purchases · Vendors |
| **Inventory** | HO Transfers · Stock · Stock Ledger · Inventory Reports · Stock Verification · Warehouses · Outlets · Item Prices |
| **Sales** | Sales · Customers · Coupons |
| **HR** | Employees · Attendance · Leave · Payroll · Hierarchy |
| **Accounts** | Chart of Accounts · Ledger · Payments · Cash & Bank · Vouchers · Books · Expenses · GST Summary · GST Returns · Reconciliation · Accounts Cash Balance · Reports |
| **Dashboard** | Dashboard |
| **Company** | Settings · Permissions · Login History |

### 8.5 Branch Permissions

Employees are assigned `branch_type` and `branch_id` at creation:

| Branch Type | Typical Use |
|---|---|
| `headoffice` | Managers, accountants, admin (branch_id = 0) |
| `outlet` | Outlet staff (branch_id = outlet ID) |
| `warehouse` | Warehouse staff (branch_id = warehouse ID) |

Branch scoping on GET routes is enforced by passing `branchType` / `branchId` query params from the frontend. The backend does NOT enforce branch-level row filtering on most GET routes — it relies on the frontend's LocationProvider.

Exception: `GET /api/stock` does filter by `branchType` + `branchId` from query params.

### 8.6 Frontend Permission Enforcement

`usePermission(moduleKey)` drives all UI visibility:

| Flag | UI Effect |
|---|---|
| `canView = false` | Sidebar link hidden; page may still render empty |
| `canAdd = false` | "New" / "Add" buttons hidden or disabled |
| `canEdit = false` | "Edit" / "Save" buttons hidden or disabled |
| `canDelete = false` | "Delete" buttons hidden or disabled |
| `canDownload = false` | "Export CSV" / "Download PDF" buttons hidden |

### 8.7 Backend Permission Enforcement

| Guard | Applied to |
|---|---|
| `requireAuth` | All `/api/*` routes (except health, login, public invoices) |
| `requireModuleView(module)` | Selected GET routes (stock ledger, outstanding, customer ledger, etc.) |
| `requireModuleAction(module, 'add')` | All POST routes that create records |
| `requireModuleAction(module, 'edit')` | All PATCH/PUT routes |
| `requireModuleAction(module, 'delete')` | All DELETE routes |

**Many GET routes are intentionally unguarded** — they rely on frontend permission hiding for discretionary access control.

---

## 9. Accounting Structure

### 9.1 Chart of Accounts Structure

The COA follows a Tally-standard double-entry hierarchy seeded at startup:

```
Balance Sheet
├── Capital Accounts (SYS-CAP) [equity]
├── Loans (Liability) (SYS-LOAN) [liability]
├── Current Liabilities (SYS-CURL) [liability]
│   ├── Duty & Tax (STD-DTX) [liability]
│   │   ├── Output CGST (STD-OUT-CGST) [liability]
│   │   ├── Output SGST (STD-OUT-SGST) [liability]
│   │   ├── Output IGST (STD-OUT-IGST) [liability]
│   │   ├── Input CGST (STD-INP-CGST) [asset]
│   │   ├── Input SGST (STD-INP-SGST) [asset]
│   │   └── Input IGST (STD-INP-IGST) [asset]
│   └── Sundry Creditors (SYS-CREDITORS) [liability]
│       └── VEND-{id} per vendor [liability]
├── Fixed Asset (SYS-FIXD) [asset]
└── Current Asset (SYS-CURA) [asset]
    ├── Opening Stock (SYS-OPSTOCK) [asset]
    ├── Closing Stock (SYS-CLSTOCK) [asset]
    ├── Sundry Debtors (SYS-DEBTORS) [asset]
    │   └── CUST-{id} per customer [asset]
    ├── Bank (STD-BANK) [asset]
    │   └── Sub-ledgers per bank account
    ├── Cash (STD-CASH) [asset]
    │   ├── OUTLET-CASH-{id} per outlet [asset]
    │   └── WH-CASH-{id} per warehouse [asset]
    ├── Electronic Payment Clearing (STD-ELEC-CLR) [asset]
    └── Cash in Transit (STD-CIT) [asset]

Profit & Loss
├── Sales (SYS-SAL) [income]
│   ├── Sales (STD-SALES) [income]
│   ├── OUTLET-SAL-{id} per outlet [income]
│   └── WH-SAL-{id} per warehouse [income]
├── Direct Income (SYS-DIRINC) [income]
├── Indirect Income (SYS-INDINC) [income]
├── Purchase (SYS-PUR) [expense]
│   └── Purchases (STD-PUR) [expense]
│       └── WH-PUR-{id} per warehouse [expense]
├── Direct Expense (SYS-DIREXP) [expense]
└── Indirect Expense (SYS-INDEXP) [expense]
    └── Bank & Processor Charges (STD-PROC-CHG) [expense]
```

### 9.2 Voucher Types and Their Double-Entry Flows

#### Sales Invoice Posting
```
Payment mode: cash
  Dr OUTLET-CASH-{id} / WH-CASH-{id}         (full invoice total)
  Cr OUTLET-SAL-{id} / WH-SAL-{id}           (net of GST — derived split)
  Cr STD-OUT-CGST + STD-OUT-SGST             (intrastate GST)
  OR Cr STD-OUT-IGST                          (interstate GST)

Payment mode: upi / card
  Dr STD-ELEC-CLR                             (full invoice total)
  Cr Location Sales ledger + GST ledgers       (as above)

Payment mode: credit
  Dr CUST-{customerId}                        (full invoice total)
  Cr Location Sales ledger + GST ledgers       (as above)
```

Note: The `receipts` table records a single entry with `received_in_ledger_id = cash/clearing`, `received_from_ledger_id = sales ledger`. The GST sub-split is derived at query time by `buildDerivedPostings()` and `lineTaxHeads()`.

#### Sales Return Posting (Credit Note)
```
  Dr STD-SALES / Location Sales ledger        (return value, net)
  Cr CUST-{customerId}                        (for registered customers)
  OR Dr Cash ledger, Cr <nothing>             (cash refund for walk-ins)
```

#### Purchase Invoice Posting (Derived)
```
  Dr STD-PUR (Purchases)                      (taxable value)
  Dr STD-INP-CGST + STD-INP-SGST            (intrastate input tax)
  OR Dr STD-INP-IGST                          (interstate input tax)
  Cr VEND-{vendorId}                          (total payable)
```

#### Purchase Return Posting (Debit Note)
```
  Dr VEND-{vendorId}                          (return value)
  Cr STD-PUR / Location Purchase ledger       (returned goods value)
```

#### Vendor Payment
```
  Dr VEND-{vendorId}                          (reduces outstanding)
  Cr Cash / Bank ledger                       (payment source)
```

#### Receipt Voucher
```
  Dr received_in_ledger (cash/bank)
  Cr received_from_ledger (customer/income)
```

#### Payment Voucher
```
  Dr paid_to_ledger (expense/vendor)
  Cr paid_from_ledger (cash/bank)
```

#### Journal Voucher
```
  Dr ledger_A × amount_A
  Dr ledger_B × amount_B
  Cr ledger_C × amount_C
  Cr ledger_D × amount_D
  (sum of Dr = sum of Cr enforced by UI)
```

#### Contra Voucher (Cash↔Bank transfer)
```
  Dr to_ledger (destination cash/bank)
  Cr from_ledger (source cash/bank)
```

#### Expense Posting
```
  Dr ledger_account_id (expense category)
  Cr payment_account_id (cash or bank)
```

#### Payroll Approval Posting
```
  Dr Salary Expense (Direct Expense group)    (gross salary + allowances)
  Cr Salary Payable (Current Liabilities)     (net payable amount)
  Dr Salary Payable                           (advance offset, if any)
  Cr ADV-EMP-{id} (Advance ledger)            (advance already paid)
```

#### Payroll Payment Posting
```
  Dr Salary Payable
  Cr Cash / Bank ledger
```

#### Reconciliation Batch Posting
```
  Dr destination_bank_ledger                  (net amount)
  Dr STD-PROC-CHG (Processor Charges)        (charges amount)
  Cr STD-ELEC-CLR (Clearing account)         (gross amount)
```

#### Cash Deposit Posting
```
  Step 1 - Transit:
    Dr STD-CIT (Cash in Transit)
    Cr OUTLET-CASH-{id} / WH-CASH-{id}       (cash handed over)
  Step 2 - Reconcile:
    Dr destination_bank_ledger
    Cr STD-CIT
```

### 9.3 GST Calculation Logic

`lineTaxHeads(lineItems, companyState, partyState)`:
- Compares company GSTIN state code with party (customer/vendor) GSTIN state code
- **Intrastate** (same state or no GSTIN): splits tax into CGST (50%) + SGST (50%)
- **Interstate** (different states): full tax as IGST

Tax rate sources:
- Sales: `items.tax_rate` per line item
- Purchases: `materials.tax_rate` / `raw_materials.tax_rate` / `items.tax_rate` per line item

### 9.4 Financial Statements

`buildDerivedPostings()` aggregates all voucher tables into a unified ledger movement dataset:

Sources included:
- `sales` table (with GST split via `lineTaxHeads`)
- `purchases` table (with input GST split)
- `receipts` table
- `payments` table
- `expenses` table
- `journal_vouchers` + `journal_voucher_lines` table
- `opening_balances` table

**Trial Balance**: Debit/credit totals per ledger from `buildDerivedPostings()`  
**Ledger Statement**: Filtered to one ledger, ordered by date, running balance  
**Balance Sheet**: `section = 'balance_sheet'` ledgers with net movement  
**Profit & Loss**: `section = 'profit_loss'` ledgers with net movement  
**Day Book**: All movements in date order  
**Cash Book**: Movements for all Cash (`STD-CASH` subtree) ledgers  
**Bank Book**: Movements for all Bank (`STD-BANK` subtree) ledgers  

---

## 10. Inventory Structure

### 10.1 Material Types

| Type | Table | Used in |
|---|---|---|
| **Raw Materials** | `raw_materials` | Inputs to production (ingredients, primary inputs) |
| **Materials** | `materials` | Packaging and processing materials |
| **Finished Goods** | `items` | Output of production; sold to customers |

All three types appear in purchase line items (`materialType: 'raw_material'|'material'|'item'`).

### 10.2 Stock Locations

| Location Type | Branch ID | Stock Table |
|---|---|---|
| Head Office | 0 | `stock_entries (branch_type='headoffice', branch_id=0)` |
| Warehouse | warehouse.id | `stock_entries (branch_type='warehouse', branch_id=warehouse.id)` |
| Outlet | outlet.id | `stock_entries (branch_type='outlet', branch_id=outlet.id)` |

Production credits stock to headoffice. Stock transfers move stock between any two locations.

### 10.3 Batch Management (FEFO)

Every stock movement (purchase, production, transfer) creates entries in `stock_batches`:

```
stock_batches row:
  item_id, branch_type, branch_id,
  batch_number, mfg_date, expiry_date,
  quantity (remaining),
  unit_cost, source ('production'|'purchase'|'transfer'), source_id
```

**FEFO Allocation** (`lib/batches.ts → planFEFO()`):

Sort order: `expiry_date ASC NULLS LAST, id ASC`

Iteration:
1. Sort batches by expiry (earliest first; no-expiry batches last)
2. Consume from the earliest-expiry batch until quantity is satisfied
3. If total available < required → record "Untracked" shortfall

**`consumeBatches()`**:
1. Honour manual batch overrides first (specific batch IDs)
2. Call `planFEFO` for remaining quantity
3. Deduct from `stock_batches.quantity` (floor at 0)
4. Write stock_ledger entry

**`creditBatch()`**: Upsert `stock_batches` row by (item_id, branch, batch_number) — adds to existing lot if same batch number, creates new if different.

### 10.4 Stock Ledger

Append-only audit table written on every stock movement:

| `doc_type` | Trigger |
|---|---|
| `sale` | Sale creation / edit |
| `purchase` | Purchase creation / edit / delete |
| `production` | Production creation / delete |
| `transfer_out` | Transfer dispatch |
| `transfer_in` | Transfer approval |
| `adjustment` | Stock verification adjustment |

Running balance is computed at query time using a PostgreSQL window function (`SUM(quantity) OVER (PARTITION BY item_id, branch ORDER BY created_at)`).

### 10.5 Stock Transfer (State Machine)

```
POST /api/stock/transfers → status = 'in_transit'
  Source stock deducted immediately
  batchBreakdown captured on each line item

PATCH /api/stock/transfers/:id/approve → status = 'approved'
  Destination stock credited (received_line_items quantities)
  Batch lots allocated via allocateReceived (FEFO-ordered, capped at dispatched)
  GST JVs auto-created
  approved_by, approved_at recorded

PATCH /api/stock/transfers/:id/reject → status = 'rejected'
  Source stock restored using batchBreakdown
  rejection_reason stored
```

### 10.6 Item Pricing

- One price per `(item_id, location_type, outlet_id)` combination
- POST `/api/item-prices` upserts (UPDATE if exists, INSERT if not)
- `valid_from` / `valid_to` optional ISO date strings
- Active = `valid_from <= today <= valid_to` (or dates not set)
- POS fetches the price for the selected location; falls back to headoffice price if no location-specific price

### 10.7 Stock Verification

`POST /api/stock/verifications` records a physical count event. Quantity adjustments can be applied at the time of verification — these create `adjustment` entries in the stock ledger and update `stock_entries.quantity`.

---

## 11. Complete Page Documentation

### Authentication

#### `/login` — Login
| Field | Value |
|---|---|
| **Module** | Auth |
| **Purpose** | User authentication — submit username/password, receive JWT |
| **Features** | Username/password form; rate-limited to 5 attempts/15 min; shows error on invalid credentials; redirects to `/` on success or `/change-password` if `mustChangePassword = true` |
| **Permission keys** | None |
| **APIs called** | `POST /api/auth/login` |
| **Tables** | `employees`, `hierarchies`, `login_history` |

#### `/change-password` — Change Password
| Field | Value |
|---|---|
| **Module** | Auth |
| **Purpose** | Forced password change on first login or admin reset |
| **Features** | Current password + new password + confirm fields; cannot access rest of app until complete |
| **Permission keys** | None (allowMustChange = true in AuthGuard) |
| **APIs called** | `POST /api/auth/change-password` |
| **Tables** | `employees` |

---

### Dashboard

#### `/` or `/dashboard` — Dashboard
| Field | Value |
|---|---|
| **Module** | Dashboard |
| **Purpose** | Executive business overview — KPIs, charts, alerts |
| **Features** | Revenue total, sales count, production volume, stock value KPI cards; daily sales trend chart; stock alerts list; recent activity feed; top-selling items; sales by location chart; production trend |
| **Permission keys** | `Dashboard` (canView) |
| **APIs called** | `GET /api/dashboard/summary`, `/sales-trend`, `/stock-alerts`, `/recent-activity`, `/top-items`, `/sales-by-location`, `/production-trend` |
| **Tables** | `sales`, `productions`, `stock_entries`, `items`, `outlets`, `warehouses`, `activity_log` |

---

### Operations (Sales branch)

#### `/sales` — Location Picker
| Field | Value |
|---|---|
| **Module** | Operations |
| **Purpose** | Branch selection before accessing any Operations page |
| **Features** | Lists available outlets and warehouses; sets LocationProvider context; persists to localStorage |
| **Permission keys** | None |
| **APIs called** | `GET /api/outlets`, `GET /api/warehouses` |
| **Tables** | `outlets`, `warehouses` |

#### `/sales/dashboard` — Sales Dashboard
| Field | Value |
|---|---|
| **Module** | Operations |
| **Purpose** | Location-scoped sales summary for selected branch |
| **Features** | Branch-filtered revenue KPIs, payment mode breakdown, recent sales list |
| **Permission keys** | `Point of Sale` (canView) |
| **APIs called** | `GET /api/dashboard/summary`, `GET /api/sales?locationType=&locationId=` |
| **Tables** | `sales`, `outlets`, `warehouses` |

#### `/sales/pos` — Point of Sale
| Field | Value |
|---|---|
| **Module** | Point of Sale |
| **Purpose** | Create sales invoices for customers at the selected branch |
| **Features** | Item selection, quantity, live pricing, GST calculation, coupon application, payment mode, credit limit check, invoice PDF, WhatsApp share |
| **Permission keys** | `Point of Sale` (canAdd to create, canEdit to update) |
| **APIs called** | `GET /api/items`, `GET /api/item-prices`, `GET /api/customers`, `GET /api/coupons`, `POST /api/sales`, `PUT /api/sales/:id`, `GET /api/sales/:id`, `POST /api/sales/:id/share-token` |
| **Tables** | `sales`, `sale_payments`, `stock_entries`, `stock_batches`, `item_prices`, `customers`, `items`, `account_ledgers` |

#### `/sales/stock` — Sales Stock
| Field | Value |
|---|---|
| **Module** | Stock |
| **Purpose** | View current stock levels at the selected branch |
| **Features** | Item stock quantities for the selected outlet/warehouse |
| **Permission keys** | `Stock` (canView) |
| **APIs called** | `GET /api/stock?branchType=&branchId=` |
| **Tables** | `stock_entries`, `items` |

#### `/sales/expenses` — Sales Expenses
| Field | Value |
|---|---|
| **Module** | Location Expenses |
| **Purpose** | Record and view operational expenses at the branch |
| **Features** | Add expense with category, amount, date; view expense list; delete; summary by category |
| **Permission keys** | `Location Expenses` (canAdd, canDelete) |
| **APIs called** | `GET/POST /api/accounts/location-expenses`, `GET /api/accounts/location-expenses/summary`, `DELETE /api/accounts/location-expenses/:id` |
| **Tables** | `expenses`, `account_ledgers` |

#### `/sales/cash-balance` — Sales Cash Balance
| Field | Value |
|---|---|
| **Module** | Cash Balance |
| **Purpose** | View cash in hand at the selected branch |
| **Features** | Current cash balance for outlet/warehouse; deposit history |
| **Permission keys** | `Cash Balance` (canView) |
| **APIs called** | `GET /api/cash-in-outlet?locationType=&locationId=` |
| **Tables** | `cash_deposits`, `account_ledgers` |

#### `/transfers` — Stock Transfers
| Field | Value |
|---|---|
| **Module** | HO Transfers |
| **Purpose** | Inter-branch stock transfer management (dispatch, approve, reject) |
| **Features** | Create transfer (dispatch), view in-transit list, approve with received quantities, reject with reason; challan detail view |
| **Permission keys** | `HO Transfers` (canAdd, canEdit) |
| **APIs called** | `GET/POST /api/stock/transfers`, `PATCH /api/stock/transfers/:id/approve`, `PATCH /api/stock/transfers/:id/reject`, `GET /api/stock/transfers/:id` |
| **Tables** | `stock_transfers`, `stock_entries`, `stock_batches`, `items`, `outlets`, `warehouses` |

---

### Inventory (Head Office)

#### `/headoffice/stock` — Stock
| Field | Value |
|---|---|
| **Module** | Stock |
| **Purpose** | Stock levels across all branches |
| **Features** | Filter by item name, branch; stock quantity and cost per item per branch |
| **Permission keys** | `Stock` (canView) |
| **APIs called** | `GET /api/stock` |
| **Tables** | `stock_entries`, `items`, `outlets`, `warehouses` |

#### `/headoffice/stock-ledger` — Stock Ledger
| Field | Value |
|---|---|
| **Module** | Stock Ledger |
| **Purpose** | Append-only stock movement audit trail |
| **Features** | Date range, item, branch filters; Dr/Cr quantity, running balance; doc_type badges |
| **Permission keys** | `Stock Ledger` (canView) |
| **APIs called** | `GET /api/stock/ledger` |
| **Tables** | `stock_ledger`, `items`, `outlets`, `warehouses` |

#### `/headoffice/stock-verification` — Stock Verification
| Field | Value |
|---|---|
| **Module** | Stock Verification |
| **Purpose** | Physical stock count recording and adjustment |
| **Features** | Enter verified quantities per item; adjustments applied; notes |
| **Permission keys** | `Stock Verification` (canAdd) |
| **APIs called** | `POST /api/stock/verifications`, `GET /api/stock` |
| **Tables** | `stock_verifications`, `stock_entries`, `stock_batches` |

#### `/headoffice/inventory-reports` — Inventory Reports
| Field | Value |
|---|---|
| **Module** | Inventory Reports |
| **Purpose** | Cross-branch inventory analytics |
| **Features** | Stock summary, batch expiry report, stock valuation (weighted average) |
| **Permission keys** | `Inventory Reports` (canView, canDownload) |
| **APIs called** | `GET /api/stock`, `GET /api/stock/batches`, `GET /api/stock/expiry-report`, `GET /api/stock/valuation` |
| **Tables** | `stock_entries`, `stock_batches`, `items`, `outlets`, `warehouses` |

#### `/headoffice/item-price` — Item Prices
| Field | Value |
|---|---|
| **Module** | Item Prices |
| **Purpose** | Location-specific item price configuration |
| **Features** | Set price per item per location (HO/warehouse/outlet) with optional validity dates; Active/Inactive badge |
| **Permission keys** | `Item Prices` (canAdd) |
| **APIs called** | `GET /api/item-prices`, `POST /api/item-prices`, `GET /api/items`, `GET /api/outlets`, `GET /api/warehouses` |
| **Tables** | `item_prices`, `items`, `outlets`, `warehouses` |

#### `/headoffice/warehouses` — Warehouses
| Field | Value |
|---|---|
| **Module** | Warehouses |
| **Purpose** | Warehouse master management |
| **Features** | Add/edit/delete warehouses; auto-provision ledgers on create |
| **Permission keys** | `Warehouses` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/warehouses`, `PATCH/DELETE /api/warehouses/:id` |
| **Tables** | `warehouses`, `account_ledgers` |

#### `/headoffice/outlets` — Outlets
| Field | Value |
|---|---|
| **Module** | Outlets |
| **Purpose** | Outlet master management |
| **Features** | Add/edit/delete outlets; assign parent warehouse; auto-provision ledgers on create |
| **Permission keys** | `Outlets` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/outlets`, `PATCH/DELETE /api/outlets/:id`, `GET /api/warehouses` |
| **Tables** | `outlets`, `warehouses`, `account_ledgers` |

#### `/headoffice/sales` — HO Sales
| Field | Value |
|---|---|
| **Module** | Sales |
| **Purpose** | Head-office view of all sales across locations |
| **Features** | Full sales list with filters; invoice detail slide-out; PDF download; WhatsApp share; payment status |
| **Permission keys** | `Sales` (canView, canDownload) |
| **APIs called** | `GET /api/sales`, `GET /api/sales/:id`, `POST /api/sales/:id/share-token`, `GET /api/sales/:id/payments` |
| **Tables** | `sales`, `sale_payments`, `customers`, `outlets`, `warehouses` |

---

### Production

#### `/production/units` — Units
| Field | Value |
|---|---|
| **Module** | Units |
| **Purpose** | Unit of measure master |
| **Features** | Add/edit units; used across material and item forms |
| **Permission keys** | `Units` (canAdd, canEdit) |
| **APIs called** | `GET/POST /api/units`, `PATCH /api/units/:id` |
| **Tables** | `units` |

#### `/production/item-master` — Item Master
| Field | Value |
|---|---|
| **Module** | Items |
| **Purpose** | Centralized hub for finished goods, materials, raw materials, and BOMs |
| **Features** | Tabbed view: Items, Materials, Raw Materials, BOM Templates; add/edit/delete all types |
| **Permission keys** | `Items` (canAdd, canEdit, canDelete), `Production` (canAdd, canEdit, canDelete for BOM) |
| **APIs called** | `GET/POST /api/items`, `GET/POST /api/materials`, `GET/POST /api/raw-materials`, `GET/POST /api/bom-templates` |
| **Tables** | `items`, `materials`, `raw_materials`, `bom_templates`, `units` |

#### `/production/items` — Items (list)
| Field | Value |
|---|---|
| **Module** | Items |
| **Purpose** | Finished goods item list |
| **Permission keys** | `Items` |
| **APIs called** | `GET /api/items`, `PATCH/DELETE /api/items/:id` |
| **Tables** | `items` |

#### `/production/production` — Production Batches
| Field | Value |
|---|---|
| **Module** | Production |
| **Purpose** | Production batch recording and management |
| **Features** | Create batch with item, qty, materials consumed, wastage; cost auto-calculated; BOM comparison; edit/delete with stock reversal |
| **Permission keys** | `Production` (canAdd, canEdit, canDelete, canDownload) |
| **APIs called** | `GET/POST /api/productions`, `GET/PATCH/DELETE /api/productions/:id`, `GET /api/bom-templates/item/:itemId`, `GET /api/items`, `GET /api/materials`, `GET /api/raw-materials` |
| **Tables** | `productions`, `items`, `materials`, `raw_materials`, `stock_entries`, `stock_batches`, `bom_templates` |

#### `/production/reports` — Production Reports
| Field | Value |
|---|---|
| **Module** | Production |
| **Purpose** | Production analytics — yield, BOM variance, batch cost history |
| **Features** | Date-range analytics, wastage summary, material consumption reports |
| **Permission keys** | `Production` (canView, canDownload) |
| **APIs called** | `GET /api/productions/reports` |
| **Tables** | `productions`, `items`, `materials`, `raw_materials`, `bom_templates` |

#### `/production/purchase` — Purchases
| Field | Value |
|---|---|
| **Module** | Purchases |
| **Purpose** | Purchase order management from vendors |
| **Features** | Create PO with vendor, line items, GST; edit/delete with stock reversal; PDF generation |
| **Permission keys** | `Purchases` (canAdd, canEdit, canDelete, canDownload) |
| **APIs called** | `GET/POST /api/purchases`, `GET/PATCH/DELETE /api/purchases/:id`, `GET /api/vendors`, `GET /api/materials`, `GET /api/raw-materials`, `GET /api/items` |
| **Tables** | `purchases`, `vendors`, `materials`, `raw_materials`, `items`, `stock_entries`, `stock_batches` |

---

### Customers, Vendors, Sales

#### `/customers` — Customers
| Field | Value |
|---|---|
| **Module** | Customers |
| **Purpose** | Customer master management |
| **Features** | Add/edit/delete customers; credit limit; ledger statement |
| **Permission keys** | `Customers` (canAdd, canEdit, canDelete, canDownload) |
| **APIs called** | `GET/POST /api/customers`, `PATCH/DELETE /api/customers/:id`, `GET /api/customers/:id/ledger` |
| **Tables** | `customers`, `account_ledgers`, `sales` |

#### `/vendors` — Vendors
| Field | Value |
|---|---|
| **Module** | Vendors |
| **Purpose** | Supplier/vendor master management |
| **Features** | Add/edit/delete vendors; vendor ledger; record payment |
| **Permission keys** | `Vendors` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/vendors`, `PATCH/DELETE /api/vendors/:id`, `GET /api/vendors/:id/ledger`, `POST /api/vendors/:id/payment` |
| **Tables** | `vendors`, `account_ledgers`, `purchases`, `payments` |

#### `/coupons` — Coupons
| Field | Value |
|---|---|
| **Module** | Coupons |
| **Purpose** | Discount coupon management |
| **Permission keys** | `Coupons` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/coupons`, `PATCH/DELETE /api/coupons/:id` |
| **Tables** | `coupons` |

#### `/returns` — Returns
| Field | Value |
|---|---|
| **Module** | Sales |
| **Purpose** | Sales returns (credit notes) and purchase returns (debit notes) |
| **Features** | Select original sale/purchase; specify return quantity per line; stock restored; CN/DN created |
| **Permission keys** | `Sales` (canAdd) |
| **APIs called** | `POST/GET /api/sales-returns`, `POST/GET /api/purchase-returns`, `GET /api/sales`, `GET /api/purchases` |
| **Tables** | `sales_returns`, `purchase_returns`, `sales`, `purchases`, `stock_entries`, `stock_batches`, `journal_vouchers`, `payments` |

#### `/outstanding` — Outstanding
| Field | Value |
|---|---|
| **Module** | Sales |
| **Purpose** | Aging report for receivables and payables |
| **Features** | Customer outstanding with aging buckets (0-30, 31-60, 61-90, 90+ days); vendor outstanding; collection register |
| **Permission keys** | `Sales`, `Customers`, `Vendors` (canView) |
| **APIs called** | `GET /api/outstanding/receivables`, `GET /api/outstanding/payables`, `GET /api/outstanding/collections` |
| **Tables** | `sales`, `sale_payments`, `customers`, `vendors`, `purchases` |

---

### HR

#### `/hr/hierarchy` — Hierarchy
| Field | Value |
|---|---|
| **Module** | Hierarchy |
| **Permission keys** | `Hierarchy` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/hr/hierarchies`, `PATCH/DELETE /api/hr/hierarchies/:id` |
| **Tables** | `hierarchies` |

#### `/hr/employees` — Employees
| Field | Value |
|---|---|
| **Module** | Employees |
| **Permission keys** | `Employees` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST /api/hr/employees`, `GET/PATCH/DELETE /api/hr/employees/:id` |
| **Tables** | `employees`, `hierarchies`, `pay_components` |

#### `/hr/attendance` — Attendance
| Field | Value |
|---|---|
| **Module** | Attendance |
| **Purpose** | Attendance records; access to leave management |
| **Permission keys** | `Attendance` (canAdd, canEdit), `Leave` (canAdd, canEdit) |
| **APIs called** | `GET /api/hr/attendance`, `POST /api/hr/attendance/check-in`, `POST /api/hr/attendance/check-out`, `GET/POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve` |
| **Tables** | `attendance`, `leaves`, `employees` |

#### `/hr/leave` — Leave
| Field | Value |
|---|---|
| **Module** | Leave |
| **Purpose** | Leave request list and management |
| **Permission keys** | `Leave` (canAdd, canEdit) |
| **APIs called** | `GET/POST /api/hr/leaves`, `POST /api/hr/leaves/:id/approve` |
| **Tables** | `leaves`, `employees` |

#### `/hr/payroll` — Payroll
| Field | Value |
|---|---|
| **Module** | Payroll |
| **Purpose** | Monthly payroll generation and approval |
| **Permission keys** | `Payroll` (canAdd, canEdit, canDownload) |
| **APIs called** | `GET /api/hr/payroll`, `POST /api/hr/payroll/generate`, `POST /api/hr/payroll/:id/approve`, `POST /api/hr/payroll/:id/pay`, `POST /api/pdf/payslip` |
| **Tables** | `payroll`, `pay_components`, `attendance`, `employees`, `account_ledgers` |

#### `/hr/advances` — Advances
| Field | Value |
|---|---|
| **Module** | Payroll |
| **Permission keys** | `Payroll` (canAdd) |
| **APIs called** | `GET/POST /api/hr/advances` |
| **Tables** | `employee_advances`, `employees` |

---

### Accounts

#### `/accounts/chart` — Chart of Accounts
| Field | Value |
|---|---|
| **Module** | Chart of Accounts |
| **Permission keys** | `Chart of Accounts` (canAdd, canEdit, canDelete) |
| **APIs called** | `GET/POST/PATCH/DELETE /api/accounts/chart`, `GET/POST /api/accounts/opening-balances`, `DELETE /api/accounts/opening-balances/:id`, `GET /api/accounts/financial-statements` |
| **Tables** | `account_ledgers`, `opening_balances` |

#### `/accounts/ledger` — Ledger Statement
| Field | Value |
|---|---|
| **Module** | Ledger |
| **Permission keys** | `Ledger` (canView, canDownload) |
| **APIs called** | `GET /api/accounts/ledger-statement`, `GET /api/accounts/chart` |
| **Tables** | Derived from all voucher tables |

#### `/accounts/cash-bank` — Cash & Bank
| Field | Value |
|---|---|
| **Module** | Cash & Bank |
| **Permission keys** | `Cash & Bank` (canAdd) |
| **APIs called** | `GET /api/accounts/cash-bank`, `POST /api/accounts/cash-bank`, `GET /api/accounts/cash-bank-book/ledgers` |
| **Tables** | `account_ledgers`, `payments`, `receipts` |

#### `/accounts/expenses` — Expenses
| Field | Value |
|---|---|
| **Module** | Expenses |
| **Permission keys** | `Expenses` (canAdd) |
| **APIs called** | `GET/POST /api/expenses`, `GET /api/accounts/expense-ledgers` |
| **Tables** | `expenses`, `account_ledgers` |

#### `/accounts/vouchers` — Vouchers
| Field | Value |
|---|---|
| **Module** | Vouchers |
| **Permission keys** | `Vouchers` (canAdd, canDelete) |
| **APIs called** | `GET/POST /api/accounts/journal-vouchers`, `DELETE /api/accounts/journal-vouchers/:id` |
| **Tables** | `journal_vouchers`, `journal_voucher_lines`, `account_ledgers` |

#### `/accounts/payments` — Payment Vouchers
| Field | Value |
|---|---|
| **Module** | Payments |
| **Permission keys** | `Payments` (canAdd) |
| **APIs called** | `GET/POST /api/accounts/payments` |
| **Tables** | `payments`, `account_ledgers` |

#### `/accounts/receipts` — Receipt Vouchers
| Field | Value |
|---|---|
| **Module** | Payments |
| **Permission keys** | `Payments` (canAdd, canDelete) |
| **APIs called** | `GET/POST /api/accounts/receipts`, `DELETE /api/accounts/receipts/:id` |
| **Tables** | `receipts`, `account_ledgers` |

#### `/accounts/journal` — Journal Voucher
| Field | Value |
|---|---|
| **Module** | Vouchers |
| **Permission keys** | `Vouchers` (canAdd) |
| **APIs called** | `POST /api/accounts/journal-vouchers` (voucherType: 'journal') |
| **Tables** | `journal_vouchers`, `journal_voucher_lines` |

#### `/accounts/contra` — Contra Voucher
| Field | Value |
|---|---|
| **Module** | Vouchers |
| **Permission keys** | `Vouchers` (canAdd) |
| **APIs called** | `POST /api/accounts/journal-vouchers` (voucherType: 'contra') |
| **Tables** | `journal_vouchers`, `journal_voucher_lines` |

#### `/accounts/notes` — Credit/Debit Notes
| Field | Value |
|---|---|
| **Module** | Vouchers |
| **Permission keys** | `Vouchers` (canAdd) |
| **APIs called** | `GET/POST /api/accounts/journal-vouchers` (voucherType: 'credit_note'|'debit_note') |
| **Tables** | `journal_vouchers`, `journal_voucher_lines` |

#### `/accounts/day-book` — Day Book
| Field | Value |
|---|---|
| **Module** | Books |
| **Permission keys** | `Books` (canView, canDownload) |
| **APIs called** | `GET /api/accounts/day-book` |
| **Tables** | Derived from all voucher tables |

#### `/accounts/cash-book` — Cash Book
| Field | Value |
|---|---|
| **Module** | Books |
| **Permission keys** | `Books` (canView) |
| **APIs called** | `GET /api/accounts/cash-bank-book?type=cash` |
| **Tables** | Derived from `payments`, `receipts`, `sales` |

#### `/accounts/bank-book` — Bank Book
| Field | Value |
|---|---|
| **Module** | Books |
| **Permission keys** | `Books` (canView) |
| **APIs called** | `GET /api/accounts/cash-bank-book?type=bank` |
| **Tables** | Derived from `payments`, `receipts` |

#### `/accounts/trial-balance` — Trial Balance
| Field | Value |
|---|---|
| **Module** | Books |
| **Permission keys** | `Books` (canView, canDownload) |
| **APIs called** | `GET /api/accounts/trial-balance` |
| **Tables** | Derived from all voucher tables |

#### `/accounts/gst` — GST Summary
| Field | Value |
|---|---|
| **Module** | GST Summary |
| **Permission keys** | `GST Summary` (canView, canDownload) |
| **APIs called** | `GET /api/gst/summary`, `GET /api/gst/hsn-summary` |
| **Tables** | `sales`, `purchases` |

#### `/accounts/gst-returns` — GST Returns
| Field | Value |
|---|---|
| **Module** | GST Returns |
| **Permission keys** | `GST Returns` (canView, canDownload) |
| **APIs called** | `GET /api/gst/gstr1`, `GET /api/gst/gstr3b`, `GET /api/gst/reconciliation`, `GET /api/gst/hsn-summary` |
| **Tables** | `sales`, `purchases`, `customers`, `company_settings` |

#### `/accounts/reconciliation` — Reconciliation
| Field | Value |
|---|---|
| **Module** | Reconciliation |
| **Permission keys** | `Reconciliation` (canAdd, canEdit) |
| **APIs called** | `GET /api/reconciliation/pending`, `GET /api/reconciliation/bank-ledgers`, `GET/POST /api/reconciliation/batches`, `GET /api/reconciliation/batches/:id` |
| **Tables** | `reconciliation_batches`, `reconciliation_batch_items`, `sale_payments`, `receipts`, `payments` |

#### `/accounts/cash-in-outlet` — Cash in Outlet (HO view)
| Field | Value |
|---|---|
| **Module** | Cash Balance |
| **Purpose** | Aggregate cash view for all branches + cash deposit management |
| **Permission keys** | `Cash Balance` (canAdd), `Reconciliation` (canEdit for deposit reconcile) |
| **APIs called** | `GET /api/cash-in-outlet`, `GET/POST /api/cash-in-outlet/deposits`, `POST /api/cash-in-outlet/deposits/:id/reconcile` |
| **Tables** | `cash_deposits`, `account_ledgers`, `outlets`, `warehouses` |

#### `/reports/:cat` — Reports Centre
| Field | Value |
|---|---|
| **Module** | Reports |
| **Purpose** | Analytics reports hub with 6 section tabs |
| **Permission keys** | `Reports` (canView, canDownload), `Sales`, `Purchases`, `Chart of Accounts` |
| **APIs called** | `GET /api/reports/sales-register`, `/sales-by-item`, `/sales-by-location`, `/discounts`, `/sales-stock-combined`, `/purchase-register`, `/purchases-by-vendor`, `/purchases-by-material`, `/profitability`, `GET /api/accounts/financial-statements` |
| **Tables** | `sales`, `purchases`, `stock_entries`, `items`, `customers`, `vendors`, `account_ledgers` |

---

### Company

#### `/company/settings` — Settings
| Field | Value |
|---|---|
| **Module** | Settings |
| **Permission keys** | `Settings` (canEdit) |
| **APIs called** | `GET/PATCH /api/company/settings` |
| **Tables** | `company_settings` |

#### `/company/profile` — Company Profile
| Field | Value |
|---|---|
| **Module** | Settings |
| **Permission keys** | `Settings` (canEdit) |
| **APIs called** | `GET/PATCH /api/company/settings` |
| **Tables** | `company_settings` |

#### `/company/audit` — Audit Log
| Field | Value |
|---|---|
| **Module** | Settings |
| **Permission keys** | `Settings` (canView) |
| **APIs called** | `GET /api/audit/logs`, `GET /api/audit/logs/:id` |
| **Tables** | `activity_log` |

#### `/company/permissions` — Permissions
| Field | Value |
|---|---|
| **Module** | Permissions |
| **Permission keys** | `Permissions` (canEdit) |
| **APIs called** | `GET /api/company/permissions`, `POST /api/company/permissions`, `GET /api/hr/hierarchies` |
| **Tables** | `permissions`, `hierarchies` |

#### `/company/login-history` — Login History
| Field | Value |
|---|---|
| **Module** | Login History |
| **Permission keys** | `Login History` (canView) |
| **APIs called** | `GET /api/company/login-history` |
| **Tables** | `login_history` |

#### `/profile/me` — My Profile
| Field | Value |
|---|---|
| **Module** | — (no permission guard) |
| **Purpose** | Logged-in user's personal profile and password change |
| **Permission keys** | None |
| **APIs called** | `GET /api/auth/me`, `PATCH /api/auth/profile`, `POST /api/auth/change-password` |
| **Tables** | `employees` |

---

## 12. Complete API Documentation

All endpoints are prefixed with `/api`. All require `Authorization: Bearer <token>` unless marked *(public)* or *(no auth)*. Request bodies are JSON unless noted. All responses are JSON.

---

### Health

#### `GET /api/health` *(no auth)*
- **Purpose:** Server health check
- **Request:** None
- **Response:** `200 { status: 'ok', timestamp: string }`
- **Tables:** None

---

### Auth

#### `POST /api/auth/login` *(no auth, rate-limited)*
- **Purpose:** Authenticate user, receive JWT
- **Request body:** `{ username: string, password: string }`
- **Response:** `200 { token: string, user: { id, name, username, hierarchyId, hierarchyLevel, branchType, branchId, mustChangePassword } }`
- **Errors:** `401` invalid credentials; `429` rate limit exceeded
- **Tables:** `employees`, `hierarchies`, `login_history` (writes)

#### `POST /api/auth/logout`
- **Purpose:** Invalidate session (client-side only — no server-side token invalidation)
- **Response:** `200 { message: 'Logged out' }`

#### `GET /api/auth/me`
- **Purpose:** Return current user profile + permissions
- **Response:** `{ user: Employee, permissions: Permission[] }`
- **Tables:** `employees`, `permissions`, `hierarchies`

#### `POST /api/auth/change-password`
- **Request body:** `{ currentPassword: string, newPassword: string }`
- **Response:** `200 { message: 'Password changed' }`
- **Tables:** `employees`

#### `PATCH /api/auth/profile`
- **Request body:** `{ name?: string, email?: string, phone?: string, photoUrl?: string }`
- **Response:** Updated employee object
- **Tables:** `employees`

---

### Dashboard

#### `GET /api/dashboard/summary`
- **Purpose:** KPI cards — revenue, sales count, production volume, stock value
- **Query params:** `from?`, `to?` (ISO dates)
- **Response:** `{ totalRevenue, salesCount, productionVolume, stockValue, todaySales, monthRevenue }`
- **Tables:** `sales`, `productions`, `stock_entries`, `items`

#### `GET /api/dashboard/sales-trend`
- **Query params:** `from?`, `to?`, `days?` (number, default 30)
- **Response:** `[{ date: string, revenue: number, count: number }]`
- **Tables:** `sales`

#### `GET /api/dashboard/stock-alerts`
- **Response:** `[{ itemId, name, quantity, threshold }]` — items below reorder level
- **Tables:** `stock_entries`, `items`

#### `GET /api/dashboard/recent-activity`
- **Response:** `[{ id, action, entity, user, details, created_at }]` — last 20 entries
- **Tables:** `activity_log`

#### `GET /api/dashboard/top-items`
- **Query params:** `from?`, `to?`, `limit?` (default 10)
- **Response:** `[{ itemId, name, revenue, quantity }]`
- **Tables:** `sales`

#### `GET /api/dashboard/sales-by-location`
- **Response:** `[{ locationType, locationId, name, revenue }]`
- **Tables:** `sales`, `outlets`, `warehouses`

#### `GET /api/dashboard/production-trend`
- **Query params:** `from?`, `to?`
- **Response:** `[{ date, quantity, itemName }]`
- **Tables:** `productions`, `items`

---

### Item Prices

#### `GET /api/item-prices`
- **Query params:** `itemId?`, `locationType?`, `locationId?`
- **Response:** `[{ id, itemId, outletId, locationType, price, validFrom, validTo, itemName, outletName, updatedAt }]`
- **Tables:** `item_prices`, `items`, `outlets`, `warehouses`

#### `POST /api/item-prices`
- **Guard:** `requireModuleAction("Item Prices", "add")`
- **Request body:** `{ itemId: number, outletId: number, price: number, validFrom?: string, validTo?: string, locationType?: string }`
- **Response:** Updated item price object
- **Tables:** `item_prices` (upsert), `items`, `outlets`, `warehouses`

---

### Sales

#### `GET /api/sales`
- **Query params:** `page?`, `limit?`, `q?` (search), `from?`, `to?`, `locationType?`, `locationId?`, `outletId?`, `paymentMode?`, `paymentStatus?`
- **Response:** `{ total, page, limit, rows: Sale[] }` where Sale includes customer name, location name
- **Tables:** `sales`, `customers`, `outlets`, `warehouses`

#### `POST /api/sales`
- **Guard:** `requireModuleAction(["Sales", "Point of Sale"], "add")`
- **Request body:** `{ outletId?: number, locationId?: number, locationType?: string, customerId?: number, saleDate: string, lineItems: [{ itemId, quantity, unitPrice?, discount?, taxAmount? }], paymentMode: 'cash'|'upi'|'card'|'credit', couponCode?: string, discountTotal?: number, creditOverride?: boolean }`
- **Response:** `201` Created Sale object
- **Tables:** `sales`, `stock_entries`, `stock_batches`, `item_prices`, `customers`, `company_settings`, `account_ledgers` (receipts table)

#### `PUT /api/sales/:id`
- **Guard:** `requireModuleAction(["Sales", "Point of Sale"], "edit")`
- **Request body:** Same as POST
- **Response:** Updated Sale object
- **Tables:** Same as POST (reversal + re-application)

#### `GET /api/sales/summary`
- **Response:** `{ totalSales, totalTax, totalInvoices, byOutlet, byLocation }`
- **Tables:** `sales`, `outlets`, `warehouses`

#### `GET /api/sales/:id`
- **Response:** Full Sale object with line items, payment history, customer, location
- **Tables:** `sales`, `sale_payments`, `customers`, `outlets`, `warehouses`

#### `POST /api/sales/:id/share-token`
- **Response:** `{ token: string, expiresAt: string }` — HMAC-signed public invoice URL token
- **Tables:** `sales`

#### `GET /api/public/invoices/:token` *(public)*
- **Purpose:** Render invoice for public sharing (WhatsApp link)
- **Response:** Invoice HTML or PDF
- **Tables:** `sales`, `customers`, `outlets`, `warehouses`, `company_settings`

#### `GET /api/sales/:id/payments`
- **Response:** `[SalePayment]`
- **Tables:** `sale_payments`

#### `POST /api/sales/:id/payments`
- **Guard:** `requireModuleAction(["Sales", "Point of Sale", "Payments"], "add")`
- **Request body:** `{ paymentDate: string, method: 'cash'|'upi'|'card', amount: number, referenceNumber?: string, notes?: string }`
- **Response:** `201` SalePayment object + updated Sale
- **Tables:** `sale_payments`, `sales`

---

### Returns & Outstanding

#### `POST /api/sales-returns`
- **Guard:** `requireModuleAction(["Sales", "Point of Sale"], "add")`
- **Request body:** `{ saleId: number, returnDate: string, reason: string, lines: [{ lineIndex: number, quantity: number }] }`
- **Response:** `201` SalesReturn object
- **Tables:** `sales_returns`, `sales`, `stock_entries`, `stock_batches`, `journal_vouchers`, `payments`

#### `GET /api/sales-returns`
- **Query params:** `saleId?`
- **Response:** `[SalesReturn]`

#### `POST /api/purchase-returns`
- **Guard:** `requireModuleAction(["Sales", "Purchases"], "add")`
- **Request body:** `{ purchaseId: number, returnDate: string, reason: string, lines: [{ lineIndex: number, quantity: number }] }`
- **Response:** `201` PurchaseReturn object
- **Tables:** `purchase_returns`, `purchases`, `materials`, `raw_materials`, `stock_entries`, `journal_vouchers`

#### `GET /api/purchase-returns`
- **Response:** `[PurchaseReturn]`

#### `GET /api/outstanding/receivables`
- **Guard:** `requireModuleView(["Customers", "Sales"])`
- **Response:** `[{ customerId, name, totalDue, aging: { 0-30, 31-60, 61-90, 90+ }, lastPaymentDate }]`

#### `GET /api/outstanding/payables`
- **Guard:** `requireModuleView(["Vendors", "Sales"])`
- **Response:** `[{ vendorId, name, totalDue, lastPurchaseDate }]`

#### `GET /api/outstanding/collections`
- **Response:** `[{ saleId, invoiceNumber, customerName, saleDate, totalAmount, amountPaid, balance }]`

---

### Customers & Vendors

#### `GET /api/customers`
- **Query params:** `q?`, `locationType?`, `locationId?`
- **Response:** `[{ id, name, phone, gstNumber, totalPurchases, outstandingBalance }]`
- **Tables:** `customers`, `sales`, `sale_payments`

#### `POST /api/customers`
- **Guard:** `requireModuleAction("Customers", "add")`
- **Request body:** `{ name: string, phone?: string, email?: string, address?: string, gstNumber?: string, state?: string, notes?: string, creditLimit?: number, creditDays?: number, locationType?: string, locationId?: number }`
- **Response:** `201` Customer + auto-created `CUST-{id}` ledger
- **Tables:** `customers`, `account_ledgers`

#### `GET /api/customers/:id`
- **Response:** Full customer object
- **Tables:** `customers`

#### `PATCH /api/customers/:id`
- **Guard:** `requireModuleAction("Customers", "edit")`
- **Request body:** Partial Customer fields
- **Tables:** `customers`, `account_ledgers` (name sync)

#### `DELETE /api/customers/:id`
- **Guard:** `requireModuleAction("Customers", "delete")`
- **Blocked if:** Customer has linked sales
- **Tables:** `customers`

#### `GET /api/customers/:id/ledger`
- **Guard:** `requireModuleView("Customers")`
- **Response:** `[{ date, description, debit, credit, balance }]`
- **Tables:** `sales`, `journal_vouchers`, `journal_voucher_lines`

#### `GET /api/vendors`
- **Response:** `[{ id, name, phone, gstNumber, totalPurchased, totalPaid, outstandingBalance }]`
- **Tables:** `vendors`, `purchases`, `payments`

#### `POST /api/vendors`
- **Guard:** `requireModuleAction("Vendors", "add")`
- **Request body:** `{ name: string, phone?: string, email?: string, address?: string, gstNumber?: string, state?: string, bankName?: string, accountNumber?: string }`
- **Response:** `201` Vendor + auto-created `VEND-{id}` ledger
- **Tables:** `vendors`, `account_ledgers`

#### `GET /api/vendors/:id`
- **Tables:** `vendors`

#### `PATCH /api/vendors/:id`
- **Guard:** `requireModuleAction("Vendors", "edit")`

#### `DELETE /api/vendors/:id`
- **Guard:** `requireModuleAction("Vendors", "delete")`
- **Blocked if:** Vendor has linked purchases

#### `GET /api/vendors/:id/ledger`
- **Guard:** `requireModuleView("Vendors")`
- **Response:** Dr/Cr statement from purchases, payments, journal vouchers

#### `POST /api/vendors/:id/payment`
- **Guard:** `requireModuleAction(["Vendors", "Payments"], "add")`
- **Request body:** `{ date: string, amount: number, cashBankLedgerId: number, narration?: string }`
- **Tables:** `payments`, `account_ledgers`

#### `GET /api/coupons`
- **Tables:** `coupons`

#### `POST /api/coupons`
- **Guard:** `requireModuleAction("Coupons", "add")`
- **Request body:** `CreateCouponBody` — `{ code, discountType: 'fixed'|'percent', discountValue, minOrderValue?, maxUses?, validFrom?, validTo? }`
- **Tables:** `coupons`

#### `PATCH /api/coupons/:id`
- **Guard:** `requireModuleAction("Coupons", "edit")`

#### `DELETE /api/coupons/:id`
- **Guard:** `requireModuleAction("Coupons", "delete")`

---

### Items & Materials

#### `GET /api/items`
- **Response:** `[Item]` with `productionStock`, `cost`, `mrp`
- **Tables:** `items`, `units`

#### `POST /api/items`
- **Guard:** `requireModuleAction("Items", "add")`
- **Request body:** `{ name, hsnCode, taxRate, unit, mrp?, cost? }`
- **Tables:** `items`

#### `PATCH /api/items/:id`
- **Guard:** `requireModuleAction("Items", "edit")`

#### `DELETE /api/items/:id`
- **Guard:** `requireModuleAction("Items", "delete")`
- **Blocked if:** Item has linked sales, productions, or stock entries

#### `GET /api/materials`, `GET /api/raw-materials`
- **Tables:** `materials` / `raw_materials`

#### `POST /api/materials`, `POST /api/raw-materials`
- **Guard:** `requireModuleAction("Items", "add")`
- **Request body:** `{ name, unit, hsnCode?, taxRate?, cost? }`

#### `PATCH /api/materials/:id`, `PATCH /api/raw-materials/:id`
- **Guard:** `requireModuleAction("Items", "edit")`

#### `DELETE /api/materials/:id`, `DELETE /api/raw-materials/:id`
- **Guard:** `requireModuleAction("Items", "delete")`

#### `GET /api/units`
- **Tables:** `units`

#### `POST /api/units`
- **Guard:** `requireModuleAction("Units", "add")`
- **Request body:** `{ name: string, abbreviation: string }`

#### `PATCH /api/units/:id`
- **Guard:** `requireModuleAction("Units", "edit")`

---

### Purchases

#### `GET /api/purchases`
- **Query params:** `page?`, `limit?`, `q?`, `vendorId?`, `from?`, `to?`
- **Response:** `{ total, page, limit, rows: [Purchase] }`
- **Tables:** `purchases`, `vendors`

#### `POST /api/purchases`
- **Guard:** `requireModuleAction("Purchases", "add")`
- **Request body:** `{ vendorId: number, purchaseDate: string, invoiceNumber?: string, lineItems: [{ materialType: 'material'|'raw_material'|'item', materialId: number, quantity: number, unitCost: number, batchNumber?: string, mfgDate?: string, expiryDate?: string }], notes?: string }`
- **Response:** `201` Purchase object
- **Tables:** `purchases`, `vendors`, `materials`, `raw_materials`, `items`, `stock_entries`, `stock_batches`

#### `GET /api/purchases/:id`
- **Response:** Full purchase with vendor name, material names
- **Tables:** `purchases`, `vendors`, `materials`, `raw_materials`, `items`

#### `PATCH /api/purchases/:id`
- **Guard:** `requireModuleAction("Purchases", "edit")`
- **Request body:** Partial `CreatePurchaseBody`
- **Tables:** Same as POST (reversal + re-application)

#### `DELETE /api/purchases/:id`
- **Guard:** `requireModuleAction("Purchases", "delete")`
- **Tables:** `purchases`, `materials`, `raw_materials`, `items`, `stock_entries`, `stock_batches`

---

### Productions

#### `GET /api/productions`
- **Query params:** `page?`, `limit?`, `itemId?`, `from?`, `to?`
- **Response:** `{ total, rows: [Production] }` with item name, costing data
- **Tables:** `productions`, `items`

#### `POST /api/productions`
- **Guard:** `requireModuleAction("Production", "add")`
- **Request body:** `{ itemId: number, producedQuantity: number, productionDate: string, materialUsed: [{ materialType, materialId, quantity }], wastage?: [{ materialType, materialId, quantity }] }`
- **Response:** `201` Production object with computed costs
- **Tables:** `productions`, `items`, `materials`, `raw_materials`, `stock_entries`, `stock_batches`, `company_settings`

#### `GET /api/productions/reports`
- **Guard:** `requireModuleView("Production")`
- **Query params:** `from?`, `to?`
- **Response:** `{ summary, byItem, bomVariance, batchCostHistory }`
- **Tables:** `productions`, `bom_templates`, `items`, `materials`, `raw_materials`

#### `GET /api/productions/:id`
- **Tables:** `productions`, `items`, `materials`, `raw_materials`

#### `PATCH /api/productions/:id`
- **Guard:** `requireModuleAction("Production", "edit")`
- **Request body:** `{ notes?, productionDate? }` (metadata only — stock effects not reversible via PATCH)

#### `DELETE /api/productions/:id`
- **Guard:** `requireModuleAction("Production", "delete")`
- **Tables:** Full reversal — `productions`, `items`, `materials`, `raw_materials`, `stock_entries`, `stock_batches`

---

### BOM Templates

#### `GET /api/bom-templates`
- **Tables:** `bom_templates`, `items`

#### `GET /api/bom-templates/item/:itemId`
- **Tables:** `bom_templates`, `materials`, `raw_materials`

#### `POST /api/bom-templates`
- **Guard:** `requireModuleAction("Production", "add")`
- **Request body:** `{ itemId: number, lines: [{ materialType: 'material'|'raw_material', materialId: number, quantity: number }], notes?: string }`
- **Tables:** `bom_templates`

#### `PUT /api/bom-templates/:id`
- **Guard:** `requireModuleAction("Production", "edit")`

#### `DELETE /api/bom-templates/:id`
- **Guard:** `requireModuleAction("Production", "delete")`

---

### Stock

#### `GET /api/stock`
- **Query params:** `branchType?`, `branchId?`, `q?` (item search)
- **Response:** `[{ itemId, name, unit, quantity, costPrice, branchType, branchId, locationName }]`
- **Tables:** `stock_entries`, `items`, `outlets`, `warehouses`

#### `GET /api/stock/ledger`
- **Guard:** `requireModuleView(["Stock", "Inventory Reports"])`
- **Query params:** `itemId?`, `branchType?`, `branchId?`, `from?`, `to?`
- **Response:** `[{ docType, docId, date, quantity, runningBalance, description }]`
- **Tables:** `stock_ledger`, `items`

#### `GET /api/stock/transfers`
- **Guard:** `requireModuleView("HO Transfers")`
- **Query params:** `status?`, `from?`, `to?`
- **Response:** `[StockTransfer]` with location names
- **Tables:** `stock_transfers`, `outlets`, `warehouses`

#### `POST /api/stock/transfers`
- **Guard:** `requireModuleAction("HO Transfers", "add")`
- **Request body:** `{ fromType, fromId, toType, toId, transferDate, lineItems: [{ itemId, quantity }] }`
- **Response:** `201` StockTransfer (status = 'in_transit')
- **Tables:** `stock_transfers`, `stock_entries`, `stock_batches`, `stock_ledger`

#### `GET /api/stock/transfers/:id`
- **Response:** Full StockTransfer with line details and location names

#### `PATCH /api/stock/transfers/:id/approve`
- **Guard:** `requireModuleAction("HO Transfers", "edit")`
- **Request body:** `{ receivedLineItems: [{ itemId, quantity }] }`
- **Response:** Updated StockTransfer (status = 'approved')
- **Tables:** `stock_transfers`, `stock_entries`, `stock_batches`, `stock_ledger`, `account_ledgers` (GST JVs), `journal_vouchers`

#### `PATCH /api/stock/transfers/:id/reject`
- **Guard:** `requireModuleAction("HO Transfers", "edit")`
- **Request body:** `{ rejectionReason: string }`
- **Response:** Updated StockTransfer (status = 'rejected')
- **Tables:** `stock_transfers`, `stock_entries`, `stock_batches`

#### `GET /api/stock/batches`
- **Query params:** `itemId?`, `branchType?`, `branchId?`
- **Response:** `[StockBatch]`

#### `GET /api/stock/expiry-report`
- **Guard:** `requireModuleView("Stock")`
- **Query params:** `daysAhead?` (default 30)
- **Response:** Batches expiring within N days + already expired

#### `GET /api/stock/valuation`
- **Guard:** `requireModuleView("Stock")`
- **Response:** `[{ itemId, name, totalQuantity, weightedAvgCost, totalValue }]` per branch

#### `POST /api/stock/verifications`
- **Guard:** `requireModuleAction("Stock Verification", "add")`
- **Request body:** `{ branchType, branchId, verifyDate, adjustments: [{ itemId, physicalQuantity, notes? }], notes? }`
- **Tables:** `stock_verifications`, `stock_entries`, `stock_batches`, `stock_ledger`

---

### Branches

#### `GET /api/warehouses`
- **Response:** `[{ id, name, state, gstNumber, address, outletCount, upiId }]`
- **Tables:** `warehouses`, `outlets`

#### `POST /api/warehouses`
- **Guard:** `requireModuleAction("Warehouses", "add")`
- **Request body:** `CreateWarehouseBody` — `{ name, state?, gstNumber?, address?, upiId? }`
- **Response:** `201` Warehouse + Cash, Sales, Purchase ledgers provisioned
- **Tables:** `warehouses`, `account_ledgers`

#### `GET /api/warehouses/:id`
- **Tables:** `warehouses`

#### `PATCH /api/warehouses/:id`
- **Guard:** `requireModuleAction("Warehouses", "edit")`

#### `DELETE /api/warehouses/:id`
- **Guard:** `requireModuleAction("Warehouses", "delete")`
- **Blocked if:** Accounting entries or outlets linked

#### `GET /api/outlets`
- **Response:** `[{ id, name, warehouse_id, warehouseName, address, phone, upiId }]`
- **Tables:** `outlets`, `warehouses`

#### `POST /api/outlets`
- **Guard:** `requireModuleAction("Outlets", "add")`
- **Request body:** `{ name, warehouseId, address?, phone?, upiId? }`
- **Response:** `201` Outlet + Cash, Sales ledgers provisioned
- **Tables:** `outlets`, `account_ledgers`

#### `GET /api/outlets/:id`
- **Tables:** `outlets`

#### `PATCH /api/outlets/:id`
- **Guard:** `requireModuleAction("Outlets", "edit")`

#### `DELETE /api/outlets/:id`
- **Guard:** `requireModuleAction("Outlets", "delete")`
- **Blocked if:** Sales or accounting entries linked

---

### Accounts

#### `GET /api/accounts/chart`
- **Response:** Tree of `AccountLedger` nodes
- **Tables:** `account_ledgers`

#### `POST /api/accounts/chart`
- **Guard:** `requireModuleAction("Chart of Accounts", "add")`
- **Request body:** `CreateAccountLedgerBody` — `{ name, type, parentId, section, bankDetails? }`
- **Tables:** `account_ledgers`

#### `PATCH /api/accounts/chart/:id`
- **Guard:** `requireModuleAction("Chart of Accounts", "edit")`
- **Request body:** `UpdateAccountLedgerBody`
- **Tables:** `account_ledgers`

#### `DELETE /api/accounts/chart/:id`
- **Guard:** `requireModuleAction("Chart of Accounts", "delete")`
- **Blocked if:** System group, or has transaction entries
- **Tables:** `account_ledgers`

#### `GET /api/accounts/payments`
- **Guard:** `requireModuleView("Payments")`
- **Response:** `[Payment]` with ledger names
- **Tables:** `payments`, `account_ledgers`

#### `POST /api/accounts/payments`
- **Guard:** `requireModuleAction("Payments", "add")`
- **Request body:** `{ paymentDate: string, paidFromLedgerId: number, paidToLedgerId: number, amount: number, narration?: string }`
- **Posting:** Dr `paidToLedgerId`, Cr `paidFromLedgerId`
- **Tables:** `payments`

#### `GET /api/accounts/receipts`
- **Guard:** `requireModuleView("Payments")`
- **Tables:** `receipts`, `account_ledgers`

#### `POST /api/accounts/receipts`
- **Guard:** `requireModuleAction("Payments", "add")`
- **Request body:** `{ receiptDate: string, receivedFromLedgerId: number, receivedInLedgerId: number, amount: number, narration?: string }`
- **Posting:** Dr `receivedInLedgerId`, Cr `receivedFromLedgerId`
- **Tables:** `receipts`

#### `DELETE /api/accounts/receipts/:id`
- **Guard:** `requireModuleAction("Payments", "delete")`
- **Tables:** `receipts`

#### `GET /api/accounts/cash-bank`
- **Guard:** `requireModuleView("Cash & Bank")`
- **Tables:** `account_ledgers`, `payments`, `receipts`

#### `POST /api/accounts/cash-bank`
- **Guard:** `requireModuleAction("Cash & Bank", "add")`
- **Request body:** `{ type: 'payment'|'receipt', date, fromLedgerId, toLedgerId, amount, narration? }`
- **Tables:** `payments` or `receipts`

#### `GET /api/accounts/ledger-statement`
- **Guard:** `requireModuleView("Ledger")`
- **Query params:** `ledgerId`, `from?`, `to?`
- **Response:** `[{ date, description, debit, credit, balance, voucherType }]`

#### `GET /api/accounts/ledger/:id/statement`
- **Response:** Same as above, for a specific ledger ID

#### `GET /api/accounts/financial-statements`
- **Guard:** `requireModuleView("Chart of Accounts")`
- **Query params:** `from?`, `to?`
- **Response:** `{ balanceSheet: { assets, liabilities, equity }, profitLoss: { income, expense, netProfit } }`

#### `GET /api/accounts/opening-balances`
- **Guard:** `requireModuleView("Chart of Accounts")`
- **Tables:** `opening_balances`, `account_ledgers`

#### `POST /api/accounts/opening-balances`
- **Guard:** `requireModuleAction("Chart of Accounts", "add")`
- **Request body:** `{ ledgerId: number, amount: number, type: 'debit'|'credit', date: string }`
- **Tables:** `opening_balances`

#### `DELETE /api/accounts/opening-balances/:id`
- **Guard:** `requireModuleAction("Chart of Accounts", "delete")`

#### `GET /api/accounts/journal-vouchers`
- **Response:** `[JournalVoucher]` with ledger names
- **Tables:** `journal_vouchers`, `journal_voucher_lines`, `account_ledgers`

#### `POST /api/accounts/journal-vouchers`
- **Guard:** `requireModuleAction("Vouchers", "add")`
- **Request body (journal):** `{ voucherType: 'journal', voucherDate, narration, lines: [{ ledgerId, debit, credit }] }`
- **Request body (contra):** `{ voucherType: 'contra', voucherDate, narration, fromLedgerId, toLedgerId, amount }`
- **Request body (credit_note):** `{ voucherType: 'credit_note', voucherDate, narration, reason, partyId, counterLedgerId, amount }`
- **Request body (debit_note):** `{ voucherType: 'debit_note', voucherDate, narration, reason, partyId, counterLedgerId, amount }`
- **Tables:** `journal_vouchers`, `journal_voucher_lines`, `account_ledgers`

#### `DELETE /api/accounts/journal-vouchers/:id`
- **Guard:** `requireModuleAction("Vouchers", "delete")`

#### `GET /api/accounts/day-book`
- **Guard:** `requireModuleView("Books")`
- **Query params:** `from?`, `to?`
- **Response:** All voucher movements in date order

#### `GET /api/accounts/cash-bank-book`
- **Query params:** `type: 'cash'|'bank'`, `ledgerId?`, `from?`, `to?`
- **Response:** Cash or bank ledger movements with running balance

#### `GET /api/accounts/cash-bank-book/ledgers`
- **Response:** List of all cash and bank leaf ledgers

#### `GET /api/accounts/trial-balance`
- **Query params:** `from?`, `to?`
- **Response:** `[{ ledgerName, debitTotal, creditTotal, balance }]`

#### `GET /api/expenses`
- **Response:** `[Expense]` with ledger names
- **Tables:** `expenses`, `account_ledgers`

#### `POST /api/expenses`
- **Guard:** `requireModuleAction("Expenses", "add")`
- **Request body:** `{ ledgerAccountId, paymentAccountId, amount, expenseDate, description }`
- **Posting:** Dr `ledgerAccountId` (expense), Cr `paymentAccountId` (cash/bank)
- **Tables:** `expenses`

#### `GET /api/accounts/expense-ledgers`
- **Response:** Leaf ledgers under `SYS-DIREXP` and `SYS-INDEXP`

#### `GET /api/accounts/location-expenses`
- **Query params:** `branchType?`, `branchId?`, `from?`, `to?`
- **Tables:** `expenses`, `account_ledgers`

#### `GET /api/accounts/location-expenses/summary`
- **Query params:** `branchType?`, `branchId?`, `from?`, `to?`
- **Response:** Expenses grouped by category ledger

#### `GET /api/accounts/location-expenses/all`
- **Response:** All branch expenses across all locations

#### `POST /api/accounts/location-expenses`
- **Guard:** `requireModuleAction("Location Expenses", "add")`
- **Request body:** `{ ledgerAccountId, paymentAccountId, amount, expenseDate, description, branchType?, branchId? }`
- **Tables:** `expenses`

#### `DELETE /api/accounts/location-expenses/:id`
- **Guard:** `requireModuleAction("Location Expenses", "delete")`
- **Tables:** `expenses`

---

### GST

#### `GET /api/gst/summary`
- **Guard:** `requireModuleView(["GST Summary", "GST Returns"])`
- **Query params:** `from?`, `to?`
- **Response:** `{ outputGst: { cgst, sgst, igst, total }, inputGst: { cgst, sgst, igst, total }, netPayable, bySlab: [{ rate, taxableValue, cgst, sgst, igst }] }`

#### `GET /api/gst/hsn-summary`
- **Query params:** `from?`, `to?`
- **Response:** `[{ hsnCode, description, quantity, unit, taxableValue, cgst, sgst, igst, total }]`

#### `GET /api/gst/gstr1`
- **Query params:** `from?`, `to?`
- **Response:** `{ b2b: [{ gstin, partyName, invoices }], b2c: [{ rate, taxableValue, cgst, sgst, igst }] }`

#### `GET /api/gst/gstr3b`
- **Query params:** `month?`, `year?`
- **Response:** `{ outwardSupplies, itcAvailable, netTaxPayable, breakdowns }`

#### `GET /api/gst/reconciliation`
- **Response:** Comparison of GST per ledger (buildDerivedPostings) vs GST per invoice register; mismatched entries flagged

---

### HR

#### `GET /api/hr/hierarchies`
- **Tables:** `hierarchies`

#### `POST /api/hr/hierarchies`
- **Guard:** `requireModuleAction("Hierarchy", "add")`
- **Request body:** `{ name: string, level: number, description?: string }`

#### `PATCH /api/hr/hierarchies/:id`
- **Guard:** `requireModuleAction("Hierarchy", "edit")`

#### `DELETE /api/hr/hierarchies/:id`
- **Guard:** `requireModuleAction("Hierarchy", "delete")`
- **Blocked if:** Employees are assigned to this hierarchy

#### `GET /api/hr/employees`
- **Guard:** `requireModuleView("Employees")`
- **Query params:** `q?`, `branchType?`, `branchId?`, `isActive?`
- **Response:** `[Employee]` with hierarchy name, branch name

#### `POST /api/hr/employees`
- **Guard:** `requireModuleAction("Employees", "add")`
- **Request body:** `{ name, username, password, email?, phone?, hierarchyId, branchType, branchId, salary, joinDate, photoUrl? }`
- **Response:** `201` Employee (mustChangePassword = true)
- **Tables:** `employees`, `hierarchies`

#### `GET /api/hr/employees/:id`
- **Tables:** `employees`, `pay_components`

#### `PATCH /api/hr/employees/:id`
- **Guard:** `requireModuleAction("Employees", "edit")`
- **Request body:** Partial employee + `payComponents?: { workingDaysPerMonth, allowances, deductions }`
- **Tables:** `employees`, `pay_components`

#### `DELETE /api/hr/employees/:id`
- **Guard:** `requireModuleAction("Employees", "delete")`
- **Action:** Sets `is_active = false` (soft delete)

#### `GET /api/hr/attendance`
- **Guard:** `requireModuleView("Attendance")`
- **Query params:** `employeeId?`, `from?`, `to?`
- **Tables:** `attendance`, `employees`

#### `POST /api/hr/attendance/check-in`
- **Request body:** `{ employeeId: number, date: string, checkIn: string, lat?: number, lng?: number }`
- **Tables:** `attendance`

#### `POST /api/hr/attendance/check-out`
- **Request body:** `{ attendanceId: number, checkOut: string, lat?: number, lng?: number }`
- **Tables:** `attendance`

#### `GET /api/hr/leaves`
- **Query params:** `employeeId?`, `status?`
- **Tables:** `leaves`, `employees`

#### `POST /api/hr/leaves`
- **Request body:** `{ employeeId, fromDate, toDate, leaveType, reason }`
- **Tables:** `leaves`

#### `POST /api/hr/leaves/:id/approve`
- **Guard:** `requireModuleAction("Leave", "edit")`
- **Request body:** `{ status: 'approved'|'rejected', approvalNote?: string }`
- **Tables:** `leaves`

#### `GET /api/hr/payroll`
- **Guard:** `requireModuleView("Payroll")`
- **Query params:** `employeeId?`, `month?`, `year?`
- **Tables:** `payroll`, `employees`

#### `POST /api/hr/payroll/generate`
- **Guard:** `requireModuleAction("Payroll", "add")`
- **Request body:** `{ employeeId: number, month: number, year: number }`
- **Response:** `201` Payroll record (status = 'draft')
- **Tables:** `payroll`, `attendance`, `pay_components`, `employees`, `employee_advances`

#### `PATCH /api/hr/payroll/:id`
- **Guard:** `requireModuleAction("Payroll", "edit")`
- **Request body:** Partial payroll fields (bonus, adjustments)
- **Tables:** `payroll`

#### `POST /api/hr/payroll/:id/approve`
- **Guard:** `requireModuleAction("Payroll", "edit")`
- **Response:** Updated Payroll (status = 'approved')
- **Posting:** Dr Salary Expense / Cr Salary Payable
- **Tables:** `payroll`, `account_ledgers`, `payments`, `receipts`

#### `POST /api/hr/payroll/:id/pay`
- **Guard:** `requireModuleAction("Payroll", "edit")`
- **Request body:** `{ paymentLedgerId: number, payDate: string }`
- **Response:** Updated Payroll (status = 'paid')
- **Tables:** `payroll`, `payments`

#### `GET /api/hr/advances`
- **Tables:** `employee_advances`, `employees`

#### `POST /api/hr/advances`
- **Guard:** `requireModuleAction("Payroll", "add")`
- **Request body:** `{ employeeId, amount, advanceDate, notes? }`
- **Tables:** `employee_advances`

---

### Reconciliation & Cash

#### `GET /api/reconciliation/bank-ledgers`
- **Response:** Leaf ledgers under `STD-BANK`

#### `GET /api/reconciliation/pending`
- **Response:** `[SalePayment]` where `reconciliation_status = 'pending'`

#### `GET /api/reconciliation/batches`
- **Tables:** `reconciliation_batches`

#### `GET /api/reconciliation/batches/:id`
- **Response:** Batch with included `sale_payments`

#### `POST /api/reconciliation/batches`
- **Guard:** `requireModuleAction("Reconciliation", "add")`
- **Request body:** `{ salePaymentIds: number[], charges: number, settlementDate: string, destinationBankLedgerId: number, externalReference?: string, notes?: string }`
- **Posting:** Dr `destination_bank_ledger` (net), Dr `STD-PROC-CHG` (charges), Cr `STD-ELEC-CLR` (gross)
- **Tables:** `reconciliation_batches`, `reconciliation_batch_items`, `sale_payments`, `receipts`, `payments`

#### `GET /api/cash-in-outlet`
- **Response:** `[{ locationType, locationId, name, cashBalance, pendingDeposits }]`
- **Tables:** `account_ledgers`, `cash_deposits`, `outlets`, `warehouses`

#### `GET /api/cash-in-outlet/deposits`
- **Query params:** `locationType?`, `locationId?`
- **Tables:** `cash_deposits`

#### `POST /api/cash-in-outlet/deposits`
- **Guard:** `requireModuleAction("Cash Balance", "add")`
- **Request body:** `{ outletId?: number, warehouseId?: number, amount: number, depositDate: string, depositReference?: string, destinationBankLedgerId?: number, notes?: string }`
- **Posting:** Dr `STD-CIT` (Cash in Transit), Cr `OUTLET-CASH-{id}` / `WH-CASH-{id}`
- **Tables:** `cash_deposits`, `payments`

#### `POST /api/cash-in-outlet/deposits/:id/reconcile`
- **Guard:** `requireModuleAction(["Cash Balance", "Reconciliation"], "edit")`
- **Request body:** `{ destinationBankLedgerId: number, bankReference?: string, charges?: number, settlementDate: string }`
- **Posting:** Dr `destination_bank_ledger`, Cr `STD-CIT`
- **Tables:** `cash_deposits`, `receipts`, `payments`

---

### Company & Admin

#### `GET /api/company/settings`
- **Tables:** `company_settings`

#### `PATCH /api/company/settings`
- **Guard:** `requireModuleAction("Settings", "edit")`
- **Request body:** Partial CompanySettings fields
- **Tables:** `company_settings`

#### `GET /api/company/login-history`
- **Guard:** `requireModuleView(["Login History", "Settings"])`
- **Tables:** `login_history`

#### `GET /api/company/permissions`
- **Response:** `[Permission]` — all rows for all hierarchies
- **Tables:** `permissions`, `hierarchies`

#### `POST /api/company/permissions`
- **Guard:** `requireModuleAction("Permissions", "edit")`
- **Request body:** `{ hierarchyId, module, canView, canAdd, canEdit, canDelete, canDownload }`
- **Action:** Upsert on `(hierarchyId, module)`
- **Tables:** `permissions`

#### `POST /api/company/reset`
- **Guard:** `requireModuleAction("Settings", "delete")`
- **Action:** Factory reset — truncates all data tables

#### `GET /api/audit/logs`
- **Guard:** `requireModuleView("Settings")`
- **Query params:** `module?`, `action?`, `user?`, `from?`, `to?`, `page?`, `limit?`
- **Tables:** `activity_log`

#### `GET /api/audit/logs/:id`
- **Tables:** `activity_log`

---

### PDF Generation

#### `POST /api/pdf/challan`
- **Purpose:** Generate delivery challan PDF
- **Request body:** `{ transfer: StockTransfer, lineItems, fromBranch, toBranch, companySettings }`
- **Response:** PDF binary (`application/pdf`)

#### `POST /api/pdf/report`
- **Purpose:** Generate tabular report PDF (max 3,000 rows)
- **Request body:** `{ title, columns, rows, companySettings? }`
- **Response:** PDF binary

#### `POST /api/pdf/payslip`
- **Purpose:** Generate employee payslip PDF
- **Request body:** `{ payroll, employee, company }`
- **Response:** PDF binary

---

### Reports

#### `GET /api/reports/sales-register`
- **Guard:** `requireModuleView("Sales")`
- **Query params:** `from?`, `to?`, `locationId?`, `locationType?`
- **Response:** Detailed invoice list

#### `GET /api/reports/sales-by-item`
- **Guard:** `requireModuleView("Sales")`
- **Response:** Revenue and quantity grouped by item

#### `GET /api/reports/sales-by-location`
- **Guard:** `requireModuleView("Sales")`
- **Response:** Revenue grouped by outlet/warehouse

#### `GET /api/reports/discounts`
- **Guard:** `requireModuleView("Sales")`
- **Response:** Discount amounts by coupon and date

#### `GET /api/reports/sales-stock-combined`
- **Guard:** `requireModuleView("Sales")`
- **Response:** Sales revenue alongside stock levels per item

#### `GET /api/reports/purchase-register`
- **Guard:** `requireModuleView("Purchases")`
- **Response:** Detailed purchase order list

#### `GET /api/reports/purchases-by-vendor`
- **Guard:** `requireModuleView("Purchases")`
- **Response:** Purchase total grouped by vendor

#### `GET /api/reports/purchases-by-material`
- **Guard:** `requireModuleView("Purchases")`
- **Response:** Purchase total grouped by material

#### `GET /api/reports/profitability`
- **Guard:** `requireModuleView("Chart of Accounts")`
- **Response:** `[{ itemId, name, revenue, cogs, grossProfit, margin }]` based on batch cost at time of sale

---

### Search

#### `GET /api/search?q=`
- **Purpose:** Global quick search across entities
- **Response:** `{ sales, customers, vendors, items, employees, productions }` — permission-scoped
- **Tables:** `sales`, `customers`, `vendors`, `items`, `employees`, `productions`

---

## 13. Current Sidebar Documentation

The sidebar is generated dynamically from `moduleRegistry.ts`. Below is the exact structure as defined in code — `NAV_GROUP_ORDER = ['Operations', 'Stock', 'Production', 'Inventory', 'Sales', 'HR', 'Accounts', 'Company']` with Dashboard as the standalone first item.

*Note: The `Stock` section appears in `NAV_GROUP_ORDER` and `NAV_GROUP_META` but no module has `navGroup: 'Stock'` — it renders as an empty section and is not visible.*

---

### ① Dashboard *(standalone — always first, icon: LayoutDashboard)*

| Link Name | URL |
|---|---|
| Dashboard | `/` |

*Module key: `Dashboard` (permGroup: Dashboard)*

---

### ② Operations *(collapsible group, icon: Store)*

| Link Name | URL | Module Key | Icon |
|---|---|---|---|
| Point of Sale | `/sales/pos` | `Point of Sale` | ShoppingCart |
| Stock Transfer | `/transfers` | `HO Transfers` | ArrowLeftRight |
| Expenses | `/sales/expenses` | `Location Expenses` | Receipt |
| Cash Balance | `/accounts/cash-in-outlet` | `Cash Balance` | Banknote |
| Customers | `/customers` | `Customers` | *(group icon)* |
| Stock | `/headoffice/stock` | `Stock` | Package |

*Notes:*
- `Location Stock` module (permGroup: Operations) has empty `navEntries` — no link rendered
- `HO Transfers` module is in permGroup Inventory but renders in the Operations sidebar section via `navGroup: 'Operations'`
- `Stock` module is in permGroup Inventory with `navGroup: 'Inventory'`, but its navEntry overrides with `navGroup: 'Operations'`
- `Customers` module has `navGroup: 'Operations'`

---

### ③ Production *(collapsible group, icon: Factory)*

| Link Name | URL | Module Key |
|---|---|---|
| Batches | `/production/production` | `Production` |
| Reports | `/production/reports` | `Production` |
| Purchases | `/production/purchase` | `Purchases` |
| Vendors | `/vendors` | `Vendors` |

---

### ④ Inventory *(collapsible group, icon: Building2)*

| Link Name | URL | Module Key |
|---|---|---|
| Item Master | `/production/item-master` | `Items` |
| Units | `/production/units` | `Units` |
| Stock Ledger | `/headoffice/stock-ledger` | `Stock Ledger` |
| Reports | `/headoffice/inventory-reports` | `Inventory Reports` |
| Verification | `/headoffice/stock-verification` | `Stock Verification` |
| Warehouses | `/headoffice/warehouses` | `Warehouses` |
| Outlets | `/headoffice/outlets` | `Outlets` |
| Item Prices | `/headoffice/item-price` | `Item Prices` |

---

### ⑤ Sales *(collapsible group, icon: Calculator)*

| Link Name | URL | Module Key |
|---|---|---|
| Returns | `/returns` | `Sales` |
| Outstanding | `/outstanding` | `Sales` |
| Coupons | `/coupons` | `Coupons` |

---

### ⑥ HR *(collapsible group, icon: Users)*

| Link Name | URL | Module Key |
|---|---|---|
| Employees | `/hr/employees` | `Employees` |
| Attendance | `/hr/attendance` | `Attendance` |
| Payroll | `/hr/payroll` | `Payroll` |
| Advances | `/hr/advances` | `Payroll` |
| Hierarchy | `/hr/hierarchy` | `Hierarchy` |

*Note: `Leave` module (permGroup: HR) has empty `navEntries` — no sidebar link rendered; leave management is accessed from the Attendance page.*

---

### ⑦ Accounts *(collapsible group, icon: UsersRound)*

| Link Name | URL | Module Key |
|---|---|---|
| Chart of Accounts | `/accounts/chart` | `Chart of Accounts` |
| Ledger Statement | `/accounts/ledger` | `Ledger` |
| Cash & Bank | `/accounts/cash-bank` | `Cash & Bank` |
| Vouchers | `/accounts/vouchers` | `Vouchers` |
| Day Book | `/accounts/day-book` | `Books` |
| Cash Book | `/accounts/cash-book` | `Books` |
| Bank Book | `/accounts/bank-book` | `Books` |
| Trial Balance | `/accounts/trial-balance` | `Books` |
| Expenses | `/accounts/expenses` | `Expenses` |
| GST Summary | `/accounts/gst` | `GST Summary` |
| GST Returns | `/accounts/gst-returns` | `GST Returns` |
| Reconciliation | `/accounts/reconciliation` | `Reconciliation` |
| Reports | `/reports/sales` | `Reports` |

*Notes:*
- `Payments` module (permGroup: Accounts) has empty `navEntries` — no sidebar link; payment/receipt pages are accessed via `/accounts/payments` and `/accounts/receipts` directly
- `Accounts Cash Balance` module has empty `navEntries` — no sidebar link (Cash Balance link is in Operations)

---

### ⑧ Company *(collapsible group, icon: Settings)*

| Link Name | URL | Module Key |
|---|---|---|
| Settings | `/company/settings` | `Settings` |
| Company Profile | `/company/profile` | `Settings` |
| Audit Log | `/company/audit` | `Settings` |
| Permissions | `/company/permissions` | `Permissions` |
| Login History | `/company/login-history` | `Login History` |

---

### Sidebar Footer

- **Profile link** (always visible, no permission guard): navigates to `/profile/me`
- **Theme toggle**: light/dark mode switch
- **Logout button**: clears localStorage tokens → `/login`

---

## 14. Current Navigation Flow

### How Users Navigate the ERP

#### Entry Point
1. User opens the ERP → AuthGuard checks `marlin_auth_token` in localStorage
2. No token → `/login` page
3. Valid token + `mustChangePassword = true` → `/change-password`
4. Valid token → `/` (Dashboard)

#### General Navigation
- The **sidebar** is the primary navigation surface for all authenticated users
- **Collapsible groups** (Operations, Production, Inventory, Sales, HR, Accounts, Company) are clicked to expand/collapse
- **Active link** is highlighted based on current path match (or `matchPrefix` for `/reports` routes)
- Sidebar links with `canView = false` are hidden from the user

#### Operations Flow (Branch Staff)
```
/sales → LocationPicker → select outlet or warehouse
    └─► /sales/dashboard  — branch sales overview
    └─► /sales/pos        — create invoice
    └─► /sales/stock      — view branch stock
    └─► /sales/expenses   — record expense
    └─► /sales/cash-balance — view cash balance
/transfers → dispatch or approve/reject stock transfers
/customers → manage customer records
```

#### Inventory / Production Flow (Managers)
```
Inventory section:
  /production/item-master → manage items, materials, BOMs
  /production/units       → manage units
  /headoffice/stock       → view all branch stock
  /headoffice/stock-ledger → audit trail
  /headoffice/stock-verification → physical count
  /headoffice/inventory-reports → analytics
  /headoffice/warehouses / /headoffice/outlets → branch management
  /headoffice/item-price  → set prices

Production section:
  /production/production → create/view batches
  /production/reports    → production analytics
  /production/purchase   → purchase orders
  /vendors               → vendor management
```

#### Accounts Flow (Accountants)
```
Accounts section:
  /accounts/chart        → COA tree, opening balances
  /accounts/ledger       → ledger statement for any account
  /accounts/cash-bank    → cash/bank management
  /accounts/vouchers     → journal, contra, notes
  /accounts/day-book     → all movements
  /accounts/cash-book / /accounts/bank-book → cash/bank movements
  /accounts/trial-balance → debit/credit summary
  /accounts/expenses     → HO expenses
  /accounts/gst          → GST summary
  /accounts/gst-returns  → GSTR-1, GSTR-3B
  /accounts/reconciliation → bank reconciliation
  /accounts/cash-in-outlet → aggregate cash + deposits
  /reports/sales         → reports centre (6 sections via tabs: /reports/:cat)
```

#### Company Flow (Admin)
```
/company/settings        → company info + invoice config
/company/profile         → detailed company profile
/company/audit           → full audit trail
/company/permissions     → role-based access setup
/company/login-history   → security log
```

#### Secondary Navigation
- **`/profile/me`** — accessible from sidebar footer, not from any section group
- **`/hr/leave`** — directly accessible via URL; leave management also embedded in Attendance page
- **`/headoffice/sales`** — HO sales view, reachable by direct link (not in sidebar)
- **`/sales/dashboard`** — reachable from Operations section after location selection
- **`/reports/:cat`** — Reports link in Accounts section navigates to `/reports/sales`; section tabs within the page switch between sales/purchases/inventory/production/parties/financial

#### 404 Handling
Any URL not matching a defined route renders the `NotFound` component with a "Return to Dashboard" link.

---

## 15. Current Business Architecture

### How All Modules Interact

```
┌─────────────────────────────────────────────────────────────┐
│                    CONFIGURATION LAYER                       │
│  Company Settings  │  Hierarchies  │  Permissions           │
│  (invoice prefix,  │  (roles,      │  (module flags          │
│   overhead %)      │   levels)     │   per role)             │
└────────────────────────────┬────────────────────────────────┘
                             │ governs
                ┌────────────▼────────────┐
                │      EMPLOYEES           │
                │  (ERP login accounts)    │
                │  branch_type + branch_id │
                └────────────┬────────────┘
                             │ works at
     ┌───────────────────────┼──────────────────────┐
     ▼                       ▼                      ▼
 OUTLETS                WAREHOUSES             HEAD OFFICE
 (retail points)        (distribution)         (admin)
     │                       │                      │
     └───────────────────────┼──────────────────────┘
                             │
             ┌───────────────▼───────────────┐
             │         STOCK LAYER           │
             │   stock_entries (quantities)  │
             │   stock_batches (FEFO lots)   │
             │   stock_ledger (audit trail)  │
             └───┬──────────┬──────────┬────┘
                 │          │          │
          credited by   deducted by  moved by
                 │          │          │
          ┌──────┘   ┌──────┘   ┌─────┘
          ▼          ▼          ▼
     PRODUCTION   SALES     STOCK TRANSFERS
     (batches)    (invoices) (dispatch/approve/reject)
          │          │          │
          │          │          │
     credits        creates   creates
     items.         sale +    transfer
     production_    receipt   challan
     stock          voucher
                    │
            ┌───────▼────────┐
            │   CUSTOMERS    │
            │  (debtors,     │
            │   credit limit)│
            └───────┬────────┘
                    │
         ┌──────────▼──────────┐
         │   OUTSTANDING/      │
         │   PAYMENTS          │
         │   (receivables,     │
         │    sale payments)   │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   RECONCILIATION    │
         │   (UPI/card settle) │
         └─────────────────────┘

PURCHASES ──► credits materials/raw_materials stock
          ──► creates vendor ledger postings
          ──► feeds GST input credit
VENDORS   ──► master for purchases, payments
COUPONS   ──► applied at POS (discount_total on sales)
HR        ──► attendance → payroll → COA postings
ACCOUNTS  ──► aggregates all postings into financial statements
REPORTS   ──► reads from all operational tables for analytics
DASHBOARD ──► read-only aggregates from all modules
AUDIT LOG ──► records every mutation from all modules
```

### Module Interaction Summary

| Module | Produces | Consumes |
|---|---|---|
| Company Settings | Config for all modules | — |
| Hierarchies + Permissions | RBAC for all modules | Employees |
| Warehouses / Outlets | Location master | Stock, Sales, Transfers, Cash |
| Items | Finished goods catalogue | Production, Sales, Stock, Prices |
| Materials / Raw Materials | Input catalogue | Production, Purchases |
| BOM Templates | Production blueprint | Production |
| Purchases | Stock credit (materials/items), vendor payables | Vendors, Materials |
| Productions | Stock credit (items, headoffice), batch lots | Items, Materials, BOM |
| Stock Entries | Current stock truth | Sales (deduct), Transfers, Dashboard |
| Stock Batches | FEFO lot tracking | Sales, Transfers, Production |
| Stock Transfers | Branch-to-branch movement | Stock Entries, Stock Batches |
| Item Prices | Selling prices | Point of Sale |
| Sales | Revenue, stock deduction, customer receivables | Items, Customers, Stock, Prices, Coupons |
| Sale Payments | Payment tracking | Sales |
| Reconciliation | Settlement posting | Sale Payments, Bank Ledgers |
| Cash Deposits | Cash transit + banking | Outlet/WH Cash Ledgers |
| Customers | Debtors master | Sales, Outstanding |
| Vendors | Creditors master | Purchases, Outstanding |
| Coupons | Discount rules | Sales (POS) |
| Returns | Stock restoration, CN/DN | Sales, Purchases, Stock |
| Employees | Login accounts, HR master | Payroll, Attendance |
| Attendance | Daily presence records | Payroll |
| Leaves | Approved leave days | Attendance, Payroll |
| Payroll | Salary computation + COA posting | Attendance, Advances, Employees |
| Advances | Pre-paid salary deductions | Payroll |
| Account Ledgers | COA tree | All accounting modules |
| Receipts / Payments | Voucher records | Ledger, Books, Trial Balance |
| Journal Vouchers | Manual JVs | Ledger, Books, Trial Balance |
| Expenses | Expense records | Ledger, Books |
| Opening Balances | Historical balances | Financial Statements |
| GST Ledgers | Tax postings | GST Summary, GSTR-1/3B |
| Dashboard | Aggregated KPIs | All modules (read-only) |
| Audit Log | Mutation history | Company Admin |
| Reports | Analytics output | All operational tables |

---

## 16. Module Dependency Diagram

### Dependency by Shared Table

```
account_ledgers ◄──── Chart of Accounts (manages)
                ◄──── Sales (auto-receipts)
                ◄──── Purchases (vendor postings via derived)
                ◄──── Receipts/Payments (direct voucher links)
                ◄──── Journal Vouchers (direct JV lines)
                ◄──── Expenses (ledger FK)
                ◄──── Payroll (COA postings)
                ◄──── Reconciliation (JV postings)
                ◄──── Cash Deposits (transit postings)
                ◄──── Branches (auto-provision on create)
                ◄──── Customers/Vendors (auto-provision on create)
                ──►   All Accounting Reads (Ledger, Books, Trial Balance, Financial)

stock_entries   ◄──── Production (credit headoffice)
                ◄──── Purchases (credit location)
                ◄──── Sales (deduct branch)
                ◄──── Stock Transfers (deduct source / credit dest)
                ◄──── Stock Verification (adjust)
                ──►   Stock view, Dashboard, Inventory Reports

stock_batches   ◄──── Production (new lots)
                ◄──── Purchases (new lots with expiry)
                ◄──── Sales (FEFO deduction)
                ◄──── Stock Transfers (FEFO deduction + credit)
                ──►   Inventory Reports (expiry), FEFO allocation

sales           ◄──── Point of Sale (creates)
                ◄──── Sales Returns (references)
                ──►   Outstanding (receivables)
                ──►   GST (output tax)
                ──►   Reports (analytics)
                ──►   Dashboard (KPIs)
                ──►   Reconciliation (pending payments)

purchases       ◄──── Purchases module (creates)
                ◄──── Purchase Returns (references)
                ──►   GST (input tax)
                ──►   Reports (analytics)

employees       ◄──── HR Employees (manages)
                ──►   Auth (login)
                ──►   Attendance (employee_id FK)
                ──►   Payroll (employee_id FK)
                ──►   Permissions (hierarchy_id FK)

permissions     ◄──── Company Permissions (manages)
                ──►   Middleware (requireModuleAction/View)
                ──►   Frontend usePermission hook

company_settings◄──── Company Settings (manages)
                ──►   Invoice PDF (prefix, sequence)
                ──►   Production (overhead %)
                ──►   GST (company GSTIN for inter/intrastate)
                ──►   All report headers
```

### Blocking Dependencies (creation order matters)

```
hierarchies        → employees (hierarchy_id FK)
warehouses         → outlets (warehouse_id FK)
employees          → attendance, payroll, leaves, advances
account_ledgers    → expenses, payments, receipts, journal_voucher_lines
items              → stock_entries, item_prices, productions, bom_templates
vendors            → purchases
customers          → sales (for credit mode)
outlets/warehouses → stock_entries, item_prices, sales
```

---

## 17. Complete Summary

### Counts

| Category | Count |
|---|---|
| **ERP modules (permission keys)** | 41 |
| **Sidebar sections** | 8 (Dashboard + 7 groups) |
| **Sidebar links rendered** | 35 |
| **Authenticated pages** | 58 |
| **Route definitions (App.tsx)** | 63 (including aliases and redirects) |
| **Backend route files** | 27 |
| **API endpoints** | ~115 |
| **Database tables (Drizzle-managed)** | 25 |
| **Database tables (startup-migration)** | 7 |
| **Report sections** | 6 (Sales, Purchases, Financial, Inventory, Production, Parties) |
| **Report endpoints** | 9 |
| **Business workflows documented** | 10 |
| **Accounting posting flows** | 12 |
| **COA system groups** | 13 |
| **Auto-provisioned ledger types** | 8 (`OUTLET-CASH`, `WH-CASH`, `WH-SAL`, `WH-PUR`, `OUTLET-SAL`, `CUST-`, `VEND-`, GST ledgers) |
| **Startup-migration one-time guards** | 4 (in `migration_log`) |

### Technology Summary

| Layer | Technology |
|---|---|
| Frontend framework | React 18 + Vite + TypeScript |
| UI library | shadcn/ui (Radix UI + Tailwind CSS) |
| Routing | Wouter |
| Data fetching | TanStack React Query |
| API client | orval-generated hooks + hand-written custom hooks |
| Backend runtime | Node.js + Express + TypeScript |
| ORM | Drizzle ORM |
| Database | PostgreSQL (Neon) |
| Validation | Zod |
| Auth | JWT (jsonwebtoken) + bcryptjs |
| Logging | pino + pino-http |
| PDF generation | jsPDF (server-side) |
| Mobile app | Expo / React Native |
| Package manager | pnpm (workspaces monorepo) |
| Build tool | Vite (frontend) + tsc (backend) |

### Coverage

This ERP covers the complete operational lifecycle of a frozen fruits business:

1. **Procurement** — Vendor management, purchase orders, GST input credit
2. **Production** — Batch manufacturing, BOM comparison, costing, wastage tracking
3. **Inventory** — Multi-branch FEFO batch stock, inter-branch transfers, stock ledger
4. **Sales** — Location-gated POS, credit limits, invoice sharing, payment tracking
5. **Finance** — Double-entry COA (Tally-standard), bank reconciliation, cash deposits
6. **GST** — Line-level tax computation, GSTR-1/3B preparation, reconciliation
7. **HR** — GPS attendance, leave management, payroll with COA auto-posting
8. **Reporting** — 6-section analytics centre with CSV export
9. **Administration** — Module-level RBAC, full audit trail, login history

---

*End of documentation — describes the Marlin Frozen Fruits ERP exactly as implemented on the analysis date of July 2026. No source code was modified during the preparation of this document.*

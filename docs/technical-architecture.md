# Marlin Frozen Fruits ERP — Technical Architecture Document

**Version:** Post-Task-80 (Unified Sidebar)  
**Date:** July 2026  
**Status:** Current implementation — read-only reference

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Backend Architecture](#3-backend-architecture)
4. [Authentication & Session](#4-authentication--session)
5. [Authorization (RBAC)](#5-authorization-rbac)
6. [Database Schema](#6-database-schema)
7. [API Reference](#7-api-reference)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Navigation & Module Registry](#9-navigation--module-registry)
10. [Permission System (End-to-End)](#10-permission-system-end-to-end)
11. [Shared Libraries](#11-shared-libraries)
12. [Data Flow](#12-data-flow)
13. [PDF Generation](#13-pdf-generation)
14. [Current Limitations & Technical Debt](#14-current-limitations--technical-debt)

---

## 1. Project Overview

Marlin Frozen Fruits ERP is an internal operations platform built as a **pnpm monorepo**. It manages the full supply chain: raw-material purchase → production → warehouse → outlet distribution → POS sales → accounting → GST returns.

### Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript |
| Backend framework | Express 4 |
| ORM / query builder | Drizzle ORM + raw `pg` pool |
| Database | PostgreSQL (Replit managed) |
| Frontend framework | React 18 + Vite 5 |
| Frontend routing | Wouter |
| Server state | TanStack Query v5 |
| UI components | shadcn/ui (Radix + Tailwind) |
| API client | Orval-generated hooks + custom hand-written hooks |
| Auth | Custom HMAC-SHA256 JWT (v2 token scheme) |
| Password hashing | bcryptjs |
| Logging | Pino |
| PDF generation | pdfkit (server-side) |

---

## 2. Monorepo Structure

```
/ (workspace root)
├── pnpm-workspace.yaml
├── package.json
├── artifacts/
│   ├── api-server/              ← Express backend
│   │   ├── src/
│   │   │   ├── app.ts           ← Express app, middleware registration
│   │   │   ├── index.ts         ← Server entry point, startup migrations
│   │   │   ├── seed-items.ts    ← Sample data seeder
│   │   │   ├── db/              ← (schema via Drizzle, referenced via @workspace/db)
│   │   │   ├── lib/             ← Business logic helpers
│   │   │   │   ├── audit.ts
│   │   │   │   ├── batches.ts
│   │   │   │   ├── dataScope.ts
│   │   │   │   ├── gst.ts
│   │   │   │   ├── gstTransfer.ts
│   │   │   │   ├── logger.ts
│   │   │   │   ├── password.ts
│   │   │   │   ├── passwordPolicy.ts
│   │   │   │   ├── shareToken.ts
│   │   │   │   ├── stockLedger.ts
│   │   │   │   ├── token.ts
│   │   │   │   └── voucherNumber.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts      ← requireAuth
│   │   │   │   └── permissions.ts ← requireModuleAction
│   │   │   ├── routes/          ← 24 route files (see §7)
│   │   │   └── services/        ← PDF renderers
│   │   │       ├── invoicePdf.ts
│   │   │       ├── challanPdf.ts
│   │   │       ├── reportPdf.ts
│   │   │       └── payslipPdf.ts
│   │   └── package.json
│   │
│   └── marlin-erp/              ← React frontend
│       ├── src/
│       │   ├── App.tsx          ← Router, AuthGuard, all routes
│       │   ├── components/
│       │   │   ├── layout/
│       │   │   │   └── AppLayout.tsx ← Unified sidebar + topbar
│       │   │   └── ui/          ← shadcn/ui primitives + custom components
│       │   ├── lib/
│       │   │   ├── moduleRegistry.ts ← Single source of truth for nav + perms
│       │   │   ├── usePermission.ts  ← Permission hook + resolver
│       │   │   ├── locationContext.tsx ← Branch location state
│       │   │   ├── locationHierarchy.ts ← Location picker tree builder
│       │   │   └── theme.ts     ← Dark/light mode
│       │   └── pages/           ← All application pages (see §8)
│       └── package.json
│
└── lib/
    ├── api-client-react/        ← Orval-generated + hand-written React Query hooks
    │   ├── src/
    │   │   ├── generated/
    │   │   │   ├── api.ts       ← All auto-generated hooks (useLogin, useListSales, etc.)
    │   │   │   └── api.schemas.ts ← TypeScript types for all entities
    │   │   ├── custom-fetch.ts  ← Authenticated fetch wrapper
    │   │   ├── index.ts         ← Barrel export
    │   │   ├── analytics.ts     ← Sales analytics hooks
    │   │   ├── bom.ts           ← Bill of Materials hooks
    │   │   ├── gst.ts           ← GST report hooks
    │   │   ├── inventory-batches.ts ← Batch query hooks
    │   │   ├── journal.ts       ← Journal/contra/notes hooks
    │   │   ├── location-expenses.ts ← Location expense hooks
    │   │   ├── login-history.ts
    │   │   ├── paginated-lists.ts
    │   │   ├── payments-reconciliation.ts
    │   │   ├── payroll.ts
    │   │   ├── production.ts
    │   │   ├── production-reports.ts
    │   │   ├── quick-search.ts
    │   │   ├── reports.ts
    │   │   ├── returns.ts
    │   │   ├── stock-ledger.ts
    │   │   ├── transfers.ts
    │   │   └── vouchers.ts
    ├── api-zod/                 ← Zod validation schemas (server-side)
    └── db/                      ← Shared PostgreSQL pool (@workspace/db)
```

---

## 3. Backend Architecture

### 3.1 app.ts — Middleware Stack

Middleware is registered in order:

```
pino-http          ← structured request/response logging
cors               ← allows x-refreshed-token response header
express.json()     ← body parsing (JSON)
express.urlencoded ← body parsing (forms)
/api/*             ← global requireAuth (except /healthz, /auth/login, /public/invoices/*)
routes/index.ts    ← all route handlers mounted under /api
```

### 3.2 index.ts — Server Entry Point

1. Calls `runMigrations()` — idempotent startup migrations (schema evolution + data seeding)
2. Seeds default `admin` user if no level-1 hierarchy exists
3. Migrates plaintext passwords to bcrypt
4. Seeds Tally-standard Chart of Accounts groups and ledgers
5. Provisions per-outlet and per-warehouse cash/sales/purchase ledgers
6. Backfills customer/vendor `account_ledger` rows
7. Starts HTTP server on `process.env.PORT`

### 3.3 Route Organization

All routes are mounted flat under `/api` (no sub-prefix nesting):

| Route file | Base paths |
|---|---|
| auth.ts | `/auth/*` |
| dashboard.ts | `/dashboard/*` |
| inventory.ts | `/materials`, `/raw-materials`, `/items`, `/stock`, `/stock-entries`, `/outlets`, `/warehouses` |
| branches.ts | `/branches` |
| purchases.ts | `/purchases`, `/purchase-returns` |
| production.ts | `/production/*`, `/bom` |
| stock.ts | `/stock/transfers` |
| inventory-batches.ts | `/inventory-batches` |
| sales.ts | `/sales`, `/outstanding/*` |
| payments.ts | `/accounts/payments`, `/accounts/receipts`, `/cash-deposits`, `/reconciliation/*`, `/sale-payments/*` |
| accounts.ts | `/accounts/*`, `/expenses` |
| journal.ts | `/accounts/journal`, `/accounts/contra`, `/accounts/notes` |
| gst.ts | `/gst/*` |
| hr.ts | `/hr/*` |
| customers.ts | `/customers`, `/coupons` |
| returns.ts | `/sales-returns`, `/purchase-returns` |
| bom.ts | `/bom` |
| reports.ts | `/reports/*` |
| search.ts | `/search/quick` |
| company.ts | `/company/*`, `/permissions` |
| audit.ts | `/audit/*` |
| pdfGen.ts | `/pdf/*` |
| publicInvoices.ts | `/public/invoices/*` |
| cash-in-outlet.ts | `/accounts/location-expenses/all`, `/accounts/cash-in-outlet` |
| reconciliation.ts | `/reconciliation/*` |
| health.ts | `/healthz` |

---

## 4. Authentication & Session

### 4.1 Token Format

Custom "v2" stateless token (no JWT library dependency):

```
v2.<base64url(id:username:timestamp)>.<base64url(hmac-sha256-signature)>
```

- Signed with `SESSION_SECRET` environment variable via HMAC-SHA256
- Verified on every request by `requireAuth` middleware
- Attached to `req.employee` for downstream use

### 4.2 Login Flow

```
POST /api/auth/login
  → Rate-limit check (5 attempts per 15 min per IP — in-memory store)
  → Query employee by username
  → bcrypt.compare(password, password_hash)
  → If mustChangePassword=true → return token + flag
  → Return { token, employee: { id, name, username, hierarchyId, branchType, branchId, ... } }
```

### 4.3 Token Refresh

The `x-refreshed-token` response header carries a fresh token on each successful response. The frontend `customFetch` wrapper reads this header and updates the stored token transparently — no explicit refresh endpoint needed.

### 4.4 Forced Password Change

- `must_change_password` column on `employees` table (boolean)
- Set to `true` for new accounts and on admin reset
- Frontend `AuthGuard` reads the `marlin_user` localStorage entry and redirects to `/change-password` if this flag is set
- `POST /api/auth/change-password` clears the flag after successful change

### 4.5 Password Policy (`lib/passwordPolicy.ts`)

- Minimum 8 characters
- At least one uppercase letter
- At least one number
- Default initial password: `marlin1458` (forced change on first login)

### 4.6 Client-Side Storage

| Key | Value |
|---|---|
| `marlin_auth_token` | v2 HMAC token string |
| `marlin_user` | JSON-serialised employee object |
| `marlin_sales_location` | JSON-serialised LocationState |
| `marlin_company_logo` | Base64 data URL of company logo |

---

## 5. Authorization (RBAC)

### 5.1 Architecture Overview

```
Employee
  └── hierarchyId → hierarchies.id (level 1–N, level 1 = full access)
                         └── permissions rows (module × action × boolean)

Employee
  └── branchType: 'headoffice' | 'warehouse' | 'outlet'
  └── branchId:   references warehouses.id or outlets.id (0 for headoffice)
```

### 5.2 requireAuth (middleware/auth.ts)

Global guard applied to all `/api/*` routes except `/api/healthz`, `/api/auth/login`, and `/api/public/invoices/*`.

```typescript
// Verifies v2 token, attaches req.employee
const decoded = TokenService.verify(token);   // throws on bad sig / expired
req.employee = await db.query('SELECT * FROM employees WHERE id = $1', [decoded.id]);
```

### 5.3 requireModuleAction (middleware/permissions.ts)

Per-route guard for write operations:

```typescript
requireModuleAction(modules: string | string[], action: 'add' | 'edit' | 'delete')
```

**Resolution logic:**

1. Look up `hierarchies.level` for `req.employee.hierarchyId`
2. If `level === 1` → pass through (full access)
3. Query `permissions` table for rows matching `hierarchy_id` and `module IN (modules)`
4. If **any** module in the list has the action column ≠ `false` → pass through
5. Otherwise → `403 Forbidden`

**Default behaviour (no row in permissions table):** ALLOW — the absence of a saved row means "no explicit restriction." Only `false` actively blocks.

### 5.4 getUserDataScope (lib/dataScope.ts)

Returns the set of location IDs the employee may read data from:

```typescript
interface DataScope {
  isHeadOffice: boolean;
  warehouseIds: number[];
  outletIds: number[];
}

// Head Office  → isHeadOffice: true, all data visible
// Warehouse    → warehouseIds: [branchId], outletIds: [mapped outlet IDs]
// Outlet       → outletIds: [branchId]
```

Used by sales, stock, expenses, and transfer queries to scope `WHERE` clauses.

### 5.5 Permission Hierarchy

| Level | Role | Access |
|---|---|---|
| 1 | Management / Admin | Full access — bypasses all permission checks |
| 2–N | Custom roles | Only modules/actions explicitly granted |

Hierarchies are created in HR → Hierarchy. Permissions are assigned per hierarchy level on the Permissions page.

### 5.6 Frontend Permission Hook (lib/usePermission.ts)

```typescript
usePermission(module: string): PermissionSet
// { canView, canAdd, canEdit, canDelete, canDownload, isLoading }

canViewModule(module, hierarchyId, level, permissions): boolean
// Used by AppLayout sidebar filter
```

**Resolution rules (mirrored exactly between frontend and backend):**

| Condition | Result |
|---|---|
| level === 1 | Full access |
| No row in permissions for this module | View-only (DEFAULT_VIEW_ONLY) |
| Row exists | Exactly what the row says |

---

## 6. Database Schema

The database uses PostgreSQL. Tables are created/evolved via startup migrations in `index.ts` using idempotent `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements. Drizzle ORM is used for typed queries in some routes; raw `pg` pool queries are used for complex joins and migrations.

### 6.1 Core Tables

#### `employees`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | Display name |
| username | text UNIQUE NOT NULL | Login credential |
| password_hash | text NOT NULL | bcrypt hash |
| hierarchy_id | integer FK→hierarchies.id | Role level |
| branch_type | text | `'headoffice'` / `'warehouse'` / `'outlet'` |
| branch_id | integer | FK→warehouses.id or outlets.id; 0 for HO |
| salary | numeric | Base monthly salary |
| join_date | text | ISO date string |
| is_active | boolean | Soft-delete flag |
| must_change_password | boolean DEFAULT false | Forced change flag |
| work_experience | jsonb DEFAULT `[]` | Array of past experience records |
| phone, email, address | text | Contact info |

#### `hierarchies`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | Role name (e.g. "Management", "Sales Staff") |
| level | integer | Lower = more senior; level 1 = full access |
| description | text | |

#### `permissions`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| hierarchy_id | integer FK→hierarchies.id | |
| module | text NOT NULL | Must match a key in MODULE_REGISTRY |
| can_view | boolean | Sidebar visibility + page access |
| can_add | boolean | Create operations |
| can_edit | boolean | Update operations |
| can_delete | boolean | Delete operations |
| can_download | boolean | PDF/export buttons |
| UNIQUE | (hierarchy_id, module) | One row per role per module |

#### `warehouses`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| address | text | |
| gstin | text | GST registration number |
| upi_id | text | For QR on invoices |
| cash_ledger_id | integer FK→account_ledgers | Auto-provisioned |
| sales_ledger_id | integer FK→account_ledgers | Auto-provisioned |
| purchase_ledger_id | integer FK→account_ledgers | Auto-provisioned |

#### `outlets`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| warehouse_id | integer FK→warehouses.id | Parent warehouse |
| address | text | |
| gstin | text | |
| upi_id | text | |
| cash_ledger_id | integer FK→account_ledgers | Auto-provisioned |
| sales_ledger_id | integer FK→account_ledgers | Auto-provisioned |

#### `materials` (packaging / processing materials)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| unit | text | e.g. kg, pcs |
| hsn_code | text | GST HSN code |
| tax_rate | numeric(5,2) | GST % |
| cost | numeric | Unit cost |
| avg_cost | numeric(12,4) | Rolling weighted-average cost |

#### `raw_materials`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | Same structure as materials |

#### `items` (finished goods for sale)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| unit | text | |
| hsn_code | text | |
| tax_rate | numeric(5,2) | Must be valid GST slab: 0/5/12/18/28 |
| mrp | numeric(10,2) | Maximum Retail Price |
| cost | numeric(10,2) | Standard cost |
| reorder_level | numeric | Low-stock threshold |

#### `item_prices`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| item_id | integer FK→items.id | |
| warehouse_id | integer FK→warehouses.id | Null = all warehouses |
| outlet_id | integer FK→outlets.id | Null = all outlets |
| price | numeric(10,2) | Selling price |
| valid_from | text | ISO date (startup migration column) |
| valid_to | text | ISO date (startup migration column) |

#### `bom_templates`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| item_id | integer FK→items.id | One BOM per finished item |
| lines | jsonb | Array of `{materialType, materialId, quantity}` |
| notes | text | |

#### `productions` (production batches)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| batch_number | text UNIQUE | |
| item_id | integer FK→items.id | |
| quantity_produced | numeric | |
| production_date | text | |
| expiry_date | text | |
| warehouse_id | integer FK→warehouses.id | |
| line_items | jsonb | Actual materials consumed |
| material_cost | numeric(12,2) | Nullable (not costed for old batches) |
| overhead_percent | numeric(5,2) | |
| overhead_amount | numeric(12,2) | |
| total_cost | numeric(12,2) | |
| cost_per_unit | numeric(12,4) | |
| wastage | jsonb DEFAULT `[]` | Array of waste records |
| wastage_qty | numeric(10,3) | |
| wastage_value | numeric(12,2) | |

#### `purchases`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| vendor_id | integer FK→vendors.id | |
| purchase_date | text | |
| warehouse_id | integer FK→warehouses.id | |
| line_items | jsonb | Array of `{materialType, materialId, quantity, rate, amount, taxRate, taxAmount}` |
| subtotal | numeric(12,2) | |
| tax_total | numeric(12,2) | |
| discount_total | numeric(12,2) | |
| round_off | numeric(12,2) | |
| total_amount | numeric(12,2) | |
| invoice_number | text | Vendor invoice reference |
| notes | text | |

#### `stock_entries`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| warehouse_id | integer | Nullable (warehouse stock) |
| outlet_id | integer | Nullable (outlet stock) |
| item_id | integer FK→items.id | |
| quantity | numeric | Current on-hand quantity |
| UNIQUE | (warehouse_id, outlet_id, item_id) | One row per location per item |

**Note:** `stock_entries` holds current quantity. History lives in `stock_ledger`.

#### `stock_batches` (FEFO tracking)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| warehouse_id | integer | Nullable |
| outlet_id | integer | Nullable |
| item_id | integer FK→items.id | |
| batch_number | text | Links to productions.batch_number |
| quantity | numeric | Remaining in this batch at this location |
| cost_per_unit | numeric(12,4) | At time of production |
| production_date | text | |
| expiry_date | text | **FEFO sort key** |
| created_at | timestamptz | |

#### `stock_transfers`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| from_warehouse_id | integer | Nullable |
| from_outlet_id | integer | Nullable |
| to_warehouse_id | integer | Nullable |
| to_outlet_id | integer | Nullable |
| status | text DEFAULT `'in_transit'` | `in_transit` / `approved` / `rejected` |
| transfer_date | text | |
| line_items | jsonb | `[{itemId, quantity, batchNumber, costPerUnit}]` |
| received_line_items | jsonb DEFAULT `[]` | What was actually received (on approve) |
| rejection_reason | text | |
| approved_by | text | Username |
| approved_at | timestamptz | |
| gst_type | text | `internal` / `intrastate` / `interstate` |
| journal_voucher_id | integer | Dispatch JV |
| receive_voucher_id | integer | Approve JV |
| notes | text | |

#### `stock_verifications`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| warehouse_id | integer | |
| outlet_id | integer | |
| verification_date | text | |
| verified_by | text | |
| items | jsonb | `[{itemId, systemQty, physicalQty, discrepancy}]` |
| notes | text | |

#### `stock_ledger`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| warehouse_id | integer | Nullable |
| outlet_id | integer | Nullable |
| item_id | integer FK→items.id | |
| transaction_type | text | `production`/`sale`/`transfer_out`/`transfer_in`/`purchase`/`adjustment`/`return` |
| reference_id | integer | FK to source record |
| reference_type | text | Table name of source |
| quantity_change | numeric | Positive = in, negative = out |
| batch_number | text | |
| notes | text | |
| created_at | timestamptz | |

#### `sales`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| invoice_number | text UNIQUE | Auto-generated |
| sale_date | text | |
| customer_id | integer FK→customers.id | Nullable (walk-in) |
| location_type | text DEFAULT `'outlet'` | `'outlet'` / `'warehouse'` |
| location_id | integer | FK to outlet or warehouse |
| outlet_id | integer | Legacy column (kept for compat) |
| payment_mode | text | `cash`/`upi`/`card`/`credit` |
| payment_status | text DEFAULT `'unpaid'` | `unpaid`/`partially_paid`/`paid` |
| amount_paid | numeric(12,2) | |
| subtotal | numeric(12,2) | Pre-tax subtotal |
| discount_total | numeric(12,2) | Bill-level coupon discount only |
| tax_amount | numeric(12,2) | Total GST |
| total_amount | numeric(12,2) | Final payable |
| line_items | jsonb | `[{itemId, itemName, quantity, mrp, rate, discount, taxRate, taxAmount, cgst, sgst, igst, amount}]` |
| gstin | text | Customer GSTIN (B2B sales) |
| notes | text | |
| coupon_id | integer FK→coupons.id | Nullable |
| authorized_by | text | For credit-limit override |

#### `sale_payments`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| sale_id | integer FK→sales.id | |
| payment_date | text | |
| method | text | `cash`/`upi`/`card`/`bank_transfer` |
| amount | numeric(12,2) | |
| reference_number | text | Cheque/UTR |
| outlet_id | integer | Nullable |
| reconciliation_status | text | `pending`/`reconciled` |
| clearing_receipt_id | integer | FK→receipts.id |

#### `sales_returns`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| original_sale_id | integer FK→sales.id | |
| return_date | text | |
| line_items | jsonb | Items returned |
| refund_amount | numeric(12,2) | |
| refund_method | text | |
| notes | text | |

#### `customers`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| phone | text | |
| email | text | |
| gst_number | text | GSTIN for B2B |
| credit_limit | numeric(12,2) | 0 = no limit |
| location_type | text | Location scope |
| location_id | integer | Location scope |
| ledger_id | integer FK→account_ledgers | Auto-created as `CUST-{id}` |

#### `vendors`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | |
| phone, email | text | |
| gst_number | text | |
| ledger_id | integer FK→account_ledgers | Auto-created as `VEND-{id}` |

#### `coupons`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| code | text UNIQUE NOT NULL | |
| discount_type | text | `percentage` / `fixed` |
| discount_value | numeric | |
| min_order_value | numeric | |
| max_discount | numeric | Cap for percentage coupons |
| valid_from, valid_to | text | Date range |
| is_active | boolean | |

#### `account_ledgers` (Chart of Accounts)
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text NOT NULL | Display name |
| type | text | `asset`/`liability`/`income`/`expense`/`equity` |
| code | text UNIQUE | System codes: `SYS-*`, `STD-*`, `CUST-{id}`, `VEND-{id}`, etc. |
| parent_id | integer self-FK | Hierarchical groups |
| section | text | `balance_sheet` / `profit_loss` |
| is_system_group | boolean | Protected from deletion/rename |
| is_group | boolean | Container node (no direct transactions) |
| description | text | |
| bank_details | jsonb | For bank ledgers |

**System group codes:**

| Code | Name | Type |
|---|---|---|
| SYS-CAP | Capital Accounts | equity |
| SYS-LOAN | Loans (Liability) | liability |
| SYS-CURL | Current Liabilities | liability |
| SYS-FIXD | Fixed Asset | asset |
| SYS-CURA | Current Asset | asset |
| SYS-PUR | Purchase | expense |
| SYS-DIREXP | Direct Expense | expense |
| SYS-INDEXP | Indirect Expense | expense |
| SYS-SAL | Sales | income |
| SYS-DEBTORS | Sundry Debtors | asset |
| SYS-CREDITORS | Sundry Creditors | liability |
| STD-SALES | Sales | income |
| STD-PUR | Purchases | expense |
| STD-BANK | Bank | asset |
| STD-CASH | Cash | asset |
| STD-DTX | Duty & Tax | liability |
| STD-OUT-CGST/SGST/IGST | Output GST | liability |
| STD-INP-CGST/SGST/IGST | Input GST (ITC) | asset |
| STD-ELEC-CLR | Electronic Payment Clearing | asset |
| STD-CIT | Cash in Transit | asset |
| STD-PROC-CHG | Bank & Processor Charges | expense |

#### `payments`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| voucher_number | text | Format: `PAY/FY/NNNN` |
| payment_date | text | |
| paid_from_ledger_id | integer FK→account_ledgers | Debit |
| paid_to_ledger_id | integer FK→account_ledgers | Credit |
| amount | numeric(12,2) | |
| narration | text | |

#### `receipts`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| voucher_number | text | Format: `REC/FY/NNNN` |
| receipt_date | text | |
| received_from_ledger_id | integer FK→account_ledgers | |
| received_in_ledger_id | integer FK→account_ledgers | |
| amount | numeric(12,2) | |
| narration | text | |

#### `journal_vouchers`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| voucher_number | text | JV/CTR/CN/DN prefix |
| voucher_type | text | `journal`/`contra`/`credit_note`/`debit_note` |
| voucher_date | text | |
| narration | text | |

#### `journal_voucher_lines`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| voucher_id | integer FK→journal_vouchers.id | |
| ledger_id | integer FK→account_ledgers.id | |
| debit | numeric(12,2) DEFAULT 0 | |
| credit | numeric(12,2) DEFAULT 0 | |
| narration | text | |

#### `voucher_sequences`
| Column | Type | Notes |
|---|---|---|
| prefix | text PK | `PAY`/`REC`/`JV`/`CTR`/`CN`/`DN`/`SR`/`PR` |
| fy_label | text PK | e.g. `2026-27` |
| last_number | integer | Auto-incremented with `ON CONFLICT DO UPDATE` |

#### `reconciliation_batches`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| batch_reference | text | |
| settlement_date | text | |
| gross_amount | numeric(12,2) | |
| charges | numeric(12,2) | |
| net_amount | numeric(12,2) | |
| destination_bank_ledger_id | integer FK→account_ledgers | |
| status | text DEFAULT `'active'` | |

#### `reconciliation_batch_items`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| batch_id | integer FK→reconciliation_batches.id | |
| sale_payment_id | integer FK→sale_payments.id UNIQUE | |
| amount | numeric(12,2) | |

#### `cash_deposits`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| outlet_id | integer | Nullable |
| warehouse_id | integer | Nullable |
| source_cash_ledger_id | integer FK→account_ledgers | |
| amount | numeric(12,2) | |
| deposit_date | text | |
| status | text DEFAULT `'pending_reconciliation'` | |
| transit_payment_id | integer FK→payments.id | Cash in Transit JV |
| bank_receipt_id | integer FK→receipts.id | Final bank receipt |

#### `expenses`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| expense_date | text | |
| description | text | |
| amount | numeric(12,2) | |
| ledger_account_id | integer FK→account_ledgers | Expense category |
| outlet_id | integer | Nullable |
| warehouse_id | integer | Nullable |
| payment_method | text | |

#### `hr_leave`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| employee_id | integer FK→employees.id | |
| leave_type | text | |
| start_date, end_date | text | |
| status | text | `pending`/`approved`/`rejected` |
| approved_by | text | |

#### `hr_attendance`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| employee_id | integer FK→employees.id | |
| date | text | |
| check_in, check_out | timestamptz | |
| lat, lng | numeric | Geo-tagged location |
| status | text | `present`/`absent`/`half_day` |

#### `hr_payroll`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| employee_id | integer FK→employees.id | |
| month | text | `YYYY-MM` |
| base_salary | numeric(12,2) | |
| lop_days | numeric | Loss of Pay days |
| lop_deduction | numeric(12,2) | |
| allowances | jsonb | `[{name, type, value, computed}]` |
| deductions | jsonb | |
| gross | numeric(12,2) | |
| net_pay | numeric(12,2) | |

#### `audit_log`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| employee_id | integer | |
| action | text | |
| entity_type | text | |
| entity_id | integer | |
| details | jsonb | Before/after snapshot |
| created_at | timestamptz | |

#### `login_attempts`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| username | text | |
| ip | text | |
| success | boolean | |
| created_at | timestamptz | |

#### `company_settings`
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | text | Company display name |
| gstin | text | |
| address | text | |
| fy_start_month | integer DEFAULT 4 | Financial year start (April = 4) |
| production_overhead_percent | numeric(5,2) DEFAULT 0 | Applied to new production batches |

#### `migration_log`
| Column | Type | Notes |
|---|---|---|
| name | text PK | Migration identifier |
| applied_at | timestamptz | |

---

## 7. API Reference

### 7.1 Authentication

| Method | Path | Guard | Purpose |
|---|---|---|---|
| POST | `/auth/login` | None | Login; returns token + employee |
| POST | `/auth/logout` | requireAuth | Clears session (client-side) |
| POST | `/auth/change-password` | requireAuth | Change password, clears mustChangePassword |
| GET | `/auth/me` | requireAuth | Current employee profile |

### 7.2 Dashboard

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/dashboard/summary` | requireAuth | KPIs: cash, bank, total sales, stock value |
| GET | `/dashboard/sales-trend` | requireAuth | Daily revenue grouped by date |
| GET | `/dashboard/top-items` | requireAuth | Best-selling items by revenue |
| GET | `/dashboard/sales-by-location` | requireAuth | Revenue breakdown by warehouse/outlet |
| GET | `/dashboard/stock-alerts` | requireAuth | Items below reorder level |
| GET | `/dashboard/recent-activity` | requireAuth | Audit feed |

### 7.3 Inventory / Branches

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET/POST | `/materials` | requireAuth / add | List/create packaging materials |
| GET/PATCH/DELETE | `/materials/:id` | requireAuth / edit/delete | Update/delete material |
| GET/POST | `/raw-materials` | requireAuth / add | List/create raw materials |
| GET/PATCH/DELETE | `/raw-materials/:id` | requireAuth / edit/delete | |
| GET/POST | `/items` | requireAuth / add | List/create finished goods |
| GET/PATCH/DELETE | `/items/:id` | requireAuth / edit/delete | |
| GET/POST | `/warehouses` | requireAuth / add | |
| GET/PATCH/DELETE | `/warehouses/:id` | requireAuth / edit/delete | |
| GET/POST | `/outlets` | requireAuth / add | |
| GET/PATCH/DELETE | `/outlets/:id` | requireAuth / edit/delete | |
| GET | `/stock` | requireAuth | Stock entries (scoped by branch) |
| GET/POST | `/item-prices` | requireAuth / add | Location-specific pricing |
| DELETE | `/item-prices/:id` | requireAuth / delete | |
| GET | `/stock-entries` | requireAuth | Raw stock entry rows |

### 7.4 Purchases

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/purchases` | requireAuth | List all purchase bills |
| POST | `/purchases` | add("Purchases") | Record purchase, update stock + WAC |
| PATCH | `/purchases/:id` | edit("Purchases") | Update bill |
| DELETE | `/purchases/:id` | delete("Purchases") | Delete bill, reverse stock |
| GET | `/purchases/:id` | requireAuth | Purchase details |

### 7.5 Production

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/production` | requireAuth | List production batches |
| POST | `/production` | add("Production") | Create batch, deduct materials, add item stock |
| PATCH | `/production/:id` | edit("Production") | Update batch |
| DELETE | `/production/:id` | delete("Production") | Delete batch, reverse stock |
| GET | `/production/reports` | requireAuth | Aggregated production analytics |
| GET/POST | `/bom` | requireAuth / add | BOM templates |
| PATCH/DELETE | `/bom/:id` | edit/delete | |

### 7.6 Inventory Batches & Stock Transfers

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/inventory-batches` | requireAuth | FEFO batch list (filtered by location/item) |
| GET | `/stock/transfers` | requireAuth | Transfer list (scoped by branch) |
| POST | `/stock/transfers` | add("HO Transfers") | Initiate transfer; deducts from source |
| GET | `/stock/transfers/:id` | requireAuth | Transfer details |
| PATCH | `/stock/transfers/:id/approve` | edit("HO Transfers") | Approve; adds to destination stock; creates JVs |
| PATCH | `/stock/transfers/:id/reject` | edit("HO Transfers") | Reject; restores source stock |
| GET | `/stock/transfers/:id/challan` | requireAuth | Delivery challan PDF |

### 7.7 Sales

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/sales` | requireAuth (scoped) | Paginated invoice list |
| POST | `/sales` | add("Sales","Point of Sale") | Create sale; deduct stock (FEFO); post accounting |
| PUT | `/sales/:id` | edit("Sales","Point of Sale") | Edit invoice; reverse + reapply |
| DELETE | `/sales/:id` | delete("Sales","Point of Sale") | Cancel; restore stock; reverse accounting |
| GET | `/sales/:id` | requireAuth | Invoice details |
| GET | `/sales/:id/pdf` | requireAuth | Generate invoice PDF |
| GET | `/outstanding/receivables` | requireAuth | Unpaid/partial sales |
| GET | `/outstanding/collections` | requireAuth | Recent payments received |
| GET | `/outstanding/payables` | requireAuth | Vendor outstanding |
| POST | `/sale-payments/:saleId` | requireAuth | Record payment against credit sale |
| GET | `/sale-payments/:saleId` | requireAuth | Payment history for a sale |

### 7.8 Sales Returns

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/sales-returns` | requireAuth | List returns |
| POST | `/sales-returns` | add("Sales") | Create return; restore stock; refund |
| GET | `/sales-returns/:id` | requireAuth | Return details |

### 7.9 Customers & Vendors

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET/POST | `/customers` | requireAuth / add("Sales") | |
| PATCH/DELETE | `/customers/:id` | edit/delete("Sales") | |
| GET/POST | `/vendors` | requireAuth / add | |
| PATCH/DELETE | `/vendors/:id` | edit/delete | |
| GET/POST | `/coupons` | requireAuth / add | |
| PATCH/DELETE | `/coupons/:id` | edit/delete | |

### 7.10 Accounts

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/accounts/chart` | requireAuth | Full COA tree |
| POST | `/accounts/chart` | add("Chart of Accounts") | Create ledger or group |
| PATCH | `/accounts/chart/:id` | edit("Chart of Accounts") | Rename ledger |
| DELETE | `/accounts/chart/:id` | delete("Chart of Accounts") | Delete (blocked if system group or has transactions) |
| GET | `/accounts/ledger-statement` | requireAuth | Running-balance ledger report |
| GET | `/accounts/payments` | requireAuth | List payments |
| POST | `/accounts/payments` | add("Payments") | Payment voucher |
| GET | `/accounts/receipts` | requireAuth | List receipts |
| POST | `/accounts/receipts` | add("Payments") | Receipt voucher |
| GET | `/expenses` | requireAuth | Location-scoped expenses |
| POST | `/expenses` | add("Location Expenses") | Record expense |
| DELETE | `/expenses/:id` | delete("Location Expenses") | |
| GET | `/accounts/trial-balance` | requireAuth | Trial balance |
| GET | `/accounts/books/day` | requireAuth | Day Book |
| GET | `/accounts/books/cash` | requireAuth | Cash Book |
| GET | `/accounts/books/bank` | requireAuth | Bank Book |

### 7.11 Journal Vouchers

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET/POST | `/accounts/journal` | requireAuth / add("Vouchers") | Journal vouchers |
| GET/POST | `/accounts/contra` | requireAuth / add("Vouchers") | Contra vouchers |
| GET/POST | `/accounts/notes` | requireAuth / add("Vouchers") | Credit/debit notes |
| DELETE | `/accounts/journal/:id` | delete("Vouchers") | |

### 7.12 GST

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/gst/summary` | requireAuth | Monthly GST summary (date-filtered) |
| GET | `/gst/hsn-summary` | requireAuth | HSN-wise tax breakdown |
| GET | `/gst/gstr1` | requireAuth | GSTR-1 data (B2B + B2C) |
| GET | `/gst/gstr3b` | requireAuth | GSTR-3B monthly summary |
| GET | `/gst/reconciliation` | requireAuth | Sales/purchase vs COA reconciliation |

### 7.13 Payments & Reconciliation

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/reconciliation/pending` | requireAuth | Unreconciled UPI/card payments |
| POST | `/reconciliation/batches` | requireAuth | Create settlement batch |
| GET | `/reconciliation/batches` | requireAuth | List settlement batches |
| POST | `/cash-deposits` | requireAuth | Record cash deposit |
| GET | `/cash-deposits` | requireAuth | List deposits |

### 7.14 HR

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET/POST | `/hr/employees` | requireAuth / add("Employees") | |
| PATCH/DELETE | `/hr/employees/:id` | edit/delete("Employees") | |
| GET/POST | `/hr/hierarchies` | requireAuth / add("Hierarchy") | |
| PATCH/DELETE | `/hr/hierarchies/:id` | edit/delete | |
| POST | `/hr/attendance/check-in` | requireAuth | Geo-tagged check-in |
| POST | `/hr/attendance/check-out` | requireAuth | Check-out |
| GET | `/hr/attendance` | requireAuth | Attendance list (date/employee scoped) |
| GET/POST | `/hr/leave` | requireAuth / add("Leave") | |
| PATCH | `/hr/leave/:id/approve` | edit("Leave") | Approve/reject leave |
| POST | `/hr/payroll/generate` | add("Payroll") | Generate monthly payslips |
| GET | `/hr/payroll` | requireAuth | Payroll list |
| GET | `/hr/payroll/:id/pdf` | requireAuth | Payslip PDF |

### 7.15 Company & Permissions

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET/PATCH | `/company/settings` | requireAuth / edit("Settings") | Company name, GSTIN, FY start |
| GET | `/company/permissions` | requireAuth | All permission rows |
| POST | `/company/permissions` | add("Permissions") | Set/upsert permission row |
| GET | `/audit/log` | requireAuth | Audit trail |
| GET | `/company/login-history` | requireAuth | Login attempt history |

### 7.16 Reports, PDF, Search

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/reports/sales` | requireAuth | Sales summary (date/location filtered) |
| GET | `/reports/stock` | requireAuth | Stock level report |
| GET | `/reports/production` | requireAuth | Production summary |
| GET | `/reports/purchase` | requireAuth | Purchase summary |
| GET | `/pdf/invoice/:id` | requireAuth | Invoice PDF (authenticated) |
| GET | `/public/invoices/:token.pdf` | None | Shared invoice (HMAC token) |
| GET | `/search/quick` | requireAuth | Cross-entity quick search |
| GET | `/accounts/location-expenses/all` | requireAuth | All location expenses (HO view) |
| GET | `/accounts/cash-in-outlet` | requireAuth | Cash balance per outlet |

---

## 8. Frontend Architecture

### 8.1 Application Entry Point

`App.tsx` wraps the entire app in:
```
QueryClientProvider       ← TanStack Query cache
TooltipProvider           ← Radix tooltips
LocationProvider          ← Branch location state
WouterRouter              ← SPA routing (base = import.meta.env.BASE_URL)
Toaster                   ← Sonner toast notifications
```

**AuthGuard** — applied to every protected route:
- Reads `marlin_auth_token` from localStorage; redirects to `/login` if absent
- Reads `marlin_user.mustChangePassword`; redirects to `/change-password` if true
- `allowMustChange` prop used only for `/change-password` itself

### 8.2 Routing Table

| Route | Component | Notes |
|---|---|---|
| `/login` | Login | Unauthenticated |
| `/change-password` | ChangePassword | allowMustChange=true |
| `/` | Dashboard | Main KPI dashboard |
| `/dashboard` | Dashboard | Alias |
| `/sales` | LocationPicker | Context picker for HO users |
| `/sales/dashboard` | SalesDashboard | Branch sales KPIs |
| `/sales/pos` | SalesPOS | Point of Sale |
| `/sales/stock` | SalesStock | Branch stock view |
| `/sales/expenses` | SalesExpenses | Branch expense recording |
| `/sales/cash-balance` | SalesCashBalance | Branch cash summary |
| `/transfers` | Transfers | Unified transfer management |
| `/production/units` | Units | Unit of measure master |
| `/production/items` | Items | Legacy item list |
| `/production/item-master` | ItemMaster | Full item management |
| `/production/purchase` | Purchases | Purchase orders |
| `/production/production` | ProductionList | Batch management |
| `/production/reports` | ProductionReports | Production analytics |
| `/headoffice/stock` | Stock | HO stock overview |
| `/headoffice/stock-ledger` | StockLedger | Movement history |
| `/headoffice/inventory-reports` | InventoryReports | Inventory analytics |
| `/headoffice/stock-verification` | StockVerification | Physical count |
| `/headoffice/warehouses` | Warehouses | Warehouse master |
| `/headoffice/outlets` | Outlets | Outlet master |
| `/headoffice/item-price` | ItemPrices | Location-specific pricing |
| `/headoffice/sales` | Sales | HO sales management |
| `/hr/hierarchy` | Hierarchy | Role hierarchy |
| `/hr/employees` | Employees | Employee management |
| `/hr/payroll` | Payroll | Payroll management |
| `/hr/attendance` | Attendance | Daily attendance |
| `/hr/leave` | Leave | Leave management |
| `/customers` | Customers | Customer master |
| `/vendors` | Vendors | Vendor master |
| `/coupons` | Coupons | Coupon management |
| `/returns` | Returns | Sales returns |
| `/outstanding` | Outstanding | Receivables/payables |
| `/accounts/chart` | ChartOfAccounts | COA tree |
| `/accounts/ledger` | Ledger | Ledger statement |
| `/accounts/payments` | Payment | Payment vouchers |
| `/accounts/receipts` | ReceiptPage | Receipt vouchers |
| `/accounts/cash-bank` | CashBank | Cash & bank accounts |
| `/accounts/expenses` | Expenses | HO expense view |
| `/accounts/journal` | Journal | Journal entries |
| `/accounts/contra` | Contra | Contra vouchers |
| `/accounts/notes` | Notes | Credit/debit notes |
| `/accounts/day-book` | DayBook | Day book |
| `/accounts/cash-book` | CashBankBook (cash) | Cash book |
| `/accounts/bank-book` | CashBankBook (bank) | Bank book |
| `/accounts/trial-balance` | TrialBalance | Trial balance |
| `/accounts/gst` | GstSummary | GST summary |
| `/accounts/gst-returns` | GstReturns | GSTR-1 / GSTR-3B |
| `/accounts/reconciliation` | Reconciliation | Payment reconciliation |
| `/accounts/cash-in-outlet` | CashInOutlet | HO cash view |
| `/reports/:cat` | ReportsCenter | Multi-tab report centre |
| `/company/settings` | CompanySettings | Company profile |
| `/company/permissions` | Permissions | RBAC management |
| `/company/profile` | Profile | Company profile |
| `/company/audit` | AuditLog | Audit trail |
| `/company/login-history` | LoginHistory | Login history |
| `/profile/me` | ProfileMe | Personal profile |

Legacy redirect routes:
- `/production/stock-transfer` → `/transfers`
- `/headoffice/transfers` → `/transfers`
- `/accounts/reports` → `/reports/sales`
- `/reports` → `/reports/sales`

### 8.3 AppLayout — Unified Sidebar

`AppLayout.tsx` renders the shell (sidebar + topbar) wrapping every authenticated page.

**Sidebar structure:**
```
┌─────────────────────────────┐
│  [Logo]          [Collapse] │  ← Logo row (16px border-b)
├─────────────────────────────┤
│  📍 Selling from: X [change]│  ← Location indicator (when locationId ≠ null)
│                             │
│  [Dashboard]                │  ← Standalone leaf (from _standaloneNavItems)
│  [My Profile]               │  ← Always visible, no permission
│                             │
│  ▼ Operations               │  ← Collapsible group
│     Point of Sale           │
│     Stock                   │
│     Transfers               │
│     Expenses                │
│     Cash Balance            │
│                             │
│  ▶ Production               │
│  ▶ Inventory                │
│  ▶ Sales (HO)               │
│  ▶ HR                       │
│  ▶ Accounts                 │
│  ▶ Company                  │
└─────────────────────────────┘
```

**Permission filtering:**
```typescript
const filteredNavigation = navigation
  .filter(item => isAdmin || canViewModule(item.module, ...))   // remove invisible items
  .map(item => ({ ...item, children: item.children.filter(...) }))  // filter children
  .filter(item => !item.children || item.children.length > 0);  // remove empty groups
```

**Branch employee auto-set:**
```typescript
useEffect(() => {
  if (!isLocationEmployee || !userBranchId) return;
  setLocContext({ locationType: userBranchType, locationId: userBranchId, ... });
}, [user?.id, userBranchType, userBranchId]);
```

**Collapsed mode:** All items show as icon-only with Tooltip on hover.

### 8.4 Key Frontend Libraries

| Library | Usage |
|---|---|
| shadcn/ui | All UI primitives (Dialog, Table, Badge, Checkbox, etc.) |
| Radix UI | Tooltip, DropdownMenu, Dialog, Collapsible (via shadcn) |
| Tailwind CSS | All styling |
| Lucide React | All icons |
| Recharts | Dashboard charts |
| react-hook-form | All forms |
| Zod | Client-side form validation |
| Sonner | Toast notifications |
| date-fns | Date formatting |
| pdfkit (via server) | PDF generation |

---

## 9. Navigation & Module Registry

### 9.1 Module Registry (`lib/moduleRegistry.ts`)

The single source of truth for:
- Which modules exist (permission keys)
- Which sidebar group they belong to
- What nav links they produce
- How the Permissions page is organized

Key types:
```typescript
interface ModuleDef {
  key: string;           // Permission key — matches DB permissions.module
  permGroup: string;     // Permissions page group
  navGroup: string;      // Sidebar section ('Operations', '__standalone__', etc.)
  navEntries: NavEntry[];// One or more sidebar links
  icon?: LucideIcon;     // Icon for standalone/Operations items
}
```

### 9.2 Sidebar Sections

| Section | Modules | Notes |
|---|---|---|
| _(standalone)_ | Dashboard | Top-level, above all groups |
| Operations | Point of Sale, Location Stock, HO Transfers, Location Expenses, Cash Balance | Branch-facing |
| Production | Units, Items, Production, Purchases | |
| Inventory | Stock, Stock Ledger, Inventory Reports, Stock Verification, Warehouses, Outlets, Item Prices, HO Transfers | Transfers appears here AND in Operations |
| Sales (HO) | Sales, Customers, Vendors, Coupons | HO-facing |
| HR | Employees, Attendance, Leave, Payroll, Hierarchy | |
| Accounts | Chart of Accounts, Ledger, Payments, Cash & Bank, Vouchers, Books, Expenses, GST Summary, GST Returns, Reconciliation, Accounts Cash Balance, Reports | |
| Company | Settings, Permissions, Login History | |

### 9.3 Key Exports

| Export | Purpose |
|---|---|
| `MODULE_REGISTRY` | Complete module list |
| `NAV_GROUP_ORDER` | Sidebar section display order |
| `PERM_GROUP_ORDER` | Permissions page group order |
| `getNavGroups()` | Builds sidebar nav items |
| `getPermissionGroups()` | Builds Permissions page groups |
| `ALL_MODULE_KEYS` | All permission key strings |

---

## 10. Permission System (End-to-End)

```
┌─────────────────┐    ┌────────────────────┐    ┌─────────────────────┐
│  Permissions    │    │  usePermission()   │    │  requireModuleAction│
│  Page (UI)      │    │  (frontend hook)   │    │  (backend middleware)│
│                 │    │                    │    │                     │
│  Admin sets     │    │  resolvePermissions│    │  Same logic:        │
│  canView/Add/   │───▶│  - level 1 → full │───▶│  - level 1 → pass  │
│  Edit/Delete    │    │  - no row → view  │    │  - no row → allow  │
│  per module     │    │    only default   │    │  - row false → 403 │
│  per hierarchy  │    │  - row → exact    │    │                     │
└─────────────────┘    └────────────────────┘    └─────────────────────┘
         │                      │                          │
         └──────────────────────┴──────────────────────────┘
                         PostgreSQL
                         permissions table
                    (hierarchy_id, module, can_*)
```

**Sidebar generation:**

1. `getNavGroups()` returns all groups/children from MODULE_REGISTRY
2. `filteredNavigation` filters by `canViewModule()` per user's hierarchy + permissions
3. Groups with zero visible children are hidden entirely
4. No hardcoded branch-type conditions in sidebar logic

**Page protection:**

Pages rely on `usePermission(moduleKey)` and conditionally show/hide action buttons:
```typescript
const perm = usePermission('Sales');
if (!perm.isLoading && !perm.canView) return <AccessDenied />;
// ...
{perm.canAdd && <Button onClick={...}>New Sale</Button>}
{perm.canDelete && <Button onClick={...}>Delete</Button>}
```

**API enforcement:**

Every write operation is wrapped in `requireModuleAction(key, 'add'|'edit'|'delete')`. Read endpoints are currently unguarded at the permission level (all authenticated employees can read); data scope (branch filtering) is the primary read-side control.

---

## 11. Shared Libraries

### 11.1 `lib/api-client-react`

Generated by Orval from the OpenAPI spec. Each entity has:
- `useList*()` — GET list query
- `useGet*()` — GET single item query
- `useCreate*()` / mutation hooks — POST/PATCH/DELETE mutations

Hand-written custom hooks supplement the generated ones for complex endpoints:

| File | Hooks |
|---|---|
| analytics.ts | Sales trend, top items, by-location analytics |
| bom.ts | `useListBom`, `useUpsertBom` |
| gst.ts | `useGstSummary`, `useGstr1`, `useGstr3b`, `useHsnSummary` |
| inventory-batches.ts | `useListInventoryBatches` |
| journal.ts | `useListJournal`, `useCreateJournalVoucher`, etc. |
| location-expenses.ts | `useListLocationExpenses`, `useCreateLocationExpense` |
| payroll.ts | `useListPayroll`, `useGeneratePayroll` |
| production.ts | `useListProductions`, `useCreateProduction` |
| production-reports.ts | `useProductionReports` |
| quick-search.ts | `useQuickSearch` (Cmd+K global search) |
| reports.ts | Report centre hooks |
| returns.ts | `useListReturns`, `useCreateReturn` |
| stock-ledger.ts | `useStockLedger` |
| transfers.ts | `useListTransfers`, `useCreateTransfer`, `useApproveTransfer` |
| vouchers.ts | `useListVouchers`, `useDeleteVoucher` |
| payments-reconciliation.ts | Reconciliation batch hooks |
| paginated-lists.ts | Generic cursor-based pagination hook |
| login-history.ts | `useLoginHistory` |
| audit.ts | `useAuditLog` |

### 11.2 `lib/api-client-react/src/custom-fetch.ts`

Authenticated fetch wrapper:
```typescript
customFetch(url, options?)
  → reads token from tokenGetter (localStorage)
  → adds Authorization: Bearer <token>
  → reads x-refreshed-token response header → calls tokenSetter to update stored token
  → throws on non-2xx responses
```

Configuration:
```typescript
setBaseUrl(url)           // Set API base URL
setAuthTokenGetter(fn)    // How to read the stored token
setAuthTokenSetter(fn)    // How to persist a new token
```

### 11.3 Backend Lib Helpers

| File | Purpose |
|---|---|
| `gst.ts` | `lineTaxHeads(rate, taxableValue, isInterState)` — computes {cgst, sgst, igst, total}; `validateGstRate(rate)` — enforces valid slabs (0/5/12/18/28) |
| `gstTransfer.ts` | `classifyTransfer(fromGstin, toGstin)` → `'internal'/'intrastate'/'interstate'`; creates dispatch + receive JVs for interstate/intrastate transfers |
| `batches.ts` | `consumeBatchesFEFO(pool, location, itemId, qty)` — deducts from stock_batches in expiry-date order; returns `{batches: [{batchNumber, qty, costPerUnit}], untracked: remainingQty}` |
| `stockLedger.ts` | `appendStockLedger(pool, entry)` — appends to stock_ledger; `getRunningBalance(pool, location, itemId)` — uses window function for current balance |
| `voucherNumber.ts` | `nextVoucherNumber(pool, prefix, fyStartMonth)` — atomic increment via `ON CONFLICT DO UPDATE`; format: `{PREFIX}/{FY}/{NNNN}` |
| `token.ts` | `TokenService.sign(payload)`, `TokenService.verify(token)` — HMAC-SHA256 v2 scheme |
| `password.ts` | `PasswordService.hash(pw)`, `PasswordService.verify(pw, hash)` — bcrypt wrapper |
| `passwordPolicy.ts` | `DEFAULT_INITIAL_PASSWORD = 'marlin1458'`; complexity rules |
| `shareToken.ts` | `createShareToken(saleId)`, `verifyShareToken(token)` — HMAC tokens for public invoice links |
| `dataScope.ts` | `getUserDataScope(employee)` — returns `DataScope` for query scoping |
| `audit.ts` | `logAudit(pool, employeeId, action, entityType, entityId, details)` |

---

## 12. Data Flow

```
Browser
  │
  ├─ customFetch (lib/api-client-react)
  │    → adds Bearer token
  │    → reads x-refreshed-token → updates stored token
  │
  ▼
Express app (artifacts/api-server)
  │
  ├─ cors + pino-http + express.json
  ├─ requireAuth → attaches req.employee
  ├─ Route handler
  │    ├─ requireModuleAction (write routes)
  │    ├─ getUserDataScope (read routes, scoped)
  │    ├─ Business logic (GST calc, FEFO, WAC, voucher numbers)
  │    ├─ pg pool queries (raw SQL + Drizzle ORM)
  │    └─ Accounting postings (payments/receipts/JVs auto-created)
  │
  ▼
PostgreSQL
  │
  ▼
Response JSON
  │
  ▼
TanStack Query cache
  │
  ▼
React components (re-render with fresh data)
```

---

## 13. PDF Generation

All PDFs are rendered server-side using **pdfkit**.

| Service | Output | Notes |
|---|---|---|
| `invoicePdf.ts` | A4 GST Tax Invoice | Brand header, line items, GST table (CGST/SGST/IGST), amount-in-words, UPI QR code |
| `challanPdf.ts` | Delivery Challan | FROM/TO box, item list, no prices |
| `reportPdf.ts` | Generic table report | Portrait/landscape, zebra rows, navy total rows |
| `payslipPdf.ts` | Employee payslip | Earnings/deductions table, LOP detail, net pay |

**Public invoice sharing:** `GET /public/invoices/{token}.pdf` uses HMAC-signed tokens (`shareToken.ts`) to allow unauthenticated access to a specific invoice. Tokens are not time-limited but are keyed to the sale ID.

---

## 14. Current Limitations & Technical Debt

### Schema & Data

| Issue | Impact |
|---|---|
| Schema lives in `index.ts` startup migrations, not Drizzle migration files | Hard to audit schema history; every boot re-runs idempotent DDL |
| `startup-migration` columns invisible to Drizzle's typed queries | `db.select()` silently drops them; must use raw SQL for valid_from/valid_to, wastage_qty, etc. |
| `sales.outlet_id` is legacy (nullable after migration) | `location_type` + `location_id` are canonical; old code still references `outlet_id` in some places |
| No database foreign key constraints in Drizzle schema | Referential integrity enforced in application layer only |
| `date` columns return JS `Date` objects from pg driver | Comparing to `YYYY-MM-DD` strings causes silent mismatches |

### RBAC

| Issue | Impact |
|---|---|
| No row in permissions = default allow | Missing permission rows silently grant view access |
| Roles are fused with branch hierarchy | Cannot give a warehouse employee cross-branch access without schema changes |
| GET endpoints unguarded by permission level | Any authenticated user can read all data (scoped by branch only) |

### Frontend

| Issue | Impact |
|---|---|
| Operations pages (POS, Stock, Expenses) show blank for HO users without a location set | No inline prompt — just empty UI |
| `Sales Dashboard` (`/sales/dashboard`) is accessible but no longer in the nav | Orphaned page |
| `SalesTransfers.tsx` file still exists in the pages directory | Dead code (route redirects to `/transfers`) |
| TypeScript `any` casts in AppLayout for permission filtering | Type safety gaps |

### Business Logic

| Issue | Impact |
|---|---|
| Credit notes and debit notes do not reduce GST returns | Over-reporting of output tax |
| Dashboard sales totals do not include warehouse direct sales in all chart queries | Understated totals |
| No expiry alert system | Stock nearing expiry is only visible in reports, not proactively flagged |
| BOM over-consumption not warned | Production can exceed BOM quantities silently |
| Opening balances not supported | Books cannot be initialised from existing accounts |

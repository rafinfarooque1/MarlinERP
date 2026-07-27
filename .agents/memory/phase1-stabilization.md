---
name: Phase 1 stabilization changes
description: Key architectural decisions and constraints applied during Phase 1 ERP Foundation Stabilization
---

## Default-deny permissions (LIVE)

**Rule:** Missing permissions row = DENIED (was default-allow before). Only an explicit `can_view=true` row grants access.

**Why:** The architecture review flagged default-allow as a security hole — new hierarchies should be denied until explicitly granted.

**How to apply:**
- Seeding migration in `index.ts` inserts all-true rows for ALL existing non-level-1 hierarchies × all 40 modules at startup. This preserves existing access.
- New hierarchies created after the migration start denied until an admin sets permissions.
- The frontend `usePermission.ts` and backend `permissions.ts` now agree on default-deny.

## Token expiry (LIVE)

**Rule:** v2 session tokens expire after 8 hours. Controlled by `TOKEN_MAX_AGE_HOURS` env var.

**Why:** Tokens had no expiry — a stolen token was valid forever.

**How to apply:** `verifyToken()` in `lib/token.ts` now rejects tokens older than `TOKEN_MAX_AGE_HOURS * 3600 * 1000` ms. The payload already contains `issuedAt` (3rd segment). Tokens without a valid timestamp are rejected.

## Payroll COA posting

**Rule:** When payroll is marked paid (`POST /hr/payroll/:id/pay`), a journal voucher is auto-created: Dr STD-SALARY-EXP / Cr STD-CASH.

**Why:** Salary payments must appear in the books as an expense.

**How to apply:** The Salary Expense ledger is auto-provisioned with code `STD-SALARY-EXP` under `STD-INDIRECT-EXP` if it doesn't exist. Journal entry failure is non-fatal (payroll stays marked paid; accountant notified via console warn).

## Opening balances table

**Schema:** `opening_balances` table with `UNIQUE(ledger_id, financial_year)` constraint.

**API:** GET/POST/DELETE at `/accounts/opening-balances` guarded by `Chart of Accounts` module permission.

**Why:** Needed for Trial Balance and P&L to be accurate from day one of ERP use.

## Credit limit enforced on sale edit

**Rule:** `PUT /sales/:id` now runs the same credit-limit check as `POST /sales`. Override requires `can_edit=true` on the Sales module.

**Why:** Editing a sale to a higher amount was bypassing the credit limit guard.

## requireModuleView guards added to GETs

**Endpoints now guarded (weren't before):**
- `/accounts/payments` & `/accounts/receipts` → Payments
- `/accounts/ledger-statement` → Ledger
- `/accounts/cash-bank` → Cash & Bank
- `/gst/summary` → GST Summary or GST Returns
- `/accounts/day-book` → Books
- `/accounts/cash-bank-book` & `/accounts/cash-bank-book/ledgers` → Cash & Bank
- `/accounts/trial-balance` → Books
- `/hr/employees` & `/hr/employees/:id` → Employees
- `/hr/payroll` → Payroll
- `/hr/leaves` → Leave

## Negative stock prevention

A CHECK constraint `chk_stock_non_negative CHECK (quantity >= -0.001)` is added to `stock_entries` at startup. Tolerates floating-point errors; blocks real negatives at DB level.

## AuditAction type extended

`lib/audit.ts` AuditAction union now includes `"PERMISSION_DENIED"`. Permission failures are logged to the activity_log table with action=PERMISSION_DENIED.

## CORS and body limits

- `ALLOWED_ORIGINS` env var (comma-separated) locks CORS in production; defaults to open in development.
- `express.json({ limit: '1mb' })` prevents memory exhaustion via large payloads.
- Global error handler in `app.ts` returns standard JSON error format for CORS, 413, malformed JSON, and unhandled errors.

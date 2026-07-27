---
name: RBAC & branch scoping
description: Branch type system, sidebar visibility rules, permission semantics, and branch data scoping — includes the 2026-07 'production' branch-type retirement.
---

**Rule:** The ERP has exactly THREE branch types: `headoffice`, `warehouse`, `outlet`. There is no `production` branch type — Production is a department of Head Office, gated by permission, not by branch.

**Branch type values stored in DB and sent in auth session:**
- `'headoffice'` — Head Office employees (including Production staff)
- `'warehouse'` — Warehouse employees
- `'outlet'` — Outlet/POS employees

**Sidebar visibility (moduleRegistry.ts `branchGroups`):**
- `['headoffice']` — visible to HO employees only (e.g. Production, HR, Accounts)
- `['headoffice', 'warehouse']` — visible to HO + warehouse (e.g. Inventory, Sales HO)
- omitted (undefined) — visible to all branch types (e.g. Company)
- The AppLayout filter is: `(item.branchGroups as string[]).includes(userBranchType ?? 'headoffice')`
- Legacy `[null]` convention is GONE — replaced with `['headoffice']`

**Why:**
- `null` was the old HQ convention but `branchType` is always a non-null string in session, so `[null].includes('headoffice')` === false → HR/Accounts sidebar was invisble for HO employees (bug).
- Removing production branch type was a business rule: Production is a HO department, not a separate branch.

**How to apply:**
- Any new HO-only module: `branchGroups: ['headoffice']`
- Any HO+warehouse module: `branchGroups: ['headoffice', 'warehouse']`
- Stock for production batches/purchases lives under `branch_type = 'headoffice', branch_id = 1` in DB — a constant pair; do NOT introduce a lookup or a second HO id, it would fork stock.
- Stock transfers page filters `t.fromType === 'headoffice'` for HO→warehouse dispatches

# Retirement details ('production' branch type, 2026-07)
- Startup migration `remove_production_branch_type_v1` (migration_log-guarded, single txn) merged production rows into headoffice across employees/stock_entries/stock_batches/stock_transfers/stock_verifications; `/auth/me` also normalizes any legacy `'production'` session value to `'headoffice'`.
- KEEP: `source: "production"` on batches, audit/activity `module: "production"`, `productions` table, `items.production_stock` counter, Production module & reports category — module refs, not branch types.
- Never reintroduce 'production' in a branch_type/fromType/locationType enum. openapi.yaml + generated api-zod/api-client-react files were hand-edited in lockstep, so regen from spec is safe.
- After editing generated lib sources, rebuild dist (`npx tsc` in lib/api-zod and lib/api-client-react) or consumers typecheck against stale dist .d.ts.

# Backend authorization semantics (verified in api-server/src/middleware/permissions.ts)
- No permission row in `permissions` table → backend ALLOWS (default-allow). Frontend uses level-based defaults instead → UI hides what the API permits.
- Level-1 hierarchy bypasses all checks on both ends (consistent); branchGroups gating still applies to level-1 in the sidebar.
- Most GET endpoints are unguarded (no requireModuleView); only some reports/ledgers/outstanding/login-history GETs are guarded.
- Backend guard keys include stale modules not in the frontend registry: 'Materials', 'Raw Materials', 'Cash & Bank' (DB permissions rows also exist for these + 'Profile').
- 403s from permission middleware are NOT audit-logged.

# Branch data scoping status (as of 2026-07 audit)
- Session (`req.employee`) already carries id/hierarchyId/branchType/branchId — handlers just don't use it.
- List endpoints either return ALL rows or trust client-sent locationId/branchId params (sales, stock, reports); HR/payroll/cash/vouchers/dashboard return company-wide data to any authenticated user.
- Many pages scope client-side after fetching everything (SalesDashboard, SalesTransfers, both Cash Balance pages, all HR pages) — data leaks via devtools.
- Outlet→warehouse mapping exists: `outlets.warehouse_id` — warehouse scope = own warehouse + mapped outlets is derivable.
- Cash Balance is duplicated: two pages (`sales/SalesCashBalance.tsx`, `finance/CashInOutlet.tsx`) + two routes both reading `GET /cash-in-outlet`, which ignores the caller entirely (`(_req, res)`).

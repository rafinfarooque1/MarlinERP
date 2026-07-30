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
- No permission row in `permissions` table → backend DENIES (default-deny, both ends). A missing row is an answer, not a gap; nothing may backfill it at boot.
- Level-1 hierarchy bypasses all checks on both ends (consistent); branchGroups gating still applies to level-1 in the sidebar.
- Most GET endpoints are unguarded (no requireModuleView); only some reports/ledgers/outstanding/login-history GETs are guarded.
- Backend guard keys include stale modules not in the frontend registry: 'Materials', 'Raw Materials', 'Cash & Bank' (DB permissions rows also exist for these + 'Profile').
- 403s from permission middleware are NOT audit-logged.

# Two independent authorization layers

Page permission and location scope are separate gates, and the page gate runs FIRST.

- Page layer denies with **403** (`requireModuleView` / `requireModuleAction`).
- Location layer denies with **404** on reads/records (deliberately indistinguishable from "missing", so ids cannot be enumerated) and **403** on writes that name a foreign location.

**Why it matters for testing:** a fixture role without the page right can never reach the scope code — it 403s first. Every location-scope test must GRANT the page right, otherwise a passing test proves only that the page gate works. This produced a false "scope broken" result once.

**How to apply:** to test scope on module X, give the fixture full rights on `page:X`, then vary only the location.

# Location in a request is a view request, not authority

`locationType` / `locationId` / `outletId` in a body or query say what the caller *wants*, never what they may have. Derive scope from `req.employee` and check the **effective** value.

Two distinct checks are needed on an edit: the stored record must be in scope (or the caller can edit foreign records), AND the incoming destination must be in scope (or an in-scope record becomes a vehicle for moving stock and ledger effects into a foreign location). Checking only one is the common miss.

Guards must sit before the first mutation *and* before side-effecting lookups (invoice numbering, stock locks, voucher creation).

# SQL scope fragments must be told the caller's table alias

A shared `scope*Where(scope, params, alias)` helper is invisible to head-office callers because their fragment collapses to a constant `TRUE`. If the alias does not match what the query selects FROM, only branch users get a 500 — the exact users the scope exists to restrict, and the ones least likely to be in your test session.

**How to apply:** grep each call site for its FROM clause (bare table vs aliased) and pass the matching alias; smoke-test every scoped endpoint as a branch user, never only as admin.

# Branch data scoping status
- Session (`req.employee`) carries id/hierarchyId/branchType/branchId; handlers derive scope from it via `lib/dataScope.ts` (`getUserDataScope`, `isLocationInScope`, `scopeSalesWhere`, `scopeBranchWhere`, `scopeTransferWhere`).
- Scoped as of 2026-07: sales list/detail/edit/cancel/create, stock transfers list/detail/create/approve/reject, cash deposit create + reconcile.
- Still company-wide and unverified: purchase reports, several dashboard aggregates, HR/payroll, vouchers. Consolidated finance/GST is company-wide by policy, not by omission.
- Many pages still scope client-side after fetching everything — presentation only, never security.
- Outlet→warehouse mapping exists: `outlets.warehouse_id` — warehouse scope = own warehouse + mapped outlets.
- Cash Balance is duplicated: two pages (`sales/SalesCashBalance.tsx`, `finance/CashInOutlet.tsx`) + two routes both reading `GET /cash-in-outlet`, which ignores the caller entirely (`(_req, res)`).

## Alias bugs in scope SQL are invisible until a branch user hits them

The scope helpers emit fragments qualified with a fixed table alias, and
head-office callers get a constant `TRUE` instead. So a query that selects from
the bare table (no alias) works perfectly for every head-office user and throws
`missing FROM-clause entry` — a plain 500, with no hint of authorisation — the
first time a branch-scoped user opens it.

**Why:** the fragment is the only reference to the alias, and it is never
evaluated for the users who do the testing.

**How to apply:** whenever a query interpolates a scope fragment, alias the
table to what the helper expects. When triaging a 500 that only one role sees,
check the alias before anything else.

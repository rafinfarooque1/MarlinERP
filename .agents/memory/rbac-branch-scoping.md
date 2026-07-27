---
name: RBAC & branch scoping findings
description: Verified findings from the 2026-07 RBAC/branch-data-access audit — branch-type representation mismatch, backend default-allow, unguarded GETs, client-side scoping.
---

# Branch-type representation mismatch (root cause of "HR missing" class of bugs)
- DB `employees.branch_type` is text NOT NULL storing `'headoffice' | 'warehouse' | 'outlet' | 'production'`; `/auth/me` passes it through unchanged.
- The frontend nav/permission code historically used `null` to mean head office (`branchGroups: [null]` in the module registry; AppLayout casts branchType to a union that omits `'headoffice'`).
- Result: `[null].includes('headoffice')` is false → every branchGroups-gated nav group vanishes for NON-ADMIN head-office employees (level-1 bypass hid the bug from admins).
**Why:** two teams' conventions never reconciled; the branch gate runs before the permission gate so canView never rescues the item.
**How to apply:** when touching sidebar visibility, permission gating, or branch scoping, normalize on the literal string `'headoffice'` (never null) end-to-end, or map at ONE boundary only.

# Backend authorization semantics (verified in api-server/src/middleware/permissions.ts)
- No permission row in `permissions` table → backend ALLOWS (default-allow). Frontend uses level-based defaults instead → UI hides what the API permits.
- Level-1 hierarchy bypasses all checks on both ends (consistent).
- Most GET endpoints are unguarded (no requireModuleView); only some reports/ledgers/outstanding/login-history GETs are guarded.
- Backend guard keys include stale modules not in the frontend registry: 'Materials', 'Raw Materials', 'Cash & Bank' (DB permissions rows also exist for these + 'Profile').
- 403s from permission middleware are NOT audit-logged.

# Branch data scoping status (as of audit)
- Session (`req.employee`) already carries id/hierarchyId/branchType/branchId — handlers just don't use it.
- List endpoints either return ALL rows or trust client-sent locationId/branchId params (sales, stock, reports); HR/payroll/cash/vouchers/dashboard return company-wide data to any authenticated user.
- Many pages scope client-side after fetching everything (SalesDashboard, SalesTransfers, both Cash Balance pages, all HR pages) — data leaks via devtools.
- Outlet→warehouse mapping exists: `outlets.warehouse_id` — warehouse scope = own warehouse + mapped outlets is derivable.
- Cash Balance is duplicated: two pages (`sales/SalesCashBalance.tsx`, `finance/CashInOutlet.tsx`) + two routes both reading `GET /cash-in-outlet`, which ignores the caller entirely (`(_req, res)`).

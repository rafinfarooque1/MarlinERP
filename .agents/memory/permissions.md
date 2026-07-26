---
name: Permission system
description: How the role-based permission enforcement hook works and what module names to use
---

## Hook location
`artifacts/marlin-erp/src/lib/usePermission.ts`

## Usage
```ts
const perm = usePermission('Production'); // module name as string
// returns: { canView, canAdd, canEdit, canDelete, canDownload, isLoading }
```

## Module name mapping (must match Permissions page MODULE_GROUPS exactly)
Production, Stock Transfers, Purchases, Sales, Employees, Item Prices,
Materials, Raw Materials, Items, Warehouses, Outlets, Stock, HO Transfers,
Coupons, Hierarchy, Payroll, Attendance, Leave, Chart of Accounts, Ledger,
Cash & Bank, Expenses, GST Summary, Settings, Permissions, Profile, Customers, Vendors

## Logic
- Calls useGetMe() + useListPermissions() + useListHierarchies()
- Level 1 hierarchy → always full access (locked in Permissions UI too)
- No DB record for a module → defaults to canView=true, canAdd/Edit/Delete=false, canDownload=true
- During loading → returns isLoading=true with FULL_ACCESS values (to avoid flash of denied)

**Why:** Prevents flickering access denied screens while data loads; safe default is view-only.

**How to apply:** Guard every Add/Edit/Delete/Export button with the relevant perm flag. Show "Access Denied" block instead of page content when !perm.canView && !perm.isLoading.

## Server-side enforcement (added with Reports Center)
- `requireModuleView(module)` middleware in api-server `routes/reports.ts` mirrors UI rules: level-1 hierarchy → allow; no permissions row → allow (default-view); row with can_view=false → 403. Reuse/extract it when guarding more routers.
- **Why:** UI-only gating is trivially bypassed with curl; reports expose financials. Rest of the API is still requireAuth-only (follow-up task exists).
- Nav: top-level items in AppLayout support an any-of `modules: string[]` list (used by Reports); category pills inside ReportsCenter gate per-module via usePermission.
- Middleware now lives in api-server `middleware/permissions.ts` (`requireModuleView(module | modules[])` — any-of allow). Applied to all Reports Center data paths: /api/reports/*, stock valuation/expiry/reorder, /stock/transfers, /productions/reports, /outstanding/*, party ledgers, financial-statements.
- Shared endpoints need any-of lists matching every UI surface that calls them (e.g. /stock/transfers → Stock, Stock Transfers, HO Transfers, Location Transfers; /outstanding/* → Customers|Vendors + Sales since the Outstanding page is module 'Sales').
- **Testing lesson:** before insert/delete of permissions rows in curl tests, snapshot existing rows for that hierarchy first (pre-existing deny rows for the same module would duplicate and get wiped by cleanup DELETEs).

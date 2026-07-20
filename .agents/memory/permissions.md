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

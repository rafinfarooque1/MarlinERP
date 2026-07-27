---
name: RBAC & branch scoping
description: Branch type system, sidebar visibility rules, and permission scoping for the three branch types.
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
- Stock for production batches/purchases lives under `branch_type = 'headoffice', branch_id = 1` in DB
- Stock transfers page filters `t.fromType === 'headoffice'` for HO→warehouse dispatches
- backend default-ALLOWS missing perm rows; most GETs unguarded; scoping is client-side

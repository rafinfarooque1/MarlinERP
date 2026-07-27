---
name: Unified sidebar architecture
description: ONE nav for all users — Sales/Accounts switcher removed; how moduleRegistry exports changed.
---

# Unified sidebar architecture

The dual Sales/Accounts segment switcher is gone. Every user now sees one permission-filtered sidebar.

## The rule
- **Permissions decide visibility** — `canView: ON` → link shown in sidebar.
- **Backend decides data scope** — `getUserDataScope(employee)` filters DB rows.
- **No branch-type conditions in the frontend nav.**

## Key moduleRegistry changes
- `permSegment` field **removed** from `ModuleDef`.
- `navGroup: '__sales__'` **renamed** to `navGroup: 'Operations'`.
- `getNavGroups()` replaces both `getAccountsNavGroups()` + `getSalesNavItems()`.
  - Old names are kept as `@deprecated` aliases that call through to `getNavGroups()`.
- `getPermissionGroups()` replaces `getPermissionSegments()` (single flat list).
  - Old `getPermissionSegments()` still exists — returns a single-element array.
- `SALES_SEGMENT_MODULE_KEYS` and `SalesNavItemDef` **removed**.
- `HO Transfers` has TWO navEntries: one for Operations, one for Inventory.
  - Deduplication via `seenHref` map inside `getNavGroups()`.

**Why:** Admins want to grant access to individual modules, not segments. Branch employees needed the same modules (Transfers, Stock) that HO staff use — a separate "Sales" sidebar created a maintenance split with no data-scope benefit.

**How to apply:** When adding a new module, set `navGroup` to the section name (e.g. `'Operations'`, `'Inventory'`). Do NOT add segment-level conditions to AppLayout. Backend scoping lives in `getUserDataScope()`.

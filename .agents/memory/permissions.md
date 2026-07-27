---
name: Permission system
description: How role-based permission enforcement works, module-name registry rules, and defaults
---

## Single source of truth: moduleRegistry.ts
`artifacts/marlin-erp/src/lib/moduleRegistry.ts` (MODULE_REGISTRY) drives the sidebar nav, the Permissions page groups, and the set of valid module names.

**Rule:** every name passed to frontend `usePermission('X')` or backend `requireModuleAction("X", ...)` MUST be a registry key, spelled identically. An unregistered name is *silently ungovernable*: no permission row can ever be saved for it, so the backend guard default-allows every write while the UI hides buttons. (This exact bug shipped for 'Materials', 'Raw Materials', 'Cash & Bank' — fixed by registering them.)

**How to apply:** when adding a module or guard, add the registry entry first, then grep both repos for the name to confirm alignment.

## Hook & shared helpers
`artifacts/marlin-erp/src/lib/usePermission.ts`
- `usePermission('Module')` → `{ canView, canAdd, canEdit, canDelete, canDownload, isLoading }`
- Pure helpers exported for non-hook use: `resolvePermissions()`, `canViewModule()`. AppLayout imports `canViewModule` for nav filtering — do NOT reintroduce duplicate local copies of this logic.
- Level 1 hierarchy → always full access (locked in Permissions UI too).
- No DB row for a module → view-only default: canView=true, writes=false, canDownload=true.
- While loading → isLoading=true with FULL_ACCESS values (avoids flash of denied).

**Why:** one code path = display can't drift from enforcement; view-only is the safe no-row default.

## Enforced vs backend default (asymmetry, kept deliberately)
- Frontend no-row default: view-only. Backend `requireModuleAction` no-row default: ALLOW (compatibility with roles never configured; flipping to deny risks lockouts in live data). Writes are only really blocked once an admin saves rows for that hierarchy.
- The Permissions page shows the *enforced* view-only default for unsaved roles. The old aspirational `defaultAccess`/`getDefaultAccess` registry config was deleted — never re-add display-only defaults that enforcement ignores.
- `canDownload` is persisted as a copy of canView and ~28 PDF/export buttons consume it; UI subtitle documents "Download and PDF buttons follow View access."

## Server-side enforcement
- `requireModuleView(module | modules[])` (any-of) in api-server `middleware/permissions.ts`: level-1 allow; no row → allow; can_view=false → 403. Applied to Reports Center data paths, stock valuation/expiry/reorder, /stock/transfers, /productions/reports, /outstanding/*, party ledgers, financial statements.
- `requireModuleAction(module, 'add'|'edit'|'delete')` guards writes across routers; names must match registry keys.
- Shared endpoints need any-of lists matching every UI surface that calls them (e.g. /stock/transfers → Stock, Stock Transfers, HO Transfers, Location Transfers).
- Most other GETs are still requireAuth-only (follow-up task exists).

## Testing lessons
- Before insert/delete of permissions rows in curl tests, snapshot existing rows for that hierarchy (pre-existing deny rows would duplicate and get wiped by cleanup DELETEs). Best: create a throwaway hierarchy+employee, test against it, then delete perm rows via SQL (no DELETE endpoint) before deleting the hierarchy — FK blocks hierarchy delete (500) while rows exist.
- API auth is bearer-token (`Authorization: Bearer v2....` from POST /api/auth/login), NOT cookies. New employees get DEFAULT_INITIAL_PASSWORD + mustChangePassword; change it via /api/auth/change-password before exercising the account.

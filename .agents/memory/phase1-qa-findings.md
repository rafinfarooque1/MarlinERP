---
name: Phase 1 QA findings
description: Bugs found and fixed during Phase 1 QA verification pass, and test evidence for each Phase 1 item
---

## Bugs found and fixed during QA

### 1. Health route auth bypass mismatch
- Route is at `/healthz` but app.ts was bypassing auth only for `/health`
- Fix: bypass both `/health` and `/healthz`
- File: `artifacts/api-server/src/app.ts`

### 2. Permission seeding incomplete
- 6 module names in the DB were NOT in the hardcoded seeding list: `Materials`, `Raw Materials`, `Stock Transfers`, `Location Transfers`, `Sales Dashboard`, `Profile`
- `Materials` and `Raw Materials` ARE used in backend guards (`requireModuleAction`) — the "SAles Mangaer" hierarchy had no row for them, so default-deny would have blocked those endpoints for that hierarchy
- Fix: added all 6 to the hardcoded list AND added a dynamic gap-fill pass:
  ```sql
  INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete)
  SELECT h.id, all_mods.module, true, true, true, true
  FROM hierarchies h
  CROSS JOIN (SELECT DISTINCT module FROM permissions) all_mods
  WHERE h.level != 1
  AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.hierarchy_id = h.id AND p.module = all_mods.module)
  ```
- File: `artifacts/api-server/src/index.ts`

### 3. Frontend permission default was still allow
- `usePermission.ts` line 68: `if (!perm) return DEFAULT_VIEW_ONLY` — when no DB row, frontend showed module
- Backend is now default-deny (no row = 403)
- Fix: changed to `DEFAULT_DENY` (canView: false, all false) for the no-row case
- Also changed null fallbacks from `?? true` to `?? false` for consistency
- File: `artifacts/marlin-erp/src/lib/usePermission.ts`

## QA test evidence

### Security
- healthz without auth → 200 ✅
- no-token requests → 401 on all protected endpoints ✅
- tampered token → 401 ✅
- 1.5MB body → 413 "Request body too large (max 1 MB)" ✅
- malformed JSON → 400 "Request body is not valid JSON" ✅
- CORS preflight → Access-Control-Allow-Origin returned ✅

### Permissions
- Admin (level 1): 48+ endpoints → all 200 ✅
- raf (level 3, warehouse): modules with can_view=false → 403 ✅
- raf trying to add employees → "You don't have permission to create records in Employees" ✅
- PERMISSION_DENIED written to activity_log table ✅
- Seeding: 94 rows total (47 modules × 2 hierarchies) ✅

### Accounting
- Trial balance: balanced=true, difference=0 ✅
- P&L + Balance Sheet: both returned ✅
- Opening balance CRUD: create/read/delete all work; group ledger rejected; unique constraint enforced ✅
- Payroll journal: JV/2026-27/0004 Dr STD-SALARY-EXP / Cr STD-CASH ✅
- Credit limit on PUT /sales/:id: 60000 > 50000 limit → "Credit limit exceeded" ✅
- Journal balance validation: unbalanced JV → 400 ✅

### Database
- All 17 indexes confirmed in pg_indexes ✅
- chk_stock_non_negative: INSERT -5 → ERROR violates check constraint ✅
- opening_balances_ledger_year_unique: UNIQUE constraint present ✅
- activity_log table: exists with proper columns and index on created_at ✅

### Data scope
- Warehouse (raf): all sales have locationId=1, locationType=warehouse ✅
- Outlet (rafin): all sales have locationId=2, locationType=outlet ✅

### Frontend
- TypeScript: zero errors (both packages) ✅
- Login page: renders correctly ✅
- HMR: propagating updates to all pages ✅

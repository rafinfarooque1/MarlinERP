# Frozen Fruits ERP — Current System Master

**Audit status:** IN PROGRESS — Phase 1 complete  
**Snapshot date:** 2026-09-29  
**Evidence scope:** current repository source and read-only development-database schema metadata  
**Production database:** NOT QUERIED  
**Functional changes during this audit:** none

> This is the new working master document. It does not replace code as the authority. Findings labelled **NOT VERIFIED** are deliberately left open until the relevant route, service, schema and tests are traced.

## 1. Audit scope and source precedence

For this audit, use evidence in this order:

1. Current route, service, UI and migration code.
2. Read-only schema metadata from the development PostgreSQL database.
3. Existing documentation as historical context only.

The Drizzle schema is a partial view of the database. Raw PostgreSQL queries and startup migrations also create or alter operational schema. Do not infer the complete schema from Drizzle alone. No production database was queried and no database writes, migrations, restores, or tests against business data were performed during this documentation phase.

## 2. Current architecture

### Runtime components

| Component | Current location | Verified role |
|---|---|---|
| ERP web application | `artifacts/marlin-erp` | React/Vite browser UI; route tree is in `src/App.tsx`, page/module navigation and permission metadata in `src/lib/moduleRegistry.ts`. |
| API server | `artifacts/api-server` | Express/TypeScript API. `src/app.ts` installs request logging, CORS, body parsing, global API authentication and JSON error handling; `src/routes/index.ts` mounts business routers. |
| Employee application | `artifacts/employee-app` | Expo/React Native application; screens are under `app/`. Individual screen behavior remains to be audited. |
| Component preview sandbox | `artifacts/mockup-sandbox` | Design/component preview service; not an ERP business runtime. |
| Shared libraries | `lib/*` | Database schema/types, API specification/Zod/client hooks, PDF helpers and purchase-pricing code. Exact usage by module remains to be traced. |
| Database | PostgreSQL | API uses `pg` and Drizzle helpers. Many business queries and boot migrations use raw SQL. |

### Request and reporting flow

```text
ERP browser / employee mobile app
        ↓
React Query or app API client
        ↓
Express API (request middleware → authentication → mounted route)
        ↓
module authorization, location scope and business/date guards
        ↓
route and shared service/library logic
        ↓
PostgreSQL source documents, ledgers and inventory tables
        ↓
accounting derivation / inventory valuation / report-specific readers
        ↓
JSON and document/export responses
```

The exact per-module path from screen to export is **NOT VERIFIED** in Phase 1. The accounting derivation and valuation services identified by prior repository documentation will be traced against current consumers before being treated as proven universal sources.

### Current platform/workflow inventory

Four managed workflows are configured: API Server, ERP web, employee Expo app, and component preview sandbox. At the audit snapshot all four were reported running. The first three serve the ERP; the sandbox is auxiliary.

## 3. Initial code inventory

These are mechanical source counts, not a final count of unique business modules or API operations:

| Inventory | Phase 1 count | Counting rule / caveat |
|---|---:|---|
| API route files | 43 | Files directly under `artifacts/api-server/src/routes`, including the router index. |
| Mounted route modules | 42 | `router.use(...)` calls in `src/routes/index.ts`. |
| API route declarations | 410 | Explicit `router.get/post/put/patch/delete` expressions found in route files. Aliases and duplicate method/path pairs have not been deduplicated. |
| Frontend module registry entries | 55 | `MODULE_REGISTRY` entries; the registry also retains retired/compatibility surfaces. Not the final count of active user-facing modules. |
| Frontend page source files | 105 | `.ts`/`.tsx` files under `artifacts/marlin-erp/src/pages`; not equivalent to screens or modules. |
| Employee-app route source files | 20 | `.ts`/`.tsx` files under `artifacts/employee-app/app`; not a verified count of distinct workflows. |
| Configured Replit workflows | 4 | API, web, Expo employee app, component preview sandbox. |
| Public development database base tables | 93 | Read-only `information_schema` snapshot on 2026-09-29. Production count is NOT VERIFIED. |
| Public development database trigger objects | 3 | Two stock-master guards and one stock-ledger daily-close guard; the metadata query returned six event rows because each trigger handles two events. |

The current development schema includes the future-only stock-close tables: `stock_daily_close_baseline`, `stock_daily_close_baseline_entries`, `stock_daily_close_runs`, and `stock_daily_close_entries`. The stock-close implementation and its effects on FI-08 are present in current source; full operational behavior and report parity are deferred to the inventory/report phases.

## 4. Source and documentation inventory

### Existing references reviewed

| File | Snapshot indicated by file | Phase 1 finding |
|---|---|---|
| `ERP_COMPLETE_DOCUMENTATION.md` | Repository-derived documentation marked inspected 2026-09-18 | The file has 9,560 lines consisting of eight byte-identical 1,195-line copies. Treat as historical input, not a clean current master. |
| `ERP_FINAL_HARDENING_REPORT.md` | 2026-09-18 | Reports development as NOT READY and lists remaining evidence gates. It predates the current daily stock-close implementation, so its FI-08 status is not current. |
| `ERP_RELEASE_GATE_REPORT.md` | — | Not present at repository root. |
| `docs/ERP_SYSTEM_AUDIT.md` | 2026-08-01 with August addenda | Historical audit. Its database summary says 69 tables and no triggers; the 2026-09-29 development-schema metadata shows 93 base tables and three trigger objects. |
| `SOURCE_OF_TRUTH.md` | Undated in inspected section | Contains statements that conflict with later documentation. The affected code paths must be checked before deciding which behavior is current. |

The older documents are useful as leads and historical evidence only. In particular, the August audit and the September 18 reports must not be copied forward as current status without source verification.

## 5. Phase plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Existing-document audit, architecture, code/module/API/table inventory baseline | **COMPLETE** |
| 2 | Accounting engine, source-of-truth functions, exact formula register, P&L and Balance Sheet | NOT STARTED |
| 3 | Inventory, costing/valuation, batches, reservations, transfers, production, sales and purchases | NOT STARTED |
| 4 | GST, customer/vendor settlement, cash/bank, assets, payroll and HR | NOT STARTED |
| 5 | Permissions/location security, audit logging, background jobs, backup/restore, mobile and external services | NOT STARTED |
| 6 | Full report/export/API inventory, tests, issue cross-check, final counts and verification | NOT STARTED |

**DOCUMENTATION PROGRESS:** Phase 1 completed. Phases 2–6 remain.  
**Completion estimate:** 10% — architecture and initial inventories only; no claim of a complete ERP audit.

## 6. Outstanding counts

The following totals are not yet established from source:

- Active business modules and complete business workflows.
- Distinct API operations after alias/deduplication and auth/scope classification.
- Important tables and relationships beyond the initial schema count.
- Reports and export surfaces.
- Exact formulas.
- Current verified code issues and their severity.

These remain **NOT VERIFIED** until their owning code paths are inspected.
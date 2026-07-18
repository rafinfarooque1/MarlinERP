---
name: Marlin ERP Architecture
description: Key decisions, structure, and gotchas for the Marlin Frozen Fruits ERP system
---

## Stack
- `artifacts/api-server` — Express + Drizzle ORM, esbuild bundled, port from `PORT` env
- `artifacts/marlin-erp` — React + Vite frontend, dark futuristic theme (electric blue/cyan on deep dark)
- `lib/db` — Drizzle schema, Postgres; push with `pnpm --filter @workspace/db run push`
- `lib/api-spec/openapi.yaml` — Source of truth for all endpoints (~60+)
- `lib/api-client-react/src/generated/api.ts` — Generated React Query hooks (do NOT hand-edit)
- `lib/api-zod/src/generated/api.ts` — Generated Zod schemas (do NOT hand-edit)

## Auth
- Simple base64 token: `Buffer.from("id:username").toString("base64")`
- Default admin login: username=`admin`, password=`admin123`
- Default staff password: `default123`
- No bcrypt in demo — passwords stored plain in `password_hash` column

## Zod Schema Naming (Orval codegen)
`CreateXBody`, `UpdateXBody`, `GetXParams`, `UpdateXParams`, `DeleteXParams`, `ListXResponse`, `GetXResponse`, `CreateXResponse`, `ListXQueryParams`
Exception: cash-bank accounts → `CreateCashBankAccountBody` (not `CreateCashBankBody`)

## DB Schema Files
All in `lib/db/src/schema/` — company, branches, vendors, customers, inventory, purchases, production, transfers, sales, hr, accounts, coupons, permissions, activity

## Numeric Fields
Drizzle returns PG `numeric` columns as strings. Always convert: `Number(row.amount)` before returning in API responses.

## Inter-state Transfer
Stock transfers between warehouses in different states auto-set `is_interstate = true`. Determined by comparing `warehousesTable.state` on both ends.

**Why:** GST compliance requires separate sale+purchase ledger entries for interstate movements.

## Seeded Demo Data
- 3 warehouses (Karnataka, Tamil Nadu, Maharashtra)
- 4 outlets (2 in KA, 2 in TN)
- 5 employees across all branch types
- 5 items, stock entries for warehouse/outlet/production
- 4 hierarchies (Director→Manager→Supervisor→Staff)
- 3 vendors, 3 customers, 3 coupons
- Chart of accounts, cash/bank accounts

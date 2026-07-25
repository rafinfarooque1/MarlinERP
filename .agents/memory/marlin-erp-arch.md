---
name: Marlin ERP architecture
description: Full stack ERP for Marlin Frozen Fruits — api-server + marlin-erp + shared libs
---

## Login
- username: admin; dev password = the DEFAULT_INITIAL_PASSWORD constant in artifacts/api-server/src/lib/passwordPolicy.ts (read it from code — never store the value in memory files)
- curl testing: POST /api/auth/login → use `Authorization: Bearer <token>` (cookie auth does NOT work from curl); JWTs survive server restarts

## Router mounting trap
- ALL routers in routes/index.ts mount FLAT under /api with no per-router prefix — accounts.ts's `/gst/summary` is `/api/gst/summary` (NOT /api/accounts/...), sharing the namespace with routes/gst.ts. Check index.ts before assuming a path; collisions are silent.

## Dev workflow quirk
- api-server dev workflow runs `pnpm run build && pnpm run start` (esbuild bundle) — NO watch/HMR; must restart the workflow to pick up backend changes
- Workspace lib dist types go stale (project references resolve to dist/, runtime uses src/): if tsc reports a schema column "missing" that exists in src, run `pnpm exec tsc -b lib/db` (same idea as api-client-react)

## Stack
- api-server: Express + Drizzle ORM + PostgreSQL (via pool from @workspace/db)
- marlin-erp: React + Vite + Wouter routing + React Query
- lib/api-client-react: generated hooks + custom hooks (production.ts, bom.ts, vouchers.ts)
- lib/api-zod: generated Zod schemas for API validation

## Custom API hooks pattern
- New hooks go in lib/api-client-react/src/<name>.ts + export from index.ts
- Must run `pnpm tsc` in lib/api-client-react after adding files
- Use `customFetch` from './custom-fetch' — same pattern as bom.ts / production.ts

## DB migrations
- All startup migrations are in artifacts/api-server/src/index.ts::runMigrations()
- Non-fatal (warnings only), use ALTER TABLE IF NOT EXISTS pattern
- Raw pool.query for new tables not in Drizzle schema
- New tables added: payments, receipts (both reference account_ledgers)
- Purchases table got: tax_total, discount_total, round_off columns
- account_ledgers table got: code column

## Default CoA seed data
- 7 root groups seeded on startup: Capital Account, Sales Account, Purchase Account, Expenses, Cash & Bank, Trade Receivables, Trade Payables
- Uses DO $$ IF NOT EXISTS ... $$ pattern to avoid duplicates

## Purchase Bill (as of latest)
- lineItems JSONB now rich: hsnCode, gstRate, taxType (intra/inter), discount, discountAmt, taxableValue, cgst, sgst, igst, taxAmount, lineTotal
- Total columns: tax_total, discount_total, round_off on purchases table
- Route handles raw req.body.lineItems (bypasses Zod strip) for full JSONB storage
- GST rates: 0/5/12/18/28%; intra = CGST+SGST split, inter = IGST

## Chart of Accounts
- Tree structure returned by GET /api/accounts/chart (nested children)
- GET /api/accounts/chart/flat for dropdowns (flat list)
- useListAccountsFlat() hook in vouchers.ts for dropdowns

## Payment & Receipt vouchers
- Tables: payments (paidFromLedgerId, paidToLedgerId), receipts (receivedFromLedgerId, receivedInLedgerId)
- Routes: GET/POST/DELETE /api/accounts/payments and /api/accounts/receipts
- Hooks: useListPayments, useCreatePayment, useDeletePayment, useListReceipts, useCreateReceipt, useDeleteReceipt in lib/api-client-react/src/vouchers.ts

## Ledger statement aggregation
- GET /api/accounts/ledger-statement?accountId=N&fromDate=&toDate=
- Aggregates from: payments, receipts, expenses, sales (if income type), purchases (if expense type with 'purchase' in name)
- Returns both `entries` and `transactions` keys (backward compat)

## Navigation (current)
- Production: Units, Item Master, BOM Templates, Batches, Stock Transfers, Purchases
- Accounts: Chart of Accounts, Ledger, Payments, Receipts, GST Summary, GST Returns (/accounts/gst-returns — HSN, GSTR-1, GSTR-3B, reconciliation)
- Old: Cash & Bank and Expenses removed from sidebar (routes kept for backward compat)

## Item Master page (/production/item-master)
- Unified view of raw_materials + materials + items tables
- Type badge per row; filter by type; unified create/edit with type selector
- Items (finished_good type) get extra HSN code + tax rate fields
- Old /production/materials, /production/raw-materials, /production/items routes still exist (BOM/Production pages reference them)

## Permissions
- usePermission hook at src/lib/usePermission.ts
- Module name must match sidebar group name exactly (e.g. 'Accounts', 'Purchases', 'Production')
- Level-1 hierarchy = full access always

## Item prices
- valid_from/valid_to added as text columns via startup migration
- ItemPrice type from generated code lacks these; use (ip as any).validFrom casts

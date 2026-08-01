---
name: drizzle push destroys raw-migration schema
description: Why drizzle-kit push (especially --force) must NEVER run against this project's databases, and what to do instead.
---

# Never run drizzle-kit push against this project

- Most of the live schema — dozens of tables (journal_vouchers, receipts, payments, sale_payments, stock_ledger, payroll/rent accruals, opening_balances, migration_log, …) and ~150 columns (material_type, location_type/location_id, avg_cost, …) — is created by **raw SQL boot migrations** in the api-server and does **not** exist in `lib/db/src/schema/*.ts`.
- `drizzle-kit push` diffs live DB against schema.ts and **drops everything it cannot see**. `--force` auto-confirms the drops. On 2026-08-01 a completed push-force deleted 27 tables and ~150 columns from the dev DB.
- It had "worked" before only by accident: the post-merge script's push always died at an interactive prompt (no TTY) or the 20s timeout **before applying**. Fixing the prompt is what armed the bomb.
- **Why:** schema.ts is a partial view by long-standing design (see raw-migration-columns.md); any schema-diff tool that treats it as the whole truth is destructive here.
- **How to apply:** schema changes ship as boot migrations in api-server/src/index.ts (ADD COLUMN/CREATE TABLE IF NOT EXISTS + guarded backfills). Post-merge setup must only `pnpm install` (+ build); the workflow restart applies DDL. If a new drizzle-schema table is truly needed, create it with raw `CREATE TABLE IF NOT EXISTS` in boot migrations instead of push. Recovery levers if it ever happens again: Replit checkpoint rollback (includes the DB) or the app's own zip backups in object storage (`backup_meta.backups`, `.private/backups/…`, contains database.dump/database.sql).
- Schema.ts must also never re-add constraints the live data forbids: sales.outlet_id stays nullable (warehouse sales), stock_entries/stock_batches item_id gets NO items FK (polymorphic with materials), invoice_share_links.public_id uniqueness comes from the NAMED _uq index only.

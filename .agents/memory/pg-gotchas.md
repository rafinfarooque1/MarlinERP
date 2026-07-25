---
name: Raw pg query gotchas in this codebase
description: Recurring traps when using pg Pool directly (dates, status codes, locking pattern for financial checks)
---

# Raw pg query gotchas

## Date columns return JS Date objects
`date` columns (e.g. `sale_date`, `bill_date`) come back from `pg` as **JS Date objects, not strings**.
**Why:** String comparisons like `row.sale_date === '2026-07-25'` silently never match, producing wrong filters/aggregations that pass typechecking. Cost a debugging round during returns/aging work.
**How to apply:** Normalize first via a `dateOnly()` helper (`d instanceof Date ? d.toISOString().slice(0,10) : String(d).slice(0,10)`) before comparing against `YYYY-MM-DD` strings. Grep `dateOnly` in api-server routes for the canonical helper.

## Sales/create endpoints return 201, not 200
POST /api/sales (and most create routes) respond `201 Created`. Test scripts asserting `status === 200` fail spuriously — accept `[200, 201]`.

## Financial guard + insert must share one transaction with an advisory lock
Pattern for check-then-insert guards (credit limit, and any future balance/quota checks):
1. `pgPool.connect()` a dedicated client; `BEGIN`.
2. `SELECT pg_advisory_xact_lock(hashtext('<domain>'), <entityId>)` to serialize per entity (auto-released at COMMIT/ROLLBACK).
3. Re-read balances INSIDE the txn, decide, then INSERT (and increment any sequence counters) on the same client; COMMIT.
**Why:** The original credit check read aggregates on the pool, then inserted later — two concurrent requests both passed the limit (architect-flagged race). The advisory lock + single-txn version is verified by a concurrency test (two simultaneous sales → exactly one accepted).
**How to apply:** See POST /sales in api-server routes/sales.ts. Also enforce any "manager override" flags server-side (hierarchy level 1 or module can_edit in `permissions`) — never trust client gating alone (403 `CREDIT_OVERRIDE_FORBIDDEN`).

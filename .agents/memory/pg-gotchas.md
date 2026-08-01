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

## FOR UPDATE is rejected on an aggregate query

`SELECT COALESCE(SUM(qty),0) … FOR UPDATE` fails at runtime with
`FOR UPDATE is not allowed with aggregate functions` (SQLSTATE 0A000) — it
typechecks and builds fine, so it only shows up as a 500 under test.

**How to apply:** when you need both the total and the lock, select the
individual rows `FOR UPDATE` and sum them in JS.

## A backtick inside a SQL template literal silently ends the string

SQL written as a TS template literal must not contain a backtick — including
inside a `--` comment. Quoting an identifier or a column name the way you would
in prose (`` `like this` ``) closes the template literal, and the bundler then
fails somewhere further down the file with a meaningless syntax error
(`Expected ")"`) that points nowhere near the comment.

**How to apply:** in comments inside these queries, use plain single quotes.
When esbuild reports a syntax error in a route file full of SQL and the flagged
line looks fine, search that file for a stray backtick before anything else.

## executeSql around environment restarts
A write via executeSql that runs while the environment is being recycled can RETURN rows yet never commit (the txn dies with the connection). Evidence: an INSERT's RETURNING ids were later re-issued by the sequence to a different insert. After any environment restart, re-verify recent writes before building on them.

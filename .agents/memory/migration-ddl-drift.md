---
name: CREATE TABLE IF NOT EXISTS hides later DDL changes
description: Constraints added to an existing CREATE TABLE IF NOT EXISTS block never reach databases where the table already exists
---

# `CREATE TABLE IF NOT EXISTS` drift

Editing a `CREATE TABLE IF NOT EXISTS` block to add a constraint (UNIQUE, CHECK, FK, or a new column) is a **no-op on every database where that table already exists**. The startup migration keeps "succeeding" and the schema stays silently wrong. Only a brand-new database gets the constraint, so it works locally-from-scratch and fails everywhere real.

**Why:** `stock_batches` had `UNIQUE (item_id, branch_type, branch_id, batch_number)` written into its `CREATE TABLE IF NOT EXISTS`, but the live table predated that edit. Every `ON CONFLICT (item_id, branch_type, branch_id, batch_number)` upsert — in the startup migrations and in `lib/batches.ts` — failed with Postgres **42P10** ("no unique or exclusion constraint matching the ON CONFLICT specification"). That surfaced as a 500 on sales returns and as a long-ignored non-fatal boot warning. The declaration looked correct in source, which is exactly why it went unnoticed for so long.

**How to apply:**
- Never add a constraint by editing an existing `CREATE TABLE IF NOT EXISTS`. Add a separate, `migration_log`-guarded `CREATE UNIQUE INDEX IF NOT EXISTS` / `ALTER TABLE` step.
- Any new unique index on live data needs a **dedupe step first** (merge duplicates in one transaction, then create the index), or it throws on databases that accumulated duplicates.
- Order it **before** any migration whose `ON CONFLICT` targets that key.
- Do not just log-and-continue on failure: assert the constraint exists afterwards (query `pg_indexes`) and log loudly. But do **not** rethrow from inside `runMigrations()` — that aborts the whole function and silently skips every later migration.
- A 42P10 error is almost always one of the two causes here, not a typo in the conflict clause. Check `\d <table>` against the source DDL before touching the query.

# Cause 2 — widening a natural key strands every older `ON CONFLICT` target

When a unique key **gains** a column (e.g. `material_type` once a table went polymorphic, giving `stock_batches_natural_key_v2` five columns), every pre-existing `INSERT … ON CONFLICT (old, four, column, list)` becomes a 42P10. The source looks untouched and correct; the index it names simply no longer exists.

**How to apply:**
- 42P10 is a **planning** error: it fires even when the SELECT would match **zero rows**. "There is no data to migrate here" does not protect a block from aborting the whole run.
- A liveness check for the index must include the **new** column. A check written against the old column set reports a healthy key while Postgres still refuses it as an arbiter — a green assertion sitting directly above the statement that fails.
- Resolve the conflict target **against the live schema** (look up the column in `information_schema`, build the target string) rather than hardcoding it. Where one such key in a block was already resolved that way and a neighbouring one was not, assume the neighbour is broken.
- **Environment asymmetry:** these blocks are gated by a `migration_log` row, so any environment that already applied them never executes the broken statement. Production can be perfectly healthy while development aborts on boot. A clean production is not evidence the code is correct.

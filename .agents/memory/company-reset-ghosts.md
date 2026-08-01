---
name: Company reset & ghost rows
description: Why reset table lists must have one source of truth, and how surviving rows corrupt a reset company
---

**Rule:** every reset endpoint derives its table list from the ONE maintained transactional list (`TXN_RESET_TABLES`, lib/resetTables.ts — importable by tests without the router's DB pool) plus explicit extras. Never keep a second hand-copied list, and every NEW transactional table must be added there (quotations were forgotten once; the completion review caught it).

**Why:** a stale copy once missed several transactional tables. TRUNCATE … RESTART IDENTITY reissues master ids 1..N, so any surviving old row silently re-attaches to the new company's records. Nothing errors — the corruption only surfaces as impossible figures later.

**How to apply:**
- Standalone sequences and `company_settings` counters (invoice_sequence, quotation_sequence) are NOT owned by truncated tables — reset them explicitly, together.
- Accrual sweeps (salary, rent) backfill from anchors/agreements: a reset must advance the anchors and wipe agreements or the sweeps resurrect old-company money.
- Verification invariant: batch coverage may fall SHORT of stock_entries (untracked stock is legitimate) but must never EXCEED it — over-coverage = ghost rows.
- One-time destructive cleanups need, beyond a same-txn migration_log marker: an environment gate, a data-shape gate, AND a deployment-specific identity pin (e.g. the database's first activity row falling in a known minute) — shape alone can match an innocent database.

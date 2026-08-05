---
name: Destructive boot cleanups
description: One-time destructive boot migrations guarded only by data-shape probes re-fire after schema incidents and wipe data.
---

# Destructive boot cleanups must be guarded by migration_log, not data shape

**Rule:** Any boot-time block that DELETEs rows must be guarded by a positive `migration_log` record, never solely by a probe of current data shape ("does a row with code X exist?", "is column Y populated?"). The block must write its own marker in the SAME transaction as the deletes (or as the recognition that the target state already exists), so all environments converge and a partial failure never records success.

**Why:** After an incident re-added dropped columns empty (defaults satisfied every shape probe), a legacy ledger-cleanup block saw "no canonical ledger" and deleted all account ledgers, receipts and payments — a second data-loss wave after the tables had already been restored. A freshly-defaulted column satisfies shape probes in the worst possible way.

**How to apply:**
- Before adding or auditing a guard, check that `migration_log` is created BEFORE its first read in the boot sequence — a fresh DB otherwise crashes on the guard query itself.
- Some cleanups run every boot BY DESIGN (test-data cleanup deletes "unreferenced test" customers/items) — know which are intentional before assuming data went missing.
- Restore gotchas: `setval` is NOT rolled back with a failed transaction — re-check sequences after any aborted restore; `pg_dump --data-only` output sets an empty search_path, so schema-qualify any statements appended to the same psql session.

# Owner-requested one-time prod row deletions (pattern proven Aug 2026)

**Rule:** When the owner asks to delete specific production rows, ship it as a fingerprint-gated boot migration (prod DB is only writable by the deployed app): pin identity on PRIMARY KEY id + document number + amount + source + party ledger code; delete only when NODE_ENV=production AND every pinned row matches in full (all-or-nothing under FOR UPDATE); reuse the app's own delete-route unwind logic via a parameterised core so the exact path can be rehearsed in dev with fixtures; write audit rows + marker in the SAME txn.
**Why:** Review caught that number+amount alone can fire on a clone/namesake DB, and that "0 matches → mark done" on prod silently suppresses a corrective migration forever. So: non-prod with matches = skip WITHOUT marker (restored prod clone); non-prod with 0 matches = mark done; prod with 0 matches and no marker = throw loudly and retry next boot.
**How to apply:** verify fingerprints on the prod replica first (read-only); rehearse core + refusal paths (partial match, zero match, marker absence) via esbuild-bundled test in tests/ before publishing; books derive at read time so row removal auto-reverses postings.

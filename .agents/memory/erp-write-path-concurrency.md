---
name: ERP write-path concurrency
description: Lock order for production/purchase write paths in the Marlin ERP, and the stale-snapshot reversal trap that keeps recurring.
---

# Lock order (production write paths)

Canonical order, enforced in every production route that can reallocate labour:

1. day+location labour advisory lock — sorted by date when two days are involved
2. per-item `production-stock` advisory lock
3. row locks (`SELECT … FOR UPDATE`)

**Why:** the day-pool costing model means any new/removed batch re-spreads a whole
location-day, so the serialization point is the *day*, not the row. Before this
order existed, delete took a row lock and then wanted the labour lock while a
concurrent create held the labour lock and wanted that row — a real cycle found in
review. A per-item lock alone cannot fix it: `FOR UPDATE` cannot lock a sibling row
that a concurrent request has not inserted yet, so two creates each spread the pool
over an incomplete sibling set and the "allocation sums exactly to the pool"
invariant breaks.

**How to apply:** edit/delete paths do not know the day or item until they read the
row, so they use peek → lock → re-read `FOR UPDATE` → revalidate, and return 409
("changed by someone else") if day/location/item moved between peek and lock. Never
retry internally: these are business mutations with side effects. Acquiring the same
advisory lock twice in one transaction is free, so helpers may re-take it defensively.

# Stale-snapshot reversal trap

Any handler that reverses stock from a document's stored lines must read those lines
from a row locked `FOR UPDATE` **inside** the transaction. Reading the document
before `BEGIN` (the natural shape when a 404 check comes first) lets two concurrent
edits/deletes reverse the same lines twice — stock, lots and the ledger all drift
by exactly one document. Pair deletes with `DELETE … RETURNING` and a rowCount
guard so a reversal can never commit against a document someone else removed.

**Why:** this bug shape appeared in purchases even after the writes were made
transactional — the transaction was correct but its *input* was stale.

**How to apply:** when adding a transaction to an existing handler, move the
authoritative read inside it rather than reusing the pre-existing read; keep the
outer read only for cheap 404s and metadata-only paths.

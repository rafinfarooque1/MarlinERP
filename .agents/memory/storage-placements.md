---
name: Storage locations & placements
description: The additive rack/cold-room placement layer over stock_entries (Phase 2, Aug 2026).
---

**Rule:** storage locations (named areas per warehouse/outlet) and placements are an ADDITIVE layer — `stock_entries` stays the quantity truth; placements only say where within the site some of it sits. Unplaced quantity is implicit (site total − Σ placements), never a stored row. Nesting is capped at THREE levels (freezer → rack → shelf) — enforced in route validation, not DDL; ancestor lookups are plain self-joins (parent + grandparent), no recursion.

**Why:** mirroring quantities into a second store would drift from every stock producer; the additive design needs no hooks in sales/purchases/transfers.

**How to apply:**
- Moves validate against available (site stock − other placements) and clamp at the effective site quantity; placement rows for a product must never sum past site stock.
- Any hierarchy-aware read/write must walk the FULL ancestor chain: effectiveDisabled = self OR parent OR grandparent; childPlacedQty rolls up children AND grandchildren (disjoint buckets, no double count); pathLabel is up to 3 segments (`›` in list/create, `>` in storage-stock and Live Stock ride-along — pre-existing asymmetry, intentional).
- Deletes must run deepest-first (shelf → rack → root); fixture sweeps ordered by `parent_id IS NULL` alone break at 3 levels.
- Deleting a storage location requires it empty (400 otherwise) — move stock out first.
- UI lives as a tab on the Stock page (sidebar frozen); permissions ride the Stock page key.
- Permanent suite: tests/storage-locations.test.mjs.

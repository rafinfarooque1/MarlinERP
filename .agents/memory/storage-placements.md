---
name: Storage locations & placements
description: The additive rack/cold-room placement layer over stock_entries (Phase 2, Aug 2026).
---

**Rule:** storage locations (named areas per warehouse/outlet) and placements are an ADDITIVE layer — `stock_entries` stays the quantity truth; placements only say where within the site some of it sits. Unplaced quantity is implicit (site total − Σ placements), never a stored row.

**Why:** mirroring quantities into a second store would drift from every stock producer; the additive design needs no hooks in sales/purchases/transfers.

**How to apply:**
- Moves validate against available (site stock − other placements) and clamp at the effective site quantity; placement rows for a product must never sum past site stock.
- Deleting a storage location requires it empty (400 otherwise) — move stock out first.
- UI lives as a tab on the Stock page (sidebar frozen); permissions ride the Stock page key.
- Permanent suite: tests/storage-locations.test.mjs.

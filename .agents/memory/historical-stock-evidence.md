---
name: Historical stock evidence
description: Rules for correcting missing historical inventory evidence without rewriting operational stock.
---

Historical stock evidence is an additive, source-backed record, not a stock movement. Draft evidence is non-authoritative. Only a separately approved checkpoint affects reports at its exact effective date. Approval must not change live stock quantities, average costs, batches, stock ledger rows, or journals.

**Why:** Rewriting operational stock or creating balancing journals would fabricate business activity. Missing historical quantity or cost evidence must remain visible rather than being inferred from today's product master.

**How to apply:** Require per-product/location quantities, historical costs, and a source reference; validate the approved on-hand checkpoint against recorded later movements and current stock. For same-day count reconciliation, compare ledger timestamps to the verification timestamp, not only business dates. Use an exact-date persisted cost checkpoint; do not carry an older checkpoint forward unless the absence of intervening movements is proven. Never replace missing historical cost with current item cost. Compare batch-allocation business dates, row creation times, and source-purchase dates before using lot history: migration/backfill can attach a batch breakdown to a sale dated before that batch's purchase. Keep sender-owned in-transit value derived from reservation history. A transfer-in ledger date is not receipt proof: block approval when receipt date is after cutoff or sender reservation remains unreleased past it. Do not reuse the additive Opening Stock importer.

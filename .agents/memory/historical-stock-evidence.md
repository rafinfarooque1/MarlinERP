---
name: Historical stock evidence
description: Rules for correcting missing historical inventory evidence without rewriting operational stock.
---

Historical stock evidence is an additive, source-backed record, not a stock movement. Draft evidence is non-authoritative. Only a separately approved checkpoint affects reports at its exact effective date. Approval must not change live stock quantities, average costs, batches, stock ledger rows, or journals.

**Why:** Rewriting operational stock or creating balancing journals would fabricate business activity. Missing historical quantity or cost evidence must remain visible rather than being inferred from today's product master.

**How to apply:** Require per-product/location quantities, historical costs, and a source reference; validate the approved on-hand checkpoint against recorded later movements and current stock. For same-day count reconciliation, compare ledger timestamps to the verification timestamp, not only business dates. Use the latest append-only cost snapshot through the cutoff only when its quantity reconciles; never replace missing historical cost with current item cost. Keep sender-owned in-transit value derived from reservation history. A transfer-in ledger date is not receipt proof: block approval when its receipt date is after the cutoff or sender reservation remains unreleased past it. Do not reuse the additive Opening Stock importer.

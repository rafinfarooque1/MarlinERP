---
name: Historical stock evidence
description: Rules for correcting missing historical inventory evidence without rewriting operational stock.
---

Historical stock evidence is an additive, source-backed record, not a stock movement. Draft evidence is non-authoritative. Only a separately approved checkpoint affects reports at its exact effective date. Approval must not change live stock quantities, average costs, batches, stock ledger rows, or journals.

A prior persisted cost checkpoint may be carried forward only when there is trustworthy evidence that no stock movement occurred between it and the requested date. Do not treat a missing movement-log row alone as proof when that history is incomplete; daily-close coverage or another independently reliable source is required. Explain that current ERP stock can be present while a past-date cost remains unverified.

**Why:** the ERP is the user's only available source; missing dated evidence must be investigated in existing ERP records before requesting an external backup, while unproven reconstruction would fabricate historical profit.

**How to apply:** inspect existing checkpoints and the evidence that covers the intervening period first. Never replace an unsupported historical cost with today's item cost or clear an integrity warning just to make the report look complete.

**Why:** Rewriting operational stock or creating balancing journals would fabricate business activity. Missing historical quantity or cost evidence must remain visible rather than being inferred from today's product master.

**How to apply:** Require per-product/location quantities, historical costs, and a source reference; validate the approved on-hand checkpoint against recorded later movements and current stock. For same-day count reconciliation, compare ledger timestamps to the verification timestamp, not only business dates. Use an exact-date persisted cost checkpoint; do not carry an older checkpoint forward unless the absence of intervening movements is proven. Never replace missing historical cost with current item cost. Compare batch-allocation business dates, row creation times, and source-purchase dates before using lot history: migration/backfill can attach a batch breakdown to a sale dated before that batch's purchase. Keep sender-owned in-transit value derived from reservation history. A transfer-in ledger date is not receipt proof. A partial receipt is valid only when linked receipt-date evidence, received-line totals, destination ledger quantity, dispatched quantity, and the sender's remaining reservation all reconcile; keep only the undelivered balance in transit. A fully released reservation may support legacy receipt only when it was released by the cutoff and the quantities match. Do not reuse the additive Opening Stock importer.

**Why:** Production records contained real partial receipts with active reservations for exactly the undelivered balance; treating any active reservation as a conflict hid valid destination stock.

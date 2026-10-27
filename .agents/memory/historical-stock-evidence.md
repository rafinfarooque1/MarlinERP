---
name: Historical stock evidence
description: Rules for correcting missing historical inventory evidence without rewriting operational stock.
---

Historical stock evidence is an additive, source-backed record, not a stock movement. Draft evidence is non-authoritative. Only a separately approved checkpoint affects reports at its exact effective date. Approval must not change live stock quantities, average costs, batches, stock ledger rows, or journals.

A prior persisted cost checkpoint may be carried forward only when there is trustworthy evidence that no stock movement occurred between it and the requested date. Do not treat a missing movement-log row alone as proof when that history is incomplete; daily-close coverage or another independently reliable source is required. Explain that current ERP stock can be present while a past-date cost remains unverified.

**Why:** the ERP is the user's only available source; missing dated evidence must be investigated in existing ERP records before requesting an external backup, while unproven reconstruction would fabricate historical profit.

**How to apply:** when an ERP-generated worksheet flags missing history, trace its lookup predicates and joins against purchases, batches, transfers, production, and ledger records before concluding source data is absent. Inspect checkpoints and intervening movement evidence; never substitute today's cost or clear a warning to make a report look complete.

**Why:** the business confirmed that purchase, sales, production, batch, movement, and transfer data are already entered in the ERP and that its worksheet is generated from the same database; a warning may be a calculation-path limitation rather than missing source data.

**Why:** Rewriting operational stock or creating balancing journals would fabricate business activity. Missing historical quantity or cost evidence must remain visible rather than being inferred from today's product master.

**How to apply:** Require per-product/location quantities, historical costs, and a source reference; validate the approved on-hand checkpoint against recorded later movements and current stock. For same-day count reconciliation, compare ledger timestamps to the verification timestamp, not only business dates. Use an exact-date persisted cost checkpoint; do not carry an older checkpoint forward unless the absence of intervening movements is proven. Never replace missing historical cost with current item cost. Compare batch-allocation business dates, row creation times, and source-purchase dates before using lot history: migration/backfill can attach a batch breakdown to a sale dated before that batch's purchase. A historical batch fallback must reconstruct from dated ledger movements plus source-document allocations and purchase-backed unit cost; never use mutable `stock_batches.quantity` as a historical balance. Reconcile allocations by source document and compute per-batch cutoff balances; multiple batches and costs are valid only when each remaining batch is purchase-backed and movement allocations reconcile. For transfer-ins, batch identity/cost comes from dispatched lines while received lines supply the accepted quantity; fail closed when lines cannot be paired unambiguously. Sale edits can leave the current document lines different from historical ledger lines; a zero-net sale/reversal can be omitted only when its sales and restorations balance exactly. Keep sender-owned in-transit value derived from reservation history. A transfer-in ledger date is not receipt proof. A partial receipt is valid only when linked receipt-date evidence, received-line totals, destination ledger quantity, dispatched quantity, and the sender's remaining reservation all reconcile; keep only the undelivered balance in transit. A fully released reservation may support legacy receipt only when it was released by the cutoff and the quantities match. Do not reuse the additive Opening Stock importer.

Purchase reversals may use the current purchase row only when its batch allocations exactly reconcile to the net dated purchase/reversal ledger quantity; a balanced zero-net pair may be omitted only when it has no active batch allocation. A transferred lot at a destination may use its exact purchase-line cost only when a positive dated purchase-ledger row corroborates that product and cost. Positive stock-verification adjustments can use `ADJ-<verification id>` only when the verification variance, dated ledger quantity/cost, and persisted adjustment-batch cost all agree; never use that batch's mutable quantity. Negative count adjustments have no saved FEFO batch breakdown and must remain unverified.

**Why:** Production records showed reversal rows with zero cost but exact net-quantity matches to current purchase lines, destination transfers whose source purchase cost was still stored, and an adjustment batch whose quantity had already been consumed while its exact source cost remained available.

**How to apply:** Require document-level net quantity reconciliation and per-batch cutoff checks before accepting reversal evidence. Treat the adjustment batch's source ID and cost as identity evidence, not its current quantity; if the source linkage or cost differs, fail closed.

**Why:** Current batch rows are mutable reconciliation state, not an append-only historical movement journal; source allocations and dated ledger rows are the evidence needed to reconstruct a past balance.

**Why:** Production records contained real partial receipts with active reservations for exactly the undelivered balance; treating any active reservation as a conflict hid valid destination stock.

An unreliable overall rewind does not invalidate every line. Inventory Valuation may include a missing-checkpoint line when the shared historical batch resolver proves its exact quantity and purchase-backed cost; it must retain the rewind's broader warning for unrelated gaps or deleted products.

**Why:** Requiring global reliability before accepting any fallback caused Inventory Valuation to omit individually proven batch values that Books correctly included, creating a false report-to-report difference.

**How to apply:** Match each reconstructed row to the reported material, location, and quantity; adopt only that row's source-backed value, remove only its resolved line issue, and keep the aggregate historical warning and unreliable status.

Daily-close quantity snapshots can include a future business-date movement if it was entered before the company's local midnight: the close materializes current `stock_entries`, while the ledger's `txn_date` may be the next day. Compare the close run time, `created_at`, and business date before trusting a close row as a cutoff quantity.

**Why:** Production's September 30 close included an October 1 sale created on September 30 local time, producing a lower quantity than the September 30 cost checkpoints.

**How to apply:** For historical cutoffs, prefer business-date-aware reconciliation and flag same-day future-dated postings; do not use an unqualified current-stock snapshot to overwrite an exact-date cost snapshot.

For transfer-in rows without an explicit receipt date, use the linked receipt voucher/purchase date or ledger creation date as the event-date fallback, consistently in statements and inventory valuation. A corrected non-stock purchase line may pair with a missing source allocation only when one sale allocation exactly matches the product, quantity, batch, and positive ledger cost and the lot is fully consumed; never use that inferred pair to cost positive cutoff stock.

**Why:** Imported bill corrections can intentionally leave obsolete ledger rows for consumed lots, while transfer ledger business dates can precede actual receipt evidence. Exact consumed-pair reconciliation avoids inventing remaining stock or cost; consistent receipt dating avoids backdating stock into an earlier cutoff.

**How to apply:** Keep these exceptions generic and fail closed on ambiguity, mismatched quantities/costs, or any positive balance lacking purchase-backed cost.

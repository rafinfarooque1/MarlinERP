---
name: Transfer accounting
description: Accounting policy and migration boundary for taxable inter-warehouse transfers
---

Completed taxable transfers recognize stock value as `Transfer-Out` income at
dispatch and `Transfer-In` expense at receipt. Cross-GSTIN transfers also carry
the appropriate GST heads; same-GSTIN transfers use tax-free internal vouchers.
P&L recognition stays separate from the inter-branch payable.

Location statements include Transfer-Out as income and Transfer-In as purchase
expense; consolidated statements remain neutral. Do not apply the transfer
opening-stock adjustment to a location P&L. At a location, keep total closing
stock for statement arithmetic but show on-hand and sender-owned in-transit as
separate components. Their sum must match the total closing-stock value on both
the P&L and Balance Sheet. Dispatch reduces sender on-hand; transit remains
owned by the sender until receipt.

There is one payable ledger per undirected location pair. The balanced dispatch
and receipt legs split between that pair ledger and shared clearing so a
forward transfer increases the pair balance and a reverse transfer decreases
it; the shared clearing is a contra-account, not another branch payable.

**Why:** Posting both sides of a completed transfer to the pair ledger would
net the obligation to zero. Splitting the legs preserves each document's
balance while keeping the actual bilateral position visible; rewriting
historical journal lines would damage the audit trail.

**How to apply:** Invoice-mode postings use the derived invoice projection and
must not create duplicate JVs. Legacy voucher-mode history is repaired only
with additive, balanced adjustment vouchers; keep existing journal lines
immutable. Migrations are marker-guarded and atomic.

For reporting, apply transfer P&L lines only to location-scoped statements and
keep the pair-payable postings unchanged. The transfer-in amount is already
separate from ordinary purchases; include it once in goods available and
COGS. Keep monthly statements, on-screen reports, PDFs, and canonical exports
aligned on the same transfer and stock split.
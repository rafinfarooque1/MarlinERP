---
name: Transfer accounting
description: Accounting policy and migration boundary for taxable inter-warehouse transfers
---

Completed taxable transfers recognize stock value as `Transfer-Out` income at
dispatch and `Transfer-In` expense at receipt. Cross-GSTIN transfers also carry
the appropriate GST heads; same-GSTIN transfers use tax-free internal vouchers.
P&L recognition stays separate from the inter-branch payable.

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
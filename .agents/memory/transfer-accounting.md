---
name: Transfer accounting
description: Accounting policy and migration boundary for taxable inter-warehouse transfers
---

Completed transfers recognize stock value as `Transfer-Out` income at dispatch
and `Transfer-In` expense at receipt. Cross-GSTIN transfers also carry the
appropriate GST heads; same-GSTIN transfers use tax-free internal vouchers.
Both remain separate from GST heads and inter-branch receivable/payable
ledgers, so a completed relocation is P&L-neutral while both location events
remain visible.

**Why:** The old `STD-BRANCH-TRF` clearing presentation hid the transfer cost and offset from P&L, while rewriting historical journal lines would damage the audit trail.

**How to apply:** Invoice-mode postings use the derived invoice projection and
must not create duplicate JVs. Legacy voucher-mode history is repaired only
with additive, balanced adjustment vouchers that reverse the old clearing
effect and introduce the new P&L leg; internal history is similarly backfilled
without rewriting existing journal lines. Migrations are marker-guarded and
atomic.
---
name: Transfer accounting
description: Accounting policy and migration boundary for taxable inter-warehouse transfers
---

Completed cross-GSTIN transfers recognize the taxable stock value as `Transfer-Out` income at dispatch and `Transfer-In` expense at receipt. Both remain separate from GST heads and inter-branch receivable/payable ledgers, so a completed relocation is P&L-neutral while the two location events remain visible.

**Why:** The old `STD-BRANCH-TRF` clearing presentation hid the transfer cost and offset from P&L, while rewriting historical journal lines would damage the audit trail.

**How to apply:** Invoice-mode postings use the derived invoice projection and must not create duplicate JVs. Legacy voucher-mode history is repaired only with additive, balanced adjustment vouchers that reverse the old clearing effect and introduce the new P&L leg; the migration is marker-guarded and atomic.
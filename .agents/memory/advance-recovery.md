---
name: Employee advance settlement invariants
description: advances live as a debit on the ledger payroll credits; one settlement path; settling any claim needs per-row proof, never a global marker
---

**Invariant 1 — the debit must sit where the credit will land.** An employee
advance is only safe to settle through payroll if the disbursed money is a
debit on the very ledger the payroll settlement credits (Salary Payable, since
the Aug 2026 owner decision folded the separate Current-Asset advance flow).
If the debit lives elsewhere — or nowhere, because a historical create path
inserted the row before its voucher and swallowed voucher failures — settling
the row credits money the books never received and strands a liability.

**Invariant 2 — per-row evidence, never a global marker.** "The migration ran"
proves nothing about any individual row: a row whose backing entry silently
failed migrates zero while the marker still gets written. Every row a
settlement path consumes must carry its own confirmed link to the posting that
put the money on the offset ledger; settlement fails closed on rows without
one. Migrations that move balances must reconcile aggregate ledger balances
against the per-row sums BEFORE writing their marker, and refuse (retry next
boot, loud log + boot_status) on any mismatch rather than completing.

**Invariant 3 — one settlement path.** Two paths (payroll deduction + cash
recovery) raced and double-settled; cash recovery is retired. Any new
settlement path must take the advance row lock first and preserve the
one-path rule.

**How to apply:** when adding any advance producer/consumer, ask (a) does the
money land on the ledger settlement offsets, (b) does the row carry proof,
(c) does it serialize on the row lock. Test the swallowed-voucher case:
fabricate a row with no backing entry and prove approval refuses with zero
residue.

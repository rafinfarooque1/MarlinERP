---
name: Verifying costing on live data
description: Creating and deleting production batches to test costing leaves permanent valuation drift in the Marlin ERP; how to detect and restore it.
---

Create-then-delete of a production batch does **not** return to the starting state:
the deposit rolls the item's weighted-average cost down, and the delete removes the
quantity while leaving the lowered average. Closing stock (and therefore net profit)
stays permanently wrong by `Δavg × total item quantity`, even though the trial
balance still balances and the finished-goods control account still reconciles.

**Why:** the reversal path was never given the inverse of the moving-average roll —
a known gap that belongs to the valuation phase, not to whichever feature you are
testing. It means "the books still balance" is NOT sufficient evidence that a test
left no trace.

**How to apply:**
- Snapshot closing stock and net profit *before* creating test batches, not just the
  trial balance, and compare after cleanup.
- To restore, invert the deposits: `A0 = (A_now × (Q + q_in) − Σ q_in·u_in) / Q`,
  where `Q` is the item's current total quantity across stock entries (which is back
  to its pre-test value once the test batches are deleted). Cross-check the answer
  against the observed closing-stock delta — `(A0 − A_now) × Q` must equal it.
- When reading deposit quantities and costs from the stock ledger, filter to the
  item rows. A production document's positive-quantity ledger rows also include the
  **material returns** written by the delete, and counting those as deposits inflates
  the restored average.

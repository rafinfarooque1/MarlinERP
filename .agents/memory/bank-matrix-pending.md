---
name: Bank matrix reconciliation pending
description: Scope and accounting treatment of the bank matrix's pending line.
---

In the Cross-Warehouse Financial Summary Matrix, “Reconciliation pending” means incoming bank sales and receipt vouchers still awaiting a bank destination in Electronic Payment Clearing. It does not include outgoing payment vouchers or transactions already posted to a bank ledger but not yet marked reconciled. The figure is current outstanding status, not a date-range flow, and must not be deducted from the closing bank balance.

**Why:** The matrix needs to distinguish electronic collections not yet assigned to a bank account from metadata-only Bank Book reconciliation. Closing bank remains the authoritative ledger position.

**How to apply:** Keep the pending amount as its own informational row before the ledger-derived closing bank figure. Preserve the sales-and-receipts-only scope if the matrix is extended.
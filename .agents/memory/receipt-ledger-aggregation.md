---
name: Customer receipt ledger aggregation
description: Allocation receipts must remain one customer-ledger transaction while retaining bill-level settlement metadata.
---

Bill-wise allocation rows are settlement metadata, not separate customer financial transactions. The derived books may keep one clearing/bank leg per allocation for invoice settlement, but the customer account must receive exactly one credit for the full receipt amount, including any advance slice. The receipt list may expose the allocation rows as detail without expanding them into ledger entries.

**Why:** Expanding one receipt into one customer statement row per invoice makes the customer ledger disagree with the receipt voucher and creates misleading financial activity, especially when one receipt spans multiple bills or includes an advance.

**How to apply:** When changing receipt posting logic, verify multi-bill, partial, advance, edit, delete, customer-ledger, outstanding, cash/bank, and trial-balance parity together. Keep the receipt-level credit and bill-level allocation rows separate.
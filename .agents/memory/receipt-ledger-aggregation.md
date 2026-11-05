---
name: Customer receipt ledger aggregation
description: Allocation receipts must remain one customer-ledger transaction while retaining bill-level settlement metadata.
---

Bill-wise allocation rows are settlement metadata, not separate customer financial transactions. The derived books may keep one clearing/bank leg per allocation for invoice settlement, but the customer account must receive exactly one credit for the full receipt amount, including any advance slice. The receipt list may expose the allocation rows as detail without expanding them into ledger entries.

An allocation payment can still be financially active when its sale row is cancelled or missing. If the sale is omitted from derived sales postings, retain the allocation's clearing/party debit under the receipt identity; otherwise the receipt-level bank movement and customer credit become an artificial one-sided entry.

**Why:** Expanding one receipt into one customer statement row per invoice makes the customer ledger disagree with the voucher. A cancelled or missing invoice must not erase a real receipt; skipping its sale while also dropping its allocation leaves clearing and customer-control postings unbalanced.

**How to apply:** When changing receipt posting logic, verify multi-bill, partial, advance, cancelled/missing sale, edit, delete, customer-ledger, outstanding, cash/bank, and trial-balance parity together. Keep the receipt-level credit and bill-level allocation rows separate.
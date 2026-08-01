---
name: Ghost transfer documents
description: Deleting a stock transfer nulls its generated sale/purchase twins' branch_transfer_id, creating ghost BTR invoices and stuck reservations
---
Deleting a `stock_transfers` row does NOT cascade to the documents it generated: the twin sales/purchases rows survive with `branch_transfer_id` nulled (FK SET NULL), and their `stock_reservations` rows stay `active`/`in_transit` forever.

**Why it hurts:** every "exclude transfer docs" filter keys on `branch_transfer_id IS NOT NULL`, so ghosts leak into the plain sales list, books (Dr on Sundry Debtors parent since customer is NULL), pricing heuristics (transfer invoices use exclusive tax, POS assumes inclusive), and available-stock math (stuck reservations).

**How to detect:** `sales WHERE invoice_number LIKE 'BTR/%' AND branch_transfer_id IS NULL` (same for purchases), and reservations whose `doc_id` no longer resolves. Remove the ghosts; a real fix would forbid deleting a transfer that has generated documents.

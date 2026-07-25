---
name: Sales settlement semantics
description: Domain rule for which sale payment modes are settled at creation vs credit-controlled, and how dues/ledgers must be derived.
---

**Rule:** cash/upi/card sales are settled at the counter — they are fully paid the moment they exist. Only credit ("pay later") sales carry a balance, require a customer, and are subject to credit-limit control. The canonical payment-status enum is `unpaid | partially_paid | paid`.

**Why:** dues everywhere are computed as invoice total minus amount paid. If settled sales are stored with zero paid, customers get falsely blocked by credit limits and settled invoices appear as receivables/collections. A completion review rejected the phase for exactly this.

**How to apply:**
- Any dues, aging, collections, or exposure computation must use balance (total − paid) as the only source — never infer dues from the payment mode or status label alone.
- Any code path that records a sale must apply the same settlement rule; any path that edits one must preserve collected payments rather than recomputing from scratch.
- Ledger routing mirrors settlement: cash → location cash ledger, upi/card → electronic clearing (awaiting bank), credit → the customer's debtor ledger only.
- Startup data backfills must run after the DDL that creates the columns they touch, guarded one-time via the existing migration-log convention (completion review boots older snapshot DBs).

---
name: Cash/Bank multi-location assignment
description: Rules for Cash/Bank account availability across assigned warehouses.
---

Bank accounts may be assigned to multiple warehouses through the existing
`cash_bank_account_locations` junction table. That membership set is
authoritative for branch availability, money-account pickers, reconciliation,
and location-filtered account lists. The scalar `location_type`/`location_id`
columns remain as a legacy primary compatibility value; new writes keep them
set to the first selected assignment. Cash, UPI, and other accounts retain
single-location behavior.

**Why:** Shared bank accounts are a required business capability, while
historical payments, receipts, vouchers, and journal entries still retain
their original location stamps and must not be rewritten.

**How to apply:** Use the junction memberships for availability and matching;
fall back to the scalar fields only for legacy rows with no junction entry.
The Cash & Bank form uses a warehouse multi-select for Bank accounts. Never
rewrite historical document stamps.
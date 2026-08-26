---
name: Cash/Bank single-location ownership
description: Rules for Cash/Bank account ownership after removing multi-location assignment.
---

Each managed Cash/Bank account has one canonical owner in its scalar
`location_type`/`location_id` fields. Head Office uses `headoffice:0`. The
legacy junction table may remain as a one-row compatibility shadow, but
application ownership reads must use the scalar owner.

**Why:** Account-level multi-location assignment made ownership ambiguous and
could duplicate account rows or balances in location views. Historical
payments, receipts, vouchers, and journal entries still retain their original
location stamps and are not rewritten during canonicalization.

**How to apply:** Account pickers, automatic payment routing, voucher guards,
and location cleanup must resolve the scalar owner. Global location filters
remain multi-select for reports and dashboards, but a Cash/Bank form accepts
one required location only. Never rewrite historical document stamps.
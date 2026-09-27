---
name: Cash/Bank and Online multi-location assignment
description: Rules for managed money-account availability across assigned locations.
---

Bank, Cash, and Online accounts may be assigned to multiple locations through the existing
`cash_bank_account_locations` junction table. That membership set is
authoritative for branch availability, money-account pickers, reconciliation,
and location-filtered account lists. The scalar `location_type`/`location_id`
columns remain as a legacy primary compatibility value; new writes keep them
set to the first selected assignment. UPI and Other legacy account types retain
single-location behavior.

**Why:** Shared money accounts need explicit location availability, while
historical payments, receipts, vouchers, and journal entries still retain
their original location stamps and must not be rewritten.

**How to apply:** Use the junction memberships for availability and matching;
fall back to the scalar fields only for legacy rows with no junction entry.
The Cash & Bank form uses a location multi-select for Cash, Bank, and Online
accounts. Never rewrite historical document stamps.

Money-account root additions must be included in every ledger-tree reader and
location picker, not only in the Cash & Bank account endpoint. Voucher forms
first fetch the account tree and then narrow it by `accountType`, while the
selected-location picker independently supplies the allowed ledger ids.

**Why:** Omitting a new root from either path produces an empty Online selector
even when the account exists and is active; the UI's final account-type filter
then makes the failure look like missing data.

**How to apply:** When adding a money root, update the shared subtree helper,
cash-account endpoint, voucher-location endpoint, and branch/Head Office
ownership guards together. Do not reclassify legacy rows as part of that fix.
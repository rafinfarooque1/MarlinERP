---
name: Cash/Bank and Online multi-location assignment
description: Rules for managed money-account availability across assigned locations.
---

Bank and Online accounts are global: every warehouse and outlet, including
ones created later, can use them without a location assignment. Legacy
`cash_bank_account_locations` rows for those types are inert and must not block
use, reconciliation, or location-filtered account lists. Cash remains
location-assigned; never rewrite historical transaction location stamps.

**Why:** The user requested Bank and Online to be common to all current and
future warehouses and outlets, with no assignment step.

**How to apply:** Keep location memberships and ownership checks for Cash, but
exclude Bank/Online from location ownership and expose them in all account
pickers, book views, collections, and reconciliation. Do not rewrite historical
document stamps.

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
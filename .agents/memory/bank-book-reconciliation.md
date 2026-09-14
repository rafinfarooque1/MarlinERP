---
name: Bank Book reconciliation identity
description: Durable identity and accounting boundary for one-step bank-book reconciliation.
---

Bank Book reconciliation status is keyed by the exact pair `(posting ledger id, derived posting entry id)`, not by voucher number alone. A Bank Book row may be one leg of a multi-ledger posting, and voucher numbers are not guaranteed to be unique enough for status changes. Allocation receipts must own the bank/cash leg under `receipt:<id>` and use Electronic Clearing for invoice allocation legs, so one receipt remains one bank transaction.

**Why:** The Bank Book is derived from many source modules and can show several legs for one source transaction. Reconciliation is a review status only; it must never create or alter accounting postings, balances, GST, or P&L.

**How to apply:** Re-read and authorize the exact derived posting inside one transaction, lock the status row by ledger plus entry identity, upsert idempotently, and audit the before/after status. Keep electronic sale-payment settlement states separate because legacy settlement batches intentionally post accounting entries. New account-based multi-select reconciliation batches are metadata-only: store gross/charge/net and link exact posting identities without creating vouchers or changing customer balances. A single receipt allocated across invoices owns one bank identity, `receipt:<id>`; only legacy sale-payment rows without a receipt use `sale_payment:<id>` so separate direct collections are not merged. This PostgreSQL instance exposes only the two-key `(integer, integer)` advisory-lock overload, so use `hashtext()` for both lock components.

**Date rule:** Metadata-only account reconciliation is allowed for historical and
future business dates, including dates in locked accounting months. Inclusive
transaction filtering compares normalized `YYYY-MM-DD` business dates, and batch
references sequence by the reconciliation date's year rather than the server's
current year.

**Why:** Reconciliation changes status metadata only; applying accounting month
locks or current-year numbering made valid past/future bank review inconsistent
without protecting any accounting write.

**How to apply:** Keep month-lock guards on posting/settlement flows, not on the
metadata-only bank-batch create/edit routes. Use the explicit page location
filter when present, otherwise fall back to the global location context.
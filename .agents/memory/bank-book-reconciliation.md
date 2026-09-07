---
name: Bank Book reconciliation identity
description: Durable identity and accounting boundary for one-step bank-book reconciliation.
---

Bank Book reconciliation status is keyed by the exact pair `(posting ledger id, derived posting entry id)`, not by voucher number alone. A Bank Book row may be one leg of a multi-ledger posting, and voucher numbers are not guaranteed to be unique enough for status changes.

**Why:** The Bank Book is derived from many source modules and can show several legs for one source transaction. Reconciliation is a review status only; it must never create or alter accounting postings, balances, GST, or P&L.

**How to apply:** Re-read and authorize the exact derived posting inside one transaction, lock the status row by ledger plus entry identity, upsert idempotently, and audit the before/after status. Keep electronic sale-payment settlement states separate because settlement batches intentionally post accounting entries.
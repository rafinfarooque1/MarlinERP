---
name: Employee advance voucher links
description: advances store their JV ids; edit/delete keep books in lockstep; backfill links only unambiguous rows
---

`employee_advances.journal_voucher_id` (disbursement) and `recovery_voucher_id` (cash recovery) are raw-migration columns stamped by the create/recover routes. PATCH keeps the disbursement JV in lockstep (date, total, both legs; FY-crossing date gets a fresh voucher number); DELETE removes every linked voucher in the same txn. Only pending+unclaimed rows are editable; pending and CASH-recovered rows are deletable; anything a payroll run touched (`deducted_payroll_id` set) refuses both.

**Why:** vouchers were historically posted with no back-link, in a separate transaction after the advance row — so insertion order is NOT a durable correlation. A rank-pairing backfill cross-links two same-day same-amount advances and a later delete then removes a sibling's voucher.

**How to apply:** the boot backfill links a voucher ONLY when exactly one unlinked advance and exactly one candidate voucher share the key (`COUNT(*) OVER` = 1 on both sides); ambiguous groups stay NULL, and delete on a NULL-link row removes just the advance, leaving the voucher for manual handling. Any new producer of advance vouchers must stamp the link at creation. Same pattern applies to any future "adopt orphaned system postings" backfill: never pair by row order, leave ambiguity unlinked.

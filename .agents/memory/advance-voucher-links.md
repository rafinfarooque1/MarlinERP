---
name: Advance voucher links
description: money rows and their vouchers are created in ONE txn with the link stamped; consumers fail closed on unlinked rows; backfills never pair by row order
---

An employee advance row and the voucher that disbursed it must be written in
ONE transaction with the link column stamped at creation. The historical flow
inserted the row first, posted the voucher separately, and swallowed voucher
errors — leaving rows whose money never reached the books, indistinguishable
from good rows.

**Why:** insertion order is NOT a durable correlation. A rank-pairing backfill
cross-links two same-day same-amount advances, and a later delete then removes
a sibling's voucher.

**How to apply:**
- Every producer stamps the link inside the creating txn; edit/delete keep the
  linked voucher in lockstep (same txn), and a NULL link fails closed for
  edit/delete/settlement — history stays readable.
- Backfills may link a voucher ONLY when exactly one candidate row and exactly
  one candidate voucher share the key and the amounts reconcile; ambiguity
  stays NULL and is surfaced (loud log, no completion marker), never guessed.
- Provenance-stamped vouchers (non-manual `source`) are automatically refused
  by the manual voucher endpoints — rely on that instead of duplicate guards.

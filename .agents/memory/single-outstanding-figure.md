---
name: One authoritative outstanding figure
description: How "what the customer still owes" is defined once in Marlin ERP, and the two places that quietly re-derive it — read before touching any due/balance/receivable figure.
---

# What is owed is defined in exactly one place

The definition is `invoice total − amount received − credit adjustments`, clamped at
zero, forced to zero for a cancelled document, with any excess reported separately as
overpayment. Status is **derived from that**, never read from a stored payment-mode or
status column.

The owning module must export **two** forms of the same rule:

- an in-process calculator, for single-document reads and for write-path guards; and
- SQL expression builders, for list/report/aggregate endpoints.

Both must encode the clamp and the cancelled case, so a caller can `SUM()` the SQL form
without restating either rule. One form without the other is what causes the drift
below: an endpoint that cannot conveniently call the calculator will hand-roll SQL.

**Why:** "one figure everywhere" fails in two predictable places, and both were found
only by comparing surfaces against each other rather than against expectations.

1. **Aggregate/report endpoints hand-roll `total − paid`.** It looks equivalent and is
   not: it silently drops credit notes, so a return never reduces what a report shows.
   Two separate sales reports had their own copy of this arithmetic in SQL.
2. **The frontend recomputes the balance from fields it already has.** A page that
   receives `totalAmount` and `amountPaid` will compute the difference itself rather
   than read the server's balance, reintroducing the same credit-note bug in the UI —
   and it then treats "not paid" as "collectible", offering a Collect action on
   cancelled documents.

A write path that accepts money must also *return* the position it computed, so the
caller has no reason to recompute a balance after the write.

**How to apply:** whenever a figure means "still owed", grep for `total.*paid` style
arithmetic in both SQL and TSX before adding anything, and delete what you find rather
than adding a third rule. Prove it by differential test, not by unit test: raise a
credit note against a live document and assert that *every* surface — document detail,
list, receivables, dashboard, and each report — moves by exactly the credit-note
amount. A figure that only agrees when there are no credit notes is the failure mode,
so a fixture without one proves nothing.

Beware the mirror case of over-netting: per-document figures net only credits allocated
to that document, while per-customer figures additionally net unallocated credits. A
statement that lists the invoice and the credit note as separate lines must stay
**gross**, or the credit is subtracted twice.

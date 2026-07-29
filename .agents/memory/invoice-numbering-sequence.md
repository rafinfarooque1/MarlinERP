---
name: Invoice numbering vs the sequence counter
description: Renumbering documents strands the allocator counter and can brick creation of new documents once a unique index exists.
---

# Renumbering documents strands the counter that issues them

Document numbers here come from a counter (`company_settings.invoice_sequence`
for sales), but uniqueness is enforced on the number stored on the row. Those
are two separate pieces of state, and only one of them is authoritative for
"what has been used".

**The rule:** any operation that rewrites document numbers must advance the
allocator to at least the highest number now in use, in the same change.

**Why:** a de-duplication pass that moves colliding invoices *onto* higher
numbers, then adds a unique index, leaves the counter pointing at numbers that
are now taken. Every subsequent create dies on the unique violation. The
failure is total (no new sales at all) but invisible to any read-only
verification — a balanced trial balance and a clean acceptance audit both pass
happily while the write path is completely broken.

**How to apply:**
- After any renumbering/backfill of a numbered document, reconcile the counter.
- Prefer a boot-time, idempotent, forward-only reconcile
  (`GREATEST(counter, max_suffix_in_use)`) over a one-shot migration: other
  code paths and manual data fixes can strand the counter the same way, so it
  should re-heal rather than be corrected once.
- Only ever move the counter *forward*. Moving it back re-issues numbers that
  already exist.
- Restrict the "max in use" scan to rows whose number actually matches the
  current prefix/period format, and require the suffix to be all digits —
  otherwise legacy or hand-entered formats poison the maximum.

**The general lesson:** a read-only audit cannot certify a system. It exercises
queries, not writes. Any migration that changes stored keys needs at least one
real create/update afterwards to prove the write path still works.
